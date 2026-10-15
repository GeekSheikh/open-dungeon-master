// Three kinds of "no" come back from a tool, and the model must treat them
// differently. A retry is a mistake in the call (a wrong id, a missing field,
// a choice only the player can make): nothing happened, so the model fixes
// the call, asks the player, or resends it without the part that cannot
// apply, and never narrates it. A rules refusal is the game saying no (no
// slot left, not their turn, out of reach): nothing was attempted either,
// and the model tells the table why and what they can do. A limit is the
// turn's budget for that kind of call: nothing more runs, so the model
// narrates what has resolved.
//
// Each error states its kind where its sentence is written, in the keys the
// model reads (retry: true, refused: "rules" | "limit"), so a reworded
// sentence keeps its kind and an error without one does not compile.

export type ToolError = { error: string; retry: true } | { error: string; refused: "rules" | "limit" };

// What a tool handler hands back: an error with its kind, or a result that
// is not an error.
export type ToolResult = (ToolError & { [key: string]: unknown }) | { [key: string]: unknown; error?: undefined };

// The error and its kind alone, out of an engine result that carries them
// among fields of its own (canAct's reason, a budget's ok: false), which are
// not the model's to read.
export function toolError(refusal: ToolError): ToolError {
  return "retry" in refusal ? { error: refusal.error, retry: true } : { error: refusal.error, refused: refusal.refused };
}
