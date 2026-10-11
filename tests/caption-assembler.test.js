"use strict";

const assert = require("node:assert/strict");
const assembler = require("../extension/caption-assembler.js");
const notice = "English (auto-generated) Click for settings";
const polluted = [
  `Everyone, this year's Nobel ${notice}`,
  `Everyone, this year's Nobel Prize ${notice}`,
  `Everyone, this year's Nobel Prize in physics ${notice}`
].join(" ");

assert.equal(assembler.selectActiveSentence("see the cosmos, but rather they use neutrinos.", polluted),
  "see the cosmos, but rather they use neutrinos.", "polluted history cannot replace the current caption");
assert.equal(assembler.selectActiveSentence(polluted), "", "a contaminated snapshot is rejected");
assert.equal(assembler.mergeCaptionText(polluted, "Clean current words"), "Clean current words");
assert.equal(assembler.mergeCaptionText("Clean current words", polluted), "Clean current words");

const buffer = new assembler.SentenceBuffer(polluted);
assert.equal(buffer.activeText, "", "collection cannot start with polluted history");
buffer.push("Unfinished prior words");
buffer.push(polluted);
assert.equal(buffer.activeText, "", "pollution clears previous collection history");
buffer.push("Clean current sentence.");
assert.equal(buffer.activeText, "Clean current sentence.", "later captions recover without old versions");

const clean = new assembler.SentenceBuffer();
for (const text of ["Everyone, this year's Nobel", "Everyone, this year's Nobel Prize", "Everyone, this year's Nobel Prize in physics has been announced."]) clean.push(text);
assert.equal(clean.activeText, "Everyone, this year's Nobel Prize in physics has been announced.");
assert.equal(assembler.hasCaptionArtifacts("I speak English. The button says Click for settings."), false);
assert.equal(assembler.isCaptionNotice("The button says Click for settings."), false);

console.log("All caption contamination regression tests passed");
