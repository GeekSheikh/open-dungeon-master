// A campaign freezes its settings when it is made, and since PR 298 names no
// ComfyUI checkpoint, one made before the admin picked a checkpoint froze a
// blank one, which nothing in the campaign can change. It has to paint with
// the checkpoint the admin picks later. The real admin settings route and a
// throwaway database; ComfyUI is a stand-in on a loopback port.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-media-picks-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
// A developer's own shell must not decide these answers.
for (const name of [
  "OPENAI_API_KEY",
  "OPENAI_IMAGE_API_KEY",
  "OPENAI_IMAGE_BASE_URL",
  "OPENAI_IMAGE_MODEL",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_MODEL",
  "DEFAULT_IMAGE_BACKEND",
  "COMFYUI_URL",
  "TTS_PROVIDER",
  "TTS_BASE_URL",
  "TTS_MODEL",
  "TTS_API_KEY",
  "STT_MODEL",
  "STT_OPENAI_MODEL",
  "ODM_DEVICE_WORLD",
]) {
  delete process.env[name];
}
// Nothing else the capability snapshot asks is there, and it says so at once.
process.env.DEFAULT_TEXT_PROVIDER = "none";
process.env.KOKORO_URL = "http://127.0.0.1:9";
process.env.STT_URL = "off";
process.env.FLUX_WORKER_URL = "http://127.0.0.1:9";
process.chdir(dir);

register("./lib/register-routes.mjs", import.meta.url);

const { createUser } = await import("../src/lib/db/users.ts");
const { mintSession } = await import("../src/lib/auth.ts");
const { createCampaign, getCampaignById, updateStorySettings } = await import("../src/lib/db/campaigns.ts");
const { saveGlobalConfig } = await import("../src/lib/db/app-settings.ts");
const settingsRoute = await import("../src/app/api/admin/settings/route.ts");
const { generateStoryImage } = await import("../src/lib/image-generate.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// A ComfyUI that takes the prompt it is sent.
const prompts = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/system_stats") return send(200, { system: {}, devices: [] });
    if (request.url === "/prompt") {
      prompts.push(JSON.parse(body));
      // Enough to see what was asked for; the picture itself is not needed.
      return send(500, { error: "stand-in" });
    }
    send(404, {});
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const admin = createUser("admin", "x", { isAdmin: true });
globalThis.__odmTestToken = mintSession(admin.id).token;
const table = (title) => createCampaign(admin.id, { title, description: "", theme: "", maxPlayers: 4, startingLevel: 1, difficulty: "normal" });
const patchAdmin = (body) =>
  settingsRoute.PATCH(new Request("http://t/api/admin/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

try {
  await test("a campaign made before a checkpoint was picked paints with the one the admin picks later", async () => {
    saveGlobalConfig({ images: { defaultBackend: "comfyui", comfyUrl: base, comfyCheckpoint: "", comfyWorkflowPreset: "checkpoint" } });
    const early = table("Made early");
    assert.equal(getCampaignById(early.id).settings.comfyCheckpoint, "", "nothing is picked yet");
    const own = table("Own checkpoint");
    updateStorySettings(own.id, { comfyCheckpoint: "own.safetensors" });

    const response = await patchAdmin({ images: { comfyCheckpoint: "mine.safetensors" } });
    assert.equal(response.status, 200);
    const settings = getCampaignById(early.id).settings;
    assert.equal(settings.comfyCheckpoint, "mine.safetensors", "the admin's pick reaches a campaign that had none");
    assert.equal(getCampaignById(own.id).settings.comfyCheckpoint, "own.safetensors", "a campaign's own checkpoint stays its own");

    prompts.length = 0;
    await assert.rejects(generateStoryImage(settings, { prompt: "a quiet harbor", mode: "fast", aspect: "square" }));
    assert.match(JSON.stringify(prompts.at(-1)), /mine\.safetensors/, "the picture was asked of the admin's checkpoint");
  });
} finally {
  server.close();
  process.chdir(os.tmpdir());
  removeTempDir(dir);
}
console.log(`media model picks: ${passed} checks passed`);
