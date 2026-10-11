(function (root) {
  "use strict";

  const { normalizeText, isCaptionNotice, hasCaptionArtifacts } = root.CaptionSentenceAssembler;
  const NON_CAPTION_SELECTOR = '[role="tooltip"], [role="menu"], [aria-hidden="true"], [hidden], .ytp-tooltip, .ytp-settings-menu';

  function isExcluded(element) {
    if (element.matches(NON_CAPTION_SELECTOR)) return true;
    const style = getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden" ||
      style.visibility === "collapse" || style.opacity === "0";
  }

  function readNode(node) {
    if (node.nodeType === 3) return node.textContent || "";
    if (node.nodeType !== 1 || isExcluded(node) || isCaptionNotice(node.textContent)) return "";
    if (node.tagName === "BR") return " ";
    return Array.from(node.childNodes, readNode).join("");
  }

  function readVisibleCaption(player) {
    if (!player) return "";
    const parts = [];
    for (const segment of player.querySelectorAll(".caption-window .ytp-caption-segment")) {
      // An outer segment already includes its styled children. Reading both
      // would duplicate the same caption, including nested notice text.
      if (segment.parentElement?.closest(".ytp-caption-segment")) continue;
      if (!segment.getClientRects().length) continue;
      let excluded = false;
      for (let ancestor = segment; ancestor; ancestor = ancestor.parentElement) {
        if (isExcluded(ancestor) || isCaptionNotice(ancestor.textContent)) {
          excluded = true;
          break;
        }
        if (ancestor === player) break;
      }
      if (excluded) continue;
      const text = normalizeText(readNode(segment));
      // If a notice shares a text node with speech, there is no reliable DOM
      // boundary to remove it. Discard that segment instead of guessing.
      if (text && !hasCaptionArtifacts(text) && parts[parts.length - 1] !== text) parts.push(text);
    }
    const text = normalizeText(parts.join(" "));
    return hasCaptionArtifacts(text) ? "" : text;
  }

  root.CaptionSourceReader = Object.freeze({ readVisibleCaption });
})(globalThis);
