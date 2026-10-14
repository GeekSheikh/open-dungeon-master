// A turn parked on a player's physical dice, across a server restart. The
// parked roll's row was already shown to survive a restart
// (test-enforce-persistence), and answering one was tested in a process
// that never restarted (test-enforce-player-word); nothing joined the two.
// That is the case real-dice tables hit: the host restarts the server while
// a player is still finding their d20, and the roll they type afterwards
// has to finish the turn, once, from the conversation the database kept.
//
// The restart closes the database handle (the file stays) and wipes the
// DM's per-campaign state a process keeps on globalThis: the queue, the
// status, the turn requests, the narration slots, compaction. State a module
// holds in its own scope (chapter pacing, model-client's learned routes)
// survives this in-process restart, so the test shows the database is
// enough to resume a parked turn, not that nothing else outlives a real
// one. The scripted fake model stands in for the backend, which a server
// restart does not touch.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { call as callRoute } from "./lib/enforce-campaign.mjs";
import { call, fakeModel, reply, settleQueue } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-real-dice-restart");

const { getDatabase } = await import("../src/lib/db/core.ts");
const { setMemberRealDice } = await import("../src/lib/db/campaigns.ts");
const { createDmTurn, getDmTurn, getLatestDmTurnId, listOpenPendingRolls, saveDmTurn } = await import("../src/lib/db/dm-turns.ts");
const { listRecentMessages } = await import("../src/lib/db/messages.ts");
const { listRecentRolls } = await import("../src/lib/db/rolls.ts");
const { getDmStatus } = await import("../src/lib/dm/status.ts");

// What a restart takes: the database handle (the file stays, and the next
// query reopens it and runs the boot migrations) and the DM's maps on
// globalThis, which every caller reads afresh. Chapter pacing is not wiped
// here: chapter-close.ts keeps its own reference to the map from load time,
// so clearing the global would change nothing.
const IN_MEMORY = [
  "__odmDmQueues",
  "__odmDmDepths",
  "__odmDmDropped",
  "__odmDmPauses",
  "__odmDmStatus",
  "__odmTurnRequested",
  "__odmNarrationSlots",
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

await test("A roll parked for a player's own dice survives a restart, and the roll they enter afterwards finishes the turn once, from where it stopped.", async () => {
  // A table that lets players roll their own dice, and a player who does.
  const world = await openWorld({ gameSettings: { ttsEnabled: false, dicePolicy: "real_allowed" } });
  const kara = world.addHero({ name: "Kara", class: "fighter", level: 1, abilities: { str: 16 } });
  const userId = world.sheet(kara.id).userId;
  const submitRoute = await world.route("campaigns/[campaignId]/pending-rolls/[pendingRollId]");
  const model = await fakeModel();
  model.pointAt(world);
  setMemberRealDice(world.campaignId, userId, true);

  // The DM narrates the setup and asks for the roll in one reply, as real
  // models usually do: that prose is already on the turn when it parks.
  model.script([
    reply({
      text: "The rusted gate groans and swings for Kara.",
      calls: [call("request_roll", { characterId: kara.id, kind: "saving_throw", ability: "str", dc: 12, reason: "the rusted gate swings at her" })],
    }),
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

  // The new process finds the turn still waiting and the roll still open,
  // and the table still reads as waiting on them.
  assert.equal(getDmTurn(turnId).status, "awaiting_rolls", "the restart lost the waiting turn");
  assert.deepEqual(listOpenPendingRolls(world.campaignId).map((entry) => entry.id), [pending.id]);
  assert.equal(getDmStatus(world.campaignId), "awaiting_rolls", "the restart reset a parked table to idle");

  world.signIn({ id: userId });
  const answered = await callRoute(submitRoute, "POST", { dice: [15] }, { campaignId: world.campaignId, pendingRollId: pending.id });
  assert.equal(answered.status, 200, JSON.stringify(answered.json));
  await settleQueue(world.campaignId);

  assert.equal(getDmTurn(turnId).status, "done", "the turn did not finish after the restart");
  assert.equal(getDmStatus(world.campaignId), "idle");
  assert.deepEqual(listOpenPendingRolls(world.campaignId), []);
  const said = listRecentMessages(world.campaignId, 50).filter((message) => message.authorType === "dm");
  assert.equal(said.length, 1, `expected one narration, found ${said.length}`);
  assert.match(said[0].content, /rusted gate groans/, "the prose written before the park was lost");
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

  // The same roll entered twice changes nothing: it is refused as already
  // resolved, and refused before a second roll row reaches the roll log.
  const rollsBefore = listRecentRolls(world.campaignId, 50).length;
  const twice = await callRoute(submitRoute, "POST", { dice: [15] }, { campaignId: world.campaignId, pendingRollId: pending.id });
  assert.equal(twice.status, 409, JSON.stringify(twice.json));
  assert.equal(listRecentRolls(world.campaignId, 50).length, rollsBefore, "the second submit recorded a roll");
  await settleQueue(world.campaignId);
  assert.equal(listRecentMessages(world.campaignId, 50).filter((message) => message.authorType === "dm").length, 1);
  assert.equal(model.served(), 2);

  setMemberRealDice(world.campaignId, userId, false);
  model.close();
  world.close();
});

// A table with one narration behind it and a turn parked on Kara's own d20.
async function parkedTable() {
  const world = await openWorld({ gameSettings: { ttsEnabled: false, dicePolicy: "real_allowed" } });
  const kara = world.addHero({ name: "Kara", class: "fighter", level: 1, abilities: { str: 16 } });
  const userId = world.sheet(kara.id).userId;
  const model = await fakeModel();
  model.pointAt(world);
  setMemberRealDice(world.campaignId, userId, true);
  model.script([
    reply({ text: "The crypt is quiet, and the gate is rusted shut." }),
    reply({ calls: [call("request_roll", { characterId: kara.id, kind: "saving_throw", ability: "str", dc: 12, reason: "the gate" })] }),
    reply({ text: "Kara braces, and the gate slams against her shield." }),
  ]);
  await model.turn(world, "I look around.", kara.id, userId);
  await model.turn(world, "I put my shoulder to the crypt gate.", kara.id, userId);
  const turnId = getLatestDmTurnId(world.campaignId);
  assert.equal(getDmTurn(turnId).status, "awaiting_rolls");
  const [pending] = listOpenPendingRolls(world.campaignId);
  assert.ok(pending, "no roll was parked for Kara's dice");
  return { world, kara, userId, model, turnId, pending };
}

// The lead's continue and reroll on the newest narration, as the table's
// buttons send them.
async function extendAndReroll(world) {
  const latest = listRecentMessages(world.campaignId, 50).filter((message) => message.authorType === "dm").at(-1);
  const params = { campaignId: world.campaignId, messageId: latest.id };
  world.signIn(world.owner);
  const extended = await callRoute(await world.route("campaigns/[campaignId]/messages/[messageId]/continue"), "POST", {}, params);
  const rerolled = await callRoute(await world.route("campaigns/[campaignId]/messages/[messageId]/renarrate"), "POST", { action: "reroll" }, params);
  await settleQueue(world.campaignId);
  return [extended.status, rerolled.status];
}

await test("A table parked on physical dice reads as waiting on them after a restart, and continue and reroll refuse as they did before it.", async () => {
  const { world, model } = await parkedTable();
  assert.equal(getDmStatus(world.campaignId), "awaiting_rolls");
  assert.deepEqual(await extendAndReroll(world), [409, 409], "continue or reroll ran while the turn waited on dice");
  restart();
  assert.equal(getDmStatus(world.campaignId), "awaiting_rolls", "the restart reset a parked table to idle");
  const snapshot = await callRoute(await world.route("campaigns/[campaignId]"), "GET", undefined, { campaignId: world.campaignId });
  assert.equal(snapshot.json.dmStatus, "awaiting_rolls", "a client reloading after the restart lost the waiting status");
  const served = model.served();
  assert.deepEqual(await extendAndReroll(world), [409, 409], "continue or reroll ran while the turn waited on dice");
  assert.equal(model.served(), served, "a model call ran while the turn waited on dice");
  model.close();
  world.close();
});

await test("A parked turn the table walked past reads idle after a restart, as it did before; a person's adjudication after the park does not hide one still waiting.", async () => {
  const { world, kara, userId, model } = await parkedTable();
  // A person's adjudication opens a turn of its own without touching the
  // status line (an opportunity strike, a zone, the console).
  const person = createDmTurn(world.campaignId, [], "human_dm");
  person.status = "done";
  saveDmTurn(person);
  restart();
  assert.equal(getDmStatus(world.campaignId), "awaiting_rolls", "a person's adjudication hid the parked turn");

  // Kara ignores the roll card and acts instead: the new turn answers her,
  // and the parked one is behind the story.
  model.script([reply({ text: "Kara steps back from the gate and studies the hinges." })]);
  await model.turn(world, "Never mind the gate; I look at the hinges.", kara.id, userId);
  assert.equal(getDmStatus(world.campaignId), "idle");
  assert.deepEqual(await extendAndReroll(world), [200, 200]);
  restart();
  assert.equal(getDmStatus(world.campaignId), "idle", "the restart put a walked-past roll back on the status line");
  model.script([reply({ text: "The hinges are old iron, flaked with rust." }), reply({ text: "Rust flakes from old iron hinges." })]);
  assert.deepEqual(await extendAndReroll(world), [200, 200], "continue or reroll was refused for a roll the table walked past");

  // A monster pass a person delegated parks without ever owning the line.
  const pass = createDmTurn(world.campaignId, [], "ai");
  pass.status = "awaiting_rolls";
  saveDmTurn(pass);
  restart();
  assert.equal(getDmStatus(world.campaignId), "idle", "a delegated monster pass put itself on the status line");
  model.close();
  world.close();
});

finish();
