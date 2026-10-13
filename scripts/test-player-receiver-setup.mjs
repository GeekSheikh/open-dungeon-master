// The quick path to a player receiver (docs/player-webhooks.md): the receiver
// file Settings fills in (src/lib/agents/receiver-config.ts) and the token
// store the receiver's --setup uses instead of a hand-written credential
// helper (scripts/lib/player-token-store.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);
const { receiverConfig, receiverUrl, receiverCommands, receiverFileName, receiverSlug } = await import("../src/lib/agents/receiver-config.ts");
const { tokenStore, saveToken, promptSecret, validToken } = await import("./lib/player-token-store.mjs");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
}

const TOKEN = `odm_${"Ab9_-".repeat(9)}`;
const base = { mcpUrl: "https://odm.example/api/mcp", campaignId: "camp-1", characterId: "sheet-1", characterName: "Thorin Oakenshield" };

await test("the receiver file is filled in from the server's IDs and holds no token", () => {
  const config = receiverConfig({ ...base, receiverUrl: "https://my-pc.example.ts.net:8443" });
  assert.equal(config.receiverUrl, "https://my-pc.example.ts.net:8443/odm-player", "a bare host gets the receiver's path");
  assert.equal(config.characterId, "sheet-1");
  assert.equal(config.campaignId, "camp-1");
  assert.equal(config.port, 8787);
  assert.equal(config.stateDirectory, "player-webhook-state-thorin-oakenshield-sheet1");
  assert.match(config.playerInstructions, /Thorin Oakenshield/);
  assert.equal(config.authCommand, undefined, "no helper: the receiver's own store holds the token");
  assert.ok(!JSON.stringify(config).includes("odm_"));
  assert.equal(receiverConfig({ ...base, receiverUrl: "https://my-pc.example.ts.net/custom/path" }).receiverUrl, "https://my-pc.example.ts.net/custom/path");
});

await test("addresses and ports the server or receiver would refuse are refused here", () => {
  for (const bad of ["http://my-pc.example", "https://u:p@my-pc.example", "https://my-pc.example/?t=1", "https://my-pc.example/#x", "my-pc"]) {
    assert.throws(() => receiverUrl(bad), /HTTPS address/);
  }
  for (const port of [80, 70000, 8787.5, Number.NaN]) assert.throws(() => receiverConfig({ ...base, receiverUrl: "https://a.example", port }), /local port/);
});

await test("each character gets its own file and state directory, so several receivers share a folder", () => {
  assert.equal(receiverFileName("Thorin Oakenshield", "sheet-1"), "receiver-thorin-oakenshield-sheet1.json");
  assert.notEqual(receiverSlug("Thorin", "a"), receiverSlug("Balin", "b"));
  assert.notEqual(receiverSlug("Thorin", "2f9c41aa-0001"), receiverSlug("Thorin", "77b0e3d2-0002"), "one library character copied into two campaigns");
  assert.equal(receiverSlug("Thorin", "025310b0-a80b-438f-acd3-47533d59f271"), "thorin-3d59f271", "the name, then the end of the sheet ID");
  assert.equal(receiverSlug("Æ", "Sheet-42"), "sheet42", "a name with no plain letters is the sheet ID alone");
  assert.equal(receiverSlug("../../etc", "x"), "etc-x", "no path characters survive");
  assert.match(receiverSlug("A".repeat(80), "id"), /^a{24}-id$/);
});

await test("the commands run setup then listen, with a Funnel line only for a Funnel address", () => {
  const funnel = receiverConfig({ ...base, receiverUrl: "https://my-pc.example.ts.net:10000", port: 8789 });
  const commands = receiverCommands("PATH/receiver-thorin.json", funnel);
  assert.equal(commands.setup, "node scripts/player-webhook-receiver.mjs --setup PATH/receiver-thorin.json");
  assert.equal(commands.listen, "node scripts/player-webhook-receiver.mjs --listen PATH/receiver-thorin.json");
  assert.equal(commands.tunnel, "tailscale funnel --bg --https=10000 http://127.0.0.1:8789");
  assert.equal(receiverCommands("f", receiverConfig({ ...base, receiverUrl: "https://my-pc.example.ts.net" })).tunnel, "tailscale funnel --bg --https=443 http://127.0.0.1:8787");
  assert.equal(receiverCommands("f", receiverConfig({ ...base, receiverUrl: "https://my-pc.example.ts.net:9443" })).tunnel, null, "Funnel does not serve 9443");
  assert.equal(receiverCommands("f", receiverConfig({ ...base, receiverUrl: "https://tunnel.example.com" })).tunnel, null);
});

// A stand-in for the operating system's tools: records each call and keeps
// one secret, so every platform's store is checked on any machine.
function fakeOs() {
  const calls = [];
  let kept = null;
  const run = async (command, args, input) => {
    calls.push({ command, args, input });
    if (command === "powershell.exe") {
      const script = args.at(-1);
      if (script.includes("::Protect(")) return { code: 0, stdout: Buffer.from(`sealed:${input}`).toString("base64") };
      const opened = Buffer.from(input, "base64").toString("utf8");
      return opened.startsWith("sealed:") ? { code: 0, stdout: opened.slice(7) } : { code: 1, stdout: "" };
    }
    if (command === "security" && args[0] === "-i") { kept = /-w (\S+)/.exec(input)?.[1] ?? null; return { code: 0, stdout: "" }; }
    if (command === "security") return kept ? { code: 0, stdout: `${kept}\n` } : { code: 44, stdout: "" };
    if (command === "secret-tool" && args[0] === "store") { kept = input; return { code: 0, stdout: "" }; }
    if (command === "secret-tool") return kept ? { code: 0, stdout: kept } : { code: 1, stdout: "" };
    throw new Error(`unexpected ${command}`);
  };
  return { calls, run };
}

for (const platform of ["win32", "darwin", "linux"]) {
  await test(`${platform}: the token is saved and read back, and never passed as an argument`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `odm-token-${platform}-`));
    const fake = fakeOs();
    const store = tokenStore(directory, { platform, run: fake.run });
    await assert.rejects(store.read(), /No token is saved/);
    await saveToken(store, TOKEN);
    assert.equal(await store.read(), TOKEN);
    for (const call of fake.calls) assert.ok(!call.args.some((arg) => arg.includes(TOKEN)), `${call.command} got the token as an argument`);
    if (platform === "win32") assert.ok(!fs.readFileSync(path.join(directory, "token.dpapi"), "utf8").includes(TOKEN));
    await assert.rejects(saveToken(store, "sk-not-an-odm-token"), /odm_/);
  });
}

await test("separate receiver directories keep separate store entries", async () => {
  const fake = fakeOs();
  const accounts = ["a", "b"].map((name) => {
    tokenStore(path.join(os.tmpdir(), `odm-receiver-${name}`), { platform: "darwin", run: fake.run }).read().catch(() => undefined);
    return fake.calls.at(-1).args[2];
  });
  assert.notEqual(accounts[0], accounts[1]);
});

await test("a store that says yes but keeps nothing is caught at setup", async () => {
  const silent = async (command, args) => ({ code: 0, stdout: args[0] === "-i" ? "" : "" });
  await assert.rejects(saveToken(tokenStore(os.tmpdir(), { platform: "darwin", run: silent }), TOKEN), /did not read back|missing or damaged/);
});

await test("a piped token is read whole, without paste markers", async () => {
  let said = "";
  assert.equal(await promptSecret("Paste the token:", Readable.from([`\x1b[200~${TOKEN}\x1b[201~\n`]), { write: (text) => { said += text; } }), TOKEN);
  assert.match(said, /^Paste the token:/, "the question is asked even when input is not a terminal");
  assert.ok(!said.includes(TOKEN));
  assert.equal(validToken(TOKEN), true);
  assert.equal(validToken(`${TOKEN} extra`), false);
});

if (process.platform === "win32") {
  await test("Windows DPAPI round trip on this machine", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "odm-token-dpapi-"));
    const store = tokenStore(directory);
    await saveToken(store, TOKEN);
    assert.equal(await store.read(), TOKEN);
    assert.ok(!fs.readFileSync(path.join(directory, "token.dpapi"), "utf8").includes(TOKEN));
  });
}

console.log(`${passed} player receiver setup tests passed`);
