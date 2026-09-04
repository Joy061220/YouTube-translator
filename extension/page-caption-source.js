(function (root) {
  "use strict";

  const CHANNEL = "youtube-caption-translator-timeline-v1";
  const REQUEST_TYPE = "request-timeline-caption";
  const PREFETCH_TYPE = "prefetch-timeline-caption";
  const RESPONSE_TYPE = "timeline-caption-response";
  const SENTENCE_END_RE = /[.!?。！？…][.!?。！？…]*["'”’）)\]}]*$/u;
  const WORD_RE = /[\u3040-\u30ff\u3400-\u9fff]|[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;
  const MAX_FOCUS_DISTANCE_MS = 20000;
  const MAX_BOUNDARY_SEARCH_MS = 90000;
  const MAX_CUE_GAP_MS = 15000;
  const trackCache = new Map();

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function comparable(value) {
    return normalizeText(value).toLocaleLowerCase();
  }

  function tokens(value) {
    return Array.from(normalizeText(value).matchAll(WORD_RE), (match) => ({
      key: match[0].toLocaleLowerCase(),
      start: match.index,
      end: match.index + match[0].length
    }));
  }

  function joinText(leftValue, rightValue) {
    const left = normalizeText(leftValue);
    const right = normalizeText(rightValue);
    if (!left) return right;
    if (!right) return left;
    if (
      /^[,.;:!?，。；：！？…%）)\]}”’]/u.test(right) ||
      /[（([\{“‘]$/u.test(left) ||
      (/^[\u3040-\u30ff\u3400-\u9fff]/u.test(right) && /[\u3040-\u30ff\u3400-\u9fff]$/u.test(left))
    ) {
      return `${left}${right}`;
    }
    return `${left} ${right}`;
  }

  function mergeCaptionText(leftValue, rightValue) {
    const left = normalizeText(leftValue);
    const right = normalizeText(rightValue);
    if (!left) return right;
    if (!right) return left;
    const leftKey = comparable(left);
    const rightKey = comparable(right);
    if (leftKey === rightKey || leftKey.includes(rightKey)) return left;
    if (rightKey.includes(leftKey)) return right;

    const leftTokens = tokens(left);
    const rightTokens = tokens(right);
    const maximum = Math.min(leftTokens.length, rightTokens.length);
    for (let size = maximum; size >= 1; size -= 1) {
      if (size === 1 && rightTokens[0].key.length < 2) continue;
      let matches = true;
      for (let index = 0; index < size; index += 1) {
        if (leftTokens[leftTokens.length - size + index].key !== rightTokens[index].key) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return joinText(left, right.slice(rightTokens[size - 1].end));
      }
    }
    return joinText(left, right);
  }

  function similarityScore(leftValue, rightValue) {
    const left = comparable(leftValue);
    const right = comparable(rightValue);
    if (!left || !right) return 0;
    if (left.includes(right) || right.includes(left)) return 1;
    const leftSet = new Set(tokens(left).map((item) => item.key));
    const rightSet = new Set(tokens(right).map((item) => item.key));
    if (!leftSet.size || !rightSet.size) return 0;
    let overlap = 0;
    for (const token of leftSet) {
      if (rightSet.has(token)) overlap += 1;
    }
    return overlap / Math.min(leftSet.size, rightSet.size);
  }

  function parseAssignedJson(rawValue, marker = "var ytInitialPlayerResponse = ") {
    const raw = String(rawValue || "");
    const markerAt = raw.indexOf(marker);
    if (markerAt < 0) return null;
    const start = raw.indexOf("{", markerAt + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try {
          return JSON.parse(raw.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function readPlayerResponse() {
    const player = document.querySelector("#movie_player");
    try {
      const response = player?.getPlayerResponse?.();
      if (response?.captions) return response;
    } catch {
      // Fall through to the response embedded in the page.
    }
    if (root.ytInitialPlayerResponse?.captions) return root.ytInitialPlayerResponse;

    const videoId = new URL(location.href).searchParams.get("v");
    let fallback = null;
    for (const script of document.scripts) {
      const raw = script.textContent || "";
      if (!raw.includes("ytInitialPlayerResponse") || !raw.includes('"captionTracks"')) continue;
      const response = parseAssignedJson(raw) || parseAssignedJson(raw, "ytInitialPlayerResponse = ");
      if (!response?.captions) continue;
      if (videoId && response?.videoDetails?.videoId === videoId) return response;
      fallback = response;
    }
    return fallback;
  }

  function readActiveTrack() {
    const player = document.querySelector("#movie_player");
    try {
      return player?.getOption?.("captions", "track") || null;
    } catch {
      return null;
    }
  }

  function inferredLanguageCodes(text) {
    if (/[\uac00-\ud7af]/u.test(text)) return ["ko"];
    if (/[\u3040-\u30ff]/u.test(text)) return ["ja"];
    if (/[\u3400-\u9fff]/u.test(text)) return ["zh", "ja"];
    if (/[\u0400-\u04ff]/u.test(text)) return ["ru", "uk"];
    if (/[\u0600-\u06ff]/u.test(text)) return ["ar"];
    return ["en"];
  }

  function selectCaptionTrack(tracksValue, activeTrack, currentText = "") {
    const tracks = Array.isArray(tracksValue) ? tracksValue.filter((track) => track?.baseUrl) : [];
    if (!tracks.length) return null;
    if (activeTrack?.vssId) {
      const exact = tracks.find((track) => track.vssId === activeTrack.vssId);
      if (exact) return exact;
    }
    if (activeTrack?.languageCode) {
      const exactLanguage = tracks.find((track) =>
        track.languageCode === activeTrack.languageCode &&
        String(track.kind || "") === String(activeTrack.kind || "")
      );
      if (exactLanguage) return exactLanguage;
      const sameLanguage = tracks.find((track) => track.languageCode === activeTrack.languageCode);
      if (sameLanguage) return sameLanguage;
    }
    for (const languageCode of inferredLanguageCodes(currentText)) {
      const preferred = tracks.find((track) => String(track.languageCode || "").toLowerCase().startsWith(languageCode));
      if (preferred) return preferred;
    }
    return tracks[0];
  }

  function eventsToCues(eventsValue) {
    const events = Array.isArray(eventsValue) ? eventsValue : [];
    const cues = [];
    for (const event of events) {
      const startMs = Number(event?.tStartMs);
      const text = normalizeText(
        Array.isArray(event?.segs) ? event.segs.map((segment) => segment?.utf8 || "").join("") : ""
      );
      if (!Number.isFinite(startMs) || !text) continue;
      const durationMs = Math.max(0, Number(event?.dDurationMs) || 0);
      const previous = cues[cues.length - 1];
      if (previous && previous.startMs === startMs && previous.text === text) continue;
      cues.push({ startMs, endMs: startMs + durationMs, text });
    }
    cues.sort((left, right) => left.startMs - right.startMs);
    for (let index = 0; index < cues.length; index += 1) {
      if (cues[index].endMs <= cues[index].startMs) {
        cues[index].endMs = cues[index + 1]?.startMs || cues[index].startMs + 2000;
      }
    }
    return cues;
  }

  function extractFocusedSentence(sourceValue, focusValue) {
    const source = normalizeText(sourceValue);
    const focus = normalizeText(focusValue);
    if (!source) return "";
    const sourceKey = source.toLocaleLowerCase();
    const focusKey = focus.toLocaleLowerCase();
    let focusAt = focusKey ? sourceKey.lastIndexOf(focusKey) : -1;
    let focusLength = focus.length;
    if (focusAt < 0 && focus) {
      const focusTokens = tokens(focus);
      const probe = focusTokens.slice(0, Math.min(3, focusTokens.length)).map((item) => item.key).join(" ");
      if (probe) {
        focusAt = sourceKey.indexOf(probe);
        focusLength = probe.length;
      }
    }
    if (focusAt < 0) {
      focusAt = Math.floor(source.length / 2);
      focusLength = 0;
    }

    let sentenceStart = 0;
    const boundaryBefore = /[.!?。！？…][.!?。！？…]*["'”’）)\]}]*\s+/gu;
    for (const match of source.slice(0, focusAt).matchAll(boundaryBefore)) {
      sentenceStart = match.index + match[0].length;
    }

    let sentenceEnd = source.length;
    const afterStart = Math.min(source.length, focusAt + focusLength);
    const boundaryAfter = source.slice(afterStart).match(/[.!?。！？…][.!?。！？…]*["'”’）)\]}]*/u);
    if (boundaryAfter) {
      sentenceEnd = afterStart + boundaryAfter.index + boundaryAfter[0].length;
    }

    return normalizeText(source.slice(sentenceStart, sentenceEnd));
  }

  function buildCaptionAtTime(events, currentTimeMs, currentText = "") {
    const cues = eventsToCues(events);
    if (!cues.length || !Number.isFinite(Number(currentTimeMs))) return "";
    const now = Number(currentTimeMs);
    const nearbyCueIndexes = [];
    for (let index = 0; index < cues.length; index += 1) {
      const cue = cues[index];
      const distance = cue.startMs <= now && cue.endMs >= now
        ? 0
        : Math.min(Math.abs(cue.startMs - now), Math.abs(cue.endMs - now));
      if (distance <= MAX_FOCUS_DISTANCE_MS) nearbyCueIndexes.push(index);
    }
    const candidateIndexes = nearbyCueIndexes.length
      ? nearbyCueIndexes
      : cues.map((_, index) => index);
    let focusIndex = 0;
    let bestRank = -Infinity;
    for (const index of candidateIndexes) {
      const cue = cues[index];
      const withinCue = cue.startMs <= now + 750 && cue.endMs >= now - 750;
      const distance = withinCue ? 0 : Math.min(Math.abs(cue.startMs - now), Math.abs(cue.endMs - now));
      const rank = similarityScore(cue.text, currentText) * 5000 - distance;
      if (rank > bestRank) {
        bestRank = rank;
        focusIndex = index;
      }
    }

    let left = focusIndex;
    while (left > 0) {
      const previous = cues[left - 1];
      const current = cues[left];
      const gap = Math.max(0, current.startMs - previous.endMs);
      if (
        gap > MAX_CUE_GAP_MS ||
        cues[focusIndex].startMs - previous.startMs > MAX_BOUNDARY_SEARCH_MS
      ) break;
      left -= 1;
      // Include the boundary cue itself. For rolling captions it can also contain
      // the missing beginning of the focused sentence; extractFocusedSentence
      // removes it when it is genuinely the preceding sentence.
      if (SENTENCE_END_RE.test(previous.text)) break;
    }

    let merged = "";
    for (const cue of cues.slice(left, focusIndex + 1)) {
      merged = mergeCaptionText(merged, cue.text);
    }

    let right = focusIndex;
    while (right + 1 < cues.length) {
      const focusedSentence = extractFocusedSentence(
        merged,
        currentText || cues[focusIndex].text
      );
      if (SENTENCE_END_RE.test(focusedSentence)) break;
      const current = cues[right];
      const next = cues[right + 1];
      const gap = Math.max(0, next.startMs - current.endMs);
      if (
        gap > MAX_CUE_GAP_MS ||
        next.startMs - cues[focusIndex].startMs > MAX_BOUNDARY_SEARCH_MS
      ) break;
      right += 1;
      merged = mergeCaptionText(merged, next.text);
    }

    return extractFocusedSentence(merged, currentText || cues[focusIndex].text);
  }

  function captionTrackName(track) {
    return track?.name?.simpleText || track?.name?.runs?.map((run) => run.text).join("") || "";
  }

  function decodeCaptionEntities(value) {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      if (entity[0] !== "#") return named[entity.toLowerCase()] || match;
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      try {
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      } catch {
        return match;
      }
    });
  }

  function cleanCueMarkup(value) {
    return normalizeText(decodeCaptionEntities(String(value || "").replace(/<[^>]*>/g, "")));
  }

  function parseVttTimestamp(value) {
    const parts = String(value || "").trim().split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) return NaN;
    const seconds = parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
    return Math.round(seconds * 1000);
  }

  function parseVttEvents(rawValue) {
    const blocks = String(rawValue || "").replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/);
    const events = [];
    for (const block of blocks) {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) continue;
      const timing = lines[timingIndex].split("-->");
      const startMs = parseVttTimestamp(timing[0]);
      const endMs = parseVttTimestamp((timing[1] || "").trim().split(/\s+/)[0]);
      const text = cleanCueMarkup(lines.slice(timingIndex + 1).join(" "));
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !text) continue;
      events.push({ tStartMs: startMs, dDurationMs: Math.max(0, endMs - startMs), segs: [{ utf8: text }] });
    }
    return events;
  }

  function parseSrv3Events(rawValue) {
    const raw = String(rawValue || "");
    const events = [];
    const paragraphRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    for (const match of raw.matchAll(paragraphRe)) {
      const attributes = match[1];
      const startMatch = attributes.match(/\bt=["'](\d+)["']/i);
      const durationMatch = attributes.match(/\bd=["'](\d+)["']/i);
      const text = cleanCueMarkup(match[2]);
      if (!startMatch || !text) continue;
      events.push({
        tStartMs: Number(startMatch[1]),
        dDurationMs: durationMatch ? Number(durationMatch[1]) : 0,
        segs: [{ utf8: text }]
      });
    }
    return events;
  }

  function parseTrackEvents(raw, format) {
    if (format === "json3") {
      const data = JSON.parse(raw);
      return Array.isArray(data?.events) ? data.events : [];
    }
    if (format === "vtt") return parseVttEvents(raw);
    if (format === "srv3") return parseSrv3Events(raw);
    return [];
  }

  async function loadTrackEvents(track) {
    const cacheKey = track.baseUrl;
    if (trackCache.has(cacheKey)) return trackCache.get(cacheKey);
    const promise = (async () => {
      let lastError = null;
      for (const format of ["json3", "vtt", "srv3"]) {
        try {
          const url = new URL(track.baseUrl, location.href);
          url.searchParams.set("fmt", format);
          const response = await fetch(url.toString(), { credentials: "include" });
          if (!response.ok) throw new Error(`Timed caption request failed: ${response.status}`);
          const raw = await response.text();
          if (!raw.trim()) throw new Error("Timed caption response was empty");
          const events = parseTrackEvents(raw, format);
          if (events.length) return events;
          throw new Error(`Timed caption ${format} response had no events`);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("Timed caption response was unavailable");
    })();
    trackCache.set(cacheKey, promise);
    while (trackCache.size > 4) trackCache.delete(trackCache.keys().next().value);
    try {
      return await promise;
    } catch (error) {
      trackCache.delete(cacheKey);
      throw error;
    }
  }

  async function getTimelineCaption(payload = {}) {
    const response = readPlayerResponse();
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const track = selectCaptionTrack(tracks, readActiveTrack(), payload.currentText);
    if (!track) throw new Error("No timed caption track available");
    const events = await loadTrackEvents(track);
    const text = buildCaptionAtTime(events, Number(payload.currentTimeMs), payload.currentText);
    const confidence = similarityScore(text, payload.currentText);
    if (!text || (payload.currentText && confidence < 0.45)) {
      throw new Error("Timed caption track did not match the visible caption");
    }
    return {
      text,
      confidence,
      languageCode: track.languageCode || "",
      trackName: captionTrackName(track)
    };
  }

  const api = Object.freeze({
    normalizeText,
    parseAssignedJson,
    selectCaptionTrack,
    eventsToCues,
    extractFocusedSentence,
    buildCaptionAtTime,
    similarityScore,
    parseVttEvents,
    parseSrv3Events
  });
  root.CaptionTimelineSource = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  if (typeof window === "undefined" || root !== window || root.__youtubeCaptionTimelineBridgeLoaded) return;
  root.__youtubeCaptionTimelineBridgeLoaded = true;
  root.addEventListener("message", (event) => {
    if (event.source !== root || event.origin !== location.origin || event.data?.channel !== CHANNEL) return;
    if (event.data.type === PREFETCH_TYPE) {
      getTimelineCaption(event.data.payload).catch(() => {});
      return;
    }
    if (event.data.type !== REQUEST_TYPE || !event.data.requestId) return;
    getTimelineCaption(event.data.payload)
      .then((data) => root.postMessage({
        channel: CHANNEL,
        type: RESPONSE_TYPE,
        requestId: event.data.requestId,
        ok: true,
        data
      }, location.origin))
      .catch(() => root.postMessage({
        channel: CHANNEL,
        type: RESPONSE_TYPE,
        requestId: event.data.requestId,
        ok: false
      }, location.origin));
  });
})(globalThis);
