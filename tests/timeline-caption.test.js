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
  const beginning = Array.from({ length: 90 }, (_, index) => `word${index}`).join(" ");
  const ending = "the complete ending.";
  const events = [
    { tStartMs: 0, dDurationMs: 30000, segs: [{ utf8: beginning }] },
    { tStartMs: 25000, dDurationMs: 10000, segs: [{ utf8: `${beginning.split(" ").slice(-4).join(" ")} ${ending}` }] }
  ];
  assert.equal(
    timeline.buildCaptionAtTime(events, 10000, "word30 word31 word32"),
    `${beginning} ${ending}`,
    "a sentence longer than the old 520-character cap is not silently cropped"
  );
}

{
  const events = [
    { tStartMs: 0, dDurationMs: 1800, segs: [{ utf8: "Earlier sentence." }] },
    { tStartMs: 3000, dDurationMs: 1800, segs: [{ utf8: "This deliberately long sentence" }] },
    { tStartMs: 10500, dDurationMs: 1800, segs: [{ utf8: "sentence continues after a long pause" }] },
    { tStartMs: 21500, dDurationMs: 1800, segs: [{ utf8: "pause and extends beyond twelve seconds" }] },
    { tStartMs: 32500, dDurationMs: 1800, segs: [{ utf8: "seconds before it finally ends here." }] },
    { tStartMs: 36000, dDurationMs: 1800, segs: [{ utf8: "The next sentence starts." }] }
  ];
  assert.equal(
    timeline.buildCaptionAtTime(events, 11000, "sentence continues after a long pause"),
    "This deliberately long sentence continues after a long pause and extends beyond twelve seconds before it finally ends here."
  );
}

{
  const events = [
    { tStartMs: 0, dDurationMs: 1800, segs: [{ utf8: "The same common phrase appears here." }] },
    { tStartMs: 60000, dDurationMs: 1800, segs: [{ utf8: "A nearby sentence uses" }] },
    { tStartMs: 61500, dDurationMs: 1800, segs: [{ utf8: "uses the same common phrase" }] },
    { tStartMs: 63000, dDurationMs: 1800, segs: [{ utf8: "phrase in its own context." }] }
  ];
  assert.equal(
    timeline.buildCaptionAtTime(events, 61500, "the same common phrase"),
    "A nearby sentence uses the same common phrase in its own context."
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

{
  const visible = "obviously. And Apple's also quietly increased the prices of older iPhones";
  const focus = "And Apple's also quietly increased the prices of older iPhones";
  const full = `${focus} in some markets.`;
  const events = [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "Lower prices, obviously." }] },
    { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: visible }] },
    { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: "the prices of older iPhones in some markets. Another thought." }] }
  ];
  assert.equal(timeline.buildCaptionAtTime(events, 3500, focus, visible), full,
    "screenshot target is completed without the old tail or following sentence");
  assert.equal(timeline.buildCaptionAtTime(events, 3500, visible), full,
    "a screen snapshot used as a focus also discards the carry-over prefix");
}

{
  const events = [
    { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: "Obviously." }] },
    { tStartMs: 4000, dDurationMs: 3000, segs: [{ utf8: "And Apple raised its prices." }] }
  ];
  assert.equal(timeline.buildCaptionAtTime(events, 3500, "And Apple raised", "Obviously. And Apple raised"),
    "Obviously.", "a reliably timed future sentence does not displace the active sentence");
  assert.equal(timeline.buildCaptionAtTime(events, 4000, "And Apple raised", "Obviously. And Apple raised"),
    "And Apple raised its prices.", "at the new cue's start the target switches to the new sentence");
  assert.equal(timeline.buildCaptionAtTime(events, 3500, "Obviously."), "Obviously.",
    "a complete focus does not swallow the following sentence");
  assert.equal(timeline.buildCaptionAtTime(events, 100000, "Obviously."), "",
    "a distant repeated phrase is not selected after seeking");
  assert.equal(timeline.extractFocusedSentence("An unrelated sentence.", "Completely absent words"), "",
    "missing focus is not replaced by an arbitrary sentence");
  assert.equal(timeline.extractFocusedSentence("We can now finish the revised sentence. Next thought.", "We can now finish the sentence."),
    "We can now finish the revised sentence.", "a partial focus match still collects the full revised sentence");
}

console.log("All timeline caption tests passed");
