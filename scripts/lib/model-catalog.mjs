// The hosted model IDs ODM hardcodes, checked against models.dev
// (https://models.dev, an open database of AI models). Pure functions, so
// scripts/test-model-catalogs.mjs can pin every rule; the network and the
// file writes live in scripts/check-model-catalogs.mjs.
//
// Two outcomes, split by risk:
// - removable: an ID models.dev marks deprecated that sits in a one-line list
//   of IDs with a live model beside it (KEY_PROVIDERS' `preferred`). Dropping
//   it changes which model is preselected, never whether one is.
// - review: everything else that needs a person, chiefly a deprecated ID that
//   is a lone default. Replacing a default is a benchmark question.
// An ID models.dev does not list is never removed: absence there can mean a
// gap in its data as easily as a retired model.

// The models.dev providers the check needs. A response without any of them is
// treated as broken rather than read as "every ID is unlisted".
export const WATCHED_PROVIDERS = ["openai", "openrouter", "anthropic", "xai", "google"];

// The providers a table can pick a storyteller from: OpenAI and OpenRouter in
// the setup wizard, Claude and Grok through the agent panel.
export const NEW_MODEL_PROVIDERS = ["openai", "openrouter", "anthropic", "xai"];

// A bare ID's provider, from its name. OpenRouter IDs are "vendor/model" and
// are recognized by a vendor models.dev's OpenRouter list knows, which keeps
// MIME types ("image/png") and paths out.
const BARE_ID_PROVIDERS = [
  ["openai", /^(gpt-|chatgpt-|o[1-9](-|$)|tts-1|whisper-|dall-e-|text-embedding-)/],
  ["anthropic", /^claude-/],
  ["xai", /^grok-/],
  ["google", /^gemini-/],
];

const SLASH_ID = /^([a-z0-9][a-z0-9-]*)\/[a-z0-9][\w.:-]*$/i;

export function checkData(data) {
  for (const provider of WATCHED_PROVIDERS) {
    const models = data?.[provider]?.models;
    if (!models || typeof models !== "object" || Object.keys(models).length === 0) {
      throw new Error(`models.dev answered without its ${provider} models; refusing to judge against a partial list`);
    }
  }
}

export function openRouterVendors(data) {
  return new Set(Object.keys(data.openrouter.models).map((id) => id.split("/")[0]));
}

export function providerFor(id, vendors) {
  const slash = SLASH_ID.exec(id);
  if (slash) return vendors.has(slash[1]) ? "openrouter" : null;
  for (const [provider, pattern] of BARE_ID_PROVIDERS) {
    if (pattern.test(id)) return provider;
  }
  return null;
}

// "deprecated", "listed", or "unlisted".
export function statusOf(data, provider, id) {
  const entry = data[provider]?.models?.[id];
  if (!entry) return "unlisted";
  return entry.status === "deprecated" ? "deprecated" : "listed";
}

const LITERAL = /"([^"\\\s]{2,100})"/g;
const STRING_LIST = /\[\s*"[^"]*"(?:\s*,\s*"[^"]*")*\s*\]/g;

// The one-line list of string literals around a position, if there is one.
function listAround(line, start, end) {
  for (const match of line.matchAll(STRING_LIST)) {
    if (match.index <= start && end <= match.index + match[0].length) {
      return { text: match[0], items: [...match[0].matchAll(/"([^"]*)"/g)].map((item) => item[1]) };
    }
  }
  return null;
}

// Every model ID literal in the given files: { id, provider, path, line, list }.
// files is [{ path, text }]; comment lines are skipped.
export function findModelIds(files, data) {
  const vendors = openRouterVendors(data);
  const found = [];
  for (const file of files) {
    file.text.split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      for (const match of line.matchAll(LITERAL)) {
        const provider = providerFor(match[1], vendors);
        if (!provider) continue;
        found.push({
          id: match[1],
          provider,
          path: file.path,
          line: index + 1,
          list: listAround(line, match.index, match.index + match[0].length),
        });
      }
    });
  }
  return found;
}

// Sorts what was found into removable, review, listed and unlisted.
export function planChanges(found, data) {
  const vendors = openRouterVendors(data);
  const live = (id) => {
    const provider = providerFor(id, vendors);
    return Boolean(provider) && statusOf(data, provider, id) === "listed";
  };
  const plan = { removable: [], review: [], listed: [], unlisted: [] };
  for (const hit of found) {
    const status = statusOf(data, hit.provider, hit.id);
    if (status === "listed") {
      plan.listed.push(hit);
    } else if (status === "unlisted") {
      plan.unlisted.push(hit);
    } else if (hit.list && hit.list.items.some((other) => other !== hit.id && live(other))) {
      plan.removable.push(hit);
    } else {
      plan.review.push({
        ...hit,
        reason: hit.list ? "deprecated, and nothing else in its list is live" : "deprecated default; a replacement needs choosing",
      });
    }
  }
  return plan;
}

// A file's text with the removable IDs taken out of their lists. Only the
// list is rewritten; models.dev text never enters the source.
export function applyRemovals(text, removals) {
  const lines = text.split("\n");
  for (const hit of removals) {
    const index = hit.line - 1;
    const line = lines[index];
    const start = line.indexOf(hit.list.text);
    if (start === -1) continue;
    const kept = hit.list.items.filter((item) => item !== hit.id);
    const rebuilt = `[${kept.map((item) => JSON.stringify(item)).join(", ")}]`;
    lines[index] = line.slice(0, start) + rebuilt + line.slice(start + hit.list.text.length);
    // A second removal on the same line works from the rebuilt list.
    for (const other of removals) {
      if (other !== hit && other.path === hit.path && other.line === hit.line) {
        other.list = { text: rebuilt, items: kept };
      }
    }
  }
  return lines.join("\n");
}

// Storyteller candidates models.dev added since a date: tool calls, text out,
// not deprecated. Newest first.
export function newModels(data, since, providers = NEW_MODEL_PROVIDERS) {
  const out = [];
  for (const provider of providers) {
    for (const [id, entry] of Object.entries(data[provider]?.models ?? {})) {
      if (entry.tool_call !== true || entry.status === "deprecated") continue;
      if (!entry.modalities?.output?.includes("text")) continue;
      if (!entry.release_date || entry.release_date < since) continue;
      out.push({ provider, id, name: entry.name ?? id, released: entry.release_date, context: entry.limit?.context });
    }
  }
  return out.sort((a, b) => (a.released === b.released ? (a.id < b.id ? -1 : 1) : a.released < b.released ? 1 : -1));
}

// models.dev is outside text: an ID or name goes into the markdown only as a
// code span or with everything but plain characters removed, so it cannot
// add a link, a mention or a table column.
export function code(value) {
  return `\`${String(value).replace(/[`\r\n|]/g, "")}\``;
}

export function plain(value) {
  return String(value).replace(/[^\w .:()+/-]/g, "").slice(0, 80);
}

function where(hits) {
  return hits.map((hit) => code(`${hit.path}:${hit.line}`)).join(", ");
}

function byId(hits) {
  const groups = new Map();
  for (const hit of hits) {
    const key = `${hit.provider}\u0000${hit.id}`;
    groups.set(key, [...(groups.get(key) ?? []), hit]);
  }
  return [...groups.values()];
}

export const ISSUE_MARKER = "<!-- model-catalog-report -->";

export function renderIssue({ plan, fresh, today, since, perProvider = 25 }) {
  const out = [
    ISSUE_MARKER,
    `Checked against [models.dev](https://models.dev) on ${today}. The weekly \`model-catalog\` workflow rewrites this issue; edits to it are lost on the next run. Comment instead.`,
    "",
  ];

  const review = byId(plan.review);
  out.push(`## Needs a decision (${review.length})`, "");
  if (review.length) {
    out.push("models.dev marks these deprecated, and the weekly PR cannot drop them safely: each is a default with nothing to fall back to. Picking a replacement is a benchmark question.", "");
    for (const hits of review) out.push(`- ${code(hits[0].id)} (${hits[0].provider}): ${hits[0].reason}. ${where(hits)}`);
  } else {
    out.push("Nothing.");
  }
  out.push("");

  const removable = byId(plan.removable);
  if (removable.length) {
    out.push(`## Dropped by the weekly PR (${removable.length})`, "");
    for (const hits of removable) out.push(`- ${code(hits[0].id)} (${hits[0].provider}): ${where(hits)}`);
    out.push("");
  }

  out.push(`## New tool-calling models since ${since} (${fresh.length})`, "");
  if (fresh.length) {
    out.push("Candidates for the storyteller, not yet verified with ODM: tool calls in models.dev's data do not prove a model rolls the dice when it should.", "");
    for (const provider of NEW_MODEL_PROVIDERS) {
      const rows = fresh.filter((model) => model.provider === provider);
      if (!rows.length) continue;
      out.push(`### ${provider} (${rows.length})`, "", "| Released | Model | Name | Context |", "| --- | --- | --- | --- |");
      for (const model of rows.slice(0, perProvider)) {
        const context = model.context ? `${Math.round(model.context / 1000)}K` : "";
        out.push(`| ${model.released} | ${code(model.id)} | ${plain(model.name)} | ${context} |`);
      }
      if (rows.length > perProvider) out.push("", `And ${rows.length - perProvider} more on models.dev.`);
      out.push("");
    }
  } else {
    out.push("Nothing.", "");
  }

  const all = byId([...plan.review, ...plan.removable, ...plan.listed]);
  out.push(
    `<details><summary>Every hardcoded model ID models.dev lists (${all.length})</summary>`,
    "",
    "| Model | Provider | Status | Where |",
    "| --- | --- | --- | --- |",
  );
  for (const hits of all) {
    const status = plan.listed.includes(hits[0]) ? "listed" : "deprecated";
    out.push(`| ${code(hits[0].id)} | ${hits[0].provider} | ${status} | ${where(hits)} |`);
  }
  out.push("", "</details>", "");

  const unlisted = byId(plan.unlisted);
  if (unlisted.length) {
    out.push(
      `<details><summary>Not on models.dev, so not checked (${unlisted.length})</summary>`,
      "",
      "models.dev has no entry for these, which can mean a gap in its data as easily as a retired model. Speech and transcription models are the usual case.",
      "",
    );
    for (const hits of unlisted) out.push(`- ${code(hits[0].id)} (${hits[0].provider}): ${where(hits)}`);
    out.push("", "</details>", "");
  }
  return out.join("\n");
}

export function renderPullRequest({ plan, today }) {
  const out = [
    `models.dev marks these model IDs deprecated as of ${today}. Each sat in a list with a live model beside it, so dropping it changes which model is preselected, not whether one is.`,
    "",
  ];
  for (const hits of byId(plan.removable)) out.push(`- ${code(hits[0].id)} (${hits[0].provider}): ${where(hits)}`);
  out.push(
    "",
    "The weekly `model-catalog` workflow opened this PR. Checks do not run on a PR a workflow opens with its own token, so run `npm test` before merging; a test that names a dropped ID needs updating with it.",
    "",
  );
  return out.join("\n");
}
