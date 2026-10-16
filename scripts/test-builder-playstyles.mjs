// The class step's "how do you want to play" (src/app/characters/builder/
// playstyles.ts): every answer suggests classes the table offers, the usual
// starts first, a world's own classes by role, and never more than three.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);
const { PLAYSTYLES, EASY_CLASSES, playstyleSuggestions } = await import("../src/app/characters/builder/playstyles.ts");
const { classRoles } = await import("../src/lib/srd/class-roles.ts");

const core = ["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard"].map((id) => ({
  id,
  roles: classRoles({ id }).roles,
}));

for (const style of PLAYSTYLES) {
  const picks = playstyleSuggestions(style.id, core);
  assert.ok(picks.length > 0 && picks.length <= 3, `${style.id}: ${picks}`);
  assert.deepEqual(picks.slice(0, Math.min(3, style.first.length)), style.first.slice(0, 3), `${style.id} leads with its usual starts`);
}
assert.ok(playstyleSuggestions("front", core).includes("fighter"));
assert.ok(playstyleSuggestions("help", core).includes("cleric"));
assert.ok(EASY_CLASSES.has("fighter") && !EASY_CLASSES.has("wizard"));

// A world with renamed or new classes: matched by role, never invented.
const world = [{ id: "marshal", roles: ["Tank", "Support"] }, { id: "hexblade", roles: ["DPS"] }];
assert.deepEqual(playstyleSuggestions("front", world), ["marshal"]);
assert.deepEqual(playstyleSuggestions("magic", world), [], "nothing offered fits: the grid stays the answer");
console.log("test-builder-playstyles: ok");
