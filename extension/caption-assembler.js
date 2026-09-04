(function (root) {
  "use strict";

  const SENTENCE_END_RE = /[.!?。！？…][.!?。！？…]*["'”’）)\]}]*$/u;
  const EMBEDDED_SENTENCE_END_RE = /[.!?。！？…][.!?。！？…]*["'”’）)\]}]*(?=\s+\S)/gu;
  const WORD_RE = /[\u3040-\u30ff\u3400-\u9fff]|[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function comparable(value) {
    return normalizeText(value).toLocaleLowerCase();
  }

  function endsSentence(value) {
    return SENTENCE_END_RE.test(normalizeText(value));
  }

  function captionSettleDelay(value, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : 0;
    const lastChangedAt = Number.isFinite(options.lastChangedAt)
      ? Math.min(options.lastChangedAt, now)
      : now;
    const startedAt = Number.isFinite(options.startedAt)
      ? Math.min(options.startedAt, now)
      : now;
    const sentenceEndSettleMs = Math.max(0, Number(options.sentenceEndSettleMs) || 0);
    const noPunctuationSettleMs = Math.max(0, Number(options.noPunctuationSettleMs) || 0);
    const maxCollectionMs = Math.max(0, Number(options.maxCollectionMs) || 0);
    const settleTime = endsSentence(value) ? sentenceEndSettleMs : noPunctuationSettleMs;
    const untilSettled = settleTime - (now - lastChangedAt);
    const untilMaximum = maxCollectionMs - (now - startedAt);

    if (normalizeText(value) && (untilSettled <= 0 || untilMaximum <= 0)) {
      return 0;
    }
    return Math.max(25, Math.min(Math.max(0, untilSettled), Math.max(0, untilMaximum)));
  }

  function captionCompletionDelay(value, options = {}) {
    const text = normalizeText(value);
    const now = Number.isFinite(options.now) ? options.now : 0;
    const startedAt = Number.isFinite(options.startedAt)
      ? Math.min(options.startedAt, now)
      : now;
    const lastChangedAt = Number.isFinite(options.lastChangedAt)
      ? Math.min(Math.max(options.lastChangedAt, startedAt), now)
      : startedAt;
    const blankSince = Number.isFinite(options.blankSince)
      ? Math.min(Math.max(options.blankSince, startedAt), now)
      : null;
    const sentenceEndSettleMs = Math.max(0, Number(options.sentenceEndSettleMs) || 0);
    const blankSettleMs = Math.max(0, Number(options.blankSettleMs) || 0);
    const maxCollectionMs = Math.max(0, Number(options.maxCollectionMs) || 0);
    const untilMaximum = maxCollectionMs - (now - startedAt);

    if (!text) return untilMaximum <= 0 ? 0 : Math.max(25, untilMaximum);
    if (untilMaximum <= 0) return 0;

    if (endsSentence(text)) {
      const untilSentenceEnd = sentenceEndSettleMs - (now - lastChangedAt);
      if (untilSentenceEnd <= 0) return 0;
      return Math.max(25, Math.min(untilSentenceEnd, untilMaximum));
    }

    if (blankSince != null) {
      const untilBlankSettles = blankSettleMs - (now - blankSince);
      if (untilBlankSettles <= 0) return 0;
      return Math.max(25, Math.min(untilBlankSettles, untilMaximum));
    }

    // A stable on-screen caption block is not necessarily a complete sentence.
    // Without punctuation or a real blank gap, keep collecting until the cap.
    return Math.max(25, untilMaximum);
  }

  function stripSentenceEnding(value) {
    return normalizeText(value).replace(SENTENCE_END_RE, "").trimEnd();
  }

  function tokens(value) {
    const text = normalizeText(value);
    const result = [];
    for (const match of text.matchAll(WORD_RE)) {
      result.push({
        key: match[0].toLocaleLowerCase(),
        start: match.index,
        end: match.index + match[0].length
      });
    }
    return { text, items: result };
  }

  function usableSingleTokenOverlap(key) {
    return key.length >= 2 || /[^\x00-\x7f]/u.test(key);
  }

  function overlapDetails(leftValue, rightValue) {
    const left = tokens(leftValue);
    const right = tokens(rightValue);
    const maximum = Math.min(left.items.length, right.items.length);

    for (let size = maximum; size >= 1; size -= 1) {
      if (size === 1 && !usableSingleTokenOverlap(right.items[0].key)) {
        continue;
      }
      let matches = true;
      for (let index = 0; index < size; index += 1) {
        const leftToken = left.items[left.items.length - size + index];
        const rightToken = right.items[index];
        if (leftToken.key !== rightToken.key) {
          matches = false;
          break;
        }
      }
      if (matches) {
        const overlapEnd = right.items[size - 1].end;
        return {
          size,
          tail: right.text.slice(overlapEnd).trim()
        };
      }
    }

    return { size: 0, tail: right.text };
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

  function isSameSentenceRevision(currentValue, incomingValue) {
    const current = normalizeText(currentValue);
    const incoming = normalizeText(incomingValue);
    const currentKey = comparable(current);
    const incomingKey = comparable(incoming);
    if (!current || !incoming || currentKey === incomingKey) return true;
    if (currentKey.includes(incomingKey)) return true;
    if (incomingKey.endsWith(currentKey)) return true;

    const core = stripSentenceEnding(current);
    if (!core) return false;
    const coreKey = comparable(core);
    if (!incomingKey.startsWith(coreKey)) return false;

    const tail = incoming.slice(core.length).trim();
    if (!tail || /^[.!?。！？…][.!?。！？…]*["'”’）)\]}]*$/u.test(tail)) {
      return true;
    }
    return !/^[.!?。！？…]/u.test(tail);
  }

  function mergeCaptionText(currentValue, incomingValue) {
    const current = normalizeText(currentValue);
    const incoming = normalizeText(incomingValue);
    if (!current) return incoming;
    if (!incoming) return current;

    const currentKey = comparable(current);
    const incomingKey = comparable(incoming);
    if (currentKey === incomingKey) return incoming;
    if (incomingKey.startsWith(currentKey)) return incoming;
    if (currentKey.startsWith(incomingKey)) return current;
    if (incomingKey.includes(currentKey)) return incoming;
    if (currentKey.includes(incomingKey)) return current;

    const currentCore = stripSentenceEnding(current);
    if (currentCore && incomingKey.startsWith(comparable(currentCore))) {
      return incoming;
    }

    const overlap = overlapDetails(current, incoming);
    if (overlap.size > 0) {
      return joinText(current, overlap.tail);
    }
    return joinText(current, incoming);
  }

  function removeRepeatedBoundaryPunctuation(currentValue, tailValue) {
    const current = normalizeText(currentValue);
    let tail = normalizeText(tailValue);
    const currentMatch = current.match(/[.!?。！？…]+["'”’）)\]}]*$/u);
    const tailMatch = tail.match(/^[.!?。！？…]+["'”’）)\]}]*/u);
    if (currentMatch && tailMatch && currentMatch[0][0] === tailMatch[0][0]) {
      tail = tail.slice(tailMatch[0].length).trim();
    }
    return tail;
  }

  function textAfterCompletedSentence(currentValue, incomingValue) {
    const current = normalizeText(currentValue);
    const incoming = normalizeText(incomingValue);
    const currentKey = comparable(current);
    const incomingKey = comparable(incoming);

    if (incomingKey.startsWith(currentKey)) {
      return normalizeText(incoming.slice(current.length));
    }

    const overlap = overlapDetails(current, incoming);
    if (overlap.size > 0) {
      return removeRepeatedBoundaryPunctuation(current, overlap.tail);
    }
    return incoming;
  }

  function splitEmbeddedSentences(value) {
    let remaining = normalizeText(value);
    const completed = [];

    while (remaining) {
      EMBEDDED_SENTENCE_END_RE.lastIndex = 0;
      const match = EMBEDDED_SENTENCE_END_RE.exec(remaining);
      if (!match) break;
      const boundary = match.index + match[0].length;
      const sentence = normalizeText(remaining.slice(0, boundary));
      remaining = normalizeText(remaining.slice(boundary));
      if (sentence) completed.push(sentence);
    }

    return { completed, active: remaining };
  }

  function latestCompleteSentence(value) {
    const parts = splitEmbeddedSentences(value);
    if (!parts.completed.length) return "";
    if (parts.active && endsSentence(parts.active)) {
      return parts.active;
    }
    return parts.completed[parts.completed.length - 1];
  }

  function areCaptionVersions(leftValue, rightValue) {
    const left = normalizeText(leftValue);
    const right = normalizeText(rightValue);
    if (!left || !right) return false;
    const leftKey = comparable(left);
    const rightKey = comparable(right);
    const leftCore = comparable(stripSentenceEnding(left));
    const rightCore = comparable(stripSentenceEnding(right));
    return (
      leftKey.includes(rightKey) ||
      rightKey.includes(leftKey) ||
      (leftCore && (leftCore === rightCore || rightKey.startsWith(leftCore))) ||
      (rightCore && (rightCore === leftCore || leftKey.startsWith(rightCore))) ||
      overlapDetails(left, right).size > 0 ||
      overlapDetails(right, left).size > 0
    );
  }

  function snapshotContainsSentence(snapshotValue, sentenceValue) {
    const snapshotKey = comparable(snapshotValue);
    const sentenceKey = comparable(sentenceValue);
    const sentenceCore = comparable(stripSentenceEnding(sentenceValue));
    return snapshotKey.includes(sentenceKey) || Boolean(sentenceCore && snapshotKey.includes(sentenceCore));
  }

  class SentenceBuffer {
    constructor(seed = "", lastSnapshot = "") {
      this.activeText = normalizeText(seed);
      this.lastSnapshot = normalizeText(lastSnapshot || seed);
    }

    reset() {
      this.activeText = "";
      this.lastSnapshot = "";
    }

    push(snapshotValue) {
      const snapshot = normalizeText(snapshotValue);
      const previousActive = this.activeText;
      const completed = [];

      if (!snapshot) {
        this.lastSnapshot = "";
        return { active: this.activeText, completed, changed: false };
      }
      if (snapshot === this.lastSnapshot) {
        return { active: this.activeText, completed, changed: false };
      }

      const visible = splitEmbeddedSentences(snapshot);
      if (visible.completed.length > 0) {
        if (!this.activeText) {
          completed.push(...visible.completed);
          this.activeText = visible.active;
        } else {
          const newestVisibleCompletion = visible.completed[visible.completed.length - 1];
          const completionMatchesActive = areCaptionVersions(this.activeText, newestVisibleCompletion);
          const completionIsNew = !snapshotContainsSentence(this.lastSnapshot, newestVisibleCompletion);

          if (completionMatchesActive || completionIsNew) {
            for (const earlier of visible.completed.slice(0, -1)) {
              if (!snapshotContainsSentence(this.lastSnapshot, earlier)) {
                completed.push(earlier);
              }
            }
            completed.push(mergeCaptionText(this.activeText, newestVisibleCompletion));
            this.activeText = visible.active;
          } else if (visible.active) {
            this.activeText = mergeCaptionText(this.activeText, visible.active);
          }
        }
      } else if (!this.activeText) {
        this.activeText = visible.active;
      } else if (endsSentence(this.activeText) && !isSameSentenceRevision(this.activeText, visible.active)) {
        const nextText = textAfterCompletedSentence(this.activeText, visible.active);
        if (nextText) {
          completed.push(this.activeText);
          this.activeText = nextText;
        }
      } else {
        this.activeText = mergeCaptionText(this.activeText, visible.active);
      }
      this.lastSnapshot = snapshot;

      return {
        active: this.activeText,
        completed,
        changed: previousActive !== this.activeText || completed.length > 0
      };
    }
  }

  const api = Object.freeze({
    normalizeText,
    endsSentence,
    captionSettleDelay,
    captionCompletionDelay,
    latestCompleteSentence,
    mergeCaptionText,
    textAfterCompletedSentence,
    SentenceBuffer
  });

  root.CaptionSentenceAssembler = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
