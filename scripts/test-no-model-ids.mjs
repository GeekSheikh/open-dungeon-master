// No model is named in src/ (issue #265, after #273): the backends list their
// models and the models.dev catalog describes them, so a model ID written
// into the code is one that will retire and keep being sent. This reads the
// catalog snapshot ODM ships (src/lib/model-registry/snapshot.json) and fails
// on any string literal in src/ that is a model ID from it. Offline: the
// snapshot is in the repository.
//
// What it cannot see: a model the snapshot does not list (its providers carry
// few speech models, so tts-1 or whisper-1 pass unseen), and code that guesses
// from a name, such as /mini|nano/. It checks names written into the code,
// nothing more.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

// Models ODM downloads and runs itself are pinned dependencies, not retired
// by a provider: name one here, with where it is used, if the catalog ever
// lists it. MiniLM, the built-in Whisper and the Z-Image files are not in the
// snapshot today, so nothing needs listing.
const PINNED = new Map([]);

// Names still in the code, each waiting on the change that removes it. An
// entry no longer found fails the test too, so this list only shrinks.
const LEFTOVERS = new Map([
  ["gpt-image-1", "the OpenAI image default (mcerina's follow-up to #273)"],
  ["grok-4.6", "Grok's fallback when `grok models` cannot be read (mcerina's follow-up to #273)"],
]);

// Every catalog ID, lower case, and the part after the last slash of an
// OpenRouter-style "vendor/model" ID when that part has a digit in it:
// "qwen/qwen3.6-35b" is also caught as "qwen3.6-35b", but "openrouter/auto"
// does not turn every "auto" in the code into a model.
function catalogIds(snapshot) {
  const ids = new Set();
  for (const provider of Object.values(snapshot.providers ?? {})) {
    for (const id of Object.keys(provider.models ?? {})) {
      const lower = id.toLowerCase();
      ids.add(lower);
      const tail = lower.slice(lower.lastIndexOf("/") + 1);
      if (tail !== lower && /\d/.test(tail)) ids.add(tail);
    }
  }
  return ids;
}

// String literals ("", '' and template strings without ${}) outside comment
// lines that are catalog IDs: [{ id, path, line }].
const LITERAL = /(["'`])((?:(?!\1)[^\\\n$]){2,100})\1/g;
function namedModels(files, ids) {
  const found = [];
  for (const file of files) {
    file.text.split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      for (const match of line.matchAll(LITERAL)) {
        const id = match[2].trim().toLowerCase();
        if (ids.has(id)) found.push({ id, path: file.path, line: index + 1 });
      }
    });
  }
  return found;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
}

test("the matcher finds catalog IDs in code and leaves words and comments alone", () => {
  const ids = catalogIds({
    providers: {
      openai: { models: { "gpt-9": {} } },
      openrouter: { models: { "qwen/qwen9-35b": {}, "openrouter/auto": {} } },
    },
  });
  const found = namedModels([{
    path: "src/a.ts",
    text: [
      'const model = "gpt-9";',
      "const local = 'qwen9-35b';",
      "const routed = `qwen/qwen9-35b`;",
      'const mode = "auto";',
      '// the old default was "gpt-9"',
      "const built = `${prefix}gpt-9`;",
      'const near = "gpt-9-turbo";',
    ].join("\n"),
  }], ids);
  assert.deepEqual(found.map((hit) => `${hit.line}:${hit.id}`), ["1:gpt-9", "2:qwen9-35b", "3:qwen/qwen9-35b"]);
});

const snapshot = JSON.parse(fs.readFileSync(path.join(root, "src/lib/model-registry/snapshot.json"), "utf8"));
const ids = catalogIds(snapshot);
const files = fs
  .readdirSync(path.join(root, "src"), { recursive: true })
  .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
  .map((name) => {
    const rel = path.join("src", name).split(path.sep).join("/");
    return { path: rel, text: fs.readFileSync(path.join(root, rel), "utf8") };
  });
const found = namedModels(files, ids);

test("the snapshot is the catalog, not an empty or broken file", () => {
  assert.ok(ids.size > 500, `only ${ids.size} model IDs in the snapshot`);
});

test("src/ names no model outside the pinned and leftover lists", () => {
  const unexpected = found.filter((hit) => !PINNED.has(hit.id) && !LEFTOVERS.has(hit.id));
  assert.deepEqual(
    unexpected.map((hit) => `${hit.path}:${hit.line} names ${hit.id}`),
    [],
    "Read the model from the backend or the catalog instead (src/lib/model-registry), or, for a model ODM downloads and runs itself, add it to PINNED.",
  );
});

test("every leftover is still there, so a removed one comes off the list", () => {
  const stale = [...LEFTOVERS.keys()].filter((id) => !found.some((hit) => hit.id === id));
  assert.deepEqual(stale, [], "These are gone from src/: delete them from LEFTOVERS in scripts/test-no-model-ids.mjs.");
});

console.log(`${passed} no-model-ids tests passed`);
