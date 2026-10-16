"use client";

import { BookOpenText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { KitButton } from "@/app/campaigns/[campaignId]/PanelKit";

// The way between a record's own tool and its WorldForge entry, both ways
// (audit finding WF-11; the URL is src/lib/workshop/links.ts). The native
// panels take these only in the workshop: at the table they render as
// they always have.

// A record's own tool, asked to open one record on arrival: opened once,
// as soon as the record has loaded, and not again if the author closes it.
export function useOpenOnArrival<T extends { id: string }>(openId: string | null | undefined, records: T[] | null, open: (record: T) => void) {
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!openId || opened.current === openId || !records) return;
    const record = records.find((entry) => entry.id === openId);
    if (!record) return;
    opened.current = openId;
    open(record);
  }, [openId, records, open]);
}

// "World entry": the record's WorldForge page.
export function WorldEntryLink({ onOpen }: { onOpen: () => void }) {
  return (
    <KitButton tone="small" onClick={onOpen} title="Open this record's WorldForge entry" data-testid="world-entry-link">
      <BookOpenText className="size-3.5" /> World entry
    </KitButton>
  );
}

// The World entries that link to one playable record (audit finding WF-17,
// src/app/api/campaigns/[campaignId]/world/bindings), as names.
export async function linkedEntries(campaignId: string, kind: "monster" | "item", ref: string): Promise<Array<{ ref: string; name: string }>> {
  try {
    const response = await fetch(`/api/campaigns/${campaignId}/world/bindings?kind=${kind}&ref=${encodeURIComponent(ref)}`);
    const data = (await response.json().catch(() => ({}))) as { entries?: Array<{ ref: string; name: string }> };
    return response.ok ? data.entries ?? [] : [];
  } catch {
    return [];
  }
}

// "Used in the World by": each linked entry, a way back to it.
// `record` is the linked record's ref ("homebrew:<id>"); React keeps the
// name "ref" for itself.
export function LinkedEntries({ campaignId, kind, record, onWorldEntry }: { campaignId: string; kind: "monster" | "item"; record: string; onWorldEntry: (entryRef: string) => void }) {
  const [entries, setEntries] = useState<Array<{ ref: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    void linkedEntries(campaignId, kind, record).then((found) => {
      if (!cancelled) setEntries(found);
    });
    return () => {
      cancelled = true;
    };
  }, [campaignId, kind, record]);
  if (!entries.length) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-stone-400" data-testid="linked-entries">
      <span>Used in the World by</span>
      {entries.map((entry) => (
        <KitButton key={entry.ref} tone="small" onClick={() => onWorldEntry(entry.ref)}>
          <BookOpenText className="size-3.5" /> {entry.name}
        </KitButton>
      ))}
    </div>
  );
}
