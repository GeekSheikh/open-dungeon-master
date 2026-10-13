// No model is named in src/ (scripts/lib/model-catalog.mjs): every string
// literal that is a model ID in the registry's models.dev snapshot is either
// a model ODM runs itself or on the follow-up's list. A small catalog
// stand-in pins the matcher; the last test runs it over the real tree.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PENDING, RUN_HERE, catalogIds, findModelIds, judge } from "./lib/model-catalog.mjs";

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

const catalog = {
  providers: {
    openai: { models: { "gpt-live": {}, "gpt-image-old": {} } },
    openrouter: { models: { "google/gemini-live": {} } },
    deepinfra: { models: { "Qwen/Qwen3.6-35B-A3B": {} } },
    anthropic: { models: { "claude-live": {} } },
  },
};
const ids = catalogIds(catalog);

const source = [
  'const IMAGE_MODEL = "gpt-image-old";',
  "const fallback = serverEnv('OPENROUTER_MODEL', 'google/gemini-live');",
  '// "gpt-live" in a comment is not code',
  ' * "claude-live" in a doc comment either',
  'const mime = "image/png"; const route = "api/models"; const prose = "pick gpt-live for speed";',
  'const local = "qwen/qwen3.6-35b-a3b"; const template = `${provider}/gpt-live`; const plain = `claude-live`;',
  'const unknown = "gpt-unknown";',
].join("\n");

test("the snapshot's IDs are read in either catalog shape, without regard to case", () => {
  assert.deepEqual(ids.get("qwen/qwen3.6-35b-a3b"), ["deepinfra"]);
  assert.deepEqual(catalogIds({ openai: { models: { "gpt-live": {} } } }).get("gpt-live"), ["openai"], "models.dev's own api.json");
  assert.equal(catalogIds(null).size, 0);
});

test("finds whole literals that are model IDs, and nothing else", () => {
  const found = findModelIds([{ path: "src/a.ts", text: source }], ids);
  assert.deepEqual(
    found.map((hit) => `${hit.line}:${hit.id}`),
    ["1:gpt-image-old", "2:google/gemini-live", "6:qwen/qwen3.6-35b-a3b", "6:claude-live"],
  );
  assert.deepEqual(found[1].providers, ["openrouter"]);
});

test("the lists cover what they name, and an entry src/ no longer names is stale", () => {
  const found = findModelIds([{ path: "src/a.ts", text: source }], ids);
  const verdict = judge(found, { RUN_HERE: { "Qwen/Qwen3.6-35B-A3B": "runs here" }, PENDING: { "gpt-image-old": "a follow-up", "gone-model": "done" } });
  assert.deepEqual(verdict.unexpected.map((hit) => hit.id), ["google/gemini-live", "claude-live"]);
  assert.deepEqual(verdict.stale, ["gone-model"]);
});

test("every list entry says why it may stay", () => {
  for (const [id, why] of Object.entries({ ...RUN_HERE, ...PENDING })) {
    assert.ok(typeof why === "string" && why.length > 10, `${id} needs its reason`);
  }
});

// The real tree against the snapshot the registry ships.
test("src/ names no model the catalog knows, beyond the two lists", () => {
  const root = path.join(import.meta.dirname, "..");
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, "src/lib/model-registry/snapshot.json"), "utf8"));
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) files.push({ path: path.relative(root, full).replaceAll("\\", "/"), text: fs.readFileSync(full, "utf8") });
    }
  })(path.join(root, "src"));
  assert.ok(files.length > 500, "the walk found src/");
  const snapshotIds = catalogIds(snapshot);
  assert.ok(snapshotIds.size > 500, "the snapshot holds the catalog");
  const { unexpected, stale } = judge(findModelIds(files, snapshotIds));
  assert.deepEqual(
    unexpected.map((hit) => `${hit.path}:${hit.line} ${hit.id}`),
    [],
    "a model ID written into src/: list what the provider serves through the registry instead (docs/model-catalog.md)",
  );
  assert.deepEqual(stale, [], "src/ no longer names these: take them off the list in scripts/lib/model-catalog.mjs");
});

console.log(`${passed} model catalog tests passed`);
