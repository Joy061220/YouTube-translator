(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.CaptionDisplaySettings = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_BACKGROUND_OPACITY = 96;
  const DEFAULT_TEXT_OPACITY = 100;
  const DEFAULT_TEXT_COLOR = "#ffffff";
  const TEXT_COLOR_PRESETS = Object.freeze([
    Object.freeze({ value: "#ffffff", label: "白色" }),
    Object.freeze({ value: "#ffe08a", label: "暖黄色" }),
    Object.freeze({ value: "#9ed0ff", label: "浅蓝色" }),
    Object.freeze({ value: "#a7f3d0", label: "薄荷绿" }),
    Object.freeze({ value: "#f9a8d4", label: "粉色" }),
    Object.freeze({ value: "#fdba74", label: "橙色" }),
    Object.freeze({ value: "#c4b5fd", label: "淡紫色" }),
    Object.freeze({ value: "#bef264", label: "青柠色" })
  ]);
  const TEXT_COLOR_VALUES = new Set(TEXT_COLOR_PRESETS.map((preset) => preset.value));

  function normalizeOpacity(value, fallback) {
    const numericValue = Number(value);
    const numericFallback = Number(fallback);
    const safeValue = Number.isFinite(numericValue)
      ? numericValue
      : Number.isFinite(numericFallback)
        ? numericFallback
        : 100;
    return Math.min(100, Math.max(0, Math.round(safeValue)));
  }

  function normalizeBackgroundOpacity(value, fallback = DEFAULT_BACKGROUND_OPACITY) {
    return normalizeOpacity(value, fallback);
  }

  function backgroundOpacityFraction(value) {
    return normalizeBackgroundOpacity(value) / 100;
  }

  function normalizeTextOpacity(value, fallback = DEFAULT_TEXT_OPACITY) {
    return normalizeOpacity(value, fallback);
  }

  function textOpacityFraction(value) {
    return normalizeTextOpacity(value) / 100;
  }

  function normalizeTextColor(value, fallback = DEFAULT_TEXT_COLOR) {
    const normalizedValue = String(value || "").trim().toLowerCase();
    if (TEXT_COLOR_VALUES.has(normalizedValue)) return normalizedValue;
    const normalizedFallback = String(fallback || "").trim().toLowerCase();
    return TEXT_COLOR_VALUES.has(normalizedFallback) ? normalizedFallback : DEFAULT_TEXT_COLOR;
  }

  return Object.freeze({
    DEFAULT_BACKGROUND_OPACITY,
    DEFAULT_TEXT_OPACITY,
    DEFAULT_TEXT_COLOR,
    TEXT_COLOR_PRESETS,
    normalizeBackgroundOpacity,
    backgroundOpacityFraction,
    normalizeTextOpacity,
    textOpacityFraction,
    normalizeTextColor
  });
});
