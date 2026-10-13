// The hosted model IDs hardcoded under src/, checked against models.dev:
// which are deprecated, which a person must replace, and which tool-calling
// models are new. The rules are in scripts/lib/model-catalog.mjs; the weekly
// model-catalog workflow runs this and turns the output into one rolling
// issue and, when something is safe to drop, a PR. See docs/model-catalog.md.
//
//   npm run models:check                    report only, edits nothing
//   --write                                 drop the removable IDs from src/
//   --issue <file> / --pr <file>            write the issue and PR bodies
//   --removed <file>                        write the dropped IDs, one per line
//   --data <file>                           read a saved models.dev api.json
//   --since-days <n>                        window for new models (default 30)
import fs from "node:fs";
import path from "node:path";
import {
  applyRemovals,
  checkData,
  findModelIds,
  newModels,
  planChanges,
  renderIssue,
  renderPullRequest,
} from "./lib/model-catalog.mjs";

const root = path.join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

async function loadData() {
  const file = option("--data");
  if (file) return JSON.parse(fs.readFileSync(file, "utf8"));
  const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
  return response.json();
}

function sourceFiles() {
  const src = path.join(root, "src");
  return fs
    .readdirSync(src, { recursive: true })
    .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
    .map((name) => {
      const full = path.join(src, name);
      return { path: path.relative(root, full).split(path.sep).join("/"), text: fs.readFileSync(full, "utf8") };
    });
}

const data = await loadData();
checkData(data);

const files = sourceFiles();
const plan = planChanges(findModelIds(files, data), data);
const today = new Date().toISOString().slice(0, 10);
const sinceDays = Number(option("--since-days") ?? 30);
const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
const fresh = newModels(data, since);

const unique = (hits) => new Set(hits.map((hit) => `${hit.provider}/${hit.id}`)).size;
console.log(
  `${unique([...plan.listed, ...plan.review, ...plan.removable])} hardcoded model IDs on models.dev: ` +
    `${unique(plan.removable)} removable, ${unique(plan.review)} need a decision; ` +
    `${unique(plan.unlisted)} not on models.dev; ${fresh.length} new tool-calling models since ${since}.`,
);
for (const hit of plan.review) console.log(`decide: ${hit.id} (${hit.provider}) at ${hit.path}:${hit.line}: ${hit.reason}`);
for (const hit of plan.removable) console.log(`remove: ${hit.id} (${hit.provider}) at ${hit.path}:${hit.line}`);

const issueFile = option("--issue");
if (issueFile) fs.writeFileSync(issueFile, renderIssue({ plan, fresh, today, since }));

if (args.includes("--write") && plan.removable.length) {
  for (const file of files) {
    const removals = plan.removable.filter((hit) => hit.path === file.path);
    if (!removals.length) continue;
    const text = applyRemovals(file.text, removals);
    // The edit must have taken every dropped ID out and left the others.
    const after = findModelIds([{ path: file.path, text }], data);
    for (const hit of removals) {
      if (after.some((other) => other.line === hit.line && other.id === hit.id)) {
        throw new Error(`${hit.id} is still on ${file.path}:${hit.line} after the edit`);
      }
    }
    fs.writeFileSync(path.join(root, file.path), text);
  }
  const prFile = option("--pr");
  if (prFile) fs.writeFileSync(prFile, renderPullRequest({ plan, today }));
}

const removedFile = option("--removed");
if (removedFile) {
  fs.writeFileSync(removedFile, [...new Set(plan.removable.map((hit) => hit.id))].map((id) => `${id}\n`).join(""));
}
