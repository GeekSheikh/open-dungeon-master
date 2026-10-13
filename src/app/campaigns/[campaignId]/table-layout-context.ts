"use client";

import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";
import type { PaneId } from "@/lib/table-layout";

// What the table's row (TableLayout.tsx) tells the panels inside it: the
// side panel's widen button, the fight stage's scroll, and which panes are
// on screen. Its own file so the panels and the row's parts can read it
// without importing the row.

export type LayoutApi = {
  // A window wide enough for columns (64rem): the arrangement applies.
  active: boolean;
  locked: boolean;
  editing: boolean;
  // The side panel's widen button, where the panel is a column of its own.
  canWiden: boolean;
  panelWide: boolean;
  setPanelWide: (wide: boolean) => void;
  // The fight stage's scroll (SessionView's ChronicleSplitter).
  chronicle: number | null;
  previewChronicle: (width: number) => void;
  commitChronicle: (width: number) => void;
};

export const LayoutApiContext = createContext<LayoutApi | null>(null);
// The panes on screen now. A panel out of sight rests its animation loops
// on this, the way a phone's hidden side panel does.
export const ShownContext = createContext<ReadonlySet<PaneId> | null>(null);

export function useTableLayoutApi(): LayoutApi | null {
  return useContext(LayoutApiContext);
}

export function usePaneShown(id: PaneId): boolean {
  const shown = useContext(ShownContext);
  return shown ? shown.has(id) : true;
}

const WIDE_QUERY = "(min-width: 64rem)";

function subscribeWide(callback: () => void) {
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

// Wide enough for the arrangement. Not useDocked: a fold opened flat docks
// its two leaves at any width, and its leaves are the arrangement there.
export function useWideTable(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches, () => true);
}

// An element's inner size, measured before paint and again whenever it
// changes, so the row lays its panes out in the space it really has.
export function useBoxSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
