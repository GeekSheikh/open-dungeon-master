import type { ClassRole } from "@/lib/srd/class-roles";

// "How do you want to play?", for someone who does not yet know a class by
// its name: each answer is a job at the table in plain words, the class
// roles it means (src/lib/srd/class-roles.ts), and the classes a first
// character of that kind usually starts with. Suggestions only: the whole
// catalog stays below, and nothing is picked until the player picks it.
// Pure, for scripts/test-builder-playstyles.mjs.

export type PlaystyleId = "front" | "hit" | "magic" | "help" | "sneak";

export const PLAYSTYLES: ReadonlyArray<{ id: PlaystyleId; label: string; blurb: string; roles: ClassRole[]; first: string[] }> = [
  { id: "front", label: "Stand in front", blurb: "Take the hits and keep the others safe.", roles: ["Tank"], first: ["fighter", "barbarian", "paladin"] },
  { id: "hit", label: "Hit hard", blurb: "End fights fast, up close or from afar.", roles: ["DPS"], first: ["fighter", "ranger", "warlock", "rogue"] },
  { id: "magic", label: "Cast spells", blurb: "Bend the battle with magic.", roles: ["Control"], first: ["wizard", "sorcerer", "warlock"] },
  { id: "help", label: "Help my friends", blurb: "Heal, protect and lift the party.", roles: ["Healer", "Support"], first: ["cleric", "bard", "druid"] },
  { id: "sneak", label: "Sneak and solve", blurb: "Scout ahead, pick locks, talk your way through.", roles: ["Utility"], first: ["rogue", "ranger", "bard"] },
];

// Classes with the fewest choices to manage in play: a good first
// character, which is not the same as one that fits this world (the
// setting's own star says that).
export const EASY_CLASSES: ReadonlySet<string> = new Set(["fighter", "barbarian", "rogue", "cleric"]);

// Up to three classes this table offers for a playstyle: the usual starts
// first, then any other offered class whose role matches (a world pack's or
// a workshop's own classes), in the order given.
export function playstyleSuggestions(
  playstyle: PlaystyleId,
  offered: ReadonlyArray<{ id: string; roles: readonly string[] }>,
  limit = 3,
): string[] {
  const style = PLAYSTYLES.find((entry) => entry.id === playstyle);
  if (!style) return [];
  const ids = new Set(offered.map((entry) => entry.id));
  const usual = style.first.filter((id) => ids.has(id));
  const more = offered
    .filter((entry) => !usual.includes(entry.id) && entry.roles.some((role) => (style.roles as readonly string[]).includes(role)))
    .map((entry) => entry.id);
  return [...usual, ...more].slice(0, limit);
}
