// Long, identical paragraphs arriving back-to-back are a model loop. Keep
// only the current paragraph and its predecessor so detection is independent
// of transport chunk boundaries and memory stays bounded.
const MIN_PARAGRAPH_LENGTH = 160;
const MAX_PARAGRAPH_LENGTH = 4096;

export function createStreamRepetitionGuard() {
  let paragraph = "";
  let previous = "";
  let consecutive = 0;
  let overflow = false;
  let lastWasNewline = false;

  return {
    push(delta: string): boolean {
      for (const char of delta) {
        if (char === "\r") continue;
        if (char === "\n") {
          if (lastWasNewline && paragraph) {
            const complete = paragraph.trim();
            if (!overflow && complete.length >= MIN_PARAGRAPH_LENGTH) {
              consecutive = complete === previous ? consecutive + 1 : 1;
              previous = complete;
              if (consecutive >= 3) return true;
            } else {
              previous = "";
              consecutive = 0;
            }
            paragraph = "";
            overflow = false;
          } else if (!lastWasNewline && paragraph.length < MAX_PARAGRAPH_LENGTH) {
            paragraph += "\n";
          }
          lastWasNewline = true;
          continue;
        }
        lastWasNewline = false;
        if (!overflow) {
          if (paragraph.length < MAX_PARAGRAPH_LENGTH) paragraph += char;
          else overflow = true;
        }
      }
      return false;
    },
  };
}
