// A character's life through the doors a player uses: built in the real
// builder (useBuilderDerived and submit.ts, driven without a browser by
// scripts/lib/enforce-builder.mjs), saved to the library, brought to a
// table, awarded experience by the DM, levelled up with the body the level-up
// dialog sends, and carried back to the library when the campaign ends.
//
// Every step had its own suite (the creation doors, test-enforce-levelup,
// test-edit-keeps-play), but each started from something staged by hand: a
// sheet written for the route, a hero inserted by world.addHero, a level set
// with SQL. Nothing passed one step's output to the next, so nothing checked
// that what the builder makes is what the level-up rules expect, or that a
// level earned at the table is the one the library keeps.
import assert from "node:assert/strict";
import { suite, abilityMod } from "./lib/enforce-harness.mjs";
import { openCreation } from "./lib/enforce-creation.mjs";

const { test, finish } = suite("test-build-join-levelup");
const { openBuilder } = await import("./lib/enforce-builder.mjs");
const builder = await openBuilder();
const campaigns = await import("../src/lib/db/campaigns.ts");
const { combatRiders } = await import("../src/lib/srd/feature-effects.ts");

// A human sage wizard as a player fills the wizard in: standard array with
// Intelligence first, the class's two skills, the race's and background's
// three languages, three cantrips and a six-spell book, four of them prepared.
const ILSE = {
  race: "human",
  class: "wizard",
  background: "sage",
  name: "Ilse",
  scores: { int: 15, con: 14, dex: 13, wis: 12, str: 10, cha: 8 },
  chosenSkills: ["insight", "investigation"],
  bonusLanguages: ["Elvish", "Dwarvish", "Draconic"],
  cantrips: ["Fire Bolt", "Light", "Mage Hand"],
  spells: ["Magic Missile", "Shield", "Sleep", "Detect Magic", "Mage Armor", "Burning Hands"],
  bookPrepared: ["Magic Missile", "Shield", "Sleep", "Mage Armor"],
  portrait: { url: "/uploads/ilse.png" },
};

await test("Built in the builder, through the library to a table, 300 XP from the DM, level 2 from the dialog's own request, and level 2 kept by the library when the campaign ends.", async () => {
  const table = await openCreation();
  const { world, campaignId, player, call, throughLibrary, sheetRoute } = table;

  const built = builder.build(ILSE);
  assert.equal(built.blocker, null, `the builder refused: ${built.blocker?.message}`);
  assert.equal(built.level, 1);

  const seated = await throughLibrary(built.sheet, built.level);
  assert.ok(seated.status < 300, seated.error ?? "");
  const atTable = seated.sheet;
  assert.ok(atTable, "nothing was seated");
  assert.equal(atTable.libraryCharacterId, seated.character.id);
  assert.equal(atTable.maxHp, built.sheet.maxHp, "the table changed what the builder made");
  assert.deepEqual([...atTable.spellcasting.spellbook].sort(), [...ILSE.spells].sort());

  // The table starts, and the DM awards the level's experience.
  campaigns.setCampaignStatus(campaignId, "active");
  const awarded = await world.invoke("award_xp", { characterIds: [atTable.id], amount: 300, reason: "the crypt cleared" });
  assert.equal(awarded.ok, true, awarded.error);

  // Exactly what LevelUpDialog's apply() sends for a wizard at 2 taking the
  // fixed hit points: the class, the school, and two spells for the book.
  world.signIn(player);
  const levelled = await call(sheetRoute, "PATCH", {
    level: 2,
    levelUpClass: "wizard",
    subclass: "School of Evocation",
    levelUpSpells: ["Thunderwave", "Feather Fall"],
  }, { campaignId });
  assert.equal(levelled.status, 200, JSON.stringify(levelled.json));
  const after = table.sheets.getSheetForUser(campaignId, player.id);
  assert.equal(after.level, 2);
  assert.equal(after.xp, 300);
  assert.equal(after.subclass, "School of Evocation");
  assert.equal(after.maxHp, atTable.maxHp + 4 + abilityMod(after.abilities.con), "a wizard's fixed 4 plus Constitution");
  assert.equal(after.hitDice.total, 2);
  assert.equal(after.spellcasting.slots[1].max, 3, "a level 2 wizard has three first-level slots");
  assert.deepEqual(
    [...after.spellcasting.spellbook].sort(),
    [...ILSE.spells, "Thunderwave", "Feather Fall"].sort(),
    "the two new spells did not reach the book",
  );

  // The campaign ends; the library keeps what was earned at the table.
  world.signIn(world.owner);
  const campaignRoute = await world.route("campaigns/[campaignId]");
  const ended = await call(campaignRoute, "PATCH", { status: "ended" }, { campaignId });
  assert.equal(ended.status, 200, JSON.stringify(ended.json));
  const kept = table.characters.getCharacter(seated.character.id);
  assert.equal(kept.level, 2, "the library forgot the level");
  assert.equal(kept.xp, 300, "the library forgot the experience");
  assert.equal(kept.subclass, "School of Evocation", "the library forgot the school");
  assert.ok(kept.sheet.spellcasting.spellbook.includes("Thunderwave"), "the library forgot the new spells");
  const keptFeatures = kept.sheet.features.map((feature) => feature.name);
  assert.ok(keptFeatures.includes("Sculpt Spells"), `the library forgot the school's features: ${keptFeatures.join(", ")}`);
  world.close();
});

// The other way a character changes level: a level 1 build from the library
// joins a table that starts at 5, and plays on from there.
await test("A level 1 build joining a level 5 table arrives as a level 5 fighter, with Extra Attack working, and levels on from there with the dialog's request.", async () => {
  const table = await openCreation({ campaign: { startingLevel: 5 } });
  const { world, campaignId, player, call, throughLibrary, sheetRoute } = table;
  const built = builder.build({
    race: "human",
    class: "fighter",
    background: "soldier",
    name: "Brann",
    chosenSkills: ["perception", "survival"],
    bonusLanguages: ["Dwarvish"],
    stylePicks: ["defense"],
    portrait: { url: "/uploads/brann.png" },
  });
  assert.equal(built.blocker, null, `the builder refused: ${built.blocker?.message}`);

  const seated = await throughLibrary(built.sheet, 1);
  assert.ok(seated.status < 300, seated.error ?? "");
  const joined = seated.sheet;
  assert.equal(joined.level, 5);
  assert.equal(joined.hitDice.total, 5);
  assert.equal(joined.hitDice.spent, 0);
  // Average hit points for a fighter 5: the d10's 10 at first level and its
  // fixed 6 at each of the four after, with Constitution at every level.
  const conMod = abilityMod(joined.abilities.con);
  assert.equal(joined.maxHp, 10 + conMod + 4 * (6 + conMod), "a level 5 fighter's average hit points");
  // The join brings level 5's floor of experience, so the DM's 14000 below
  // takes the sheet to 20500: past level 6's 14000, short of level 7's 23000.
  assert.equal(joined.xp, 6500, "the join did not bring the level's experience");
  assert.equal(combatRiders(joined).extraAttacks, 1, "a level 5 fighter attacks twice");
  assert.equal(seated.character.level, 1, "joining a higher table changed the library's own level");

  campaigns.setCampaignStatus(campaignId, "active");
  const awarded = await world.invoke("award_xp", { characterIds: [joined.id], amount: 14000, reason: "the siege" });
  assert.equal(awarded.ok, true, awarded.error);
  world.signIn(player);
  const levelled = await call(sheetRoute, "PATCH", {
    level: 6,
    levelUpClass: "fighter",
    asiChoices: [{ mode: "plus2", ability: "str" }],
  }, { campaignId });
  assert.equal(levelled.status, 200, JSON.stringify(levelled.json));
  const after = table.sheets.getSheetForUser(campaignId, player.id);
  assert.equal(after.level, 6);
  assert.equal(after.abilities.str, joined.abilities.str + 2, "level 6's improvement did not land");
  world.close();
});

finish();
