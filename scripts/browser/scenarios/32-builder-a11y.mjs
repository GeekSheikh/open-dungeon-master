// An accessibility check over the character builder: axe-core (WCAG 2.1 A
// and AA rules) on every step of a stored build, and on the lineage
// carousel, failing on any serious or critical violation. The unit suites
// render static markup and never see a missing label, a name a screen reader
// cannot hear or a contrast below 4.5:1; the next art pass could add any of
// them unseen.
import fs from "node:fs";
import { createRequire } from "node:module";
import { check, eventually, sleep } from "../lib.mjs";

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

async function axeViolations(page, selector) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) {
    await page.addScriptTag({ content: axeSource });
  }
  return page.evaluate(async (scope) => {
    const root = document.querySelector(scope);
    if (!root) return [{ id: "missing-root", impact: "critical", help: `no ${scope}`, nodes: [] }];
    const result = await window.axe.run(root, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    // A run that checked nothing passes nothing either: say so, rather than
    // pass in silence.
    if (!result.passes.length) {
      return [{ id: "nothing-checked", impact: "critical", help: "axe checked no rule here", nodes: [scope] }];
    }
    return result.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")),
      }));
  }, selector);
}

// The option picker (backlog B9) from the keyboard: Arrow Down opens it with
// focus in the listbox, arrows move the active option, the open list passes
// axe, and Escape closes it with focus back on the trigger.
async function pickerKeys(page, trigger) {
  const problems = [];
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await sleep(200);
  const state = () =>
    page.evaluate(() => {
      const focused = document.activeElement;
      return {
        role: focused?.getAttribute("role") ?? null,
        active: focused?.getAttribute("aria-activedescendant") ?? null,
        activeIsOption: document.getElementById(focused?.getAttribute("aria-activedescendant") ?? "")?.getAttribute("role") === "option",
        nestedButtons: focused?.getAttribute("role") === "listbox" ? focused.querySelectorAll("button").length : 0,
      };
    });
  const opened = await state();
  if (opened.role !== "listbox") return [`Arrow Down left focus on ${opened.role ?? "a non-listbox"}`];
  if (!opened.activeIsOption) problems.push("the listbox's active descendant is not an option");
  if (opened.nestedButtons) problems.push(`${opened.nestedButtons} buttons inside the listbox`);
  await page.keyboard.press("End");
  const ended = await state();
  await page.keyboard.press("Home");
  const homed = await state();
  if (ended.active === homed.active && ended.active) {
    // A one-option list cannot move; anything longer must.
    const count = await page.locator('[role="listbox"] [role="option"]').count();
    if (count > 1) problems.push("Home and End did not move the active option");
  }
  problems.push(...report("open list", await axeViolations(page, '[role="listbox"]')));
  await page.keyboard.press("Escape");
  await sleep(200);
  const back = await trigger.evaluate((node) => node === document.activeElement && node.getAttribute("aria-expanded") === "false");
  if (!back) problems.push("Escape did not close the list and return focus to the trigger");
  return problems;
}

function report(where, violations) {
  return violations.map((violation) => `${where}: ${violation.id} (${violation.impact}) ${violation.help} at ${violation.nodes.join(", ")}`);
}

export default {
  name: "builder-a11y",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids } = t;
    const found = [];
    let pickerChecked = false;

    // Every step of a stored build, reached by its diamond.
    await t.open(`/characters/${ids.library}/edit`);
    await page.locator(`${root}input[aria-label="Name"]`).locator("visible=true").first().waitFor({ state: "visible", timeout: 30_000 });
    for (let step = 1; step <= 6; step += 1) {
      if (step > 1) {
        const diamond = page.locator(`${root}button[aria-label^="Go to step ${step}:"]`).locator("visible=true");
        await eventually(async () => (await diamond.count()) && diamond.first().isEnabled(), { timeoutMs: 15_000, label: `the step ${step} diamond` });
        await t.tap(diamond.first());
        await sleep(700);
      }
      found.push(...report(`step ${step}`, await axeViolations(page, "[data-builder-root]")));
      if (!pickerChecked) {
        const trigger = page.locator(`${root}[data-builder-root] button[aria-haspopup="listbox"]`).locator("visible=true");
        if (await trigger.count()) {
          pickerChecked = true;
          found.push(...(await pickerKeys(page, trigger.first())).map((problem) => `step ${step} picker: ${problem}`));
        }
      }
    }
    if (!pickerChecked) found.push("no option picker found on any step");

    // The lineage carousel over a new character's Ancestry step.
    await t.open("/characters/new");
    const fresh = page.locator(`${root}button`).filter({ hasText: /^Start fresh$/ }).locator("visible=true");
    if (await fresh.count()) await t.tap(fresh.first());
    const name = page.locator(`${root}input[aria-label="Name"]`).locator("visible=true").first();
    await name.waitFor({ state: "visible", timeout: 30_000 });
    await name.fill("Axe Check");
    await t.tap(page.locator(`${root}button`).filter({ hasText: /^Continue/ }).locator("visible=true").first());
    await sleep(900);
    const details = page.locator(`${root}section[data-active] button[aria-label^="Details"], ${root}section[data-active] .creator-help`).locator("visible=true");
    await eventually(() => details.count(), { timeoutMs: 15_000, label: "a lineage card's details button" });
    await t.tap(details.first());
    await eventually(() => page.locator('[role="dialog"]').count(), { timeoutMs: 10_000, label: "the lineage carousel" });
    await sleep(500);
    found.push(...report("lineage carousel", await axeViolations(page, '[role="dialog"]')));

    if (found.length) await t.shot("violations");
    check(found.length === 0, `no serious or critical accessibility violations:\n  ${found.join("\n  ")}`);
  },
};
