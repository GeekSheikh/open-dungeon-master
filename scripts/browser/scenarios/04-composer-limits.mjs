// Issue 207 (PR 234): every box a player types into says its limit before
// the server refuses the text. The chronicle's desk and the Hand's composer
// both carry the note.
import { check, eventually } from "../lib.mjs";

export default {
  name: "composer-limits",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids } = t;
    await t.open(`/campaigns/${ids.campaignId}`);
    await eventually(() => page.locator(`${root}.cine-stage`).count(), { label: "the table" });
    // A phone opens a fight on the board and shows one view at a time: the
    // composer is on the Table view. (The first-visit tour used to switch
    // there; it now opens once per account, so this asks for the view.)
    const tableView = page.locator(`${root}.cine-bottombar button`).filter({ hasText: /^\s*Table\s*$/ }).locator("visible=true").first();
    if (await tableView.count()) {
      await t.tap(tableView);
    }
    // The desk under the chronicle on the stage, or the Hand's composer
    // elsewhere: whichever is on screen says "Up to N characters".
    const note = await eventually(
      async () => {
        const body = (await page.locator(`${root}.cine-stage`).first().innerText()).replace(/\s+/g, " ");
        return body.match(/Up to [\d,]+ characters/)?.[0] ?? null;
      },
      { timeoutMs: 20_000, label: "a composer's limit note" },
    );
    check(/^Up to 2,000 characters$/.test(note), `the do/say composer says its limit (${note})`);
  },
};
