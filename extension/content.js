(() => {
  "use strict";

  if (window.__youtubeCaptionTranslatorLoaded) {
    return;
  }
  window.__youtubeCaptionTranslatorLoaded = true;

  const UI_HOST_ID = "youtube-caption-translator-root";
  const MAX_HISTORY = 12;
  const SENTENCE_END_SETTLE_MS = 250;
  const BLANK_CAPTION_SETTLE_MS = 900;
  const MAX_COLLECTION_MS = 8000;
  const CAPTION_BREAK_MS = 900;
  const TIMELINE_CAPTION_TIMEOUT_MS = 450;
  const MAX_TRANSLATION_CACHE = 64;
  const MAX_TRACKED_CAPTION_CHARS = 520;
  const TIMELINE_CHANNEL = "youtube-caption-translator-timeline-v1";
  const completedCaptions = [];
  const translationCache = new Map();
  const pendingTimelineRequests = new Map();
  const captionTracker = new CaptionSentenceAssembler.SentenceBuffer();
  let uiHost = null;
  let ui = null;
  let requestSequence = 0;
  let wordRequestSequence = 0;
  let scanScheduled = false;
  let activeCollection = null;
  let lastTrackedCaption = "";
  let lastCaptionChangeAt = performance.now();
  let captionBlankSince = null;
  let timelinePrefetchedVideoId = "";
  let retryAction = "translate";

  const normalizeText = CaptionSentenceAssembler.normalizeText;

  function currentVideoId() {
    return new URLSearchParams(location.search).get("v") || "";
  }

  function ensureTimelineBridge() {
    // page-caption-source.js is loaded first in Chrome's MAIN world by the manifest.
    return Promise.resolve(true);
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== TIMELINE_CHANNEL ||
      event.data?.type !== "timeline-caption-response"
    ) {
      return;
    }
    const pending = pendingTimelineRequests.get(event.data.requestId);
    if (!pending) return;
    pendingTimelineRequests.delete(event.data.requestId);
    clearTimeout(pending.timer);
    pending.resolve(event.data.ok ? event.data.data : null);
  });

  async function requestTimelineCaption(currentText, currentTimeMs, timeoutMs = TIMELINE_CAPTION_TIMEOUT_MS) {
    if (!Number.isFinite(currentTimeMs) || !(await ensureTimelineBridge())) return null;
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        pendingTimelineRequests.delete(requestId);
        resolve(null);
      }, timeoutMs);
      pendingTimelineRequests.set(requestId, { resolve, timer });
      window.postMessage({
        channel: TIMELINE_CHANNEL,
        type: "request-timeline-caption",
        requestId,
        payload: { currentText, currentTimeMs }
      }, location.origin);
    });
  }

  function prefetchTimelineCaption(currentText) {
    const videoId = currentVideoId();
    if (!videoId || videoId === timelinePrefetchedVideoId) return;
    timelinePrefetchedVideoId = videoId;
    ensureTimelineBridge().then((ready) => {
      const video = currentVideo();
      if (!ready || !video || currentVideoId() !== videoId) return;
      window.postMessage({
        channel: TIMELINE_CHANNEL,
        type: "prefetch-timeline-caption",
        payload: { currentText, currentTimeMs: video.currentTime * 1000 }
      }, location.origin);
    });
  }

  function isWatchPage() {
    return location.hostname === "www.youtube.com" && location.pathname === "/watch";
  }

  function isVisible(element) {
    if (!element.getClientRects().length) {
      return false;
    }
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function readVisibleCaption() {
    const parts = [];
    for (const segment of document.querySelectorAll(".ytp-caption-segment")) {
      if (!isVisible(segment)) {
        continue;
      }
      const text = normalizeText(segment.textContent || "");
      if (text && parts[parts.length - 1] !== text) {
        parts.push(text);
      }
    }
    return normalizeText(parts.join(" "));
  }

  function rememberCompletedCaption(caption) {
    if (!caption || completedCaptions[completedCaptions.length - 1] === caption) {
      return;
    }
    completedCaptions.push(caption);
    if (completedCaptions.length > MAX_HISTORY) {
      completedCaptions.shift();
    }
  }

  function boundTrackedCaption() {
    const text = normalizeText(captionTracker.activeText);
    if (text.length <= MAX_TRACKED_CAPTION_CHARS) return;
    let start = text.length - MAX_TRACKED_CAPTION_CHARS;
    const boundary = text.slice(start).match(/[.!?。！？…][.!?。！？…]*["'”’）)\]}]*\s+/u);
    if (boundary && boundary.index < 140) {
      start += boundary.index + boundary[0].length;
    } else {
      const nextSpace = text.indexOf(" ", start);
      if (nextSpace >= 0) start = nextSpace + 1;
    }
    captionTracker.activeText = normalizeText(text.slice(start));
  }

  function scanCaption() {
    scanScheduled = false;
    const caption = readVisibleCaption();
    const now = performance.now();
    if (!caption) {
      if (lastTrackedCaption && captionBlankSince == null) captionBlankSince = now;
      lastTrackedCaption = "";
      captionTracker.push("");
      activeCollection?.acceptSnapshot("");
      return;
    }
    if (captionBlankSince != null) {
      if (captionTracker.activeText && now - captionBlankSince >= CAPTION_BREAK_MS) {
        rememberCompletedCaption(captionTracker.activeText);
        captionTracker.reset();
      }
      captionBlankSince = null;
    }
    if (caption !== lastTrackedCaption) {
      lastCaptionChangeAt = now;
    }
    lastTrackedCaption = caption;
    const update = captionTracker.push(caption);
    boundTrackedCaption();
    for (const completed of update.completed) {
      rememberCompletedCaption(completed);
    }
    prefetchTimelineCaption(caption);
    activeCollection?.acceptSnapshot(caption);
  }

  function scheduleCaptionScan() {
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    requestAnimationFrame(scanCaption);
  }

  function contextFor(current) {
    const useful = completedCaptions.filter((caption) => {
      if (caption === current) {
        return false;
      }
      // 排除当前句的旧版本或包含当前句的异常重复项。
      return !current.includes(caption) && !caption.includes(current);
    });
    return useful.slice(-2);
  }

  function translationCacheKey(text, context) {
    return JSON.stringify([text, context, "zh-CN"]);
  }

  function readCachedTranslation(key) {
    const cached = translationCache.get(key);
    if (!cached) return null;
    translationCache.delete(key);
    translationCache.set(key, cached);
    return cached;
  }

  function rememberTranslation(key, data) {
    if (!data?.translation) return;
    translationCache.delete(key);
    translationCache.set(key, data);
    while (translationCache.size > MAX_TRANSLATION_CACHE) {
      translationCache.delete(translationCache.keys().next().value);
    }
  }

  function reportTranslationTiming({ startedAt, captionReadyAt, requestStartedAt, captionSource, cacheHit, ok }) {
    const finishedAt = performance.now();
    console.debug("[YouTube 字幕翻译] 耗时", {
      captionWaitMs: Math.round(captionReadyAt - startedAt),
      apiWaitMs: requestStartedAt == null ? 0 : Math.round(finishedAt - requestStartedAt),
      totalMs: Math.round(finishedAt - startedAt),
      captionSource,
      cacheHit,
      ok
    });
  }

  function createUi(player) {
    uiHost = document.createElement("div");
    uiHost.id = UI_HOST_ID;
    uiHost.setAttribute("aria-hidden", "false");
    player.appendChild(uiHost);

    const shadow = uiHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { position: absolute; inset: 0; z-index: 2147483000; pointer-events: none; font-family: Arial, "Microsoft YaHei", sans-serif; }
        * { box-sizing: border-box; }
        button { font: inherit; }
        .translate-button {
          position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
          width: 42px; height: 42px; border: 1px solid rgba(255,255,255,.32); border-radius: 999px;
          color: #fff; background: rgba(15,18,24,.86); box-shadow: 0 5px 18px rgba(0,0,0,.35);
          cursor: pointer; pointer-events: auto; font-size: 14px; font-weight: 700;
          transition: transform .15s ease, background .15s ease;
        }
        .translate-button:hover { background: #1677ff; transform: translateY(-50%) scale(1.06); }
        .translate-button:focus-visible, .icon-button:focus-visible, .retry:focus-visible, .word:focus-visible { outline: 3px solid #7db5ff; outline-offset: 2px; }
        .panel {
          position: absolute; top: 16px; right: 16px; width: min(380px, calc(100% - 32px)); max-height: calc(100% - 32px);
          overflow: auto; border: 1px solid rgba(255,255,255,.16); border-radius: 14px; color: #f7f8fa;
          background: rgba(17,20,27,.96); box-shadow: 0 16px 45px rgba(0,0,0,.45); pointer-events: auto;
        }
        .panel[hidden] { display: none; }
        .header { display: flex; align-items: center; justify-content: space-between; min-height: 46px; padding: 0 10px 0 15px; border-bottom: 1px solid rgba(255,255,255,.1); cursor: grab; user-select: none; }
        .header:active { cursor: grabbing; }
        .title { font-size: 14px; font-weight: 700; letter-spacing: .02em; }
        .icon-button { width: 32px; height: 32px; border: 0; border-radius: 8px; color: #d7dae0; background: transparent; cursor: pointer; font-size: 22px; line-height: 1; }
        .icon-button:hover { background: rgba(255,255,255,.1); }
        .body { padding: 14px 15px 16px; }
        .status { display: flex; align-items: center; gap: 9px; color: #c8ccd4; font-size: 13px; }
        .status.error { color: #ffb4b4; line-height: 1.55; }
        .spinner { width: 16px; height: 16px; flex: 0 0 auto; border: 2px solid rgba(255,255,255,.25); border-top-color: #62a2ff; border-radius: 50%; animation: spin .8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .result[hidden], .status[hidden] { display: none; }
        .section + .section { margin-top: 14px; padding-top: 13px; border-top: 1px solid rgba(255,255,255,.09); }
        .label { margin-bottom: 6px; color: #9fa6b2; font-size: 11px; font-weight: 700; letter-spacing: .08em; }
        .text { margin: 0; color: #f5f6f8; font-size: 15px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
        .translation { color: #fff; font-size: 18px; }
        .original { line-height: 1.9; }
        .notice { margin: 0 0 11px; padding: 8px 10px; border-radius: 8px; color: #ffd9a1; background: rgba(179,104,0,.22); font-size: 12px; line-height: 1.5; }
        .notice[hidden] { display: none; }
        .word { display: inline; padding: 2px 1px; border: 0; border-radius: 4px; color: #8fc1ff; background: transparent; cursor: pointer; }
        .word:hover { color: #fff; background: rgba(22,119,255,.55); }
        .word-hint { margin: 7px 0 0; color: #8f97a4; font-size: 12px; }
        .word-overlay { position: absolute; inset: 0; display: grid; place-items: center; padding: 18px; background: rgba(0,0,0,.58); pointer-events: auto; }
        .word-overlay[hidden] { display: none; }
        .word-dialog { width: min(410px, 100%); max-height: min(470px, calc(100% - 24px)); overflow: auto; border: 1px solid rgba(255,255,255,.2); border-radius: 14px; color: #f7f8fa; background: #171b24; box-shadow: 0 18px 55px rgba(0,0,0,.55); }
        .word-dialog-header { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 10px 0 16px; border-bottom: 1px solid rgba(255,255,255,.1); }
        .word-dialog-body { padding: 15px 16px 18px; }
        .word-title { font-size: 20px; font-weight: 700; }
        .pronunciation { margin-left: 8px; color: #9eb5d0; font-size: 14px; font-weight: 400; }
        .word-meaning { margin: 10px 0 0; color: #fff; font-size: 17px; line-height: 1.55; }
        .word-details { margin: 12px 0 0; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.1); color: #d3d8e0; font-size: 14px; line-height: 1.65; white-space: pre-wrap; }
        .retry { margin-top: 14px; padding: 8px 13px; border: 0; border-radius: 8px; color: #fff; background: #1677ff; cursor: pointer; font-weight: 700; }
        .retry:hover { background: #4090ff; }
        @media (max-width: 520px), (max-height: 320px) {
          .translate-button { right: 8px; width: 36px; height: 36px; font-size: 12px; }
          .panel { top: 8px; right: 8px; width: min(340px, calc(100% - 16px)); max-height: calc(100% - 16px); }
          .body { padding: 10px 12px 12px; }
        }
      </style>
      <button class="translate-button" type="button" title="翻译当前字幕（Alt+Shift+T）" aria-label="翻译当前字幕">译</button>
      <section class="panel" role="dialog" aria-label="字幕翻译" hidden>
        <div class="header">
          <span class="title">字幕翻译</span>
          <button class="icon-button close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="body">
          <div class="status"><span class="spinner"></span><span class="status-text">正在翻译…</span></div>
          <div class="result" hidden>
            <p class="notice" hidden></p>
            <div class="section"><div class="label">原文</div><p class="text original"></p><p class="word-hint">点击蓝色单词查看详细解释</p></div>
            <div class="section"><div class="label">中文</div><p class="text translation"></p></div>
          </div>
          <button class="retry" type="button" hidden>再试一次</button>
        </div>
      </section>
      <div class="word-overlay" hidden>
        <section class="word-dialog" role="dialog" aria-modal="true" aria-label="单词详解">
          <div class="word-dialog-header">
            <div><span class="word-title"></span><span class="pronunciation"></span></div>
            <button class="icon-button word-close" type="button" aria-label="关闭单词解释">×</button>
          </div>
          <div class="word-dialog-body">
            <div class="word-status status"><span class="spinner"></span><span>正在查询单词…</span></div>
            <div class="word-content" hidden><p class="word-meaning"></p><p class="word-details"></p></div>
          </div>
        </section>
      </div>`;

    ui = {
      button: shadow.querySelector(".translate-button"),
      panel: shadow.querySelector(".panel"),
      header: shadow.querySelector(".header"),
      close: shadow.querySelector(".close"),
      status: shadow.querySelector(".status"),
      statusText: shadow.querySelector(".status-text"),
      spinner: shadow.querySelector(".spinner"),
      result: shadow.querySelector(".result"),
      notice: shadow.querySelector(".notice"),
      original: shadow.querySelector(".original"),
      translation: shadow.querySelector(".translation"),
      retry: shadow.querySelector(".retry"),
      wordOverlay: shadow.querySelector(".word-overlay"),
      wordClose: shadow.querySelector(".word-close"),
      wordTitle: shadow.querySelector(".word-title"),
      pronunciation: shadow.querySelector(".pronunciation"),
      wordStatus: shadow.querySelector(".word-status"),
      wordContent: shadow.querySelector(".word-content"),
      wordMeaning: shadow.querySelector(".word-meaning"),
      wordDetails: shadow.querySelector(".word-details")
    };

    ui.button.addEventListener("click", () => translateCurrentCaption());
    ui.retry.addEventListener("click", () => {
      if (retryAction === "reload") {
        location.reload();
        return;
      }
      translateCurrentCaption({ forceRefresh: true });
    });
    ui.original.addEventListener("click", (event) => {
      const word = event.target.closest(".word")?.dataset.word;
      if (word) explainWord(word, ui.original.dataset.sentence || "");
    });
    ui.wordClose.addEventListener("click", closeWordDialog);
    ui.wordOverlay.addEventListener("click", (event) => {
      if (event.target === ui.wordOverlay) closeWordDialog();
    });
    ui.close.addEventListener("click", () => {
      requestSequence += 1;
      cancelCaptionCollection();
      closeWordDialog();
      ui.panel.hidden = true;
    });
    installDragBehavior(player);
  }

  function installDragBehavior(player) {
    let drag = null;

    ui.header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) {
        return;
      }
      const panelRect = ui.panel.getBoundingClientRect();
      const playerRect = player.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - panelRect.left,
        offsetY: event.clientY - panelRect.top,
        playerRect
      };
      ui.panel.style.right = "auto";
      ui.header.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    ui.header.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      const width = ui.panel.offsetWidth;
      const height = ui.panel.offsetHeight;
      const maxLeft = Math.max(0, drag.playerRect.width - width);
      const maxTop = Math.max(0, drag.playerRect.height - height);
      const left = Math.min(maxLeft, Math.max(0, event.clientX - drag.playerRect.left - drag.offsetX));
      const top = Math.min(maxTop, Math.max(0, event.clientY - drag.playerRect.top - drag.offsetY));
      ui.panel.style.left = `${left}px`;
      ui.panel.style.top = `${top}px`;
    });

    const endDrag = (event) => {
      if (drag && event.pointerId === drag.pointerId) {
        drag = null;
      }
    };
    ui.header.addEventListener("pointerup", endDrag);
    ui.header.addEventListener("pointercancel", endDrag);
  }

  function showNotice(message = "") {
    ui.notice.hidden = !message;
    ui.notice.textContent = message;
  }

  function setRetryAction(action = "translate") {
    retryAction = action;
    ui.retry.textContent = action === "reload" ? "刷新页面" : "再试一次";
  }

  function userFacingError(error, fallback) {
    const message = String(error?.message || error || fallback);
    const extensionWasReloaded = /extension context invalidated/i.test(message) || !chrome.runtime?.id;
    if (extensionWasReloaded) {
      return {
        message: "扩展刚刚被重新加载。请刷新当前 YouTube 页面后再使用。",
        reloadRequired: true
      };
    }
    return { message, reloadRequired: false };
  }

  function showCollecting(original) {
    setRetryAction();
    ui.panel.hidden = false;
    ui.status.hidden = false;
    ui.status.classList.remove("error");
    ui.spinner.hidden = false;
    ui.statusText.textContent = "正在读取完整字幕…";
    ui.result.hidden = false;
    renderClickableCaption(original);
    ui.translation.textContent = "";
    showNotice();
    ui.retry.hidden = true;
  }

  function updateCollectingPreview(original) {
    if (!ui || !original) return;
    renderClickableCaption(original);
  }

  function showLoading(original, notice = "") {
    setRetryAction();
    ui.panel.hidden = false;
    ui.status.hidden = false;
    ui.status.classList.remove("error");
    ui.spinner.hidden = false;
    ui.statusText.textContent = "正在翻译…";
    ui.result.hidden = false;
    renderClickableCaption(original);
    ui.translation.textContent = "";
    showNotice(notice);
    ui.retry.hidden = true;
  }

  function showError(message, original = "", notice = "", { reloadRequired = false } = {}) {
    setRetryAction(reloadRequired ? "reload" : "translate");
    ui.panel.hidden = false;
    ui.status.hidden = false;
    ui.status.classList.add("error");
    ui.spinner.hidden = true;
    ui.statusText.textContent = message;
    ui.result.hidden = !original;
    renderClickableCaption(original);
    ui.translation.textContent = "";
    showNotice(notice);
    ui.retry.hidden = !reloadRequired && !original;
  }

  function showResult(original, data, notice = "") {
    setRetryAction();
    ui.panel.hidden = false;
    ui.status.hidden = true;
    ui.result.hidden = false;
    renderClickableCaption(original);
    ui.translation.textContent = data.translation;
    showNotice(notice);
    ui.retry.hidden = false;
  }

  function renderClickableCaption(text) {
    ui.original.replaceChildren();
    ui.original.dataset.sentence = text;
    const parts = text.match(/[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*|[^\p{L}\p{M}]+/gu) || [text];
    for (const part of parts) {
      if (/^[\p{L}\p{M}]/u.test(part)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "word";
        button.dataset.word = part;
        button.textContent = part;
        button.title = `查看 ${part} 的详细解释`;
        ui.original.appendChild(button);
      } else {
        ui.original.appendChild(document.createTextNode(part));
      }
    }
  }

  function closeWordDialog() {
    wordRequestSequence += 1;
    ui.wordOverlay.hidden = true;
  }

  async function explainWord(word, sentence) {
    const sequence = ++wordRequestSequence;
    ui.wordOverlay.hidden = false;
    ui.wordTitle.textContent = word;
    ui.pronunciation.textContent = "";
    ui.wordStatus.hidden = false;
    ui.wordStatus.classList.remove("error");
    ui.wordStatus.innerHTML = '<span class="spinner"></span><span>正在查询单词…</span>';
    ui.wordContent.hidden = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "explain-word",
        payload: { word, sentence }
      });
      if (sequence !== wordRequestSequence) return;
      if (!response?.ok) throw new Error(response?.error || "单词解释查询失败，请稍后再试。");
      ui.wordTitle.textContent = response.data.word || word;
      ui.pronunciation.textContent = response.data.pronunciation || "";
      ui.wordMeaning.textContent = response.data.meaning;
      ui.wordDetails.textContent = response.data.details;
      ui.wordStatus.hidden = true;
      ui.wordContent.hidden = false;
    } catch (error) {
      if (sequence !== wordRequestSequence) return;
      const visibleError = userFacingError(error, "单词解释查询失败，请稍后再试。");
      ui.wordStatus.classList.add("error");
      ui.wordStatus.textContent = visibleError.message;
    }
  }

  function cancelCaptionCollection() {
    const collection = activeCollection;
    if (!collection) return;
    activeCollection = null;
    clearTimeout(collection.timer);
    collection.resolve("");
  }

  function collectCompleteCaption(initialText, currentSnapshot, sequence) {
    cancelCaptionCollection();
    const initial = normalizeText(initialText);
    const startedAt = performance.now();
    const buffer = new CaptionSentenceAssembler.SentenceBuffer(initial, currentSnapshot);

    return new Promise((resolve) => {
      const collection = {
        buffer,
        text: initial,
        startedAt,
        lastChangedAt: startedAt,
        blankSince: null,
        timer: null,
        resolve,
        acceptSnapshot: null
      };

      const finish = (text) => {
        if (activeCollection !== collection) return;
        activeCollection = null;
        clearTimeout(collection.timer);
        resolve(normalizeText(text));
      };

      const checkCompletion = () => {
        if (sequence !== requestSequence) {
          finish("");
          return;
        }
        const delay = CaptionSentenceAssembler.captionCompletionDelay(collection.text, {
          now: performance.now(),
          lastChangedAt: collection.lastChangedAt,
          blankSince: collection.blankSince,
          startedAt: collection.startedAt,
          sentenceEndSettleMs: SENTENCE_END_SETTLE_MS,
          blankSettleMs: BLANK_CAPTION_SETTLE_MS,
          maxCollectionMs: MAX_COLLECTION_MS
        });
        if (delay === 0) {
          finish(collection.text);
          return;
        }
        collection.timer = setTimeout(checkCompletion, delay);
      };

      collection.acceptSnapshot = (snapshot) => {
        if (sequence !== requestSequence) {
          finish("");
          return;
        }
        const snapshotText = normalizeText(snapshot);
        if (!snapshotText) {
          if (collection.blankSince == null) collection.blankSince = performance.now();
          collection.buffer.push("");
          clearTimeout(collection.timer);
          checkCompletion();
          return;
        }
        collection.blankSince = null;
        const update = collection.buffer.push(snapshotText);
        if (update.completed.length > 0) {
          finish(update.completed[update.completed.length - 1]);
          return;
        }
        if (update.changed && update.active) {
          collection.text = update.active;
          collection.lastChangedAt = performance.now();
          updateCollectingPreview(collection.text);
        }
        clearTimeout(collection.timer);
        checkCompletion();
      };

      activeCollection = collection;
      checkCompletion();
    });
  }

  function currentVideo() {
    return document.querySelector("#movie_player video.html5-main-video, #movie_player video");
  }

  function pauseCurrentVideo(video = currentVideo()) {
    if (!video) {
      return "未找到当前视频，无法自动暂停；翻译仍会继续。";
    }
    try {
      if (!video.paused) {
        video.pause();
      }
      if (!video.paused) {
        return "视频未能自动暂停；翻译仍会继续。";
      }
    } catch {
      return "视频未能自动暂停；翻译仍会继续。";
    }
    return "";
  }

  async function translateCurrentCaption({ forceRefresh = false } = {}) {
    const startedAt = performance.now();
    const sequence = ++requestSequence;
    cancelCaptionCollection();
    if (!isWatchPage()) {
      showError("请先打开一个 YouTube 视频播放页。");
      return;
    }

    const current = readVisibleCaption();
    if (!current) {
      showError("没有检测到当前字幕。请先开启 YouTube 字幕后再试。");
      return;
    }

    const visibleCompleteSentence = CaptionSentenceAssembler.latestCompleteSentence(current);
    const trackerUpdate = captionTracker.push(current);
    boundTrackedCaption();
    for (const completed of trackerUpdate.completed) {
      rememberCompletedCaption(completed);
    }
    const initial = visibleCompleteSentence || captionTracker.activeText || trackerUpdate.active || current;
    showCollecting(initial);

    const video = currentVideo();
    const fallbackCaptionPromise = visibleCompleteSentence
      ? Promise.resolve(visibleCompleteSentence)
      : video?.paused
      ? Promise.resolve(normalizeText(initial))
      : collectCompleteCaption(initial, current, sequence);
    const timelineCaption = visibleCompleteSentence
      ? null
      : await requestTimelineCaption(
        current,
        Number.isFinite(video?.currentTime) ? video.currentTime * 1000 : NaN
      );
    let collected;
    if (visibleCompleteSentence) {
      collected = visibleCompleteSentence;
    } else if (timelineCaption?.text) {
      cancelCaptionCollection();
      collected = timelineCaption.text;
      updateCollectingPreview(timelineCaption.text);
    } else {
      ui.statusText.textContent = "正在继续收集后续字幕，直到当前句结束…";
      collected = await fallbackCaptionPromise;
    }
    if (sequence !== requestSequence || !collected) {
      return;
    }
    const captionReadyAt = performance.now();
    const captionSource = visibleCompleteSentence
      ? "visible-complete"
      : timelineCaption?.text
        ? "timeline"
        : "screen";

    const context = contextFor(collected);
    rememberCompletedCaption(collected);
    const pauseNotice = pauseCurrentVideo(video);
    const cacheKey = translationCacheKey(collected, context);
    const cached = forceRefresh ? null : readCachedTranslation(cacheKey);
    if (cached) {
      showResult(collected, cached, pauseNotice);
      reportTranslationTiming({ startedAt, captionReadyAt, requestStartedAt: null, captionSource, cacheHit: true, ok: true });
      return;
    }
    showLoading(collected, pauseNotice);
    const requestStartedAt = performance.now();

    try {
      const response = await chrome.runtime.sendMessage({
        type: "translate-caption",
        payload: {
          text: collected,
          context,
          targetLanguage: "zh-CN"
        }
      });
      if (sequence !== requestSequence) {
        return;
      }
      if (!response?.ok) {
        throw new Error(response?.error || "翻译失败，请稍后再试。");
      }
      rememberTranslation(cacheKey, response.data);
      showResult(collected, response.data, pauseNotice);
      reportTranslationTiming({ startedAt, captionReadyAt, requestStartedAt, captionSource, cacheHit: false, ok: true });
    } catch (error) {
      if (sequence === requestSequence) {
        const visibleError = userFacingError(error, "翻译失败，请稍后再试。");
        showError(visibleError.message, collected, pauseNotice, visibleError);
        reportTranslationTiming({ startedAt, captionReadyAt, requestStartedAt, captionSource, cacheHit: false, ok: false });
      }
    }
  }

  function ensureUi() {
    if (!isWatchPage()) {
      if (uiHost || activeCollection) {
        requestSequence += 1;
        cancelCaptionCollection();
      }
      if (uiHost) {
        uiHost.remove();
        uiHost = null;
        ui = null;
      }
      return;
    }

    const player = document.querySelector("#movie_player");
    if (!player) {
      return;
    }
    if (!uiHost || !uiHost.isConnected || uiHost.parentElement !== player) {
      uiHost?.remove();
      createUi(player);
    }
  }

  const observer = new MutationObserver(() => {
    ensureUi();
    scheduleCaptionScan();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  document.addEventListener("yt-navigate-finish", () => {
    completedCaptions.length = 0;
    translationCache.clear();
    captionTracker.reset();
    lastTrackedCaption = "";
    lastCaptionChangeAt = performance.now();
    captionBlankSince = null;
    timelinePrefetchedVideoId = "";
    requestSequence += 1;
    cancelCaptionCollection();
    ensureUi();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "translate-current-caption") {
      ensureUi();
      translateCurrentCaption();
    }
  });

  ensureUi();
  scheduleCaptionScan();
})();
