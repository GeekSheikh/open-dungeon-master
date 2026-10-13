// The model failing partway through a DM turn, and the lead's Retry. The
// pieces had tests of their own (the retry rules in test-retry-turn.mjs are
// pure, the backend's socket-drop retry in test-backend-fetch.mjs), but the
// fake model never failed, so no test ran a turn into a backend error or
// pressed Retry: the halted notice and its link, the turn parked as failed,
// work already applied not being applied again, and the route re-entering
// the saved conversation through the queue to narrate once.
//
// The scripted fake model (scripts/lib/enforce-narrator.mjs) fails a call
// with failure(): an HTTP 500 with an OpenAI-style error body.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { call, failure, fakeModel, reply } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-turn-failure-retry");

const { listRecentMessages, findMessageForDmTurn } = await import("../src/lib/db/messages.ts");
const { getDmTurn, getLatestDmTurnId } = await import("../src/lib/db/dm-turns.ts");
const { dmQueueDepth } = await import("../src/lib/dm/queue.ts");
const { getDmStatus } = await import("../src/lib/dm/status.ts");
const { DM_HALTED_PREFIX } = await import("../src/lib/campaign-types.ts");

const RETRY_NOTE = /interrupted by an internal error/;

async function settle(campaignId, ms = 30_000) {
  const until = Date.now() + ms;
  while (dmQueueDepth(campaignId) > 0) {
    if (Date.now() > until) {
      throw new Error(`the DM queue for ${campaignId} never ran dry`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function retry(world, user, turnId) {
  const route = await world.route("campaigns/[campaignId]/dm-turn/retry");
  world.signIn(user);
  const response = await route.POST(
    new Request("http://test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId }),
    }),
    { params: Promise.resolve({ campaignId: world.campaignId }) },
  );
  const json = await response.json().catch(() => ({}));
  await settle(world.campaignId);
  return { status: response.status, json };
}

const narrations = (world) => listRecentMessages(world.campaignId, 50).filter((message) => message.authorType === "dm");
const notices = (world) =>
  listRecentMessages(world.campaignId, 50).filter(
    (message) => message.authorType === "system" && message.content.startsWith(DM_HALTED_PREFIX),
  );

async function table() {
  const world = await openWorld({ gameSettings: { ttsEnabled: false } });
  const kara = world.addHero({ name: "Kara", class: "fighter", level: 1 });
  const model = await fakeModel();
  model.pointAt(world);
  return { world, kara, model };
}

await test("A backend error after the turn granted gold parks it as failed with a notice the lead can retry; Retry narrates once and never grants the gold again.", async () => {
  const { world, kara, model } = await table();
  const goldBefore = world.sheet(kara.id).gold;
  model.script([
    reply({ calls: [call("modify_gold", { characterId: kara.id, delta: 10, reason: "the council's advance" })] }),
    failure(500),
  ]);
  const halted = await model.turn(world, "I take the council's job.", kara.id);
  assert.equal(halted, null, "a halted turn posted narration");

  const turnId = getLatestDmTurnId(world.campaignId);
  assert.equal(getDmTurn(turnId).status, "failed");
  assert.equal(getDmStatus(world.campaignId), "idle", "the table is left waiting on a DM that stopped");
  const [notice] = notices(world);
  assert.ok(notice, "the table was not told the DM stopped");
  assert.equal(notice.dmTurnId, turnId, "the notice does not link the turn to retry");
  assert.equal(world.sheet(kara.id).gold, goldBefore + 10, "the gold granted before the failure");

  model.script([reply({ text: "Mother Hesk counts ten gold onto the table." })]);
  const retried = await retry(world, world.owner, turnId);
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(getDmTurn(turnId).status, "done");
  const said = narrations(world);
  assert.equal(said.length, 1, `expected one narration, found ${said.length}`);
  assert.match(said[0].content, /counts ten gold/);
  assert.equal(world.sheet(kara.id).gold, goldBefore + 10, "the retry granted the gold again");
  // The narration links the turn (for a reroll of its prose); the notice
  // must not any more, or it would still offer a Retry.
  assert.ok(!notices(world)[0].dmTurnId, "the notice still offers a Retry for a finished turn");
  assert.equal(findMessageForDmTurn(turnId)?.id, said[0].id);

  // The retry re-entered the saved conversation: the gold's result is in it,
  // and the model is told an attempt was interrupted.
  const sent = JSON.stringify(model.requests.at(-1).messages);
  assert.match(sent, RETRY_NOTE);
  assert.match(sent, /modify_gold|"tool"/);

  const again = await retry(world, world.owner, turnId);
  assert.equal(again.status, 409);
  assert.match(again.json.error ?? "", /already finished/);
  assert.equal(narrations(world).length, 1, "a second Retry narrated again");
  model.close();
  world.close();
});

await test("Only the lead can retry a halted turn.", async () => {
  const { world, kara, model } = await table();
  const brom = world.addHero({ name: "Brom", class: "cleric", level: 1 });
  model.script([failure(500)]);
  await model.turn(world, "I look around the square.", kara.id);
  const turnId = getLatestDmTurnId(world.campaignId);
  assert.equal(getDmTurn(turnId).status, "failed");

  const refused = await retry(world, { id: world.sheet(brom.id).userId }, turnId);
  assert.equal(refused.status, 403, JSON.stringify(refused.json));
  assert.equal(getDmTurn(turnId).status, "failed", "a refused retry moved the turn");
  model.close();
  world.close();
});

await test("A retry that fails again leaves a fresh notice with the link, and a second Retry finishes the turn.", async () => {
  const { world, kara, model } = await table();
  model.script([failure(500)]);
  await model.turn(world, "I knock on the sexton's door.", kara.id);
  const turnId = getLatestDmTurnId(world.campaignId);

  model.script([failure(503, "The backend is restarting.")]);
  const first = await retry(world, world.owner, turnId);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(getDmTurn(turnId).status, "failed", "the second failure did not park the turn");
  assert.equal(notices(world).length, 2, "the second failure was not reported");
  assert.equal(findMessageForDmTurn(turnId)?.id, notices(world).at(-1).id, "the fresh notice does not carry the link");

  model.script([reply({ text: "Nobody answers; the door gives a little under your knuckles." })]);
  const second = await retry(world, world.owner, turnId);
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(getDmTurn(turnId).status, "done");
  assert.equal(narrations(world).length, 1);
  const sent = JSON.stringify(model.requests.at(-1).messages);
  assert.equal(sent.match(new RegExp(RETRY_NOTE.source, "g"))?.length, 1, "the retry note was stacked twice");
  model.close();
  world.close();
});

finish();
