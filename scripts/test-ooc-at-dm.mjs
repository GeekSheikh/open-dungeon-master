// Table talk put to the DM ("@DM can I jump that gap?") is answered at once,
// out of character, instead of waiting for the next move anyone makes
// (src/lib/dm/ooc-question.ts, answerOutOfCharacter in src/lib/dm/turn.ts).
// Table talk without "@DM" still wakes nothing, and the answer spends
// nothing a turn would: no tools, no turn row, no pointer moved in a fight.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { fakeModel, reply } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-ooc-at-dm");

const { addressesDm, oocQuestionPending, oocAnswer, OOC_ANSWER_INSTRUCTION } = await import("../src/lib/dm/ooc-question.ts");
const { listRecentMessages } = await import("../src/lib/db/messages.ts");
const { getLatestDmTurnId } = await import("../src/lib/db/dm-turns.ts");
const { dmQueueDepth } = await import("../src/lib/dm/queue.ts");
const { getDmStatus } = await import("../src/lib/dm/status.ts");

await test("@DM is a word anywhere in the line, any case; an email address or a word that only starts with it is not.", () => {
  for (const line of ["@DM can I jump that gap?", "quick one @dm, does the guard look nervous?", "(@DM) is it night yet", "ok @Dm: rules question"]) {
    assert.equal(addressesDm(line), true, line);
  }
  for (const line of ["is anyone hungry", "mail me at kara@dm.example", "@dmitri you're up", "the DM said so"]) {
    assert.equal(addressesDm(line), false, line);
  }
});

await test("Only table talk since the DM last spoke, one line naming the DM, makes the turn an answer.", () => {
  const dm = { authorType: "dm", content: "The bridge sways." };
  const ask = { authorType: "player", content: "(ooc) @DM could I jump it?" };
  const chat = { authorType: "player", content: "(ooc) brb" };
  const move = { authorType: "player", content: "I jump the gap." };
  const note = { authorType: "system", content: "Kara ends their turn." };
  assert.equal(oocQuestionPending([dm, chat, ask]), true);
  assert.equal(oocQuestionPending([ask]), true, "a question before the DM has ever spoken");
  assert.equal(oocQuestionPending([dm, chat]), false, "table talk not put to the DM");
  assert.equal(oocQuestionPending([dm, ask, move]), false, "a move since makes it a real turn");
  assert.equal(oocQuestionPending([dm, note, ask]), false, "an End Turn's note since makes it a real turn");
  assert.equal(oocQuestionPending([ask, dm]), false, "already answered");
  assert.equal(oocAnswer("(ooc) Yes, with a DC 12 Athletics check."), "(ooc) Yes, with a DC 12 Athletics check.");
});

async function settle(campaignId) {
  const end = Date.now() + 30_000;
  while (dmQueueDepth(campaignId) > 0) {
    if (Date.now() > end) {
      throw new Error("the DM queue never ran dry");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function act(world, userId, content, kind) {
  const route = await world.route("campaigns/[campaignId]/actions");
  world.signIn({ id: userId });
  const response = await route.POST(
    new Request("http://test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, kind }),
    }),
    { params: Promise.resolve({ campaignId: world.campaignId }) },
  );
  await settle(world.campaignId);
  return response.status;
}

const world = await openWorld({ gameSettings: { ttsEnabled: false } });
const kara = world.addHero({ name: "Kara", class: "fighter", level: 1 });
const userId = world.sheet(kara.id).userId;
const model = await fakeModel();
model.pointAt(world);
// The first message at a table wakes the DM whatever it is (the opening), so
// the story has begun.
world.say("dm", "A rope bridge sways over the gorge, its middle planks gone.");
const said = () => listRecentMessages(world.campaignId, 50).map((message) => [message.authorType, message.content]);

await test("Table talk without @DM wakes nothing.", async () => {
  model.script([]);
  assert.equal(await act(world, userId, "is anyone else hungry", "ooc"), 202);
  assert.equal(model.served(), 0, "plain table talk woke the DM");
});

await test("@DM gets an out-of-character answer at once: one call with no tools, written as table talk, with no turn row and nothing read aloud.", async () => {
  const turnBefore = getLatestDmTurnId(world.campaignId);
  model.script([reply({ text: "Yes, it's about ten feet. You can try it with a Strength (Athletics) check when you act." })]);
  assert.equal(await act(world, userId, "@DM could I jump the gap to the far ledge?", "ooc"), 202);
  assert.equal(model.served(), 1, "the question did not wake the DM");
  const request = model.requests[0];
  assert.ok(!request.tools?.length, "the answer was offered tools");
  assert.equal(request.messages.at(-1).content, OOC_ANSWER_INSTRUCTION);
  assert.match(JSON.stringify(request.messages), /could I jump the gap/);
  assert.deepEqual(said().at(-1), ["dm", "(ooc) Yes, it's about ten feet. You can try it with a Strength (Athletics) check when you act."]);
  const stored = listRecentMessages(world.campaignId, 1)[0];
  assert.equal(stored.dmTurnId ?? null, null, "the answer is linked to a turn");
  assert.equal(getLatestDmTurnId(world.campaignId), turnBefore, "the answer made a turn row");
  assert.equal(getDmStatus(world.campaignId), "idle");
});

await test("The next move is a real turn, and the DM has its own answer in front of it.", async () => {
  model.script([reply({ text: "You take a running start and leap. What do you do?" })]);
  assert.equal(await act(world, userId, "I take a run at the gap and jump.", "do"), 202);
  assert.equal(model.served(), 1);
  assert.ok(model.requests[0].tools?.length, "a move ran without the DM's tools");
  assert.match(JSON.stringify(model.requests[0].messages), /about ten feet/);
});

await test("@DM in a fight answers and moves nothing: the turn, the round and the floor stay where they were.", async () => {
  await world.beginFight([{ monster: "goblin", count: 1 }], { heroFaces: { [kara.id]: 19 }, enemyFace: 1 });
  const before = world.encounter();
  model.script([reply({ text: "The goblin is about twenty feet off, well within your reach after a move." })]);
  assert.equal(await act(world, userId, "@DM how far is the goblin from me?", "ooc"), 202);
  assert.equal(model.served(), 1);
  const after = world.encounter();
  assert.equal(after.round, before.round);
  assert.equal(after.turnIndex, before.turnIndex);
  assert.deepEqual(after.legendary.due ?? [], before.legendary.due ?? []);
  assert.equal(world.enemies()[0].currentHp, world.enemies()[0].maxHp);
  assert.match(said().at(-1)[1], /^\(ooc\) The goblin is about twenty feet off/);
});

model.close();
world.close();
finish();
