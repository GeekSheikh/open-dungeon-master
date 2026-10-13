// Begin, end to end: a table started through the campaign route reaches its
// first DM narration through the real queue, in the order the kickoff
// promises. Every other suite opens its world already active, or calls the
// setup pass by itself, so the start that every campaign goes through (the
// lobby rule, the kickoff note, setup, then the arc, then chapter 1's rewind
// point, then the opening turn) was never run whole. Quick Start, the first
// thing a new player presses, gets the same walk from POST /api/starter.
//
// The model is the scripted fake (scripts/lib/enforce-narrator.mjs); the
// turn's requests are told apart from setup's and the arc's by the tools
// they carry, so an extra planning call never shifts what the test reads.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { fakeModel, reply } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-begin-first-turn");

const campaigns = await import("../src/lib/db/campaigns.ts");
const { listRecentMessages } = await import("../src/lib/db/messages.ts");
const { dmQueueDepth } = await import("../src/lib/dm/queue.ts");
const { getBoundarySnapshot } = await import("../src/lib/db/snapshots.ts");
const { getDmStatus } = await import("../src/lib/dm/status.ts");

const OUTLINE = "1. The sexton rang the bell for the smugglers. 2. The crypt opens on the river.";
const SETUP = JSON.stringify({
  premise: "The chapel bell has stopped and the sexton is gone.",
  openingScene: "The council room above the granary, at dusk.",
  secretOutline: OUTLINE,
});
const ARC = JSON.stringify({
  premise: "The chapel bell has stopped and the sexton is gone.",
  stakes: "The village loses its nerve and its river trade.",
  antagonist: "The Hook, a smuggling crew working under the chapel.",
  acts: [
    { beats: ["The council hires the party", "The sexton's ledger is found", "The crypt gate is forced"] },
    { beats: ["The Hook's cache under the chapel", "The bell is raised again"] },
  ],
  finale: "Ring the bell again with the Hook driven off.",
});

// The kickoff queues its jobs and returns; the test waits for the queue the
// route filled to run dry, as a reload of the page would find it.
async function settle(campaignId, ms = 30_000) {
  const until = Date.now() + ms;
  while (dmQueueDepth(campaignId) > 0) {
    if (Date.now() > until) {
      throw new Error(`the DM queue for ${campaignId} never ran dry`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function send(world, user, name, method, body, campaignId = world.campaignId) {
  const route = await world.route(name);
  world.signIn(user);
  const response = await route[method](
    new Request("http://test/", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve({ campaignId }) },
  );
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

const begin = (world, user, campaignId) =>
  send(world, user, "campaigns/[campaignId]", "PATCH", { status: "active" }, campaignId);
const ready = (world, user, campaignId) =>
  send(world, user, "campaigns/[campaignId]/ready", "POST", { ready: true }, campaignId);

// A DM turn's request offers the DM's tools; setup and the arc ask for JSON.
const isTurnRequest = (body) => Array.isArray(body.tools) && body.tools.length > 0;

function transcript(campaignId) {
  const all = listRecentMessages(campaignId, 50);
  return {
    kickoff: all.filter((message) => message.authorType === "system"),
    dm: all.filter((message) => message.authorType === "dm"),
  };
}

await test("Begin is refused until the table is ready, then runs setup, the arc, chapter 1's rewind point and one opening narration, in that order.", async () => {
  const world = await openWorld({ status: "lobby", gameSettings: { ttsEnabled: false, aiStorySetup: true } });
  world.addHero({ name: "Kara", class: "fighter", level: 1 });
  const model = await fakeModel();
  model.pointAt(world);
  model.script([reply({ text: SETUP }), reply({ text: ARC })]);

  const early = await begin(world, world.owner);
  assert.equal(early.status, 400, JSON.stringify(early.json));
  assert.match(early.json.error ?? "", /ready up/);
  assert.equal(world.campaign().status, "lobby");
  assert.equal(model.requests.length, 0, "a refused start reached the model");

  assert.equal((await ready(world, world.owner)).status, 200);
  const started = await begin(world, world.owner);
  assert.equal(started.status, 200, JSON.stringify(started.json));
  await settle(world.campaignId);

  const campaign = world.campaign();
  assert.equal(campaign.status, "active");
  assert.equal(campaign.dmOutline, OUTLINE, "the setup pass did not run");
  assert.ok(campaign.storyArc, "the arc planner wrote no arc");

  const { kickoff, dm } = transcript(world.campaignId);
  assert.equal(kickoff.length, 1, "one kickoff note");
  assert.match(kickoff[0].content, /The party is assembled/);
  assert.equal(dm.length, 1, `expected one opening narration, found ${dm.length}`);
  assert.ok(dm[0].content.trim(), "the opening narration is empty");
  assert.ok(dm[0].seq > kickoff[0].seq, "the narration came before the kickoff");

  // Chapter 1's rewind point is the world before the opening scene.
  const snapshot = getBoundarySnapshot(world.campaignId, 1);
  assert.ok(snapshot, "no chapter 1 rewind point");
  assert.ok(snapshot.meta.boundarySeq < dm[0].seq, "the rewind point was taken after the opening");

  // Setup and the arc ran before the turn, and the turn read what they wrote:
  // with an arc in place the prompt carries the arc instead of the outline
  // (src/lib/dm/prompt.ts), so the arc's beats are the proof.
  const firstTurn = model.requests.findIndex(isTurnRequest);
  assert.ok(firstTurn >= 2, `the turn ran before setup and the arc (request ${firstTurn})`);
  assert.ok(!model.requests.slice(firstTurn).some((body) => !isTurnRequest(body)), "a planning call ran after the turn began");
  assert.match(JSON.stringify(model.requests[firstTurn].messages), /The sexton's ledger is found/);
  assert.equal(getDmStatus(world.campaignId), "idle");

  // A second Begin changes nothing.
  const again = await begin(world, world.owner);
  assert.equal(again.status, 400);
  assert.match(again.json.error ?? "", /already started/);
  await settle(world.campaignId);
  assert.equal(transcript(world.campaignId).dm.length, 1, "a second Begin narrated again");
  model.close();
  world.close();
});

await test("Quick Start: the starter route, a ready-made hero, Begin, and the opening narration.", async () => {
  const world = await openWorld({ status: "lobby" });
  const created = await send(world, world.owner, "starter", "POST", { solo: true });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const campaignId = created.json.campaign.id;
  assert.equal(campaigns.getCampaignById(campaignId).status, "lobby");

  const model = await fakeModel();
  model.pointAt({ owner: world.owner, campaignId });
  model.script([reply({ text: SETUP }), reply({ text: ARC })]);

  const seated = await send(world, world.owner, "campaigns/[campaignId]/sheet/pregen", "POST", { id: "kara" }, campaignId);
  assert.equal(seated.status, 201, JSON.stringify(seated.json));
  assert.match(seated.json.sheet?.name ?? "", /Kara/);

  assert.equal((await ready(world, world.owner, campaignId)).status, 200);
  const started = await begin(world, world.owner, campaignId);
  assert.equal(started.status, 200, JSON.stringify(started.json));
  await settle(campaignId);

  assert.equal(campaigns.getCampaignById(campaignId).status, "active");
  const { kickoff, dm } = transcript(campaignId);
  assert.equal(kickoff.length, 1);
  assert.equal(dm.length, 1, `expected one opening narration, found ${dm.length}`);
  assert.ok(dm[0].seq > kickoff[0].seq);
  assert.ok(model.requests.some(isTurnRequest), "the opening turn never asked the model");
  model.close();
  world.close();
});

finish();
