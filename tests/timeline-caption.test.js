"use strict";

const assert = require("assert");
const timeline = require("../extension/page-caption-source.js");

{
  const parsed = timeline.parseAssignedJson(
    'var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc"},"nested":{"text":"a } brace"}}; window.after = true;'
  );
  assert.equal(parsed.videoDetails.videoId, "abc");
  assert.equal(parsed.nested.text, "a } brace");
}

{
  const tracks = [
    { languageCode: "de", vssId: ".de", baseUrl: "https://example.test/de" },
    { languageCode: "en", vssId: "a.en", kind: "asr", baseUrl: "https://example.test/en" }
  ];
  assert.equal(timeline.selectCaptionTrack(tracks, { vssId: "a.en" }, "hello").vssId, "a.en");
  assert.equal(timeline.selectCaptionTrack(tracks, null, "hello").languageCode, "en");
}

{
  const events = [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "Earlier sentence." }] },
    { tStartMs: 3000, dDurationMs: 1500, segs: [{ utf8: "This is" }] },
    { tStartMs: 4200, dDurationMs: 1600, segs: [{ utf8: "is a complete" }] },
    { tStartMs: 5400, dDurationMs: 1700, segs: [{ utf8: "complete sentence." }] },
    { tStartMs: 8000, dDurationMs: 1500, segs: [{ utf8: "Next thought" }] }
  ];
  assert.equal(
    timeline.buildCaptionAtTime(events, 4700, "is a complete"),
    "This is a complete sentence."
  );
}

{
  const events = [
    { tStartMs: 0, dDurationMs: 1800, segs: [{ utf8: "we need to" }] },
    { tStartMs: 1200, dDurationMs: 1800, segs: [{ utf8: "to solve this" }] },
    { tStartMs: 2400, dDurationMs: 1800, segs: [{ utf8: "this problem" }] },
    { tStartMs: 3600, dDurationMs: 1800, segs: [{ utf8: "problem together" }] }
  ];
  assert.equal(
    timeline.buildCaptionAtTime(events, 2600, "this problem"),
    "we need to solve this problem together"
  );
}

assert.equal(timeline.similarityScore("This is the current subtitle.", "current subtitle"), 1);

{
  const events = timeline.parseVttEvents(`WEBVTT

00:00:01.000 --> 00:00:03.500 align:start
More reliable, more convenient,

00:00:03.500 --> 00:00:05.500
and most importantly.`);
  assert.equal(events.length, 2);
  assert.equal(events[0].tStartMs, 1000);
  assert.equal(events[1].segs[0].utf8, "and most importantly.");
}

{
  const events = timeline.parseSrv3Events(
    '<timedtext><body><p t="1000" d="2500"><s>More reliable &amp; convenient.</s></p></body></timedtext>'
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].segs[0].utf8, "More reliable & convenient.");
}

console.log("All timeline caption tests passed");
