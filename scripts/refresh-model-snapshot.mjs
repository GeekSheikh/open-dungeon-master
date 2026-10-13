// Rewrites src/lib/model-registry/snapshot.json from models.dev: the model
// catalog a fresh server starts with before it has fetched its own copy, and
// the one an offline server keeps. Only the providers ODM reaches by name
// or that serve the open-weight models people run locally are kept, so the
// file stays a few hundred kilobytes; a running server caches the whole
// catalog in its data folder (src/lib/model-registry/catalog.ts).
//
//   node scripts/refresh-model-snapshot.mjs [--from /path/to/api.json]
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);
const { readCatalogProviders, catalogModelCount } = await import("../src/lib/model-registry/catalog-logic.ts");
const { MODELS_DEV_URL, SNAPSHOT_PROVIDERS } = await import("../src/lib/model-registry/catalog.ts");

const fromAt = process.argv.indexOf("--from");
const source = fromAt !== -1 ? process.argv[fromAt + 1] : "";
const raw = source
  ? JSON.parse(fs.readFileSync(source, "utf8"))
  : await fetch(MODELS_DEV_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) }).then((response) => {
      if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
      return response.json();
    });

const all = readCatalogProviders(raw);
const providers = Object.fromEntries(SNAPSHOT_PROVIDERS.filter((id) => all[id]).map((id) => [id, all[id]]));
const missing = SNAPSHOT_PROVIDERS.filter((id) => !all[id]);
if (missing.length) console.warn(`Not on models.dev today: ${missing.join(", ")}`);
const out = path.resolve(import.meta.dirname, "../src/lib/model-registry/snapshot.json");
fs.writeFileSync(out, JSON.stringify({ fetchedAt: new Date().toISOString().slice(0, 10), providers }));
console.log(`${out}: ${Object.keys(providers).length} providers, ${catalogModelCount(providers)} models, ${Math.round(fs.statSync(out).size / 1024)} KB`);
