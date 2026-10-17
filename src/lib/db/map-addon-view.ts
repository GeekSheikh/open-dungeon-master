import { getDatabase } from "@/lib/db/core";
import { parseMapAddonView, serializeMapAddonView, type MapAddonView } from "@/lib/addons/map-view";

// The addon_view_json column on prepared_maps and battle_maps
// (src/lib/addons/map-view.ts). Kept out of the two map modules, which are
// at their size, the way setPreparedMapSkin keeps the skin beside its table:
// written by its own statement after the row exists, normalized on the way
// in and on the way out.

type MapTable = "prepared_maps" | "battle_maps";

export function readMapAddonView(table: MapTable, mapId: string): MapAddonView | null {
  const row = getDatabase().prepare(`SELECT addon_view_json AS v FROM ${table} WHERE id = ?`).get(mapId) as { v: string | null } | undefined;
  return parseMapAddonView(row?.v);
}

export function writeMapAddonView(table: MapTable, mapId: string, view: MapAddonView | null): void {
  getDatabase().prepare(`UPDATE ${table} SET addon_view_json = ? WHERE id = ?`).run(serializeMapAddonView(view), mapId);
}

// Carries a map's view from one row to another: library to table on deploy,
// table to library on save, one campaign's library to another's on import.
export function copyMapAddonView(from: { table: MapTable; id: string }, to: { table: MapTable; id: string }): void {
  const view = readMapAddonView(from.table, from.id);
  if (view) writeMapAddonView(to.table, to.id, view);
}
