"use strict";

const assert = require("assert");
const settings = require("../extension/display-settings.js");

assert.equal(settings.DEFAULT_BACKGROUND_OPACITY, 96);
assert.equal(settings.normalizeBackgroundOpacity("55"), 55);
assert.equal(settings.normalizeBackgroundOpacity(-4), 0);
assert.equal(settings.normalizeBackgroundOpacity(104), 100);
assert.equal(settings.normalizeBackgroundOpacity("invalid"), 96);
assert.equal(settings.normalizeBackgroundOpacity(20.6), 21);
assert.equal(settings.backgroundOpacityFraction(35), 0.35);
assert.equal(settings.DEFAULT_TEXT_OPACITY, 100);
assert.equal(settings.normalizeTextOpacity("58"), 58);
assert.equal(settings.normalizeTextOpacity(-1), 0);
assert.equal(settings.normalizeTextOpacity(101), 100);
assert.equal(settings.textOpacityFraction(72), 0.72);
assert.equal(settings.DEFAULT_TEXT_COLOR, "#ffffff");
assert.equal(settings.TEXT_COLOR_PRESETS.length, 8);
assert.equal(settings.normalizeTextColor("#FFE08A"), "#ffe08a");
assert.equal(settings.normalizeTextColor("#000000"), "#ffffff");

console.log("All display setting tests passed.");
