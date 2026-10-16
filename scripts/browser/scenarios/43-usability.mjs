// The 2026-10-16 usability pass (docs/app-usability-audit-2026-10-16.md):
// the lobby's table settings in the campaign creator's named groups with a
// search that opens what it finds, the line that says what happens next, the
// three ways to a hero, the phone's More sheet reaching every tab, the
// Settings tab's contents row, and Help finding "volume" in its own words.
import { check, eventually, openPanelTab, sleep } from "../lib.mjs";

export default {
  name: "usability",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids, viewport } = t;

    // ---- the lobby ----
    await t.open(`/campaigns/${ids.lobbyId}`);
    const panel = page.locator(`${root}[data-table-settings="edit"]`).locator("visible=true").first();
    await eventually(() => panel.count(), { timeoutMs: 30_000, label: "the lobby's table settings" });
    const groups = panel.locator("[data-group]");
    const count = await groups.count();
    check(count >= 10, `the creator's named groups are drawn (${count})`);
    for (let index = 0; index < count; index += 1) {
      const summary = (await groups.nth(index).locator(".cc-group-summary").textContent())?.trim() ?? "";
      check(summary.length > 3, `group ${index} says what is set inside ("${summary}")`);
    }
    const narration = panel.locator('[data-group="narration"]');
    check((await narration.getAttribute("data-open")) === null, "groups start closed");

    // A search by the everyday word opens the group that answers it.
    const find = panel.getByRole("textbox", { name: "Find a table setting" });
    await find.fill("microphone");
    await eventually(async () => (await panel.locator("[data-group]").count()) === 1, { label: "one group answers microphone" });
    const voice = panel.locator('[data-group="voiceChat"]');
    check((await voice.count()) === 1, "it is Live voice chat");
    check((await voice.getAttribute("data-open")) !== null, "and it opens");
    await t.shot("settings-search");
    await find.fill("");
    await eventually(async () => (await panel.locator("[data-group]").count()) === count, { label: "every group back" });

    // What happens next, and the three ways to a hero for a seat with none.
    const next = page.locator(`${root}[data-lobby-next]`).locator("visible=true").first();
    await eventually(() => next.count(), { label: "the lobby's next-step line" });
    check(/choose your hero/i.test(await next.textContent()), "the lead without a hero is told to choose one");
    const routes = page.locator(`${root}[data-hero-routes]`).locator("visible=true").first();
    await eventually(() => routes.count(), { label: "the hero routes" });
    await eventually(async () => (await routes.getAttribute("aria-busy")) === "false", { label: "the routes loaded" });
    for (const route of ["ready", "library", "build"]) {
      check((await routes.locator(`[data-hero-route="${route}"]`).count()) === 1, `the ${route} route is offered`);
    }
    // The lead has heroes in the library (the seed's), so the library is marked.
    const marked = await routes.locator('[data-hero-route="library"]').innerText();
    check(/Suggested/i.test(marked), "a player with heroes is pointed at the library");
    await t.tap(routes.locator('[data-hero-route="ready"]'));
    await eventually(() => page.locator(`${root}[data-tour="pregen-picker"]`).locator("visible=true").count(), {
      label: "the ready-made heroes open",
    });
    await routes.scrollIntoViewIfNeeded();
    await sleep(400);
    await t.shot("hero-routes");

    // ---- the table: every tab reachable, the Settings tab's contents ----
    await t.open(`/campaigns/${ids.campaignId}`);
    const how = await openPanelTab(t, "settings");
    if (viewport === "phone") {
      check(how === "more", "a lead's phone keeps Settings under More");
    } else {
      check(how === "direct", "a desktop rail shows Settings itself");
    }
    const contents = page.locator(`${root}nav[aria-label="Settings sections"]`).locator("visible=true").first();
    await eventually(() => contents.count(), { label: "the Settings tab's contents row" });
    for (const label of ["Campaign", "Table settings", "Story AI", "Rules"]) {
      check((await contents.getByRole("button", { name: label }).count()) === 1, `the contents row names ${label}`);
    }
    await t.shot("settings-tab");

    // Help finds "volume" in its sections' own words.
    const help = page.locator(`${root}[data-tour="header-help"]`).locator("visible=true").first();
    await eventually(() => help.count(), { label: "the Help button" });
    await t.tap(help);
    const dialog = page.getByRole("dialog");
    await eventually(() => dialog.count(), { label: "the Help dialog" });
    const search = dialog.getByRole("textbox", { name: "Find a help topic" });
    await search.fill("volume");
    await eventually(async () => (await dialog.getByRole("button", { name: /Voice and narration/ }).count()) > 0, {
      label: "volume finds Voice and narration",
    });
    check(!/Nothing in Help mentions that/.test(await dialog.innerText()), "volume is not a dead end");
    await search.fill("zzzzqx");
    await eventually(async () => /Nothing in Help mentions that/.test(await dialog.innerText()), { label: "an unknown word says so" });
    await t.shot("help-search");
    await page.keyboard.press("Escape");
  },
};
