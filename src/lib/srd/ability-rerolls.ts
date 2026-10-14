// How freely a player may throw the 4d6 ability dice again, as one number:
// a fresh six only while the kept six add up to less than it. 0 keeps the
// first roll, 108 (six 18s) rerolls anything (issue #128). The server sets
// it for the library (Admin > Server), and a table may set its own for the
// characters made at it; a table that sets none follows the server.
//
// The number is what is stored and enforced; the words are the three ways a
// group actually plays it, so neither screen asks anyone to know that 108
// means "as often as you like". Pure, no "@/" imports, so a test can load it.

export const REROLL_NEVER = 0;
export const REROLL_ALWAYS = 108;
// ODM's own default for "reroll a poor roll" (global-config.ts).
export const REROLL_LOW_DEFAULT = 70;

export type RerollChoice = "keep" | "low" | "free";

export function rerollChoiceOf(rerollBelow: number): RerollChoice {
  if (rerollBelow <= REROLL_NEVER) {
    return "keep";
  }
  return rerollBelow >= REROLL_ALWAYS ? "free" : "low";
}

// The number a choice stores; "low" keeps a threshold already chosen.
export function rerollBelowFor(choice: RerollChoice, current: number): number {
  if (choice === "keep") {
    return REROLL_NEVER;
  }
  if (choice === "free") {
    return REROLL_ALWAYS;
  }
  return current > REROLL_NEVER && current < REROLL_ALWAYS ? current : REROLL_LOW_DEFAULT;
}

export function describeReroll(rerollBelow: number): string {
  const choice = rerollChoiceOf(rerollBelow);
  if (choice === "keep") {
    return "The first roll stands";
  }
  if (choice === "free") {
    return "Reroll as often as you like";
  }
  return `Reroll a roll totalling under ${rerollBelow}`;
}

// The rule at a table: its own when it set one, else the server's.
export function tableRerollBelow(tableSetting: number | null | undefined, serverSetting: number): number {
  return typeof tableSetting === "number" ? tableSetting : serverSetting;
}
