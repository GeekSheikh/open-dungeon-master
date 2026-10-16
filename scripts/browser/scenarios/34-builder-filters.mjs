// The class grid's filters: Role set to Tank leaves only classes whose card
// says Tank (the chosen class excepted), says how many of how many are
// shown, and Clear filters brings the whole grid back.
import { check, eventually, sleep } from "../lib.mjs";

export default {
  name: "builder-filters",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids } = t;
    await t.open(`/characters/${ids.library}/edit`);
    await page.locator(`${root}input[aria-label="Name"]`).locator("visible=true").first().waitFor({ state: "visible", timeout: 30_000 });
    const diamond = page.locator(`${root}button[aria-label^="Go to step 3:"]`).locator("visible=true");
    await eventually(async () => (await diamond.count()) && diamond.first().isEnabled(), { timeoutMs: 15_000, label: "the Calling diamond" });
    await t.tap(diamond.first());
    await sleep(800);

    const cards = page.locator(`${root}section[data-active] .creator-card`);
    const before = await cards.count();
    await t.tap(page.locator(`${root}section[data-active] button[aria-label="Role"]`).locator("visible=true").first());
    const tank = page.getByRole("menuitemradio").filter({ hasText: "Role: Tank" });
    await eventually(() => tank.count(), { timeoutMs: 10_000, label: "the Role menu" });
    await tank.first().click();
    await sleep(500);

    const after = await cards.count();
    check(after > 0 && after < before, `the Tank filter narrows the grid (${before} to ${after})`);
    for (let index = 0; index < after; index += 1) {
      const card = cards.nth(index);
      const chosen = (await card.getAttribute("aria-pressed")) === "true";
      const chips = await card.locator(".creator-chip").allInnerTexts();
      check(chosen || chips.some((chip) => /tank/i.test(chip)), `${await card.getAttribute("aria-label")} is a Tank or the chosen class`);
    }
    const count = await page.locator(`${root}section[data-active]`).getByText(/^\d+ of \d+$/).first().innerText();
    check(/^\d+ of \d+$/.test(count.trim()), `the bar says how many are shown (${count})`);
    await t.shot("tanks");

    await t.tap(page.locator(`${root}section[data-active] button`).filter({ hasText: /^Clear filters$/ }).first());
    await sleep(500);
    check((await cards.count()) === before, "Clear filters brings the grid back");
  },
};
