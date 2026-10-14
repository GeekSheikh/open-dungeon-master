// A turn parked on a player's physical dice, across a server restart. The
// parked roll's row was already shown to survive a restart
// (test-enforce-persistence), and answering one was tested in a process
// that never restarted (test-enforce-player-word); nothing joined the two.
// That is the case real-dice tables hit: the host restarts the server while
// a player is still finding their d20, and the roll they type afterwards
// has to finish the turn, once, from the conversation the database kept.
//
// The restart closes the database handle (the file stays) and wipes the
// DM's in-memory state, the queue, the status and the turn bookkeeping, as
// a new process starts without them. The scripted fake model stands in for
// the backend, which a server restart does not touch.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { call as callRoute } from "./lib/enforce-campaign.mjs";
import { call, fakeModel, reply } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-real-dice-restart");

const { getDatabase } = await import("../src/lib/db/core.ts");
const { setMemberRealDice } = await import("../src/lib/db/campaigns.ts");
const { getDmTurn, getLatestDmTurnId, listOpenPendingRolls } = await import("../src/lib/db/dm-turns.ts");
const { listRecentMessages } = await import("../src/lib/db/messages.ts");
const { dmQueueDepth } = await import("../src/lib/dm/queue.ts");
const { getDmStatus } = await import("../src/lib/dm/status.ts");

// What a restart takes: the database handle (the file stays, and the next
// query reopens it and runs the boot migrations) and every bit of DM state
// a process holds in memory.
const IN_MEMORY = [
  "__odmDmQueues",
  "__odmDmDepths",
  "__odmDmDropped",
  "__odmDmPauses",
  "__odmDmStatus",
  "__odmTurnRequested",
  "__odmNarrationSlots",
  "__odmChapterPacing",
  "__odmCompaction",
];
function restart() {
  getDatabase().close();
  globalThis.__localRoleplayDb = undefined;
  for (const key of IN_MEMORY) {
    globalThis[key] = undefined;
  }
  getDatabase().prepare("SELECT 1").get();
}

async function settle(campaignId, ms = 30_000) {
  const until = Date.now() + ms;
  while (dmQueueDepth(campaignId) > 0) {
    if (Date.now() > until) {
      throw new Error(`the DM queue for ${campaignId} never ran dry`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

await test("A roll parked for a player's own dice survives a restart, and the roll they enter afterwards finishes the turn once, from where it stopped.", async () => {
  // A table that lets players roll their own dice, and a player who does.
  const world = await openWorld({ gameSettings: { ttsEnabled: false, dicePolicy: "real_allowed" } });
  const kara = world.addHero({ name: "Kara", class: "fighter", level: 1, abilities: { str: 16 } });
  const userId = world.sheet(kara.id).userId;
  const submitRoute = await world.route("campaigns/[campaignId]/pending-rolls/[pendingRollId]");
  const model = await fakeModel();
  model.pointAt(world);
  setMemberRealDice(world.campaignId, userId, true);

  model.script([
    reply({ calls: [call("request_roll", { characterId: kara.id, kind: "saving_throw", ability: "str", dc: 12, reason: "the rusted gate swings at her" })] }),
    reply({ text: "Kara braces, and the gate slams against her shield instead of her ribs." }),
  ]);
  const before = await model.turn(world, "I put my shoulder to the crypt gate.", kara.id, userId);
  assert.equal(before, null, "the turn narrated before the roll came in");
  const turnId = getLatestDmTurnId(world.campaignId);
  assert.equal(getDmTurn(turnId).status, "awaiting_rolls");
  assert.equal(getDmStatus(world.campaignId), "awaiting_rolls");
  const [pending] = listOpenPendingRolls(world.campaignId);
  assert.ok(pending, "no roll was parked for Kara's dice");
  assert.equal(model.served(), 1);

  restart();

  // The new process finds the turn still waiting and the roll still open.
  assert.equal(getDmTurn(turnId).status, "awaiting_rolls", "the restart lost the waiting turn");
  assert.deepEqual(listOpenPendingRolls(world.campaignId).map((entry) => entry.id), [pending.id]);

  world.signIn({ id: userId });
  const answered = await callRoute(submitRoute, "POST", { dice: [15] }, { campaignId: world.campaignId, pendingRollId: pending.id });
  assert.equal(answered.status, 200, JSON.stringify(answered.json));
  await settle(world.campaignId);

  assert.equal(getDmTurn(turnId).status, "done", "the turn did not finish after the restart");
  assert.equal(getDmStatus(world.campaignId), "idle");
  assert.deepEqual(listOpenPendingRolls(world.campaignId), []);
  const said = listRecentMessages(world.campaignId, 50).filter((message) => message.authorType === "dm");
  assert.equal(said.length, 1, `expected one narration, found ${said.length}`);
  assert.match(said[0].content, /slams against her shield/);

  // It resumed rather than ran again: one more call, carrying the player's roll.
  assert.equal(model.served(), 2, "the turn's first call was made again");
  const results = model.requests
    .at(-1)
    .messages.filter((message) => message.role === "tool")
    .map((message) => JSON.parse(message.content));
  const roll = results.find((result) => result.rolledBy);
  assert.ok(roll, "the resumed call carried no roll result");
  assert.match(roll.rolledBy, /physical dice/, "the model was not told the player rolled it");
  assert.equal(roll.total, 18, "the player's 15 plus Strength 16's +3 did not reach the model");
  assert.equal(roll.success, true);

  // The same roll entered twice changes nothing.
  const twice = await callRoute(submitRoute, "POST", { dice: [15] }, { campaignId: world.campaignId, pendingRollId: pending.id });
  assert.notEqual(twice.status, 200, "a roll already answered was taken again");
  await settle(world.campaignId);
  assert.equal(listRecentMessages(world.campaignId, 50).filter((message) => message.authorType === "dm").length, 1);
  assert.equal(model.served(), 2);

  setMemberRealDice(world.campaignId, userId, false);
  model.close();
  world.close();
});

finish();
