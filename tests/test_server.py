import http.client
import json
import socket
import threading
import unittest
from io import BytesIO
from urllib import error

from local_server.server import (
    MAX_TEXT_CHARS,
    DeepSeekTranslationService,
    ServiceError,
    ThreadingHTTPServer,
    make_handler,
)


class FakeHTTPResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return self.payload


class CapturingTranslationService(DeepSeekTranslationService):
    def __init__(self, response_payload=None, raised=None, api_key="test-key"):
        super().__init__(api_key=api_key, model="test-model")
        self.response_payload = response_payload
        self.raised = raised
        self.last_request = None

    def _open(self, req):
        self.last_request = req
        if self.raised:
            raise self.raised
        return FakeHTTPResponse(self.response_payload)


class DeepSeekTranslationServiceTests(unittest.TestCase):
    def test_successfully_parses_structured_output(self):
        result_text = json.dumps(
            {"translation": "这就是重点。"},
            ensure_ascii=False,
        )
        service = CapturingTranslationService(
            {"choices": [{"message": {"role": "assistant", "content": result_text}, "finish_reason": "stop"}]}
        )

        result = service.translate("That's the point.", ["Listen carefully."], "zh-CN")

        self.assertEqual(result["translation"], "这就是重点。")
        sent = json.loads(service.last_request.data.decode("utf-8"))
        self.assertEqual(sent["model"], "test-model")
        self.assertEqual(sent["response_format"], {"type": "json_object"})
        self.assertEqual(sent["thinking"], {"type": "disabled"})
        self.assertEqual(sent["messages"][0]["role"], "system")
        self.assertIn("JSON", sent["messages"][0]["content"])
        self.assertIn("assembled, complete", sent["messages"][0]["content"])
        self.assertNotIn("test-key", service.last_request.data.decode("utf-8"))

    def test_successfully_parses_word_explanation(self):
        result_text = json.dumps(
            {
                "word": "point",
                "pronunciation": "/pɔɪnt/",
                "meaning": "重点；要点",
                "details": "此处作名词。例：That's the point. 这就是重点。",
            },
            ensure_ascii=False,
        )
        service = CapturingTranslationService(
            {"choices": [{"message": {"role": "assistant", "content": result_text}}]}
        )

        result = service.explain_word("point", "That's the point.")

        self.assertEqual(result["meaning"], "重点；要点")
        sent = json.loads(service.last_request.data.decode("utf-8"))
        self.assertEqual(json.loads(sent["messages"][1]["content"])["selectedWord"], "point")

    def test_missing_api_key_is_reported(self):
        service = DeepSeekTranslationService(api_key="")
        with self.assertRaises(ServiceError) as raised:
            service.translate("Hello", [], "zh-CN")
        self.assertEqual(raised.exception.code, "missing_api_key")
        self.assertEqual(raised.exception.status, 503)

    def test_timeout_is_reported(self):
        service = CapturingTranslationService(raised=socket.timeout("timed out"))
        with self.assertRaises(ServiceError) as raised:
            service.translate("Hello", [], "zh-CN")
        self.assertEqual(raised.exception.code, "timeout")
        self.assertEqual(raised.exception.status, 504)

    def test_rate_limit_is_reported(self):
        http_error = error.HTTPError(
            "https://api.deepseek.com/chat/completions", 429, "Too Many Requests", {}, BytesIO(b"{}")
        )
        service = CapturingTranslationService(raised=http_error)
        with self.assertRaises(ServiceError) as raised:
            service.translate("Hello", [], "zh-CN")
        self.assertEqual(raised.exception.code, "rate_limit")
        self.assertEqual(raised.exception.status, 429)

    def test_insufficient_balance_is_reported(self):
        http_error = error.HTTPError(
            "https://api.deepseek.com/chat/completions", 402, "Payment Required", {}, BytesIO(b"{}")
        )
        service = CapturingTranslationService(raised=http_error)
        with self.assertRaises(ServiceError) as raised:
            service.translate("Hello", [], "zh-CN")
        self.assertEqual(raised.exception.code, "insufficient_balance")
        self.assertEqual(raised.exception.status, 402)

    def test_malformed_deepseek_response_is_reported(self):
        service = CapturingTranslationService({"choices": []})
        with self.assertRaises(ServiceError) as raised:
            service.translate("Hello", [], "zh-CN")
        self.assertEqual(raised.exception.code, "invalid_response")


class FakeTranslationService:
    def __init__(self):
        self.calls = []

    def translate(self, text, context, target_language):
        self.calls.append((text, context, target_language))
        return {"translation": "你好"}

    def explain_word(self, word, sentence):
        self.calls.append((word, sentence))
        return {
            "word": word,
            "pronunciation": "/wɜːd/",
            "meaning": "单词",
            "details": "结合字幕语境的详细解释。",
        }


class TranslationHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = FakeTranslationService()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.service))
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, method, path, payload=None, headers=None):
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers = dict(headers or {})
        if body is not None:
            request_headers.setdefault("Content-Type", "application/json")
            request_headers["Content-Length"] = str(len(body))
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        response_body = response.read()
        connection.close()
        return response.status, dict(response.getheaders()), json.loads(response_body.decode("utf-8"))

    def test_health_check(self):
        status, _, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"status": "ok"})

    def test_translation_endpoint(self):
        status, headers, body = self.request(
            "POST",
            "/translate",
            {"text": " Hello   world ", "context": ["Earlier line"], "targetLanguage": "zh-CN"},
            {"Origin": "chrome-extension://abcdefghijklmnop"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, {"translation": "你好"})
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "chrome-extension://abcdefghijklmnop")
        self.assertEqual(self.service.calls[-1], ("Hello world", ["Earlier line"], "zh-CN"))

    def test_word_explanation_endpoint(self):
        status, _, body = self.request(
            "POST",
            "/explain-word",
            {"word": "world", "sentence": "Hello world"},
            {"Origin": "chrome-extension://abcdefghijklmnop"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["word"], "world")
        self.assertEqual(body["meaning"], "单词")
        self.assertEqual(self.service.calls[-1], ("world", "Hello world"))

    def test_rejects_non_extension_browser_origin(self):
        status, _, body = self.request(
            "POST",
            "/translate",
            {"text": "Hello", "context": [], "targetLanguage": "zh-CN"},
            {"Origin": "https://www.youtube.com"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "forbidden_origin")

    def test_rejects_overlong_caption(self):
        status, _, body = self.request(
            "POST",
            "/translate",
            {"text": "a" * (MAX_TEXT_CHARS + 1), "context": [], "targetLanguage": "zh-CN"},
        )
        self.assertEqual(status, 413)
        self.assertEqual(body["error"]["code"], "caption_too_long")

    def test_rejects_invalid_json_shape(self):
        status, _, body = self.request(
            "POST", "/translate", {"text": "Hello", "context": "wrong", "targetLanguage": "zh-CN"}
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_context")


if __name__ == "__main__":
    unittest.main()
