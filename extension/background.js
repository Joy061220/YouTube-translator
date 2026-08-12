const LOCAL_SERVICE_URL = "http://127.0.0.1:8765";
const REQUEST_TIMEOUT_MS = 22000;

async function requestService(path, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${LOCAL_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("本地翻译服务返回了无法识别的内容。请重启服务后再试。");
    }

    if (!response.ok) {
      throw new Error(body?.error?.message || "翻译失败，请稍后再试。");
    }

    return body;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("翻译请求超时，请检查网络后再试。");
    }
    if (error instanceof TypeError) {
      throw new Error("无法连接本地翻译服务。请先双击 start-server.cmd 启动服务。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const servicePath = {
    "translate-caption": "/translate",
    "explain-word": "/explain-word"
  }[message?.type];
  if (!servicePath) {
    return false;
  }

  // Only this extension's content scripts can reach this listener. The content
  // script already checks the live YouTube route before sending a request.
  // Re-checking sender.url is unreliable after YouTube SPA navigations.
  if (!sender.tab?.id) {
    sendResponse({ ok: false, error: "无法识别当前视频标签页，请刷新页面后再试。" });
    return false;
  }

  requestService(servicePath, message.payload)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "翻译失败，请稍后再试。" }));

  return true;
});

async function sendTranslateCommand(tab) {
  if (!tab?.id) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "translate-current-caption" });
  } catch {
    // 页面仍在加载或内容脚本尚未就绪时无需打扰用户。
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "translate-current-caption") {
    return;
  }
  await sendTranslateCommand(tab);
});

chrome.action.onClicked.addListener(sendTranslateCommand);
