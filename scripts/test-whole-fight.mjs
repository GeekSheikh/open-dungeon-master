// A whole fight, in the order a table plays it: the fight opens, then round
// after round the hero's attack goes through a DM turn (the model's
// pc_attack), the player's End Turn hands the round to the goblins, and the
// DM turn that wakes plays them (the model's enemy_attack) and gives the turn
// back, until the last goblin falls, the fight ends and its XP is paid.
//
// Each of those steps has its own suite (test-enforce-initiative,
// test-enforce-turn-advance, test-enforce-enemies, ...), staged one at a
// time. None ran them in sequence, so nothing checked what a round leaves
// for the next: that an enemy's hit lands on the hero's sheet and stays
// there, that a goblin killed on the hero's turn is not due on the enemies'
// turn, that the round counter and the turn pointer agree after each pass,
// and that the fight ends on the killing blow with the right XP.
//
// SRD goblins (AC 15, 7 HP, scimitar +4 for 1d6+2, 50 XP), the scripted fake
// model (scripts/lib/enforce-narrator.mjs), dice forced per swing.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { combatKit, DUMMY, TRAINED } from "./lib/enforce-combat.mjs";
import { call, fakeModel, reply } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-whole-fight");

const GOBLIN = {
  ...DUMMY,
  ac: 15,
  maxHp: 7,
  dexMod: 2,
  attacks: [{ name: "Scimitar", toHit: 4, damage: "1d6+2", type: "slashing" }],
  cr: 0.25,
  xp: 50,
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
};

const { listRecentRolls } = await import("../src/lib/db/rolls.ts");
const { startDmTurn } = await import("../src/lib/dm/turn.ts");

await test("Three rounds against two goblins: hits stay on the sheet, the dead stop acting, the turn comes back each round, and the killing blow ends the fight with its XP", async () => {
  const world = await openWorld({
    campaign: { maxPlayers: 8, difficulty: "deadly" },
    gameSettings: { ttsEnabled: false },
  });
  const kit = await combatKit(world);
  const model = await fakeModel();
  model.pointAt(world);
  const kara = world.addHero({
    name: "Kara",
    class: "fighter",
    level: 3,
    abilities: { str: 16, dex: 10, con: 14, wis: 10 },
    proficiencies: TRAINED,
    equipment: [{ name: "Longsword", qty: 1, equipped: true }],
  });
  const userId = world.sheet(kara.id).userId;
  const maxHp = world.sheet(kara.id).maxHp;
  const xpBefore = world.sheet(kara.id).xp;

  // Kara wins initiative; the goblins roll a 1. Without the content pack (as
  // in CI) a goblin's numbers are synthesized, so the SRD block is pinned.
  await world.beginFight([{ monster: "goblin", count: 2 }], { heroFaces: { [kara.id]: 19 }, enemyFace: 1 });
  for (const goblin of world.enemies()) {
    kit.setEnemy(goblin.id, { ac: 15, maxHp: 7, currentHp: 7, stats: GOBLIN });
  }
  const [first, second] = world.enemies();
  assert.equal(first.currentHp, 7);
  kit.place(kara.id, 5, 5);
  kit.place(first.id, 4, 6);
  kit.place(second.id, 6, 6);

  const turnName = () => {
    const encounter = world.encounter();
    return encounter?.orderReady ? encounter.order[encounter.turnIndex]?.name ?? null : null;
  };
  const enemy = (id) => world.enemies().find((entry) => entry.id === id);
  const damageTaken = () =>
    listRecentRolls(world.campaignId, 200)
      .filter((roll) => roll.attacker?.kind === "enemy" && roll.kind === "damage")
      .reduce((sum, roll) => sum + roll.total, 0);

  // Kara's attack, as the AI DM resolves the player's line: one pc_attack.
  async function karaAttacks(target, faces) {
    world.dice(...faces);
    model.script([
      reply({ calls: [call("pc_attack", { characterId: kara.id, targetEnemyId: target.id, weapon: "Longsword" })] }),
      reply({ text: "Kara's longsword bites." }),
    ]);
    await model.turn(world, `I attack ${target.displayName} with my Longsword.`, kara.id, userId);
    assert.equal(world.clearDice(), 0, "a forced die went unrolled on Kara's attack");
  }

  // The player's End Turn, then the DM turn it wakes playing every goblin
  // still standing. A miss rolls one die, a hit two. `dead` are goblins the
  // model also tries to play, as a model that lost count might: the server
  // must refuse them without a roll.
  async function goblinsAct(swings, round, dead = []) {
    assert.equal(kit.endTurn(userId), true, "End Turn was refused");
    const due = [...(world.encounter().legendary.due ?? [])].sort();
    assert.deepEqual(due, swings.map(([goblin]) => goblin.id).sort(), `round ${round}: the goblins due`);
    world.dice(...swings.flatMap(([, faces]) => faces));
    const attackers = [...dead, ...swings.map(([goblin]) => goblin)];
    model.script([
      reply({ calls: attackers.map((goblin) => call("enemy_attack", { enemyId: goblin.id, targetCharacterId: kara.id })) }),
      reply({ text: "The goblins press in." }),
    ]);
    await startDmTurn(world.campaignId);
    assert.equal(world.clearDice(), 0, "a forced die went unrolled on the goblins' turn");
    assert.deepEqual(world.encounter().legendary.due ?? [], [], `round ${round}: a goblin was left due`);
    assert.equal(turnName(), "Kara", `round ${round}: the turn did not come back to Kara`);
  }

  // Round 1: Kara cuts the first goblin to 3; it hits back, the second misses.
  assert.equal(world.encounter().round, 1);
  assert.equal(turnName(), "Kara");
  await karaAttacks(first, [18, 1]);
  assert.equal(enemy(first.id).currentHp, 3, "1d8+3 on a 1");
  await goblinsAct([[first, [18, 4]], [second, [1]]], 1);
  assert.equal(world.encounter().round, 2);
  assert.equal(world.sheet(kara.id).currentHp, maxHp - damageTaken(), "round 1's hit is not on Kara's sheet");
  assert.ok(world.sheet(kara.id).currentHp < maxHp, "the hit did nothing");

  // Round 2: Kara drops the first goblin on her turn, so only the second acts.
  await karaAttacks(first, [18, 1]);
  assert.equal(enemy(first.id).status, "dead");
  assert.notEqual(world.encounter(), null, "the fight ended with a goblin standing");
  const firstRolls = () =>
    listRecentRolls(world.campaignId, 200).filter((roll) => roll.attacker?.kind === "enemy" && roll.attacker.id === first.id).length;
  const firstRolledBefore = firstRolls();
  await goblinsAct([[second, [18, 3]]], 2, [first]);
  assert.equal(firstRolls(), firstRolledBefore, "the dead goblin attacked");
  const answers = model.requests.flatMap((request) => request.messages).filter((message) => message.role === "tool");
  const refusal = answers.map((message) => JSON.parse(message.content)).find((result) => result.error?.includes(first.displayName));
  assert.equal(refusal?.refused, "rules", "the dead goblin's attack was not refused on the rules");
  // Refused for being dead: "its turn has not come yet" would tell the model
  // the corpse acts later.
  assert.match(refusal.error, /is dead/, "the dead goblin was refused for something other than being dead");
  assert.equal(world.encounter().round, 3);
  assert.equal(world.sheet(kara.id).currentHp, maxHp - damageTaken(), "the hits do not add up on Kara's sheet");

  // Round 3: the killing blow on the last goblin ends the fight and pays out.
  const hpBeforeEnd = world.sheet(kara.id).currentHp;
  await karaAttacks(second, [18, 8]);
  assert.equal(world.encounter(), null, "the fight did not end on the last goblin");
  assert.equal(world.sheet(kara.id).xp - xpBefore, 100, "two goblins at 50 XP, one hero");
  assert.equal(world.sheet(kara.id).currentHp, hpBeforeEnd, "the end of the fight changed Kara's hit points");

  model.close();
  world.close();
});

finish();
