// A reply that is the model's plan rather than narration. Grok Build, run as
// the storyteller on 0.26.4, ended its opening and every later turn on a
// note to itself ("I will set the landing and the hour before anyone in
// Marrow's Crossing speaks."), and the note reached the table as the story.
// The turn now holds such a reply back and asks once for the narration
// (src/lib/dm/plan-note.ts, the planNudged branch in src/lib/dm/turn.ts).
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { call, fakeModel, reply } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-plan-note");
const { isPlanNote, PLAN_NOTE_CORRECTION } = await import("../src/lib/dm/plan-note.ts");

await test("Grok's own notes read as plans; narration, and a character's quoted 'I will', do not.", () => {
  for (const plan of [
    "The village is still on the morning clock, and the quay is not on the map yet. I will set the landing and the hour before anyone in Marrow's Crossing speaks.",
    "The quay is already the landing and the hour is evening. I'll see who is actually standing there before Kara's question gets an answer.",
    "Let me check the encounter state first.",
  ]) {
    assert.equal(isPlanNote(plan), true, plan);
  }
  for (const narration of [
    "Morning light glimmers through the river fog as you reach Marrow’s Crossing. “I’m Mother Hesk, council speaker. Find our bell and our sexton, and I’ll pay twenty gold.”",
    "Kara, the gate is locked, and you've got a crowbar on your pack. What do you do?",
    "\"I will not pay a copper more,\" Tam says, and turns back to his ferry rope.",
    "You hear a voice from the dark: \"Let me out. I'll make it worth your while.\"",
  ]) {
    assert.equal(isPlanNote(narration), false, narration);
  }
});

const world = await openWorld({ gameSettings: { ttsEnabled: false } });
const kara = world.addHero({ name: "Kara", class: "fighter", level: 1 });
const model = await fakeModel();
model.pointAt(world);

await test("A turn that answers with a plan is asked once for the narration, and only the narration reaches the table.", async () => {
  const plan = "The quay is already the landing and the hour is evening. I'll see who is actually standing there before Kara's question gets an answer.";
  const story = "A ferryman coils wet rope on the quay and will not meet your eye. \"The bell,\" he mutters. \"Ask the council.\" What do you do?";
  model.script([reply({ text: plan }), reply({ text: story })]);
  const message = await model.turn(world, "I ask the nearest villager why everyone looks so worried.", kara.id);
  assert.equal(model.served(), 2, "the plan was not sent back for narration");
  assert.match(JSON.stringify(model.requests[1].messages), /a note to yourself about what you plan to do/);
  assert.equal(message?.content.trim(), story);
  assert.doesNotMatch(message?.content ?? "", /I'll see who/);
  assert.ok(PLAN_NOTE_CORRECTION.includes("Never describe your own next steps"));
});

await test("The correction is spent once a turn: a model that plans again is not asked a third time.", async () => {
  const plan = "I will set the scene before anyone speaks.";
  model.script([reply({ text: plan }), reply({ text: plan })]);
  await model.turn(world, "I wait by the water.", kara.id);
  assert.equal(model.served(), 2);
});

// Grok's second shape, seen live: the plan written beside the tool calls,
// then an empty reply once their results are in.
await test("A plan written beside tool calls never reaches the table: the calls run, and the turn is asked for the narration it owes.", async () => {
  const plan = "Kara accepts the council's hire and asks Mother Hesk two plain questions. I'll check how the table records that exchange before she answers.";
  const story = "Mother Hesk nods once. \"Three nights ago, after the last bell. No enemies I know of.\" What do you ask next?";
  model.script([
    reply({ text: plan, calls: [call("record_event", { characterId: kara.id, kind: "story", summary: "Kara took the council's job." })] }),
    reply({ text: "" }),
    reply({ text: "" }),
    reply({ text: story }),
  ]);
  const message = await model.turn(world, "I take the job and ask about the sexton.", kara.id);
  assert.doesNotMatch(message?.content ?? "", /I'll check how the table/, "the plan reached the table");
  assert.match(message?.content ?? "", /Three nights ago/);
});

model.close();
world.close();
finish();
