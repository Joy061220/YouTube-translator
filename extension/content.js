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
  const TIMELINE_CAPTION_TIMEOUT_MS = 2500;
  const MAX_TRANSLATION_CACHE = 64;
  const MAX_TRACKED_CAPTION_CHARS = 2000;
  const TIMELINE_CHANNEL = "youtube-caption-translator-timeline-v1";
  const BACKGROUND_OPACITY_KEY = "translationBackgroundOpacity";
  const TEXT_OPACITY_KEY = "translationTextOpacity";
  const TEXT_COLOR_KEY = "translationTextColor";
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
  let captionHistoryDiscarded = false;
  let timelinePrefetchedVideoId = "";
  let retryAction = "translate";
  let lastTranslatedCaption = "";
  let lastTranslatedVideoId = "";
  let lastTranslatedRawBlankSince = null;
  let observedVideo = null;
  let backgroundOpacity = CaptionDisplaySettings.DEFAULT_BACKGROUND_OPACITY;
  let backgroundOpacityRevision = 0;
  let textOpacity = CaptionDisplaySettings.DEFAULT_TEXT_OPACITY;
  let textOpacityRevision = 0;
  let textColor = CaptionDisplaySettings.DEFAULT_TEXT_COLOR;
  let textColorRevision = 0;

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
      event.data?.channel !== TIMELINE_CHANNEL
    ) {
      return;
    }
    if (event.data.type === "caption-track-changed") {
      resetCaptionState();
      scheduleCaptionScan();
      return;
    }
    if (event.data.type !== "timeline-caption-response") return;
    const pending = pendingTimelineRequests.get(event.data.requestId);
    if (!pending) return;
    pendingTimelineRequests.delete(event.data.requestId);
    clearTimeout(pending.timer);
    pending.resolve(event.data.ok ? event.data.data : null);
  });

  async function requestTimelineCaption(currentText, currentTimeMs, visibleText = currentText, timeoutMs = TIMELINE_CAPTION_TIMEOUT_MS) {
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
        payload: { currentText, currentTimeMs, visibleText }
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
    return (
      (location.hostname === "www.youtube.com" && location.pathname === "/watch") ||
      window.__youtubeCaptionTranslatorTestWatchPage === true
    );
  }

  function readVisibleCaption() {
    return CaptionSourceReader.readVisibleCaption(document.querySelector("#movie_player"));
  }

  function isSafeCaption(text) {
    return typeof text === "string" && Boolean(normalizeText(text)) && text.length <= MAX_TRACKED_CAPTION_CHARS &&
      !CaptionSentenceAssembler.hasCaptionArtifacts(text);
  }

  function clearLastTranslatedCaption() {
    lastTranslatedCaption = "";
    lastTranslatedVideoId = "";
    lastTranslatedRawBlankSince = null;
  }

  function resetCaptionState() {
    requestSequence += 1;
    wordRequestSequence += 1;
    cancelCaptionCollection();
    for (const pending of pendingTimelineRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    pendingTimelineRequests.clear();
    completedCaptions.length = 0;
    captionTracker.reset();
    lastTrackedCaption = "";
    lastCaptionChangeAt = performance.now();
    captionBlankSince = null;
    captionHistoryDiscarded = false;
    timelinePrefetchedVideoId = "";
    clearLastTranslatedCaption();
    if (ui) {
      ui.panel.hidden = true;
      closeWordDialog();
    }
  }

  function captionAfterLastTranslation(caption, { forceRefresh = false } = {}) {
    const current = normalizeText(caption);
    if (forceRefresh || !lastTranslatedCaption) return current;
    if (lastTranslatedVideoId !== currentVideoId()) {
      clearLastTranslatedCaption();
      return current;
    }
    if (!current) {
      if (lastTranslatedRawBlankSince == null) lastTranslatedRawBlankSince = performance.now();
      return "";
    }
    if (
      lastTranslatedRawBlankSince != null &&
      performance.now() - lastTranslatedRawBlankSince >= CAPTION_BREAK_MS
    ) {
      clearLastTranslatedCaption();
      return current;
    }
    lastTranslatedRawBlankSince = null;
    const remaining = CaptionSentenceAssembler.textAfterCompletedSentence(lastTranslatedCaption, current);
    if (remaining === current) {
      clearLastTranslatedCaption();
    }
    return remaining;
  }

  function markCaptionTranslated(caption) {
    lastTranslatedCaption = normalizeText(caption);
    lastTranslatedVideoId = currentVideoId();
    lastTranslatedRawBlankSince = null;
    captionTracker.reset();
    lastTrackedCaption = "";
    captionBlankSince = null;
    captionHistoryDiscarded = false;
  }

  function rememberCompletedCaption(caption) {
    if (!isSafeCaption(caption) || completedCaptions[completedCaptions.length - 1] === caption) {
      return;
    }
    completedCaptions.push(caption);
    if (completedCaptions.length > MAX_HISTORY) {
      completedCaptions.shift();
    }
  }

  function boundTrackedCaption(snapshot = lastTrackedCaption) {
    const text = normalizeText(captionTracker.activeText);
    if (!text || isSafeCaption(text)) return;
    captionHistoryDiscarded = true;
    captionTracker.reset();
    if (isSafeCaption(snapshot)) captionTracker.push(snapshot);
  }

  function scanCaption() {
    scanScheduled = false;
    if (currentVideo()?.seeking) return;
    const caption = captionAfterLastTranslation(readVisibleCaption());
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
      if (!isSafeCaption(caption)) return false;
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

  function applyBackgroundOpacity(value) {
    backgroundOpacity = CaptionDisplaySettings.normalizeBackgroundOpacity(value);
    if (!ui) return;
    ui.panel.style.setProperty(
      "--translation-background-opacity",
      String(CaptionDisplaySettings.backgroundOpacityFraction(backgroundOpacity))
    );
    ui.backgroundOpacitySlider.value = String(backgroundOpacity);
    ui.backgroundOpacityValue.textContent = `${backgroundOpacity}%`;
  }

  function applyTextOpacity(value) {
    textOpacity = CaptionDisplaySettings.normalizeTextOpacity(value);
    if (!ui) return;
    ui.panel.style.setProperty(
      "--translation-text-opacity",
      String(CaptionDisplaySettings.textOpacityFraction(textOpacity))
    );
    ui.textOpacitySlider.value = String(textOpacity);
    ui.textOpacityValue.textContent = `${textOpacity}%`;
  }

  function applyTextColor(value) {
    textColor = CaptionDisplaySettings.normalizeTextColor(value);
    if (!ui) return;
    ui.panel.style.setProperty("--translation-text-color", textColor);
    for (const option of ui.textColorOptions) {
      const selected = option.dataset.color === textColor;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-checked", String(selected));
    }
  }

  function persistDisplaySetting(key, value) {
    try {
      const result = chrome.storage?.local?.set?.({ [key]: value });
      result?.catch?.(() => {});
    } catch {
      // The setting still applies to this page if the extension was reloaded mid-session.
    }
  }

  function saveBackgroundOpacity(value) {
    backgroundOpacityRevision += 1;
    applyBackgroundOpacity(value);
    persistDisplaySetting(BACKGROUND_OPACITY_KEY, backgroundOpacity);
  }

  function saveTextOpacity(value) {
    textOpacityRevision += 1;
    applyTextOpacity(value);
    persistDisplaySetting(TEXT_OPACITY_KEY, textOpacity);
  }

  function saveTextColor(value) {
    textColorRevision += 1;
    applyTextColor(value);
    persistDisplaySetting(TEXT_COLOR_KEY, textColor);
  }

  async function loadDisplaySettings() {
    const revisionsAtStart = {
      backgroundOpacity: backgroundOpacityRevision,
      textOpacity: textOpacityRevision,
      textColor: textColorRevision
    };
    try {
      const stored = await chrome.storage?.local?.get?.([
        BACKGROUND_OPACITY_KEY,
        TEXT_OPACITY_KEY,
        TEXT_COLOR_KEY
      ]);
      if (
        backgroundOpacityRevision === revisionsAtStart.backgroundOpacity &&
        stored?.[BACKGROUND_OPACITY_KEY] != null
      ) {
        applyBackgroundOpacity(stored[BACKGROUND_OPACITY_KEY]);
      }
      if (textOpacityRevision === revisionsAtStart.textOpacity && stored?.[TEXT_OPACITY_KEY] != null) {
        applyTextOpacity(stored[TEXT_OPACITY_KEY]);
      }
      if (textColorRevision === revisionsAtStart.textColor && stored?.[TEXT_COLOR_KEY] != null) {
        applyTextColor(stored[TEXT_COLOR_KEY]);
      }
    } catch {
      // Keep the current defaults when storage is unavailable.
    }
  }

  function setSettingsOpen(open) {
    if (!ui) return;
    ui.settingsPanel.hidden = !open;
    ui.settingsButton.setAttribute("aria-expanded", String(open));
    ui.settingsButton.setAttribute("aria-label", open ? "关闭翻译显示设置" : "打开翻译显示设置");
    if (open) ui.settingsClose.focus();
  }

  function createUi(player) {
    uiHost = document.createElement("div");
    uiHost.id = UI_HOST_ID;
    uiHost.setAttribute("aria-hidden", "false");
    player.appendChild(uiHost);

    const shadow = uiHost.attachShadow({ mode: "open" });
    const colorOptionsMarkup = CaptionDisplaySettings.TEXT_COLOR_PRESETS.map((preset) => `
      <button class="color-option" type="button" role="radio" aria-checked="false"
        aria-label="${preset.label}" title="${preset.label}" data-color="${preset.value}"
        style="--swatch-color: ${preset.value}"><span></span></button>`).join("");
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
        .settings-button {
          position: absolute; top: 12px; right: 12px; z-index: 4; display: grid; place-items: center;
          width: 36px; height: 36px; border: 1px solid rgba(255,255,255,.32); border-radius: 10px;
          color: #fff; background: rgba(15,18,24,.86); box-shadow: 0 5px 18px rgba(0,0,0,.35);
          cursor: pointer; pointer-events: auto; font-family: "Segoe UI Symbol", Arial, sans-serif; font-size: 20px; line-height: 1;
          transition: background .15s ease, transform .15s ease;
        }
        .settings-button:hover, .settings-button[aria-expanded="true"] { background: #1677ff; transform: scale(1.05); }
        .translate-button:focus-visible, .settings-button:focus-visible, .icon-button:focus-visible, .retry:focus-visible, .word:focus-visible, .setting-slider:focus-visible, .color-option:focus-visible { outline: 3px solid #7db5ff; outline-offset: 2px; }
        .panel {
          position: absolute; top: 16px; right: 56px; z-index: 1; width: min(380px, calc(100% - 72px)); max-height: calc(100% - 32px);
          overflow: auto; border: 1px solid rgba(255,255,255,.16); border-radius: 14px; color: #f7f8fa;
          background: rgba(17,20,27,var(--translation-background-opacity, .96)); box-shadow: 0 16px 45px rgba(0,0,0,.45); pointer-events: auto;
        }
        .panel[hidden] { display: none; }
        .header { display: flex; align-items: center; justify-content: space-between; min-height: 46px; padding: 0 10px 0 15px; border-bottom: 1px solid rgba(255,255,255,.1); cursor: grab; user-select: none; }
        .header:active { cursor: grabbing; }
        .title { font-size: 14px; font-weight: 700; letter-spacing: .02em; }
        .icon-button { width: 32px; height: 32px; border: 0; border-radius: 8px; color: #d7dae0; background: transparent; cursor: pointer; font-size: 22px; line-height: 1; }
        .icon-button:hover { background: rgba(255,255,255,.1); }
        .settings-panel {
          position: absolute; top: 56px; right: 12px; z-index: 3; width: min(310px, calc(100% - 24px)); max-height: calc(100% - 68px);
          overflow: auto; border: 1px solid rgba(255,255,255,.18); border-radius: 14px; color: #f7f8fa;
          background: rgba(17,20,27,.98); box-shadow: 0 16px 45px rgba(0,0,0,.5); pointer-events: auto;
        }
        .settings-panel[hidden] { display: none; }
        .settings-header { display: flex; align-items: center; justify-content: space-between; min-height: 45px; padding: 0 9px 0 14px; border-bottom: 1px solid rgba(255,255,255,.1); }
        .settings-title { font-size: 14px; font-weight: 700; }
        .settings-body { padding: 13px 14px 15px; }
        .setting-group + .setting-group { margin-top: 14px; padding-top: 13px; border-top: 1px solid rgba(255,255,255,.1); }
        .setting-label-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 7px; color: #e7e9ed; font-size: 12px; }
        .setting-value { min-width: 34px; color: #aeb6c3; font-variant-numeric: tabular-nums; text-align: right; }
        .setting-slider { display: block; width: 100%; height: 24px; margin: 0; accent-color: #62a2ff; cursor: pointer; }
        .setting-hint { margin: 5px 0 0; color: #89919e; font-size: 11px; line-height: 1.4; }
        .color-options { display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px; }
        .color-option { display: grid; place-items: center; aspect-ratio: 1; padding: 3px; border: 2px solid transparent; border-radius: 999px; background: transparent; cursor: pointer; }
        .color-option span { width: 100%; height: 100%; border: 1px solid rgba(0,0,0,.28); border-radius: inherit; background: var(--swatch-color); box-shadow: 0 1px 5px rgba(0,0,0,.3); }
        .color-option:hover { background: rgba(255,255,255,.1); }
        .color-option.selected { border-color: #62a2ff; background: rgba(98,162,255,.16); }
        .body { padding: 14px 15px 16px; }
        .status { display: flex; align-items: center; gap: 9px; color: #c8ccd4; font-size: 13px; }
        .status.error { color: #ffb4b4; line-height: 1.55; }
        .spinner { width: 16px; height: 16px; flex: 0 0 auto; border: 2px solid rgba(255,255,255,.25); border-top-color: #62a2ff; border-radius: 50%; animation: spin .8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .result[hidden], .status[hidden] { display: none; }
        .section + .section { margin-top: 14px; padding-top: 13px; border-top: 1px solid rgba(255,255,255,.09); }
        .label { margin-bottom: 6px; color: #9fa6b2; font-size: 11px; font-weight: 700; letter-spacing: .08em; }
        .text { margin: 0; color: var(--translation-text-color, #fff); opacity: var(--translation-text-opacity, 1); font-size: 15px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
        .translation { font-size: 18px; }
        .original { line-height: 1.9; }
        .notice { margin: 0 0 11px; padding: 8px 10px; border-radius: 8px; color: #ffd9a1; background: rgba(179,104,0,.22); font-size: 12px; line-height: 1.5; }
        .notice[hidden] { display: none; }
        .word { display: inline; padding: 2px 1px; border: 0; border-radius: 4px; color: inherit; background: transparent; cursor: pointer; text-decoration: underline dotted rgba(255,255,255,.45); text-underline-offset: 3px; }
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
          .settings-button { top: 8px; right: 8px; width: 32px; height: 32px; font-size: 18px; }
          .panel { top: 8px; right: 48px; width: min(340px, calc(100% - 56px)); max-height: calc(100% - 16px); }
          .settings-panel { top: 48px; right: 8px; width: min(300px, calc(100% - 16px)); max-height: calc(100% - 56px); }
          .body { padding: 10px 12px 12px; }
        }
      </style>
      <button class="translate-button" type="button" title="翻译当前字幕（Alt+Shift+T）" aria-label="翻译当前字幕">译</button>
      <button class="settings-button" type="button" title="翻译显示设置" aria-label="打开翻译显示设置" aria-expanded="false" aria-controls="translation-display-settings">⚙</button>
      <section class="settings-panel" id="translation-display-settings" role="dialog" aria-label="翻译显示设置" hidden>
        <div class="settings-header">
          <span class="settings-title">显示设置</span>
          <button class="icon-button settings-close" type="button" aria-label="关闭设置">×</button>
        </div>
        <div class="settings-body">
          <div class="setting-group">
            <div class="setting-label-row"><label for="background-opacity">背景不透明度</label><output class="background-opacity-value setting-value">96%</output></div>
            <input class="background-opacity-slider setting-slider" id="background-opacity" type="range" min="0" max="100" step="1">
            <p class="setting-hint">数值越低，翻译浮窗背景越透明。</p>
          </div>
          <div class="setting-group">
            <div class="setting-label-row"><label for="text-opacity">字体不透明度</label><output class="text-opacity-value setting-value">100%</output></div>
            <input class="text-opacity-slider setting-slider" id="text-opacity" type="range" min="0" max="100" step="1">
            <p class="setting-hint">只影响翻译浮窗中的原文和中文正文。</p>
          </div>
          <div class="setting-group">
            <div class="setting-label-row"><span id="text-color-label">字体颜色</span></div>
            <div class="color-options" role="radiogroup" aria-labelledby="text-color-label">${colorOptionsMarkup}</div>
          </div>
        </div>
      </section>
      <section class="panel" role="dialog" aria-label="字幕翻译" hidden>
        <div class="header">
          <span class="title">字幕翻译</span>
          <button class="icon-button close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="body">
          <div class="status"><span class="spinner"></span><span class="status-text">正在翻译…</span></div>
          <div class="result" hidden>
            <p class="notice" hidden></p>
            <div class="section"><div class="label">原文</div><p class="text original"></p><p class="word-hint">点击原文中的单词查看详细解释</p></div>
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
      settingsButton: shadow.querySelector(".settings-button"),
      settingsPanel: shadow.querySelector(".settings-panel"),
      settingsClose: shadow.querySelector(".settings-close"),
      panel: shadow.querySelector(".panel"),
      header: shadow.querySelector(".header"),
      close: shadow.querySelector(".close"),
      backgroundOpacitySlider: shadow.querySelector(".background-opacity-slider"),
      backgroundOpacityValue: shadow.querySelector(".background-opacity-value"),
      textOpacitySlider: shadow.querySelector(".text-opacity-slider"),
      textOpacityValue: shadow.querySelector(".text-opacity-value"),
      textColorOptions: [...shadow.querySelectorAll(".color-option")],
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

    applyBackgroundOpacity(backgroundOpacity);
    applyTextOpacity(textOpacity);
    applyTextColor(textColor);

    ui.button.addEventListener("click", () => translateCurrentCaption());
    ui.settingsButton.addEventListener("click", () => setSettingsOpen(ui.settingsPanel.hidden));
    ui.settingsClose.addEventListener("click", () => {
      setSettingsOpen(false);
      ui.settingsButton.focus();
    });
    ui.backgroundOpacitySlider.addEventListener("input", (event) => saveBackgroundOpacity(event.currentTarget.value));
    ui.textOpacitySlider.addEventListener("input", (event) => saveTextOpacity(event.currentTarget.value));
    for (const option of ui.textColorOptions) {
      option.addEventListener("click", () => saveTextColor(option.dataset.color));
    }
    shadow.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !ui.settingsPanel.hidden) {
        setSettingsOpen(false);
        ui.settingsButton.focus();
      }
    });
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
      if (event.button !== 0 || event.target.closest("button, input, label")) {
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
    text = isSafeCaption(text) ? text : "";
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
      collection.finish = () => finish(collection.text);

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
          // Completions are chronological. Keep the sentence selected at the
          // click even when one screen update also includes later sentences.
          finish(update.completed[0]);
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
    ensureUi();
    const startedAt = performance.now();
    const sequence = ++requestSequence;
    cancelCaptionCollection();
    if (!isWatchPage()) {
      showError("请先打开一个 YouTube 视频播放页。");
      return;
    }

    const video = currentVideo();
    const clickedTimeMs = Number.isFinite(video?.currentTime) ? video.currentTime * 1000 : NaN;
    if (video?.seeking) {
      showError("正在跳转视频，请在字幕更新后再试。");
      return;
    }

    const current = captionAfterLastTranslation(readVisibleCaption(), { forceRefresh });
    if (!current) {
      showError(
        lastTranslatedCaption
          ? "当前画面仍是刚翻译过的字幕。请继续播放到下一句后再试。"
          : "没有检测到当前字幕。请先开启 YouTube 字幕后再试。"
      );
      return;
    }

    const trackerUpdate = captionTracker.push(current);
    boundTrackedCaption(current);
    for (const completed of trackerUpdate.completed) {
      rememberCompletedCaption(completed);
    }
    const initial = CaptionSentenceAssembler.selectActiveSentence(current, captionHistoryDiscarded ? "" : captionTracker.activeText);
    if (!isSafeCaption(initial)) {
      showError("检测到异常字幕内容，请等画面字幕更新后再试。");
      return;
    }
    let recoveredCaption = captionHistoryDiscarded;
    showCollecting(initial);

    const fallbackCaptionPromise = video?.paused
      ? Promise.resolve(normalizeText(initial))
      : collectCompleteCaption(initial, current, sequence);
    const timelineCaption = await requestTimelineCaption(initial, clickedTimeMs, current);
    if (sequence !== requestSequence) return;
    let collected;
    const hasTimelineCaption = isSafeCaption(timelineCaption?.text || "");
    if (hasTimelineCaption) {
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
    if (!isSafeCaption(collected)) {
      collected = CaptionSentenceAssembler.selectActiveSentence(readVisibleCaption());
      recoveredCaption = true;
      captionTracker.reset();
      if (!isSafeCaption(collected)) {
        showError("检测到异常字幕内容，请等画面字幕更新后再试。");
        return;
      }
    }
    const captionReadyAt = performance.now();
    const captionSource = hasTimelineCaption ? "timeline" : "screen";

    const context = contextFor(collected);
    rememberCompletedCaption(collected);
    const partialNotice = !hasTimelineCaption && recoveredCaption
      ? "检测到异常字幕历史，已改用当前画面字幕片段。可继续播放后重试。"
      : !hasTimelineCaption && !CaptionSentenceAssembler.endsSentence(collected)
        ? "未能确认完整句，当前翻译的是已收集的字幕片段。可继续播放后重试。"
        : "";
    const pauseNotice = [pauseCurrentVideo(video), partialNotice].filter(Boolean).join(" ");
    const cacheKey = translationCacheKey(collected, context);
    const cached = forceRefresh ? null : readCachedTranslation(cacheKey);
    if (cached) {
      markCaptionTranslated(collected);
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
      markCaptionTranslated(collected);
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
    const video = currentVideo();
    if (video !== observedVideo) {
      observedVideo = video;
      resetCaptionState();
    }
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
    resetCaptionState();
    translationCache.clear();
    ensureUi();
    scheduleCaptionScan();
  });

  for (const eventName of ["seeking", "emptied"]) {
    document.addEventListener(eventName, (event) => {
      if (event.target === currentVideo()) resetCaptionState();
    }, true);
  }
  document.addEventListener("seeked", (event) => {
    if (event.target === currentVideo()) scheduleCaptionScan();
  }, true);
  document.addEventListener("pause", (event) => {
    if (event.target === currentVideo()) activeCollection?.finish();
  }, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "translate-current-caption") {
      ensureUi();
      translateCurrentCaption();
    }
  });

  chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local") return;
    const backgroundChange = changes?.[BACKGROUND_OPACITY_KEY];
    const textOpacityChange = changes?.[TEXT_OPACITY_KEY];
    const textColorChange = changes?.[TEXT_COLOR_KEY];
    if (backgroundChange?.newValue != null) applyBackgroundOpacity(backgroundChange.newValue);
    if (textOpacityChange?.newValue != null) applyTextOpacity(textOpacityChange.newValue);
    if (textColorChange?.newValue != null) applyTextColor(textColorChange.newValue);
  });

  loadDisplaySettings();
  ensureUi();
  scheduleCaptionScan();
})();
