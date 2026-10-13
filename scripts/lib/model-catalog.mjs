// The model IDs written into src/, found against the models.dev snapshot the
// model registry bundles (src/lib/model-registry/snapshot.json). ODM names no
// model in its code: the pickers list what each provider serves, and the
// registry judges those against the catalog (docs/model-catalog.md). Pure
// functions, so scripts/test-model-catalogs.mjs can pin every rule and then
// run them over the real tree.
//
// Two lists say which IDs may stay, each with why:
// - RUN_HERE: models ODM downloads and runs itself. They are pinned like a
//   dependency and are not retired under it.
// - PENDING: IDs still written into src/ that a follow-up is taking out. The
//   test fails once one is gone from src/, so the list empties as the work
//   lands and doubles as its checklist.

export const RUN_HERE = {};

export const PENDING = {
  "gpt-image-1": "the OpenAI image default (src/lib/openai-images.ts, Admin > Images); models.dev marks it deprecated",
  "grok-4.6": "Grok Build's model when `grok models` cannot be read (src/lib/harness/adapters/grok.ts)",
};

// Every model ID the catalog lists, lower-cased, with the providers that
// list it. Reads the registry's compact snapshot ({ providers: { id: {
// models } } }) or models.dev's own api.json ({ id: { models } }).
export function catalogIds(catalog) {
  const providers = catalog?.providers ?? catalog ?? {};
  const ids = new Map();
  for (const [provider, entry] of Object.entries(providers)) {
    for (const id of Object.keys(entry?.models ?? {})) {
      const key = id.toLowerCase();
      ids.set(key, [...(ids.get(key) ?? []), provider]);
    }
  }
  return ids;
}

// A whole string literal in any of the three quotes; a template literal that
// interpolates is not one model name.
const LITERAL = /(["'`])((?:(?!\1)[^\\\n])+)\1/g;

// Every literal whose whole text is a model ID the catalog lists:
// { id, providers, path, line }. files is [{ path, text }]. Comment lines
// are skipped, as is a name inside a longer string (prose, a URL).
export function findModelIds(files, ids) {
  const found = [];
  for (const file of files) {
    file.text.split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      for (const match of line.matchAll(LITERAL)) {
        if (match[1] === "`" && match[2].includes("${")) continue;
        const providers = ids.get(match[2].toLowerCase());
        if (providers) found.push({ id: match[2], providers, path: file.path, line: index + 1 });
      }
    });
  }
  return found;
}

// What the lists do not cover, and the list entries src/ no longer names.
export function judge(found, lists = { RUN_HERE, PENDING }) {
  const allowed = new Set(Object.values(lists).flatMap((list) => Object.keys(list).map((id) => id.toLowerCase())));
  const named = new Set(found.map((hit) => hit.id.toLowerCase()));
  return {
    unexpected: found.filter((hit) => !allowed.has(hit.id.toLowerCase())),
    stale: [...allowed].filter((id) => !named.has(id)).sort(),
  };
}
