"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

(async () => {
  const tracks = [
    { vssId: ".en", languageCode: "en", baseUrl: "https://example.test/en" },
    { vssId: ".zh", languageCode: "zh", baseUrl: "https://example.test/zh" }
  ];
  let activeTrack = tracks[0];
  let releaseFetch;
  let poll;
  let listener;
  const posted = [];
  const player = {
    getOption: () => activeTrack,
    getPlayerResponse: () => ({ captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } })
  };
  const sandbox = {
    URL,
    location: { href: "https://www.youtube.com/watch?v=fixture", origin: "https://www.youtube.com" },
    document: { querySelector: () => player, scripts: [] },
    setInterval: (fn) => { poll = fn; },
    addEventListener: (type, fn) => { if (type === "message") listener = fn; },
    postMessage: (message) => posted.push(message),
    fetch: () => new Promise((resolve) => { releaseFetch = resolve; })
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve("../extension/page-caption-source.js"), "utf8"), context);
  const source = vm.runInContext("window", context);
  const send = (requestId, payload) => listener({ source, origin: sandbox.location.origin, data: {
    channel: "youtube-caption-translator-timeline-v1", type: "request-timeline-caption", requestId, payload
  } });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const respond = (text) => releaseFetch({ ok: true, text: async () => JSON.stringify({
    events: [{ tStartMs: 1000, dDurationMs: 4000, segs: [{ utf8: text }] }]
  }) });

  send("first", { currentTimeMs: 2500, currentText: "And Apple raised", visibleText: "obviously. And Apple raised" });
  respond("obviously. And Apple raised its prices.");
  await flush();
  const first = posted.find((item) => item.requestId === "first");
  assert.equal(first?.ok, true);
  assert.equal(first.data.text, "And Apple raised its prices.");

  activeTrack = tracks[1];
  poll();
  assert.equal(posted.filter((item) => item.type === "caption-track-changed").length, 1,
    "changing tracks notifies the content script");
  poll();
  assert.equal(posted.filter((item) => item.type === "caption-track-changed").length, 1,
    "an unchanged track does not repeatedly reset sentence history");

  send("stale", { currentTimeMs: 2500, currentText: "新的字幕。" });
  activeTrack = tracks[0];
  respond("新的字幕。");
  await flush();
  assert.equal(posted.find((item) => item.requestId === "stale")?.ok, false,
    "a lookup for a superseded track cannot return stale text");

  console.log("All timeline bridge tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
