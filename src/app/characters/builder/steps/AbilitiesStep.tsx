"use client";

import { hpBonusPerLevel } from "@/lib/srd/race-id";
import { ui } from "@/lib/ui";
import { scoresFromSlots } from "../abilityDice";
import AbilityEditor, { ABILITY_LABELS, STANDARD_ARRAY } from "../AbilityEditor";
import { abilityPriority, keyAbilities, poolSlotsFor, standardFor } from "../classAbilities";
import type { HpExplainerInput } from "../AbilityExplainers";
import AsiFeatEditor from "../AsiFeatEditor";
import { knownTraining } from "../FeatChoicesFields";
import type { ClassOption, RaceOption } from "../useBuilderOptions";
import type { BuilderDerived } from "../useBuilderDerived";
import type { BuilderState } from "../useBuilderState";

// What the health explainer works from, shared with the Max HP field on the
// last step. Null until the class and all six scores are known. The Max HP
// field is computed by the same hpBreakdown (useBuilderDerived.ts).
export function hpExplainerInput(
  state: BuilderState,
  derived: BuilderDerived,
  race: RaceOption | undefined,
  klass: ClassOption | undefined,
): HpExplainerInput | null {
  if (!klass || !derived.shownAbilities) {
    return null;
  }
  return {
    className: klass.name,
    hitDie: klass.hitDie,
    // The Constitution the sheet will hold, a half-feat's point included.
    con: derived.shownAbilities.con,
    level: derived.effectiveLevel,
    bonusPerLevel: race ? hpBonusPerLevel(race.id) : 0,
    override: state.hpOverride,
  };
}

// "A fighter leans on Strength or Dexterity, then Constitution", and a button
// that lays the standard array (or a thrown pool) on the abilities in that
// order. A first-time player otherwise spreads the 15 at random and plays a
// fighter who cannot hit. Point buy is left to the player: it is chosen by
// people who want the shape themselves.
function PlaceForClass({ state, klass }: { state: BuilderState; klass: ClassOption }) {
  const pool = state.rollPool;
  if (state.method === "pointbuy" || (state.method === "roll" && !pool)) {
    return null;
  }
  const words = (ability: string) => ABILITY_LABELS[ability as keyof typeof ABILITY_LABELS] ?? ability;
  const keys = keyAbilities(klass);
  const named = new Set(keys.flat());
  const then = abilityPriority(klass).find((ability) => !named.has(ability));
  const needs = keys.map((group) => group.map(words).join(" and ")).join(" or ");
  const article = /^[aeiou]/i.test(klass.name) ? "An" : "A";
  function place() {
    if (state.method === "standard") {
      state.setScores(standardFor(klass, STANDARD_ARRAY));
    } else if (pool) {
      const slots = poolSlotsFor(klass, pool.map((entry) => entry.total));
      state.setRollSlots(slots);
      state.setScores(scoresFromSlots(slots, pool));
    }
  }
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-stone-800 bg-stone-950/40 px-3 py-2 text-xs text-stone-300">
      <span className="min-w-0 flex-1">
        {article} {klass.name.toLowerCase()} leans on {needs}
        {then ? `, then ${words(then)}` : ""}.
      </span>
      <button type="button" onClick={place} className={ui.btnSmall}>
        Place them for {article.toLowerCase()} {klass.name}
      </button>
    </div>
  );
}

// Step 4: the six scores by standard array, point buy or 4d6, then one card
// per ability score improvement the level has earned. Hit points are derived
// on the last step (with a Max HP override); the explainer under the summary
// only shows how that number comes about.
export function AbilitiesStep({
  state,
  derived,
  race,
  klass,
}: {
  state: BuilderState;
  derived: BuilderDerived;
  race: RaceOption | undefined;
  klass: ClassOption | undefined;
}) {
  const { asiSlotLevels, activeAsiChoices, asiTakenInPlay, asiBaseAbilities, effectiveLevel } = derived;
  const asiToPick = asiTakenInPlay.filter((taken) => !taken).length;
  return (
    <div className="space-y-4">
      <div data-builder-target="scores">
      {klass ? <PlaceForClass state={state} klass={klass} /> : null}
      <AbilityEditor
        method={state.method}
        onMethodChange={state.setMethod}
        scores={state.scores}
        onScoresChange={state.setScores}
        pool={state.rollPool}
        onPoolChange={state.setRollPool}
        slots={state.rollSlots}
        onSlotsChange={state.setRollSlots}
        // The race's bumps (the half-elf's chosen ones too) and what the
        // improvements, half-feats and Primal Champion add after them, so
        // "Final" here is the number the sheet will carry (issue #149).
        racialBonus={derived.racialBonus}
        gains={derived.abilityGains}
        asiCount={asiToPick}
        who={race && klass ? `${race.name} ${klass.name}`.toLowerCase() : ""}
        hp={hpExplainerInput(state, derived, race, klass)}
      />
      </div>
      {asiSlotLevels.length ? (
        <div data-builder-target="asi">
        <AsiFeatEditor
          level={effectiveLevel}
          slotLevels={asiSlotLevels}
          // A variant human's feat point is in from the first card on.
          baseScores={asiBaseAbilities}
          choices={activeAsiChoices}
          takenInPlay={asiTakenInPlay}
          featSpecOf={derived.featSpecOf}
          featDescOf={derived.featDescOf}
          featChoices={state.featChoices}
          onFeatPicks={state.setFeatPicks}
          known={knownTraining(derived)}
          onChange={(next) =>
            state.setAsiChoices((current) => {
              const merged = [...current];
              next.forEach((choice, index) => {
                merged[index] = choice;
              });
              return merged;
            })
          }
        />
        </div>
      ) : null}
    </div>
  );
}
