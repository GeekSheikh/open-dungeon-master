import { raceMechanics } from "@/lib/content/mechanics";
import { byName } from "@/lib/language/text-logic";

// The traits a workshop species can borrow from the published ones: the
// species editor's "Add a published trait". A trait named as published is
// what the engine runs (src/lib/srd/race-id.ts speciesHoldsTrait), so a
// homebrew Half-Dragon that borrows the Dragonborn's Draconic Ancestry and
// Breath Weapon asks its player for a dragon and breathes as one. Pure, for
// the editor and the tests alike.

export type PublishedTrait = { name: string; text: string; from: string[] };

// A trait paragraph per name, out of a race's markdown: "**_Keen Senses._**
// You have proficiency..." and "***Brave.*** You have advantage..." both.
const TRAIT_LINE = /^(?:\*\*\*|\*\*_)(.+?)(?:\*\*\*|_\*\*)\s*(.*)$/;

export function traitParagraphs(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const line of String(markdown ?? "").split("\n")) {
    const head = TRAIT_LINE.exec(line.trim());
    if (head) {
      current = head[1].replace(/\.$/, "").trim();
      out.set(current, head[2].trim());
    } else if (current && line.trim()) {
      out.set(current, `${out.get(current)} ${line.trim()}`.trim());
    }
  }
  return out;
}

// Every trait the catalog's species print, once per name, with the species
// that print it, by name.
export function publishedTraits(rows: Array<{ name: string; traits: string }>): PublishedTrait[] {
  const found = new Map<string, PublishedTrait>();
  for (const row of rows) {
    for (const [name, text] of traitParagraphs(row.traits)) {
      const held = found.get(name.toLowerCase());
      if (!held) {
        found.set(name.toLowerCase(), { name, text, from: [row.name] });
        continue;
      }
      if (!held.from.includes(row.name)) held.from.push(row.name);
      if (!held.text) held.text = text;
    }
  }
  return [...found.values()].sort(byName);
}

// The trait names the engine reads off a species's text, as the builder and
// the server read them (raceMechanics).
export function heldTraitNames(traits: string): string[] {
  return raceMechanics({ traits }).traitNames;
}

// The text with one trait more, in the book's words, unless the species
// already holds one of that name.
export function withTrait(traits: string, trait: Pick<PublishedTrait, "name" | "text">): string {
  const wanted = trait.name.toLowerCase();
  if (heldTraitNames(traits).some((name) => name.toLowerCase() === wanted)) {
    return traits;
  }
  const paragraph = `**_${trait.name}._** ${trait.text}`.trim();
  return traits.trim() ? `${traits.trimEnd()}\n\n${paragraph}` : paragraph;
}
