"use client";

import { BookOpenText } from "lucide-react";
import { useEffect, useRef } from "react";
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
