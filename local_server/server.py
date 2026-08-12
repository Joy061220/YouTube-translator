"""Loopback-only translation service for the YouTube caption extension."""

from __future__ import annotations

import json
import os
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib import error, parse, request


HOST = "127.0.0.1"
PORT = 8765
DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions"
DEFAULT_MODEL = "deepseek-v4-flash"
REQUEST_TIMEOUT_SECONDS = 20
MAX_BODY_BYTES = 8192
MAX_TEXT_CHARS = 600
MAX_CONTEXT_ITEMS = 2
MAX_CONTEXT_CHARS = 600
MAX_WORD_CHARS = 80


class ServiceError(Exception):
    def __init__(self, code: str, message: str, status: int = 500) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def load_local_env(path: Path) -> None:
    """Load simple KEY=VALUE pairs without replacing existing environment values."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def is_allowed_origin(origin: str | None) -> bool:
    # Requests made by local command-line tools may not send Origin. Browser pages do.
    if not origin:
        return True
    parsed = parse.urlparse(origin)
    return (
        parsed.scheme == "chrome-extension"
        and bool(parsed.netloc)
        and parsed.path in ("", "/")
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
    )


def validate_translation_payload(payload: Any) -> tuple[str, list[str], str]:
    if not isinstance(payload, dict):
        raise ServiceError("invalid_request", "请求内容必须是 JSON 对象。", 400)

    text = payload.get("text")
    context = payload.get("context", [])
    target_language = payload.get("targetLanguage")

    if not isinstance(text, str) or not text.strip():
        raise ServiceError("missing_caption", "没有收到可翻译的字幕。", 400)
    text = " ".join(text.split())
    if len(text) > MAX_TEXT_CHARS:
        raise ServiceError("caption_too_long", "当前字幕过长，无法作为单句翻译。", 413)

    if not isinstance(context, list) or len(context) > MAX_CONTEXT_ITEMS:
        raise ServiceError("invalid_context", "字幕上下文格式不正确。", 400)
    clean_context: list[str] = []
    for item in context:
        if not isinstance(item, str):
            raise ServiceError("invalid_context", "字幕上下文格式不正确。", 400)
        clean_item = " ".join(item.split())
        if len(clean_item) > MAX_CONTEXT_CHARS:
            raise ServiceError("context_too_long", "字幕上下文过长。", 413)
        if clean_item:
            clean_context.append(clean_item)

    if target_language != "zh-CN":
        raise ServiceError("unsupported_language", "当前版本仅支持翻译为简体中文。", 400)

    return text, clean_context, target_language


def validate_word_payload(payload: Any) -> tuple[str, str]:
    if not isinstance(payload, dict):
        raise ServiceError("invalid_request", "请求内容必须是 JSON 对象。", 400)

    word = payload.get("word")
    sentence = payload.get("sentence")
    if not isinstance(word, str) or not word.strip():
        raise ServiceError("missing_word", "没有收到需要解释的单词。", 400)
    if not isinstance(sentence, str) or not sentence.strip():
        raise ServiceError("missing_sentence", "没有收到单词所在的字幕。", 400)

    word = word.strip()
    sentence = " ".join(sentence.split())
    if len(word) > MAX_WORD_CHARS:
        raise ServiceError("word_too_long", "所选内容过长，请只选择一个单词。", 413)
    if len(sentence) > MAX_TEXT_CHARS:
        raise ServiceError("caption_too_long", "当前字幕过长。", 413)
    return word, sentence


class DeepSeekTranslationService:
    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        timeout: int = REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        self.api_key = api_key if api_key is not None else os.getenv("DEEPSEEK_API_KEY", "")
        self.model = model or os.getenv("DEEPSEEK_MODEL", DEFAULT_MODEL)
        self.timeout = timeout

    def _open(self, req: request.Request):
        return request.urlopen(req, timeout=self.timeout)

    def _request_json(self, system_prompt: str, input_data: dict[str, Any], max_tokens: int) -> dict[str, Any]:
        if not self.api_key:
            raise ServiceError(
                "missing_api_key",
                "本地服务尚未配置 DEEPSEEK_API_KEY。请编辑 local_server/.env.local 后重启服务。",
                503,
            )

        api_payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(input_data, ensure_ascii=False)},
            ],
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
            "max_tokens": max_tokens,
            "stream": False,
        }
        req = request.Request(
            DEEPSEEK_CHAT_URL,
            data=json.dumps(api_payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with self._open(req) as response:
                raw_response = response.read()
        except error.HTTPError as exc:
            # Consume the response so the underlying connection can be released, but never expose it.
            try:
                exc.read()
            except Exception:
                pass
            raise self._map_http_error(exc.code) from exc
        except (TimeoutError, socket.timeout) as exc:
            raise ServiceError("timeout", "DeepSeek 翻译请求超时，请检查网络后再试。", 504) from exc
        except error.URLError as exc:
            if isinstance(exc.reason, (TimeoutError, socket.timeout)):
                raise ServiceError("timeout", "DeepSeek 翻译请求超时，请检查网络后再试。", 504) from exc
            raise ServiceError("network_error", "无法连接 DeepSeek，请检查网络后再试。", 502) from exc

        try:
            response_data = json.loads(raw_response.decode("utf-8"))
            output_text = self._extract_output_text(response_data)
            result = json.loads(output_text)
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            raise ServiceError("invalid_response", "DeepSeek 返回了无法识别的翻译结果，请重试。", 502) from exc

        if not isinstance(result, dict):
            raise ServiceError("invalid_response", "DeepSeek 返回了无法识别的结果，请重试。", 502)
        return result

    def translate(self, text: str, context: list[str], target_language: str) -> dict[str, str]:
        input_data = {
            "currentSubtitle": text,
            "previousSubtitlesForContext": context,
            "targetLanguage": "Simplified Chinese (zh-CN)",
        }
        system_prompt = (
            "You translate one assembled, complete video subtitle sentence into natural Simplified Chinese. "
            "Use previous subtitles only to resolve context; never translate them as part of the answer. "
            "Translate every clause in currentSubtitle without omitting, shortening, or summarizing any part. "
            "The source may contain minor spacing or punctuation artifacts from automatic captions; silently "
            "repair only obvious artifacts, but never invent speech that is not present. "
            "Preserve names, brands, technical terms, tone, and implied meaning. "
            "Return only a JSON object with exactly one string field: translation."
        )
        result = self._request_json(system_prompt, input_data, 240)
        translation = result.get("translation")
        if not isinstance(translation, str) or not translation.strip():
            raise ServiceError("invalid_response", "DeepSeek 返回了空的翻译结果，请重试。", 502)
        return {"translation": translation.strip()}

    def explain_word(self, word: str, sentence: str) -> dict[str, str]:
        system_prompt = (
            "You are an English vocabulary tutor for a Simplified Chinese learner. Explain the selected "
            "word specifically as it is used in the supplied subtitle. Return only a JSON object with four "
            "string fields: word, pronunciation, meaning, details. pronunciation should be an IPA transcription "
            "when applicable. meaning should be a concise Chinese definition in this sentence. details should "
            "explain part of speech, nuance, common collocations or usage, and give one short bilingual example. "
            "Be accurate and useful, but keep details within 180 Chinese characters."
        )
        result = self._request_json(system_prompt, {"selectedWord": word, "subtitle": sentence}, 500)
        fields = ("word", "pronunciation", "meaning", "details")
        if any(not isinstance(result.get(field), str) for field in fields):
            raise ServiceError("invalid_response", "DeepSeek 返回了无法识别的单词解释，请重试。", 502)
        return {field: result[field].strip() for field in fields}

    @staticmethod
    def _extract_output_text(response_data: dict[str, Any]) -> str:
        choices = response_data.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ValueError("No choices in response")
        content = choices[0].get("message", {}).get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("No message content in response")
        return content

    @staticmethod
    def _map_http_error(status: int) -> ServiceError:
        if status in (401, 403):
            return ServiceError("authentication_error", "DeepSeek API Key 无效或没有权限，请检查配置。", 502)
        if status == 402:
            return ServiceError("insufficient_balance", "DeepSeek 账户余额不足，请充值后再试。", 402)
        if status == 429:
            return ServiceError("rate_limit", "DeepSeek 请求过于频繁，请稍后再试。", 429)
        if status in (400, 404, 422):
            return ServiceError("model_error", "DeepSeek 拒绝了请求，请确认 DEEPSEEK_MODEL 可用于当前账户。", 502)
        if status >= 500:
            return ServiceError("deepseek_unavailable", "DeepSeek 服务暂时不可用，请稍后再试。", 502)
        return ServiceError("deepseek_error", "DeepSeek 翻译请求失败，请稍后再试。", 502)


class TranslationRequestHandler(BaseHTTPRequestHandler):
    service: DeepSeekTranslationService
    server_version = "CaptionTranslator/1.0"
    sys_version = ""

    def log_message(self, _format: str, *args: Any) -> None:
        # Intentionally suppress access logs so subtitle content can never be logged accidentally.
        return

    def _origin_or_reject(self) -> str | None:
        origin = self.headers.get("Origin")
        if not is_allowed_origin(origin):
            raise ServiceError("forbidden_origin", "此本地服务只接受 Chrome 扩展请求。", 403)
        return origin

    def _send_json(self, status: int, payload: dict[str, Any], origin: str | None = None) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if origin and is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(encoded)

    def _send_error(self, exc: ServiceError, origin: str | None = None) -> None:
        self._send_json(exc.status, {"error": {"code": exc.code, "message": exc.message}}, origin)

    def do_OPTIONS(self) -> None:
        try:
            origin = self._origin_or_reject()
            if self.path not in ("/translate", "/explain-word"):
                raise ServiceError("not_found", "请求地址不存在。", 404)
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin or "null")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()
        except ServiceError as exc:
            self._send_error(exc)

    def do_GET(self) -> None:
        try:
            origin = self._origin_or_reject()
            if self.path != "/health":
                raise ServiceError("not_found", "请求地址不存在。", 404)
            self._send_json(200, {"status": "ok"}, origin)
        except ServiceError as exc:
            self._send_error(exc)

    def do_POST(self) -> None:
        origin: str | None = None
        try:
            origin = self._origin_or_reject()
            if self.path not in ("/translate", "/explain-word"):
                raise ServiceError("not_found", "请求地址不存在。", 404)
            content_type = self.headers.get("Content-Type", "").lower()
            if not content_type.startswith("application/json"):
                raise ServiceError("unsupported_media_type", "请求必须使用 application/json。", 415)
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError as exc:
                raise ServiceError("invalid_length", "请求长度不正确。", 400) from exc
            if content_length <= 0:
                raise ServiceError("empty_request", "请求内容为空。", 400)
            if content_length > MAX_BODY_BYTES:
                raise ServiceError("request_too_large", "请求内容过大。", 413)
            try:
                payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ServiceError("invalid_json", "请求不是有效的 JSON。", 400) from exc

            if self.path == "/translate":
                text, context, target_language = validate_translation_payload(payload)
                result = self.service.translate(text, context, target_language)
            else:
                word, sentence = validate_word_payload(payload)
                result = self.service.explain_word(word, sentence)
            self._send_json(200, result, origin)
        except ServiceError as exc:
            self._send_error(exc, origin)
        except Exception:
            self._send_error(ServiceError("internal_error", "本地翻译服务发生错误，请重启后再试。", 500), origin)


def make_handler(service: DeepSeekTranslationService):
    class ConfiguredHandler(TranslationRequestHandler):
        pass

    ConfiguredHandler.service = service
    return ConfiguredHandler


def run_server() -> None:
    script_dir = Path(__file__).resolve().parent
    load_local_env(script_dir / ".env.local")
    service = DeepSeekTranslationService()
    server = ThreadingHTTPServer((HOST, PORT), make_handler(service))
    print(f"YouTube 字幕翻译服务已启动：http://{HOST}:{PORT}")
    print("请保持此窗口开启。按 Ctrl+C 可停止服务。")
    if not service.api_key:
        print("提示：尚未配置 DEEPSEEK_API_KEY，翻译请求会显示配置说明。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    run_server()
