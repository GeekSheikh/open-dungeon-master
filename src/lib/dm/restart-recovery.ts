import { restoreXCardPauses } from "@/lib/dm/safety";

// What a restart leaves wrong in the DM's state, put right once when a
// server process starts (src/instrumentation.ts), before it answers its
// first request. The queue, the status line and the X-card's pause live in
// memory and die with a process; the turns and the safety events are in the
// database and outlive it, so the database is read for what the memory
// held.
//
// Running once a process, before any request, is what keeps this off a
// turn a live process owns: this process has started none yet, and one
// server per database is already what the in-memory queue assumes (a
// second process on the same file would run two turns at once regardless).
// Under `next dev` the flag on globalThis keeps a reloaded module from
// running it again.

declare global {
  var __odmDmRecovered: boolean | undefined;
}

export type RestartRecovery = {
  // Tables whose raised X-card was raised again.
  xCards: number;
};

export function recoverDmAfterRestart(): RestartRecovery | null {
  if (globalThis.__odmDmRecovered) {
    return null;
  }
  globalThis.__odmDmRecovered = true;
  // First, so anything queued below waits at the gate the table left up.
  const xCards = restoreXCardPauses().length;
  const recovery = { xCards };
  if (xCards) {
    console.log(`[dm] after the restart: ${xCards} raised X-card(s) raised again`);
  }
  return recovery;
}
