import { resolveMonster } from "@/lib/bestiary/index";
import { getEntryDetail } from "@/lib/content/index";
import { getCampaignById } from "@/lib/db/campaigns";
import { getDatabase } from "@/lib/db/core";
import { getHomebrew, tableAuthors } from "@/lib/db/homebrew";
import { parseRef, type Binding, type WorldDoc } from "@/lib/worldforge/model";

// A World entry's links to playable records, read (audit finding WF-17).
// A binding stores the ref the rest of the app uses for the record
// (src/lib/worldforge/model.ts Binding); here it is resolved the way play
// resolves it, against the authors of the table (src/lib/db/homebrew.ts
// tableAuthors), so a link is good exactly when the record is usable here.

export type BoundRecord = {
  kind: Binding["kind"];
  ref: string;
  // What the record is called, and a short line about it ("CR 2", "Your
  // own item"). Empty when the record cannot be found.
  name: string;
  detail: string;
  // The author's own record: its homebrew id, for opening it in its tool.
  // "" for a rulebook record.
  ownId: string;
  found: boolean;
};

const HOMEBREW = "homebrew:";

export function resolveBinding(campaignId: string, binding: Binding): BoundRecord {
  const ownId = binding.ref.startsWith(HOMEBREW) && !binding.ref.startsWith(`${HOMEBREW}@`) ? binding.ref.slice(HOMEBREW.length) : "";
  const missing: BoundRecord = { ...binding, name: "", detail: "", ownId, found: false };
  const campaign = getCampaignById(campaignId);
  if (!campaign) return missing;
  const authors = tableAuthors(campaignId);
  if (binding.kind === "monster") {
    const monster = resolveMonster(binding.ref, campaign.gameSettings, { userIds: authors });
    // A homebrew ref is that row or nothing; a rulebook slug is its entry.
    if (!monster || (ownId && monster.slug !== binding.ref)) return missing;
    const cr = (monster.stats as { cr?: unknown }).cr;
    return { ...binding, name: monster.reskinName ?? monster.baseName, detail: cr === undefined || cr === null ? "" : `CR ${String(cr)}`, ownId, found: true };
  }
  if (ownId) {
    for (const author of authors) {
      const item = getHomebrew(author, ownId);
      if (item && item.kind === "item") return { ...binding, name: item.name, detail: "Your own item", ownId, found: true };
    }
    return missing;
  }
  try {
    const item = getEntryDetail("items", binding.ref);
    return item ? { ...binding, name: item.name, detail: "From the rulebook", ownId, found: true } : missing;
  } catch {
    // No content pack on this server: a rulebook item cannot be read.
    return missing;
  }
}

// The World entries that link to one record, for the record's own tool:
// "used by" and the way back to each entry.
// The caller hands over the campaign's document (src/lib/db/world-forge.ts
// getWorldDoc), which reads this module.
export function entriesBoundTo(campaignId: string, doc: WorldDoc, kind: Binding["kind"], ref: string): Array<{ ref: string; name: string }> {
  const out: Array<{ ref: string; name: string }> = [];
  for (const [entryRef, entry] of Object.entries(doc.entries)) {
    if (!entry.bindings.some((binding) => binding.kind === kind && binding.ref === ref)) continue;
    const parsed = parseRef(entryRef);
    if (!parsed) continue;
    const table = parsed.shelf === "npc" ? "npcs" : parsed.shelf === "location" ? "locations" : parsed.shelf === "faction" ? "factions" : "lore_entries";
    const column = parsed.shelf === "lore" ? "title" : "name";
    const row = getDatabase().prepare(`SELECT ${column} AS name FROM ${table} WHERE id = ? AND campaign_id = ?`).get(parsed.id, campaignId) as { name?: string } | undefined;
    if (row?.name) out.push({ ref: entryRef, name: row.name });
  }
  return out;
}
