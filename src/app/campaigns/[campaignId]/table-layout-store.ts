"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createValueStore } from "@/app/campaigns/[campaignId]/liveStore";
import {
  defaultTableLayout,
  isPaneHidden,
  normalizeTableLayout,
  setPaneHidden,
  type PaneId,
  type TableLayout,
} from "@/lib/table-layout";

// Where this browser keeps the table's arrangement (src/lib/table-layout.ts).
// One per seat: the DM's console and a player's table want different
// things, and the same browser may sit in either. Only this browser's
// localStorage ever holds it; the campaign, the server and the other seats
// never see it. Read as an external store, the way the table's other
// device preferences are (SessionView.tsx), so a render never touches
// localStorage and every reader follows a change at once.
export type LayoutSeat = "player" | "dm";

const KEY_PREFIX = "odm:table-layout:";
const EVENT = "odm-table-layout";
// The side panel's widen button before there was an arrangement: a browser
// that widened the panel keeps it wide until it saves an arrangement.
const LEGACY_WIDE_KEY = "odm_side_panel_wide";

const SERVER_LAYOUT = defaultTableLayout();
const cache = new Map<LayoutSeat, TableLayout>();

function read(seat: LayoutSeat): TableLayout {
  let layout = cache.get(seat);
  if (!layout) {
    let raw: unknown = null;
    let wide = false;
    try {
      const text = window.localStorage.getItem(KEY_PREFIX + seat);
      wide = window.localStorage.getItem(LEGACY_WIDE_KEY) === "1";
      raw = text ? JSON.parse(text) : null;
    } catch {
      raw = null;
    }
    layout = normalizeTableLayout(raw, defaultTableLayout(wide));
    cache.set(seat, layout);
  }
  return layout;
}

function subscribe(callback: () => void) {
  // Another tab of this browser saved one: read it again.
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(KEY_PREFIX)) {
      cache.clear();
      callback();
    }
  };
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", storage);
  };
}

export function useTableLayout(seat: LayoutSeat): TableLayout {
  return useSyncExternalStore(subscribe, () => read(seat), () => SERVER_LAYOUT);
}

// Saves an arrangement, or an edit of the current one. Kept in memory as
// well, so a browser that refuses the write (a private window out of room)
// still draws what was asked for until the page closes.
export function saveTableLayout(seat: LayoutSeat, next: TableLayout | ((current: TableLayout) => TableLayout)) {
  const current = read(seat);
  const layout = typeof next === "function" ? next(current) : next;
  if (layout === current) return;
  cache.set(seat, layout);
  try {
    window.localStorage.setItem(KEY_PREFIX + seat, JSON.stringify(layout));
  } catch {
    // Kept for this page only.
  }
  window.dispatchEvent(new Event(EVENT));
}

// Back to the table's own arrangement, the side panel at its first width.
// Written rather than removed, so the old widen key cannot bring 30rem back.
export function resetTableLayout(seat: LayoutSeat) {
  saveTableLayout(seat, defaultTableLayout());
  setLayoutSession({ editing: false, maximized: null });
}

// ---- this visit only: arranging, a pane maximized, a pane just revealed ----

export type LayoutSession = {
  editing: boolean;
  maximized: PaneId | null;
  // A pane asked for from somewhere else (a party card, a tour step, a
  // fight starting) lights up for a moment so the eye finds it.
  flash: { id: PaneId; at: number } | null;
};

const SERVER_SESSION: LayoutSession = { editing: false, maximized: null, flash: null };
const sessionStore = createValueStore<LayoutSession>(SERVER_SESSION);

export function useLayoutSession(): LayoutSession {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.get, () => SERVER_SESSION);
}

export function setLayoutSession(patch: Partial<LayoutSession>) {
  sessionStore.set({ ...sessionStore.get(), ...patch });
}

export function setArranging(editing: boolean) {
  setLayoutSession(editing ? { editing, maximized: null } : { editing });
}

// Shows a pane that was set aside and lights it, for whatever asked to see
// what it holds.
export function revealPane(seat: LayoutSeat, id: PaneId) {
  if (isPaneHidden(read(seat), id)) {
    saveTableLayout(seat, (current) => setPaneHidden(current, id, false));
  }
  const { maximized } = sessionStore.get();
  setLayoutSession({ flash: { id, at: Date.now() }, maximized: maximized === id ? id : null });
}

// What this visit's state does over time: leaving the table ends arranging
// and any maximize, a lit pane goes dark again, and Escape (a controller's
// B too, which the apps send as Escape) puts a maximized pane back, then
// ends arranging. Escape is claimed when it does, so it never also leaves
// the table; a dialog, menu or tour on screen hears it first (some stay
// mounted while closed, so only one actually drawn counts).
export function useLayoutSessionEffects({
  maximized,
  editing,
  flash,
}: {
  maximized: PaneId | null;
  editing: boolean;
  flash: LayoutSession["flash"];
}) {
  useEffect(() => () => setLayoutSession({ editing: false, maximized: null, flash: null }), []);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setLayoutSession({ flash: null }), 1600);
    return () => window.clearTimeout(timer);
  }, [flash]);
  useEffect(() => {
    if (!maximized && !editing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const layers = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [data-guided-tour]');
      if ([...layers].some((layer) => layer.getClientRects().length > 0)) return;
      event.preventDefault();
      if (maximized) setLayoutSession({ maximized: null });
      else setArranging(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized, editing]);
}
