// Claude Code's models come from the program itself (src/lib/harness/adapters/claude.ts):
// the probe starts it with a turn's own lockdown flags and asks the stream-json
// `initialize` request, which it answers before any model call. A program that
// cannot answer leaves the card with no models and a message saying why, never
// a list from somewhere else. Stub programs stand in for Claude Code.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

register("./lib/register-alias.mjs", import.meta.url);
const { claudeAdapter, probeClaudeModels } = await import("../src/lib/harness/adapters/claude.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-claude-probe-test-"));
const log = path.join(dir, "calls.log");
const env = { PATH: process.env.PATH ?? "", HOME: dir, ODM_STUB_LOG: log };

let passed = 0;
async function test(name, fn) {
  // The stubs are shell scripts; the probe's Windows path is the turn's own
  // (spawnProgram), which the harness suites already run there.
  if (process.platform === "win32") {
    console.log(`skip: ${name} (Windows)`);
    return;
  }
  fs.rmSync(log, { force: true });
  await fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

// A stub that answers --version and auth status as Claude Code does, and runs
// `streamMode` for everything else, after logging its pid, arguments and the
// environment the lockdown relies on.
function stub(name, streamMode) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh
case "$1" in
  --version) echo "2.1.296 (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"dm@example.com"}'; exit 0 ;;
esac
echo "pid $$" >> "$ODM_STUB_LOG"
echo "nonessential $CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" >> "$ODM_STUB_LOG"
for arg in "$@"; do echo "arg [$arg]" >> "$ODM_STUB_LOG"; done
${streamMode}
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

// Claude Code 2.1.296's answer on a Pro sign-in, trimmed to its models, as
// the one line it writes.
const recorded = JSON.parse(fs.readFileSync(new URL("./fixtures/claude-initialize.json", import.meta.url), "utf8"));
const answer = path.join(dir, "answer.json");
fs.writeFileSync(answer, `${JSON.stringify(recorded)}\n`);

const logged = () => fs.readFileSync(log, "utf8").split("\n");

async function stopped() {
  const pid = Number(logged().find((line) => line.startsWith("pid "))?.slice(4));
  for (let wait = 0; wait < 50; wait += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("the probe left its program running");
}

await test("the probe lists the models Claude Code answers with, started as a turn is", async () => {
  const program = stub("claude-answers", `read request\necho "request $request" >> "$ODM_STUB_LOG"\ncat "${answer}"\ncat > /dev/null`);
  const status = await claudeAdapter.probe(program, env);
  assert.deepEqual(status.models.map((model) => model.id), ["opus", "claude-fable-5-1[1m]", "sonnet", "haiku"]);
  assert.equal(status.auth.state, "ready");
  assert.equal(status.message, undefined);
  const lines = logged();
  const args = lines.filter((line) => line.startsWith("arg ")).map((line) => line.slice(5, -1));
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value("--tools"), "", "no built-in tools, as in a turn");
  assert.equal(value("--setting-sources"), "");
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(!args.includes("--model"), "no model is chosen: the question is which ones there are");
  assert.ok(!args.includes("--system-prompt-file"), "no model call, so no prompt, and no file to leave behind");
  assert.ok(lines.includes("nonessential 1"), "the turn's environment too");
  assert.match(lines.find((line) => line.startsWith("request ")) ?? "", /"subtype":"initialize"/);
  await stopped();
});

await test("a Claude Code that cannot start leaves no models and says why", async () => {
  const program = stub("claude-dies", `echo "error: unknown option '--frobnicate'" >&2\nexit 1`);
  const status = await claudeAdapter.probe(program, env);
  assert.deepEqual(status.models, [], "never a list from anywhere else");
  assert.equal(status.auth.state, "ready", "the sign-in is still read");
  assert.match(status.message ?? "", /did not list its models \(error: unknown option '--frobnicate'\)/);
  await stopped();
});

await test("a Claude Code that never answers is stopped", async () => {
  const program = stub("claude-silent", "cat > /dev/null");
  await assert.rejects(probeClaudeModels(program, env, 300), /did not answer in time/);
  await stopped();
});

removeTempDir(dir);
console.log(`claude probe: ${passed} checks passed`);
