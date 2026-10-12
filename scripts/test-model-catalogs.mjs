// The model catalog check (scripts/lib/model-catalog.mjs): which hardcoded
// model IDs it finds, which it may drop on its own, and what it writes into
// the weekly issue and PR. A small models.dev stand-in, no network.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applyRemovals,
  checkData,
  findModelIds,
  newModels,
  planChanges,
  plain,
  code,
  renderIssue,
  renderPullRequest,
} from "./lib/model-catalog.mjs";

const model = (fields = {}) => ({ tool_call: true, modalities: { input: ["text"], output: ["text"] }, ...fields });

const data = {
  openai: {
    models: {
      "gpt-new": model({ release_date: "2026-10-01", name: "GPT New", limit: { context: 400_000 } }),
      "gpt-live": model({ release_date: "2025-08-01" }),
      "gpt-old": model({ status: "deprecated", release_date: "2024-01-01" }),
      "gpt-older": model({ status: "deprecated", release_date: "2023-01-01" }),
      "gpt-image-old": model({ status: "deprecated", tool_call: false, modalities: { input: ["text"], output: ["image"] } }),
      "gpt-image-new": model({ tool_call: false, release_date: "2026-10-02", modalities: { input: ["text"], output: ["image"] } }),
      "gpt-retiring": model({ status: "deprecated", release_date: "2026-10-03" }),
    },
  },
  openrouter: {
    models: {
      "google/gemini-live": model({ release_date: "2026-09-20", name: "Gemini `Live` @everyone [x](https://evil.test)" }),
      "vendor/no-tools": model({ tool_call: false, release_date: "2026-10-05" }),
    },
  },
  anthropic: { models: { "claude-live": model({ release_date: "2026-01-01" }) } },
  xai: { models: { "grok-live": model({ beta: true, status: "beta", release_date: "2026-09-30" }) } },
  google: { models: { "gemini-live": model() } },
};

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const source = [
  'const PREFERRED = ["gpt-old", "gpt-live"];',
  'const ALL_DEAD = ["gpt-older", "gpt-old", "gpt-unknown"];',
  'const IMAGE_MODEL = "gpt-image-old";',
  'const fallback = serverEnv("OPENROUTER_MODEL", "google/gemini-live");',
  '// "gpt-old" in a comment is not code',
  'const mime = "image/png"; const route = "api/models"; const unknownVendor = "nobody/thing";',
  'const notListed = "tts-1";',
  'const both = ["gpt-older", "gpt-old", "claude-live"];',
].join("\n");
const files = [{ path: "src/a.ts", text: source }];

test("a response missing a watched provider is refused", () => {
  assert.doesNotThrow(() => checkData(data));
  assert.throws(() => checkData({ ...data, anthropic: { models: {} } }), /anthropic/);
  assert.throws(() => checkData(null), /openai/);
});

test("finds model ID literals and nothing else", () => {
  const found = findModelIds(files, data);
  const ids = found.map((hit) => `${hit.line}:${hit.id}`);
  assert.deepEqual(ids, [
    "1:gpt-old",
    "1:gpt-live",
    "2:gpt-older",
    "2:gpt-old",
    "2:gpt-unknown",
    "3:gpt-image-old",
    "4:google/gemini-live",
    "7:tts-1",
    "8:gpt-older",
    "8:gpt-old",
    "8:claude-live",
  ]);
  assert.equal(found.find((hit) => hit.id === "google/gemini-live").provider, "openrouter");
  assert.deepEqual(found[0].list.items, ["gpt-old", "gpt-live"]);
  assert.equal(found.find((hit) => hit.id === "gpt-image-old").list, null);
});

const plan = planChanges(findModelIds(files, data), data);

test("drops a deprecated ID only from a list with a live model beside it", () => {
  assert.deepEqual(
    plan.removable.map((hit) => `${hit.line}:${hit.id}`),
    ["1:gpt-old", "8:gpt-older", "8:gpt-old"],
  );
});

test("a deprecated default or a list with nothing live left goes to a person", () => {
  assert.deepEqual(
    plan.review.map((hit) => `${hit.line}:${hit.id}`),
    ["2:gpt-older", "2:gpt-old", "3:gpt-image-old"],
  );
  assert.match(plan.review.find((hit) => hit.id === "gpt-image-old").reason, /default/);
  assert.match(plan.review[0].reason, /nothing else in its list is live/);
});

test("an ID models.dev does not list is never removed", () => {
  assert.deepEqual(plan.unlisted.map((hit) => hit.id).sort(), ["gpt-unknown", "tts-1"]);
  assert.ok(!plan.removable.some((hit) => hit.id === "gpt-unknown"));
});

test("removal rewrites only the list, keeping its order and the rest of the line", () => {
  const removals = plan.removable.map((hit) => ({ ...hit, list: { ...hit.list } }));
  const lines = applyRemovals(source, removals).split("\n");
  assert.equal(lines[0], 'const PREFERRED = ["gpt-live"];');
  assert.equal(lines[7], 'const both = ["claude-live"];');
  assert.deepEqual(lines.slice(1, 7), source.split("\n").slice(1, 7));
});

test("new models: tool calls, text out, not deprecated, in the window, newest first", () => {
  const fresh = newModels(data, "2026-09-01");
  assert.deepEqual(
    fresh.map((entry) => entry.id),
    ["gpt-new", "grok-live", "google/gemini-live"],
  );
  assert.equal(fresh[0].context, 400_000);
});

test("models.dev text cannot add links, mentions or table columns", () => {
  assert.equal(code("a`b|c\nd"), "`abcd`");
  assert.equal(plain("Gemini `Live` @everyone [x](https://evil.test)"), "Gemini Live everyone x(https://evil.test)");
  const issue = renderIssue({ plan, fresh: newModels(data, "2026-09-01"), today: "2026-10-12", since: "2026-09-01" });
  assert.ok(!issue.includes("@everyone"));
  assert.ok(!issue.includes("](https://evil.test)"));
});

test("the issue names what needs a person and what the PR drops", () => {
  const issue = renderIssue({ plan, fresh: newModels(data, "2026-09-01"), today: "2026-10-12", since: "2026-09-01" });
  assert.match(issue, /^<!-- model-catalog-report -->/);
  assert.match(issue, /## Needs a decision \(3\)/);
  assert.match(issue, /`gpt-image-old` \(openai\): deprecated default/);
  assert.match(issue, /## Dropped by the weekly PR \(2\)/);
  assert.match(issue, /\| 2026-10-01 \| `gpt-new` \| GPT New \| 400K \|/);
  assert.match(issue, /Not on models.dev, so not checked \(2\)/);
  const pr = renderPullRequest({ plan, today: "2026-10-12" });
  assert.match(pr, /`gpt-old` \(openai\): `src\/a.ts:1`, `src\/a.ts:8`/);
  assert.match(pr, /npm test/);
});

// The real tree: the check still sees the defaults it exists to watch, so a
// change to how they are written cannot silently take them out of the report.
test("the repo's own defaults are found", () => {
  const root = path.join(import.meta.dirname, "..");
  const read = (file) => ({ path: file, text: fs.readFileSync(path.join(root, file), "utf8") });
  const realData = {
    ...data,
    openrouter: { models: { ...data.openrouter.models, "google/anything": model() } },
  };
  const found = findModelIds(
    ["src/lib/setup/discovery-logic.ts", "src/lib/runtime-defaults.ts", "src/lib/openai-images.ts"].map(read),
    realData,
  );
  const preferred = found.filter((hit) => hit.path.endsWith("discovery-logic.ts") && hit.provider === "openai");
  assert.ok(preferred.length >= 2, "KEY_PROVIDERS' OpenAI preferred list");
  assert.ok(preferred.every((hit) => hit.list && hit.list.items.length === preferred.length));
  assert.ok(found.some((hit) => hit.path.endsWith("runtime-defaults.ts") && hit.provider === "openrouter" && !hit.list));
  assert.ok(found.some((hit) => hit.path.endsWith("openai-images.ts") && hit.provider === "openai"));
});

console.log(`${passed} model catalog tests passed`);
