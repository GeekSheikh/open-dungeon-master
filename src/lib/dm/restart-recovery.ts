import { getCampaignById } from "@/lib/db/campaigns";
import { listRunningAiTurns, saveDmTurn } from "@/lib/db/dm-turns";
import { isAgentTurn } from "@/lib/dm/agent-turn";
import { restoreXCardPauses } from "@/lib/dm/safety";
import { haltDmTurn } from "@/lib/dm/turn";

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

// What the table reads in the notice of a turn a restart cut short.
export const RESTART_HALT = "The server restarted while the Dungeon Master was working on this turn.";

export type RestartRecovery = {
  // Tables whose raised X-card was raised again.
  xCards: number;
  // Turns the last process was running, now failed with a Retry notice.
  halted: number;
};

export function recoverDmAfterRestart(): RestartRecovery | null {
  if (globalThis.__odmDmRecovered) {
    return null;
  }
  globalThis.__odmDmRecovered = true;
  // First, so anything queued below waits at the gate the table left up.
  const xCards = restoreXCardPauses().length;
  const halted = haltInterruptedTurns();
  const recovery = { xCards, halted };
  if (xCards || halted) {
    console.log(
      `[dm] after the restart: ${xCards} raised X-card(s) raised again, ${halted} interrupted turn(s) halted for Retry`,
    );
  }
  return recovery;
}

// No process owns a 'running' AI turn once the one running it has stopped:
// its model call and its queue job died with it. Left alone, such a turn
// refuses Retry as already being worked on, and the next player action
// reaps it ten minutes on (failStaleRunningTurns), silently and behind a
// newer turn, so Retry is refused again as the story having moved on, and a
// physical roll it was resuming with is never narrated. So the
// storyteller's turn gets the notice finalize writes for a turn that
// failed, with the link that offers the lead Retry, and the retry answers
// any roll call left dangling from the rolls already in
// (src/lib/dm/retry-turn.ts).
//
// A turn with no conversation (a monster pass a person delegated) has
// nothing to retry and is closed as failed without a notice, as is a turn
// at a table no longer playing. An agent program's turn is left alone: the
// program outlives the restart and its next call carries on with it.
function haltInterruptedTurns(): number {
  let halted = 0;
  for (const turn of listRunningAiTurns()) {
    if (isAgentTurn(turn)) {
      continue;
    }
    const storyteller = turn.conversation[0]?.role === "system";
    if (storyteller && getCampaignById(turn.campaignId)?.status === "active") {
      haltDmTurn(turn.campaignId, turn, RESTART_HALT);
      halted += 1;
      continue;
    }
    turn.status = "failed";
    saveDmTurn(turn);
  }
  return halted;
}
