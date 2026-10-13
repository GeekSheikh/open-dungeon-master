// A reply that is the model's note to itself about what it means to do next,
// not narration: "The quay is not on the map yet. I will set the landing and
// the hour before anyone speaks." Grok Build, run as the storyteller, ended
// its turns on notes like this (the opening scene and every reply after
// it), and they reached the table as the story. The narration is in the
// second person; the DM never speaks as "I" outside a character's quoted
// words, so first-person intent outside quotes is the tell.
//
// Pure, no "@/" imports, so a test loads it directly.

// Quoted speech belongs to whoever speaks it: "I will find your sexton,"
// says Kara. Straight and curly quotes both.
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;

// What the model says it is about to do, or asks to do, as itself.
const INTENT =
  /(?:^|[.!?:;]\s+|\n\s*)(?:i(?:'|’)ll|i will|i(?:'|’)m going to|i am going to|i(?:'|’)d better|i need to|i should|let me|first,? i|next,? i|now,? i)\b/i;

export function isPlanNote(text: string): boolean {
  const outside = text.replace(QUOTED, " ").trim();
  return Boolean(outside) && INTENT.test(outside);
}

// Sent once a turn when a reply was a plan instead of narration: do the
// thing, then tell the table.
export const PLAN_NOTE_CORRECTION =
  "[System] That reply was a note to yourself about what you plan to do; the players cannot use it and will not see it. Do it now: call the tools the scene needs, then write the narration the players read, in the second person, ending on what they decide next. Never describe your own next steps to the table.";
