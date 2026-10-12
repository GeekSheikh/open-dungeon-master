#!/usr/bin/env node
// Measures the catalog's ComfyUI image models (src/lib/image-models) on the
// machine ComfyUI runs on: seconds per ODM picture, the first picture after a
// model switch, and peak GPU memory, with the very graph the server sends.
// Pictures land in --out for review; --write records the rows in
// src/lib/image-models/verified.json, keyed by model and hardware.
//
//   node scripts/bench-image-models.mjs                  # every installed model
//   node scripts/bench-image-models.mjs --models z_turbo,flux2_klein_4b
//   node scripts/bench-image-models.mjs --models all --download --comfy-dir ~/ComfyUI
//   node scripts/bench-image-models.mjs --models qwen_image --steps 30 --cfg 4 --label s30
//   node scripts/bench-image-models.mjs --table          # verified.json as Markdown
//
// --download (or --download-only) fetches a model's missing files into <comfy-dir>/models/<folder>
// (a Hugging Face token from HF_TOKEN or ~/.cache/huggingface/token is sent
// for gated repos) and lists them in <out>/downloaded.json so they can be
// removed again. --files slot=name pins one slot's file. --hardware names
// the profile when the device is not one curate.ts knows. --steps, --cfg,
// --drop-patch and --files try other settings; leave --write off for those.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMFY_MODELS } from "../src/lib/image-models/catalog.ts";
import { hardwareProfile, missingFiles, pickModelFiles, readComfyDevice } from "../src/lib/image-models/curate.ts";
import { FOLDER_LOADER } from "../src/lib/image-models/types.ts";
import { buildModelWorkflow, modelDimensions, modelSteps } from "../src/lib/image-models/workflow.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERIFIED = path.join(root, "src/lib/image-models/verified.json");

const args = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const url = flag("url", "http://127.0.0.1:8188").replace(/\/+$/, "");
const out = path.resolve(flag("out", path.join(os.tmpdir(), "odm-image-bench")));
const comfyDir = flag("comfy-dir").replace(/^~/, os.homedir());
const label = flag("label");
const stepsOverride = flag("steps") ? Number(flag("steps")) : undefined;
const cfgOverride = flag("cfg") ? Number(flag("cfg")) : undefined;
// --drop-patch QwenImage21Cache: measure a model without one of its patches.
const dropped = flag("drop-patch");
const pinned = Object.fromEntries(
  args.flatMap((arg, index) => (args[index - 1] === "--files" ? arg.split(",") : [])).map((pair) => pair.split("=")),
);
const JOB_TIMEOUT_MS = Number(flag("timeout-min", "30")) * 60_000;
// --restart-cmd "systemctl --user restart comfyui": restart ComfyUI before
// each model instead of asking it to unload the last one. ComfyUI unloads a
// model by copying its weights to CPU memory first, which on a unified-memory
// machine briefly doubles a big model and can run the box out of memory; a
// restart starts every model from clean memory and a true cold start.
const restartCmd = flag("restart-cmd") || process.env.ODM_BENCH_RESTART_CMD || "";
// Past this first picture, the second portrait is skipped.
const SLOW_SECONDS = 240;
fs.mkdirSync(out, { recursive: true });

// ODM's own prompts, built the way src/lib/portrait.ts and the storyteller
// write them: a portrait and a creature token (square) and a scene
// (landscape), all in fast mode.
const PROMPTS = [
  {
    key: "portrait",
    aspect: "square",
    text:
      "Tabletop RPG character portrait, head and shoulders, centered, looking at viewer. female dwarf cleric. " +
      "High fantasy, painterly, rich colour. Acolyte background. Copper braids threaded with silver rings, a burn scar " +
      "across one cheek, a hammer-shaped holy symbol on a chain. Detailed digital painting, dramatic lighting, plain dark background",
  },
  {
    key: "creature",
    aspect: "square",
    text:
      "An owlbear, full body, three-quarter view, standing on a mossy forest floor: a huge bear's body covered in brown " +
      "feathers and fur, an owl's head with a hooked beak and round amber eyes, thick talons. High fantasy creature " +
      "illustration, detailed digital painting, dramatic lighting, simple dark background",
  },
  {
    key: "scene",
    aspect: "landscape",
    text:
      "A torchlit dwarven forge hall carved into a mountain: rivers of molten metal in stone channels, enormous anvils, " +
      "chains and hanging lanterns, a stone bridge over a glowing chasm, adventurers small in the foreground. High fantasy " +
      "illustration, painterly, rich colour, cinematic wide shot",
  },
];

async function getJson(pathname, init = {}) {
  const response = await fetch(`${url}${pathname}`, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function waitForComfy(maxMs = 15 * 60_000) {
  const until = Date.now() + maxMs;
  for (;;) {
    try {
      const stats = await getJson("/system_stats");
      if (stats.status === 200) return stats.body;
    } catch {
      // still starting
    }
    if (Date.now() > until) throw new Error(`ComfyUI at ${url} did not answer for ${maxMs / 60_000} minutes.`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function comfyLists() {
  const lists = {};
  for (const [folder, { node, input }] of Object.entries(FOLDER_LOADER)) {
    const info = await getJson(`/object_info/${node}`);
    const field = info.body?.[node]?.input?.required?.[input];
    const names = Array.isArray(field?.[0]) ? field[0] : field?.[0] === "COMBO" ? field[1]?.options : [];
    lists[folder] = Array.isArray(names) ? names : [];
  }
  return lists;
}

function hfToken() {
  if (process.env.HF_TOKEN) return process.env.HF_TOKEN.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), ".cache/huggingface/token"), "utf8").trim();
  } catch {
    return "";
  }
}

async function download(file) {
  const target = path.join(comfyDir, "models", file.folder, file.names[0]);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const token = hfToken();
  // The token goes to curl in a private header file, never on its command
  // line: a failed command's message (and any log of it) would print it.
  const headerFile = path.join(os.tmpdir(), `odm-bench-hf-${process.pid}`);
  const useToken = token && file.url.startsWith("https://huggingface.co/");
  if (useToken) fs.writeFileSync(headerFile, `Authorization: Bearer ${token}\n`, { mode: 0o600 });
  console.log(`  downloading ${file.names[0]} (${file.sizeGb} GB)`);
  try {
    // curl resumes a cut download and holds 170 MB/s without buffering in Node.
    execFileSync(
      "curl",
      ["-fsSL", "--retry", "5", "--retry-delay", "10", "-C", "-", "-o", `${target}.part`, ...(useToken ? ["-H", `@${headerFile}`] : []), file.url],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (failure) {
    const reason = String(failure?.stderr ?? "").replaceAll(token || "\0", "<token>").trim().split("\n").pop();
    throw new Error(`could not download ${file.names[0]} from ${file.url}: ${reason || "curl failed"}`);
  } finally {
    if (useToken) fs.rmSync(headerFile, { force: true });
  }
  fs.renameSync(`${target}.part`, target);
  const manifest = path.join(out, "downloaded.json");
  const listed = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : [];
  fs.writeFileSync(manifest, `${JSON.stringify([...new Set([...listed, target])], null, 2)}\n`);
  return target;
}

// Polls GPU memory while a job runs; ComfyUI's vram_free is what torch sees
// free on the device, system-wide on a unified-memory machine.
function memoryWatch() {
  let low = Infinity;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const stats = await getJson("/system_stats");
        const free = stats.body?.devices?.[0]?.vram_free;
        if (typeof free === "number") low = Math.min(low, free);
      } catch {
        // a busy ComfyUI answers late; the next poll counts
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return low;
    },
  };
}

class ComfyRestarted extends Error {
  constructor() {
    super("ComfyUI restarted during the job (out of memory?)");
  }
}

// Whether a failure means ComfyUI itself went away, not the model.
const lostComfy = (failure) =>
  failure instanceof ComfyRestarted || /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up/i.test(`${failure?.message} ${failure?.cause?.message ?? ""}`);

async function runJob(workflow) {
  const submitted = await getJson("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: "odm-bench" }),
  });
  if (submitted.status !== 200) {
    const detail = JSON.stringify(submitted.body?.node_errors ?? submitted.body?.error ?? submitted.body).slice(0, 600);
    throw new Error(`ComfyUI rejected the graph: ${detail}`);
  }
  const id = submitted.body.prompt_id;
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (Date.now() > deadline) {
      await getJson("/interrupt", { method: "POST" }).catch(() => {});
      throw new Error(`timed out after ${JOB_TIMEOUT_MS / 60_000} minutes`);
    }
    let entry;
    try {
      entry = (await getJson(`/history/${id}`)).body?.[id];
    } catch {
      // ComfyUI went away. Back again without this job in its queue or its
      // history means it restarted (an out-of-memory kill, usually) and the
      // job is gone: say so rather than poll for half an hour.
      await waitForComfy();
      const queue = (await getJson("/queue")).body ?? {};
      const queued = [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].some((item) => item?.[1] === id);
      const known = (await getJson(`/history/${id}`)).body?.[id];
      if (!queued && !known) throw new ComfyRestarted();
      continue;
    }
    if (!entry?.status) continue;
    const messages = entry.status.messages ?? [];
    const at = (kind) => messages.find(([name]) => name === kind)?.[1]?.timestamp;
    if (entry.status.status_str === "error") {
      const failure = messages.find(([name]) => name === "execution_error")?.[1];
      throw new Error(`${failure?.node_type ?? "ComfyUI"}: ${String(failure?.exception_message ?? "failed").trim().slice(0, 400)}`);
    }
    if (!entry.status.completed) continue;
    const image = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? [])[0];
    if (!image) throw new Error("finished without a picture");
    const view = await fetch(
      `${url}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder ?? "")}&type=${image.type ?? "output"}`,
    );
    return { seconds: (at("execution_success") - at("execution_start")) / 1000, bytes: Buffer.from(await view.arrayBuffer()) };
  }
}

const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

async function bench(catalogModel, lists, device, hardware) {
  const model = dropped
    ? { ...catalogModel, graph: { ...catalogModel.graph, modelPatches: (catalogModel.graph.modelPatches ?? []).filter((patch) => patch.node !== dropped) } }
    : catalogModel;
  const files = { ...pickModelFiles(model, lists), ...pinned };
  const missing = missingFiles(model, files);
  if (missing.length) {
    if (!has("download") || !comfyDir) {
      return { skipped: `missing ${missing.map((file) => file.names[0]).join(", ")}` };
    }
    try {
      for (const file of missing) await download(file);
    } catch (failure) {
      return { skipped: failure instanceof Error ? failure.message : String(failure) };
    }
    return null; // re-list, then bench
  }
  const name = (key, seed) => `${model.id}${label ? `-${label}` : ""}-${key}-${seed}.png`;
  console.log(`== ${model.id} (${Object.values(files).join(", ")})`);
  if (restartCmd) {
    execFileSync("sh", ["-c", restartCmd], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await waitForComfy(5 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } else {
    await getJson("/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  const baselineFree = (await getJson("/system_stats")).body?.devices?.[0]?.vram_free ?? 0;
  const watch = memoryWatch();
  const times = {};
  let coldSeconds = 0;
  let error = "";
  try {
    const runs = [
      { prompt: PROMPTS[0], seed: 1001, cold: true },
      { prompt: PROMPTS[0], seed: 2002 },
      { prompt: PROMPTS[1], seed: 3003 },
      { prompt: PROMPTS[2], seed: 4004 },
    ];
    for (const run of runs) {
      // A model this slow is no table's everyday painter: one portrait is
      // enough, the creature and the scene still run for the pictures.
      if (run.seed === 2002 && coldSeconds > SLOW_SECONDS) continue;
      const { width, height } = modelDimensions(model, "fast", run.prompt.aspect);
      const workflow = buildModelWorkflow(model, {
        prompt: run.prompt.text,
        width,
        height,
        seed: run.seed,
        files,
        steps: stepsOverride,
        cfg: cfgOverride,
      });
      const result = await runJob(workflow);
      fs.writeFileSync(path.join(out, name(run.prompt.key, run.seed)), result.bytes);
      console.log(`  ${run.prompt.key} ${width}x${height} seed ${run.seed}: ${round(result.seconds)} s${run.cold ? " (first, loading)" : ""}`);
      if (run.cold) coldSeconds = result.seconds;
      else (times[run.prompt.aspect] ??= []).push(result.seconds);
    }
  } catch (failure) {
    if (lostComfy(failure)) {
      await watch.stop();
      throw failure;
    }
    error = failure instanceof Error ? failure.message : String(failure);
    console.log(`  FAILED: ${error}`);
  }
  const lowFree = await watch.stop();
  const average = (list) => (list?.length ? round(list.reduce((sum, value) => sum + value, 0) / list.length) : 0);
  const row = {
    model: model.id,
    hardware: hardware?.id ?? flag("hardware", "unknown"),
    device: device?.name ?? "",
    memoryGb: device?.memoryGb ?? 0,
    comfyui: device?.comfyui ?? "",
    torch: device?.torch ?? "",
    date: new Date().toISOString().slice(0, 10),
    files,
    steps: stepsOverride ?? modelSteps(model),
    seconds: { square: average(times.square), landscape: average(times.landscape) },
    coldSeconds: round(coldSeconds),
    peakGb: Number.isFinite(lowFree) ? round(Math.max(0, baselineFree - lowFree) / 1024 ** 3) : 0,
    verdict: error ? "fails" : "works",
    ...(error ? { notes: error } : {}),
  };
  console.log(`  -> square ${row.seconds.square} s, landscape ${row.seconds.landscape} s, first ${row.coldSeconds} s, peak ${row.peakGb} GB`);
  fs.appendFileSync(path.join(out, "results.jsonl"), `${JSON.stringify({ ...row, label, cfg: cfgOverride })}\n`);
  try {
    const sheet = path.join(out, `${model.id}${label ? `-${label}` : ""}.sheet.jpg`);
    const pictures = PROMPTS.flatMap((prompt, index) => [name(prompt.key, [2002, 3003, 4004][index])])
      .concat([name("portrait", 1001)])
      .map((file) => path.join(out, file))
      .filter((file) => fs.existsSync(file));
    if (pictures.length) {
      execFileSync("montage", [...pictures, "-geometry", "512x512>+4+4", "-tile", "4x1", "-background", "#222", "-quality", "85", sheet]);
    }
  } catch {
    // a contact sheet is a convenience
  }
  return row;
}

// --table: the measured rows as the Markdown table docs/image-generation.md
// carries, one table per hardware profile.
if (has("table")) {
  const rows = JSON.parse(fs.readFileSync(VERIFIED, "utf8"));
  const seconds = (value) => (value >= 90 ? `${Math.floor(value / 60)} min ${Math.round(value % 60)} s` : `${Math.round(value)} s`);
  for (const hardware of [...new Set(rows.map((row) => row.hardware))]) {
    const mine = rows.filter((row) => row.hardware === hardware);
    const rank = { recommended: 0, works: 1, poor: 2, fails: 3 };
    mine.sort((a, b) => rank[a.verdict] - rank[b.verdict] || (a.seconds.square || 1e9) - (b.seconds.square || 1e9));
    console.log(`On ${hardware} (${mine[0].device}, ComfyUI ${mine[0].comfyui}, torch ${mine[0].torch}):\n`);
    console.log("| Model | Verdict | Portrait (square) | Scene (landscape) | First picture | Peak GPU memory | Steps | Notes |");
    console.log("|---|---|---|---|---|---|---|---|");
    for (const row of mine) {
      const label = COMFY_MODELS.find((model) => model.id === row.model)?.label ?? row.model;
      const ran = row.verdict !== "fails";
      console.log(
        `| ${label} | ${row.verdict} | ${ran ? seconds(row.seconds.square) : "-"} | ${ran ? seconds(row.seconds.landscape) : "-"} | ${ran ? seconds(row.coldSeconds) : "-"} | ${ran ? `${row.peakGb} GB` : "-"} | ${row.steps} | ${(row.notes ?? "").replace(/\|/g, "/")} |`,
      );
    }
    console.log("");
  }
  process.exit(0);
}

const stats = await waitForComfy(60_000);
const device = readComfyDevice(stats);
const hardware = hardwareProfile(device);
console.log(`ComfyUI ${device?.comfyui} on ${device?.name} (${device?.memoryGb} GB), torch ${device?.torch}; hardware ${hardware?.id ?? flag("hardware", "unknown")}`);

const wanted = flag("models", "installed");
let lists = await comfyLists();
const chosen =
  wanted === "all"
    ? COMFY_MODELS
    : wanted === "installed"
      ? COMFY_MODELS.filter((model) => missingFiles(model, pickModelFiles(model, lists)).length === 0)
      : wanted.split(",").map((id) => COMFY_MODELS.find((model) => model.id === id.trim()) ?? (() => { throw new Error(`No catalog model ${id}`); })());

// Fetch only: the bench chain downloads the next model while this one paints.
if (has("download-only")) {
  for (const model of chosen) {
    for (const file of missingFiles(model, pickModelFiles(model, lists))) {
      await download(file).catch((failure) => console.log(`  ${failure.message}`));
    }
  }
  process.exit(0);
}

const rows = [];
for (const model of chosen) {
  // A ComfyUI that dies switching models (the previous one is copied out of
  // GPU memory as this one loads) is back with clean memory a few seconds
  // later: measure this model once more on it, and say so in the row.
  const attempt = async () => {
    let result = await bench(model, lists, device, hardware);
    if (result === null) {
      lists = await comfyLists();
      result = await bench(model, lists, device, hardware);
    }
    return result;
  };
  let row;
  try {
    row = await attempt();
  } catch (failure) {
    if (!lostComfy(failure)) throw failure;
    console.log(`  ComfyUI went away (${failure.message}); waiting for it, then measuring again`);
    await waitForComfy();
    row = await attempt().catch((again) => ({ skipped: `ComfyUI went away twice: ${again.message}` }));
    if (row && !row.skipped) row.notes = [row.notes, "Measured after ComfyUI restarted: it ran out of memory switching to this model."].filter(Boolean).join(" ");
  }
  if (row?.skipped) {
    console.log(`== ${model.id}: skipped, ${row.skipped}`);
    continue;
  }
  if (row) rows.push(row);
}

if (has("write") && rows.length) {
  const existing = JSON.parse(fs.readFileSync(VERIFIED, "utf8"));
  const merged = [
    ...existing.filter((old) => !rows.some((row) => row.model === old.model && row.hardware === old.hardware)),
    ...rows.map((row) => {
      const old = existing.find((entry) => entry.model === row.model && entry.hardware === row.hardware);
      // A verdict and note given by review survive a re-measure that ran.
      return old && row.verdict !== "fails" ? { ...row, verdict: old.verdict === "fails" ? row.verdict : old.verdict, ...(old.notes ? { notes: old.notes } : {}) } : row;
    }),
  ].sort((a, b) => a.model.localeCompare(b.model) || a.hardware.localeCompare(b.hardware));
  fs.writeFileSync(VERIFIED, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`Wrote ${rows.length} row(s) to ${path.relative(root, VERIFIED)}.`);
}
