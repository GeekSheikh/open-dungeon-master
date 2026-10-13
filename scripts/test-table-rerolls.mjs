// Rolled ability scores at a table: the table's own reroll rule, and the
// six a character is admitted with. The server throws and keeps a player's
// 4d6 six (issue #128) under the admin's rule; a table may now set its own
// rule for the characters made at it (gameSettings.abilityRerollBelow), from
// "the first roll stands" to "reroll freely", and the six rolled there are
// that table's, so a table that rerolls freely cannot hand its six to a
// stricter table or to the library.
//
// Also the door no test walked: /api/characters/rolls was never called, and
// the pool's spend at admission (admit.ts usedPool) was only seen in parts.
// Here a sheet that needs rolled scores is refused without the six on record
// where it is made, admitted with them, and spends them.
import assert from "node:assert/strict";
import { suite } from "./lib/enforce-harness.mjs";
import { LEGAL_FIGHTER, openCreation } from "./lib/enforce-creation.mjs";

const { test, finish } = suite("test-table-rerolls");
const rerolls = await import("../src/lib/srd/ability-rerolls.ts");

// Twenty-four forced faces each: six 4d6 throws, the lowest set aside.
const HIGH = [6, 6, 6, 1, 6, 6, 5, 1, 6, 5, 5, 1, 5, 5, 5, 1, 5, 5, 4, 1, 5, 4, 4, 1]; // 18 17 16 15 14 13 = 93
const LOW = [4, 3, 3, 1, 3, 3, 3, 1, 3, 3, 3, 1, 3, 3, 2, 1, 3, 3, 2, 1, 3, 2, 2, 1]; // 10 9 9 8 8 7 = 51

// A human fighter on the high six, +1 to each for being human: no point buy
// or standard array reaches these, so only the rolled six admit them.
const ROLLED_FIGHTER = {
  ...LEGAL_FIGHTER,
  abilities: { str: 19, dex: 18, con: 17, int: 16, wis: 15, cha: 14 },
  maxHp: 13,
};

await test("The words and the number agree: the first roll stands at 0, reroll freely at 108, a low roll in between; a table with no rule follows the server.", () => {
  assert.equal(rerolls.rerollChoiceOf(0), "keep");
  assert.equal(rerolls.rerollChoiceOf(70), "low");
  assert.equal(rerolls.rerollChoiceOf(108), "free");
  assert.equal(rerolls.rerollBelowFor("keep", 70), 0);
  assert.equal(rerolls.rerollBelowFor("free", 70), 108);
  assert.equal(rerolls.rerollBelowFor("low", 85), 85, "a threshold already chosen is kept");
  assert.equal(rerolls.rerollBelowFor("low", 108), 70, "switching back from free lands on the default");
  assert.equal(rerolls.tableRerollBelow(null, 70), 70);
  assert.equal(rerolls.tableRerollBelow(108, 70), 108);
  assert.equal(rerolls.tableRerollBelow(0, 70), 0);
});

const table = await openCreation();
const { world, campaignId, player, call, atTable, clearSeat } = table;
const rollsRoute = await world.route("characters/rolls");
const settingsRoute = await world.route("campaigns/[campaignId]/settings");

async function roll(user, faces, at) {
  world.signIn(user);
  world.dice(...faces);
  const out = await call(rollsRoute, "POST", { kind: "abilities", ...(at ? { campaignId: at } : {}) });
  world.clearDice();
  return out;
}
async function openPool(user, at) {
  world.signIn(user);
  const response = await rollsRoute.GET(new Request(`http://test/${at ? `?campaignId=${at}` : ""}`));
  return response.json();
}
async function setRule(value) {
  world.signIn(world.owner);
  return call(settingsRoute, "PATCH", { abilityRerollBelow: value }, { campaignId });
}
const totals = (out) => out.json.abilities?.totals;

await test("The lead sets the table's rule: a number from 0 to 108, or none to follow the server; anything else is refused.", async () => {
  assert.equal((await setRule(108)).status, 200);
  assert.equal(world.campaign().gameSettings.abilityRerollBelow, 108);
  assert.equal((await setRule(200)).status, 400);
  assert.equal((await setRule(null)).status, 200);
  assert.equal(world.campaign().gameSettings.abilityRerollBelow, null);
});

await test("A table that rerolls freely throws a fresh six even for a strong roll, while the library keeps its strong roll under the server's 70.", async () => {
  assert.equal((await setRule(108)).status, 200);
  const first = await roll(player, HIGH, campaignId);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.deepEqual(totals(first), [18, 17, 16, 15, 14, 13]);
  assert.equal(first.json.abilities.rerollBelow, 108);
  const again = await roll(player, LOW, campaignId);
  assert.equal(again.json.abilities.kept, false, "a free table kept a strong six");
  assert.deepEqual(totals(again), [10, 9, 9, 8, 8, 7]);

  const library = await roll(player, HIGH);
  assert.equal(library.json.abilities.rerollBelow, 70, "the library left the server's rule");
  const libraryAgain = await roll(player, LOW);
  assert.equal(libraryAgain.json.abilities.kept, true, "the library rethrew a strong six");
  assert.deepEqual(totals(libraryAgain), [18, 17, 16, 15, 14, 13]);
  assert.deepEqual((await openPool(player, campaignId)).abilities?.totals, [10, 9, 9, 8, 8, 7], "the library's six reached the table");
});

await test("A table where the first roll stands hands back a weak six rather than throw again.", async () => {
  assert.equal((await setRule(0)).status, 200);
  const kept = await roll(player, HIGH, campaignId);
  assert.equal(kept.json.abilities.kept, true);
  assert.equal(kept.json.abilities.canReroll, false);
  assert.deepEqual(totals(kept), [10, 9, 9, 8, 8, 7], "the first roll did not stand");
});

await test("Scores that need rolled dice are admitted at a table only with that table's six: the library's strong six do not count there, the table's do, and they are spent.", async () => {
  assert.equal((await setRule(108)).status, 200);
  // The library holds the strong six; the table holds the weak ones.
  clearSeat(player);
  const refused = await atTable(ROLLED_FIGHTER);
  assert.equal(refused.status, 400, "the library's six admitted a character at the table");
  assert.equal(refused.sheet, null);

  await roll(player, HIGH, campaignId);
  const admitted = await atTable(ROLLED_FIGHTER);
  assert.equal(admitted.status, 201, admitted.error ?? "");
  assert.equal(admitted.sheet.abilities.str, 19);
  assert.equal((await openPool(player, campaignId)).abilities, null, "the table's six were not spent");
  assert.deepEqual((await openPool(player)).abilities?.totals, [18, 17, 16, 15, 14, 13], "the library's six were spent by a table's character");

  // The same scores again, with the six spent: refused.
  const twice = await atTable(ROLLED_FIGHTER);
  assert.equal(twice.status, 400, "spent dice admitted a second character");
});

await test("A table the player does not belong to has no dice for them.", async () => {
  const stranger = world.addUser("stranger");
  world.signIn(stranger);
  const out = await call(rollsRoute, "POST", { kind: "abilities", campaignId });
  assert.equal(out.status, 404);
  const response = await rollsRoute.GET(new Request(`http://test/?campaignId=${campaignId}`));
  assert.equal(response.status, 404);
});

world.close();
finish();
