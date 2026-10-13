// The pure parts of the agent-harness backend (docs/archive/harness-mcp-plan.md):
// how a DM turn is rendered for an agent program, what environment it may
// see, the lockdown flags each adapter starts it with, and how a picture it
// returns is checked. The flags are pinned here on purpose: a refactor that
// drops one of them turns a locked-down storyteller into a program with a
// shell, and must fail the build.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-harness-logic-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
register("./lib/register-alias.mjs", import.meta.url);

const { renderTurn, renderFollowUp, renderCompletion, toMcpTools, toolNames, HARNESS_PREAMBLE } = await import(
  "../src/lib/harness/render.ts"
);
const { buildChildEnv, leaksServerSecret } = await import("../src/lib/harness/child-env.ts");
const { claudeAdapter, claudeArgs, CLAUDE_ENV, CLAUDE_MCP_PREFIX, parseClaudeModels, withCacheBoundary } = await import(
  "../src/lib/harness/adapters/claude.ts"
);
const { codexAdapter, codexArgs, ignoredCodexSettings, userCodexMcpServers } = await import("../src/lib/harness/adapters/codex.ts");
const { opencodeAdapter, opencodeConfig, OPENCODE_SESSION_RULES, parseOpencodeModels } = await import(
  "../src/lib/harness/adapters/opencode.ts"
);
const { grokAdapter, grokArgs, grokAgentProfile, GROK_ENV } = await import("../src/lib/harness/adapters/grok.ts");
const { sniffImage, imageSize, acceptImage, MAX_HARNESS_IMAGE_BYTES } = await import("../src/lib/harness/images.ts");
const { maskAccount } = await import("../src/lib/harness/status.ts");
const { knownInstallDirs } = await import("../src/lib/harness/discover.ts");
const { THIS_TURN_HEADING, THIS_MOMENT_HEADING, MOMENT_INSTRUCTION } = await import("../src/lib/prompt-boundary.ts");
const { buildDmMessages, buildGameStateBlock, ENCOUNTER_RULES, PLAYER_WHISPER_RULES, REAL_DICE_RULE } = await import(
  "../src/lib/dm/prompt.ts"
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

const rollTool = {
  type: "function",
  function: {
    name: "request_roll",
    description: "Roll dice on the server.",
    parameters: { type: "object", properties: { characterId: { type: "string" } }, required: ["characterId"] },
  },
};

test("DM tools become MCP tools with their JSON Schema intact, deduplicated", () => {
  const tools = toMcpTools([rollTool, rollTool, { function: { name: "", parameters: {} } }, { nonsense: true }]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "request_roll");
  assert.equal(tools[0].inputSchema.type, "object");
  assert.deepEqual(tools[0].inputSchema.required, ["characterId"]);
  assert.deepEqual([...toolNames([rollTool])], ["request_roll"]);
});

test("a turn is rendered as the DM's own rules plus a transcript, with the preamble first", () => {
  const { system, prompt } = renderTurn([
    { role: "system", content: "RULES: the server is the rules engine." },
    { role: "user", content: "[Avery | attempt] I kick the door." },
    { role: "assistant", content: "The door groans." },
    { role: "user", content: [{ type: "text", text: "[Bryn] \"Careful.\"" }, { type: "image_url", image_url: { url: "x" } }] },
  ]);
  assert.ok(system.startsWith(HARNESS_PREAMBLE));
  assert.ok(system.includes("RULES: the server is the rules engine."));
  assert.ok(prompt.includes("[Avery | attempt] I kick the door."));
  assert.ok(prompt.includes("[Dungeon Master] The door groans."));
  assert.ok(prompt.includes("[a picture was shared here]"), "pictures are named, not silently dropped");
  assert.ok(prompt.endsWith("then write the narration."));
  assert.ok(!prompt.includes("RULES:"), "the rules stay in the system prompt, not the transcript");
});

test("a turn resumed after dice shows the calls and results as engine lines", () => {
  const { prompt } = renderTurn([
    { role: "system", content: "rules" },
    { role: "user", content: "I swing." },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "pc_attack", arguments: '{"target":"goblin-1"}' } }] },
    { role: "tool", tool_call_id: "c1", content: '{"hit":true,"damage":7}' },
  ]);
  assert.ok(prompt.includes('[engine] You called pc_attack {"target":"goblin-1"}'));
  assert.ok(prompt.includes('[engine] pc_attack answered: {"hit":true,"damage":7}'));
  assert.ok(prompt.includes("The dice above have landed."));
});

test("follow-ups carry only new user and system text, never tool results", () => {
  const text = renderFollowUp([
    { role: "assistant", content: "narration" },
    { role: "tool", tool_call_id: "x", content: "result" },
    { role: "user", content: "Your narration says the goblin died, but it has 3 HP left." },
  ]);
  assert.equal(text, "Your narration says the goblin died, but it has 3 HP left.");
});

test("a completion puts the last user message after the conversation", () => {
  const { system, prompt } = renderCompletion([
    { role: "system", content: "You summarise." },
    { role: "user", content: "Old passage." },
    { role: "assistant", content: "Summary so far." },
    { role: "user", content: "Summarise the chapter." },
  ]);
  assert.ok(system.includes("You summarise."));
  assert.ok(prompt.endsWith("Summarise the chapter."));
  assert.ok(prompt.includes("[assistant] Summary so far."));
});

test("the child environment is an allowlist: no server secret ever reaches a program", () => {
  const parent = {
    HOME: "/home/dm",
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
    DB_ENCRYPTION_KEY: "a".repeat(64),
    OPENAI_COMPAT_API_KEY: "sk-server-key-123456",
    OPENROUTER_API_KEY: "or-key-123456",
    ODM_DEVICE_WORLD: "1",
    SQLITE_DB_PATH: "/data/odm.sqlite",
    ANTHROPIC_API_KEY: "sk-ant-admin",
    OPENAI_API_KEY: "sk-openai-admin",
    RANDOM_THING: "x",
  };
  const claude = buildChildEnv(parent, "claude", "/opt/bin:/usr/bin", { ODM_MCP_TOKEN: "t" });
  assert.equal(claude.HOME, "/home/dm");
  assert.equal(claude.PATH, "/opt/bin:/usr/bin");
  assert.equal(claude.ANTHROPIC_API_KEY, "sk-ant-admin", "the program's own key goes to it");
  assert.equal(claude.OPENAI_API_KEY, undefined, "another vendor's key does not");
  for (const secret of ["DB_ENCRYPTION_KEY", "OPENAI_COMPAT_API_KEY", "OPENROUTER_API_KEY", "ODM_DEVICE_WORLD", "SQLITE_DB_PATH", "RANDOM_THING"]) {
    assert.equal(claude[secret], undefined, `${secret} must not pass`);
  }
  assert.equal(leaksServerSecret(claude, parent), null);
  const codex = buildChildEnv(parent, "codex", "/usr/bin");
  assert.equal(codex.OPENAI_API_KEY, "sk-openai-admin");
  assert.equal(codex.ANTHROPIC_API_KEY, undefined);
  assert.equal(leaksServerSecret({ ...claude, SNEAKY: `prefix-${parent.DB_ENCRYPTION_KEY}` }, parent), "SNEAKY");
});

test("Claude Code is started with no built-in tools and only ODM's MCP server", () => {
  const args = claudeArgs({
    systemPromptPath: "/tmp/run/odm-system-prompt.md",
    model: "sonnet",
    effort: "high",
    mcpConfigPath: "/tmp/run/odm-mcp.json",
  });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value("--tools"), "", "every built-in tool removed");
  assert.ok(args.includes("--strict-mcp-config"), "the admin's own MCP servers ignored");
  assert.equal(value("--setting-sources"), "", "no user or project settings, hooks or CLAUDE.md");
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.equal(value("--allowedTools"), `${CLAUDE_MCP_PREFIX}*`);
  assert.equal(value("--mcp-config"), "/tmp/run/odm-mcp.json");
  assert.equal(value("--system-prompt-file"), "/tmp/run/odm-system-prompt.md", "the system prompt replaces the coding persona");
  assert.ok(!args.includes("--system-prompt"), "the prompt itself never rides on the command line (Windows caps it at 32 K)");
  assert.ok(args.includes("--no-session-persistence"), "no transcript of a secret story left on disk");
  assert.ok(args.includes("--disable-slash-commands"));
  assert.equal(JSON.parse(value("--settings")).disableAllHooks, true);
  assert.equal(CLAUDE_ENV.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(CLAUDE_ENV.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, "1", "no second model consulted behind the lockdown's back");
  assert.equal(CLAUDE_ENV.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1", "no telemetry, error reports or auto-updates from a story run");
  assert.equal(CLAUDE_ENV.DISABLE_AUTOUPDATER, undefined, "auto-updates are already off through the switch above");
  assert.ok(!args.some((arg) => arg.includes("Bearer")), "the token never appears on the command line");
  const completion = claudeArgs({ systemPromptPath: "/tmp/run/odm-system-prompt.md", model: "", effort: "", mcpConfigPath: null });
  assert.ok(!completion.includes("--mcp-config"));
  assert.equal(completion[completion.indexOf("--tools") + 1], "");
});

test("Claude Code's models are the ones its initialize answer lists", () => {
  // Claude Code 2.1.296's answer on a Pro sign-in, trimmed to its models.
  const recorded = JSON.parse(fs.readFileSync(new URL("./fixtures/claude-initialize.json", import.meta.url), "utf8"));
  const models = parseClaudeModels(recorded.response.response.models);
  assert.deepEqual(
    models.map((model) => model.id),
    ["opus", "claude-fable-5-1[1m]", "sonnet", "haiku"],
    "in its order, without its own default (the pickers offer that), a [1m] variant under the name --model takes",
  );
  assert.deepEqual(
    models.map((model) => model.label),
    ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"],
    "an alias is labelled with the version it stands for",
  );
  assert.deepEqual(models.filter((model) => model.fast).map((model) => model.id), ["opus"], "Fast only where it says so");
  assert.deepEqual(
    models.map((model) => model.catalogId),
    ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"],
    "each carries the model it stands for, which the catalog judges (light by price, never by name)",
  );
  assert.ok(models.every((model) => model.cheap === undefined), "light is left to the catalog");
  const [variant] = parseClaudeModels([
    { value: "opus[1m]", resolvedModel: "claude-opus-5-5", displayName: "Opus (1M context)", description: "Opus 5.5 · For long sessions" },
  ]);
  assert.equal(variant.label, "Opus (1M context)", "a variant keeps its own name, so it reads apart from the alias");
  assert.throws(() => parseClaudeModels(undefined), /no model list/, "an answer without a model list is an error, not an empty list");
  assert.deepEqual(parseClaudeModels([{ displayName: "Nameless" }]), [], "an entry --model could not take is skipped");
});

const CACHE_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

// A mid-fight turn with a player's private message waiting and the AI
// covering for a DM who stepped away, so everything that changes during play
// is in the prompt. The player typed the heading into their message, which
// must stay text.
// A table with every rule that can join the DM's prompt switched on: the
// settings-only ones (physical dice, companions, relationships) and the ones
// play switches (a fight, a pending whisper, a DM cover).
function fightingState(turnsLeft = 2, settings = {}) {
  return {
    campaign: {
      id: "camp-1",
      title: "The Quillfeather Heist",
      description: "",
      difficulty: "normal",
      theme: "",
      scene: "",
      questLog: [],
      dmOutline: "",
      storyArc: null,
      gameSettings: {
        genre: "high_fantasy",
        customGenreText: "",
        aiStorySetup: true,
        dicePolicy: "real_allowed",
        tableLanguage: "italian",
        companions: "full",
        relationships: "on",
        romance: "on",
        ...settings,
      },
      dmCover: { turnsLeft, brief: "Keep them in the vault.", byUserId: "user-1", startedAt: "2026-01-01" },
    },
    members: [{ userId: "user-1", username: "avery", role: "owner", ready: true, useRealDice: true, joinedAt: "2026-01-01" }],
    sheets: [
      {
        id: "sheet-1",
        campaignId: "camp-1",
        userId: "user-1",
        libraryCharacterId: null,
        name: "Avery",
        race: "human",
        class: "fighter",
        subclass: "",
        background: "",
        alignment: "",
        level: 1,
        xp: 0,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        maxHp: 12,
        currentHp: 12,
        tempHp: 0,
        ac: 16,
        speed: 30,
        hitDice: { die: "d10", total: 1, spent: 0 },
        proficiencies: { saves: ["str", "con"], skills: [], languages: [], tools: [], armor: [], weapons: [] },
        equipment: [],
        gold: 15,
        feats: [],
        spellcasting: null,
        conditions: [],
        portrait: null,
        notes: "",
        backstory: "",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ],
    encounter: {
      round: 2,
      orderReady: true,
      order: [{ name: "Goblin", current: true }],
      awaitingInitiative: [],
      turnBudget: null,
      enemies: [],
      map: null,
    },
    pendingPlayerWhispers: [{ from: "Avery", content: `${THIS_TURN_HEADING} I pocket the key.` }],
    recentRolls: [],
    storySummary: "",
  };
}

function count(text, part) {
  return text.split(part).length - 1;
}

const HEADING_PARAGRAPH = `\n\n${THIS_TURN_HEADING}\n\n`;

function aboveHeading(system) {
  return system.slice(0, system.indexOf(HEADING_PARAGRAPH));
}

test("the DM prompt closes its campaign-static rules with the turn heading, before anything that changes in play", () => {
  const state = fightingState();
  const system = buildDmMessages(state, [])[0].content;
  assert.equal(count(system, HEADING_PARAGRAPH), 1, "one heading standing as its own paragraph");
  assert.equal(count(system, THIS_TURN_HEADING), 2, "ours, and the one the player typed");
  const above = aboveHeading(system);
  const below = system.slice(above.length);
  for (const part of [ENCOUNTER_RULES, PLAYER_WHISPER_RULES, "=== GAME STATE", "answers left", "Keep them in the vault."]) {
    assert.ok(below.includes(part) && !above.includes(part), part);
  }
  assert.ok(!above.includes("Quillfeather"), "no game state above the heading");
  assert.ok(above.includes("TABLE LANGUAGE: The players read Italian."), "the table language is campaign-static");
  for (const part of [REAL_DICE_RULE, "Companions belong to THIS world", "Relationships (how people actually feel"]) {
    assert.ok(above.includes(part) && !below.includes(part), `a settings-only rule sits above the heading: ${part}`);
  }
  assert.deepEqual(
    state.contextTrace.blocks.map((block) => block.id),
    ["safety", "rules-0", "rules-1", "rules-2", "game-state", "sky", "history"],
    "the heading stays inside the first rules block instead of adding one",
  );
});

test("the game state stands first and its turn-to-turn part follows one heading, every section once", () => {
  const state = {
    ...fightingState(),
    recentRolls: [
      {
        characterId: "sheet-1",
        kind: "skill_check",
        detail: "perception",
        total: 14,
        dc: 12,
        success: true,
        visibility: "public",
        breakdown: { crit: null },
      },
    ],
    loreBlock: "WORLD LORE: the bell was cast from a drowned saint's chains.",
    houseRulesBlock: "HOUSE RULES: potions are a bonus action.",
    directorNotes: ["The fog thickens over the jetty."],
    worldBlock: "WORLD: Old Maren keeps a knife for every toll.",
    shopsBlock: "SHOP: the chandler sells lamp oil.",
  };
  const block = buildGameStateBlock(state);
  assert.equal(count(block, THIS_MOMENT_HEADING), 1);
  const [standing, moment] = block.split(THIS_MOMENT_HEADING);
  for (const part of ["=== GAME STATE (authoritative; never contradict) ===", "Campaign: The Quillfeather Heist", "Date and time:", "Party:\n"]) {
    assert.equal(count(block, part), 1, part);
    assert.ok(standing.includes(part), `standing: ${part}`);
  }
  for (const part of ["Active combat, round 2", "Recent rolls:", "WORLD LORE:", "HOUSE RULES:", "DIRECTOR NOTES", "WORLD: Old Maren", "SHOP:", "Private messages from players", "=== END GAME STATE ==="]) {
    assert.equal(count(block, part), 1, part);
    assert.ok(moment.includes(part), `moment: ${part}`);
  }
  assert.ok(buildDmMessages(state, [])[0].content.endsWith(`${moment.trimEnd()}`), "the moment runs to the end of the system prompt");
});

test("what play switches leaves the text above the heading as it was; a settings change moves it", () => {
  const above = aboveHeading(buildDmMessages(fightingState(), [])[0].content);
  const quiet = fightingState();
  quiet.encounter = null;
  quiet.pendingPlayerWhispers = [];
  quiet.campaign.dmCover = null;
  assert.equal(aboveHeading(buildDmMessages(quiet, [])[0].content), above, "fight, whisper and cover off");
  assert.equal(aboveHeading(buildDmMessages(fightingState(1), [])[0].content), above, "the cover countdown moved");
  for (const settings of [{ relationships: "off" }, { companions: "off" }, { romance: "off" }]) {
    assert.notEqual(aboveHeading(buildDmMessages(fightingState(2, settings), [])[0].content), above, JSON.stringify(settings));
  }
  const digital = fightingState();
  digital.members[0].useRealDice = false;
  assert.ok(!aboveHeading(buildDmMessages(digital, [])[0].content).includes(REAL_DICE_RULE), "a player gave up physical dice");
});

test("a chat model reads the turn-to-turn state after the transcript, the same text in the same words", () => {
  const history = [
    { id: "m1", seq: 1, authorType: "player", characterId: "sheet-1", content: "I listen at the chapel door.", intent: null },
    { id: "m2", seq: 2, authorType: "dm", characterId: null, content: "Chanting, low and wet.", intent: null },
  ];
  const plain = { ...fightingState(), contextLimitTokens: 131_072, directorBlock: "DIRECTOR: the bell rings once." };
  const chat = { ...plain, momentAfterHistory: true };
  const before = buildDmMessages(plain, history);
  const after = buildDmMessages(chat, history);
  assert.equal(after.length, before.length + 1, "one more message: the moment");
  assert.ok(before[0].content.includes(THIS_MOMENT_HEADING));
  assert.ok(!after[0].content.includes(THIS_MOMENT_HEADING), "no turn-to-turn state in the system message");
  const moment = after[1 + history.length];
  assert.equal(moment.role, "user");
  assert.ok(moment.content.startsWith(THIS_MOMENT_HEADING));
  // The newest player line is no longer the last thing read, so the moment
  // closes on the instruction to resolve it, as an agent program's opening
  // message does.
  assert.ok(moment.content.endsWith(`=== END GAME STATE ===\n\n${MOMENT_INSTRUCTION}`));
  assert.deepEqual(after.slice(1, 1 + history.length), before.slice(1, 1 + history.length), "the history is untouched");
  assert.equal(after.at(-1).content, "DIRECTOR: the bell rings once.", "the director's note stays last");
  assert.equal(`${after[0].content}\n\n${moment.content}`, `${before[0].content}\n\n${MOMENT_INSTRUCTION}`, "only the order changes, byte for byte");
  assert.deepEqual(plain.contextTrace, chat.contextTrace, "the budget and the trace are the same");
});

// What Claude Code caches as its second system block: everything after the
// boundary marker in the system prompt file it is given.
function blockTwo(state, history = []) {
  return withCacheBoundary(renderTurn(buildDmMessages(state, history), { settledTranscript: true }).system).split(CACHE_BOUNDARY)[1];
}

test("an agent program reads the turn-to-turn state after the transcript, and the rest stays put", () => {
  const state = { ...fightingState(), recentRolls: [], loreBlock: "WORLD LORE: the bell was cast from chains." };
  const history = [
    { id: "m1", seq: 1, authorType: "player", characterId: "sheet-1", content: "I listen at the chapel door.", intent: null },
    { id: "m2", seq: 2, authorType: "dm", characterId: null, content: "Chanting, low and wet.", intent: null },
  ];
  const { system, prompt } = renderTurn(buildDmMessages(state, history));
  assert.ok(!system.includes(THIS_MOMENT_HEADING) && !system.includes("WORLD LORE:"), "no turn-to-turn state in the system prompt");
  const block = blockTwo(state, history);
  for (const part of [ENCOUNTER_RULES, PLAYER_WHISPER_RULES, "=== GAME STATE (authoritative; never contradict) ===", "Party:\n"]) {
    assert.ok(block.includes(part), `block 2 holds ${part.slice(0, 40)}`);
  }
  const transcript = prompt.indexOf("</table_transcript>");
  const moment = prompt.indexOf(THIS_MOMENT_HEADING);
  const instruction = prompt.indexOf("It is your turn as the Dungeon Master");
  assert.ok(transcript > 0 && transcript < moment && moment < instruction, "transcript, then the moment, then the instruction");
  for (const part of ["Active combat, round 2", "WORLD LORE:", "Private messages from players", "=== END GAME STATE ==="]) {
    assert.equal(count(prompt, part) + count(system, part), 1, part);
  }
  // Only the moment differs: new dice and new lore leave block 2 as it was.
  const later = { ...state, loreBlock: "WORLD LORE: the chains came from a drowned saint." };
  later.recentRolls = [{ characterId: "sheet-1", kind: "skill_check", detail: "perception", total: 9, dc: 12, success: false, visibility: "public", breakdown: { crit: null } }];
  assert.equal(blockTwo(later, history), block, "fast state only");
  const withFact = { ...state, facts: [{ category: "world", subject: "The bell", fact: "The bell rings at the new moon.", pinned: false, knownBy: [] }] };
  assert.notEqual(blockTwo(withFact, history), block, "a fact added");
  assert.notEqual(blockTwo({ ...state, encounter: null }, history), block, "the fight ended");
});

test("Claude Code reads the older transcript in whole chunks of twenty in its system prompt, every line once, in order", () => {
  const lines = (count) =>
    Array.from({ length: count }, (_, at) => ({
      id: `m${at + 1}`,
      seq: at + 1,
      authorType: at % 2 ? "dm" : "player",
      characterId: at % 2 ? null : "sheet-1",
      content: `Line ${String(at + 1).padStart(3, "0")}: the bell tolls.`,
      intent: null,
    }));
  const state = () => ({ ...fightingState(), contextLimitTokens: 131_072 });
  assert.equal(claudeAdapter.settledTranscript, true, "Claude Code reads its system prompt from a file and caches it in blocks");
  const { system, prompt } = renderTurn(buildDmMessages(state(), lines(45)), { settledTranscript: true });
  for (let at = 1; at <= 45; at += 1) {
    const line = `Line ${String(at).padStart(3, "0")}:`;
    assert.equal(count(system, line) + count(prompt, line), 1, line);
    assert.ok((at <= 40 ? system : prompt).includes(line), `${line} is in the ${at <= 40 ? "system prompt" : "opening message"}`);
  }
  assert.ok(system.indexOf("Line 001:") < system.indexOf("Line 040:") && prompt.indexOf("Line 041:") < prompt.indexOf("Line 045:"));
  const block = blockTwo(state(), lines(45));
  assert.equal(blockTwo(state(), lines(41)), block, "the same chunk: block 2 stays as it was");
  assert.notEqual(blockTwo(state(), lines(61)), block, "a chunk closed: block 2 is written again");
});

test("every other program gets the whole transcript in its opening message, as before: opencode takes its system prompt through an environment variable, which Linux caps at 128 KiB", () => {
  const lines = (count) =>
    Array.from({ length: count }, (_, at) => ({
      id: `m${at + 1}`,
      seq: at + 1,
      authorType: at % 2 ? "dm" : "player",
      characterId: at % 2 ? null : "sheet-1",
      content: `Line ${String(at + 1).padStart(3, "0")}: the bell tolls.`,
      intent: null,
    }));
  for (const adapter of [codexAdapter, opencodeAdapter, grokAdapter]) {
    assert.notEqual(adapter.settledTranscript, true, `${adapter.id} keeps its transcript in the opening message`);
  }
  const state = { ...fightingState(), contextLimitTokens: 131_072 };
  const { system, prompt } = renderTurn(buildDmMessages(state, lines(45)));
  assert.ok(!system.includes("<table_transcript_earlier>"), "no transcript in the system prompt");
  for (let at = 1; at <= 45; at += 1) {
    const line = `Line ${String(at).padStart(3, "0")}:`;
    assert.equal(count(system, line), 0, line);
    assert.equal(count(prompt, line), 1, line);
  }
  assert.ok(prompt.indexOf("Line 001:") < prompt.indexOf("Line 045:"));
  // The turn-to-turn state still follows the transcript there.
  assert.ok(prompt.indexOf("</table_transcript>") < prompt.indexOf(THIS_MOMENT_HEADING));
});

test("Claude Code gets its cache boundary where the heading was, once, and every other prompt untouched", () => {
  const system = `rules\n\n${THIS_TURN_HEADING}\n\nstate\n\n${THIS_TURN_HEADING}`;
  assert.equal(withCacheBoundary(system), `rules\n\n${CACHE_BOUNDARY}\n\nstate\n\n${THIS_TURN_HEADING}`);
  const utility = renderCompletion([
    { role: "system", content: "You summarise." },
    { role: "user", content: "Summarise the chapter." },
  ]).system;
  assert.equal(withCacheBoundary(utility), utility);
});

test("a real DM turn reaches Claude Code with the boundary on its own line, directly after the DM rules", () => {
  const { system, prompt } = renderTurn(buildDmMessages(fightingState(), []));
  const written = withCacheBoundary(system);
  assert.equal(count(written, CACHE_BOUNDARY), 1);
  assert.equal(written.split("\n").filter((line) => line === CACHE_BOUNDARY).length, 1, "a line holding only the marker");
  assert.equal(written.slice(0, written.indexOf(CACHE_BOUNDARY)), `${aboveHeading(system)}\n\n`);
  assert.ok(aboveHeading(system).startsWith(`${HARNESS_PREAMBLE}\n\n`));
  assert.equal(written.replace(CACHE_BOUNDARY, THIS_TURN_HEADING), system, "nothing else changes");
  assert.ok(prompt.includes(`${THIS_TURN_HEADING} I pocket the key.`), "the player's copy stays text, in the moment");
});

test("Codex is started with its shell, web, apps and sub-agents off, read-only, never approving", () => {
  const args = codexArgs({ mcpUrl: "http://127.0.0.1:3005/api/mcp", images: false, disableServers: ["github"] });
  const overrides = args.filter((_, index) => args[index - 1] === "-c");
  for (const expected of [
    "features.shell_tool=false",
    "features.unified_exec=false",
    "features.apps=false",
    "features.multi_agent=false",
    "features.image_generation=false",
    // Checked against Codex itself on 2026-10-09: these two are the keys that
    // remove the image viewer and the sub-agent tools. `tools.view_image`
    // was never a Codex key (ignored with a warning) and `features.multi_agent`
    // leaves the collaboration tools in place on current models.
    "features.view_image=false",
    "agents.enabled=false",
    'web_search="disabled"',
    'sandbox_mode="read-only"',
    'approval_policy="never"',
    "mcp_servers.github.enabled=false",
    'mcp_servers.odm.url="http://127.0.0.1:3005/api/mcp"',
    'mcp_servers.odm.bearer_token_env_var="ODM_MCP_TOKEN"',
    // Issue #131: without this, Codex refuses its own calls to ODM's tools.
    'mcp_servers.odm.default_tools_approval_mode="approve"',
  ]) {
    assert.ok(overrides.includes(expected), `missing ${expected}`);
  }
  assert.equal(args[0], "app-server");
  assert.ok(!overrides.includes("tools.view_image=false"), "the key Codex ignores must not come back");
  assert.ok(codexArgs({ mcpUrl: null, images: true, disableServers: [] }).includes("features.image_generation=true"));
  // Codex's own report of a setting it does not recognise, as the probe sees it.
  assert.deepEqual(
    ignoredCodexSettings(
      "Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n  session-flags: `tools.view_image` is ignored.\n  session-flags: `features.gone` is ignored.",
    ),
    ["tools.view_image", "features.gone"],
  );
  assert.deepEqual(ignoredCodexSettings("nothing of the kind"), []);
  assert.deepEqual(
    userCodexMcpServers('[mcp_servers.github]\ncommand = "x"\n\n[mcp_servers."linear"]\n[mcp_servers.odm]\n[profiles.fast]'),
    ["github", "linear"],
  );
});

test("opencode's agent denies everything but ODM's tools, in config and on the session", () => {
  const config = opencodeConfig({ system: "SYS", mcp: { url: "http://127.0.0.1:1/api/mcp", token: "tok" } });
  assert.deepEqual(config.permission, { "*": "deny", "odm_*": "allow" });
  const agent = config.agent["odm-dm"];
  assert.equal(agent.prompt, "SYS");
  assert.deepEqual(agent.permission, { "*": "deny", "odm_*": "allow" });
  for (const tool of ["bash", "edit", "write", "read", "webfetch", "websearch", "task", "apply_patch"]) {
    assert.equal(agent.tools[tool], false, `${tool} must be off`);
  }
  assert.equal(agent.tools["odm_*"], true);
  assert.equal(config.mcp.odm.oauth, false);
  assert.equal(config.mcp.odm.headers.Authorization, "Bearer tok");
  const completion = opencodeConfig({ system: "S", mcp: null });
  assert.equal(completion.mcp, undefined);
  assert.deepEqual(completion.permission, { "*": "deny", "odm_*": "deny" });
  assert.deepEqual(OPENCODE_SESSION_RULES(true)[0], { permission: "*", pattern: "*", action: "deny" });
  assert.deepEqual(
    parseOpencodeModels("opencode/big-pickle\nllama/qwen3.6-35b\nclaude-code/haiku\n  noise line\n").map((m) => m.id),
    ["llama/qwen3.6-35b", "claude-code/haiku"],
    "opencode's own free models refuse outside use and are not offered",
  );
});

test("Grok Build runs in dontAsk with an agent profile naming only ODM's tools", () => {
  assert.deepEqual(grokArgs(), ["--permission-mode", "dontAsk", "agent", "stdio"]);
  const profile = grokAgentProfile("SYS", false);
  assert.ok(profile.includes('tools: ["odm__*"]'));
  assert.ok(profile.includes("SYS"));
  assert.ok(grokAgentProfile("S", true).includes('"image_gen"'));
  assert.equal(GROK_ENV.GROK_CLAUDE_MCPS_ENABLED, "0");
  assert.equal(GROK_ENV.GROK_CURSOR_MCPS_ENABLED, "0");
});

test("pictures are checked by their bytes, not by what the program says they are", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
    Buffer.from([0, 0, 2, 0, 0, 0, 1, 0]),
    Buffer.alloc(64),
  ]);
  assert.deepEqual(sniffImage(png), { mime: "image/png", ext: "png" });
  assert.deepEqual(imageSize(png), { width: 512, height: 256 });
  assert.equal(sniffImage(Buffer.from("<svg onload=alert(1)>")), null);
  assert.equal(sniffImage(Buffer.from("%PDF-1.7 ...")), null);
  assert.equal(acceptImage(png)?.ext, "png");
  assert.equal(acceptImage(Buffer.from([0x89, 0x50])), null, "too small to be a picture");
  const huge = Buffer.concat([png, Buffer.alloc(MAX_HARNESS_IMAGE_BYTES)]);
  assert.equal(acceptImage(huge), null, "over the 8 MiB cap");
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 1, 0, 2, 0]), Buffer.alloc(80)]);
  assert.equal(sniffImage(jpeg)?.ext, "jpg");
  assert.deepEqual(imageSize(jpeg), { width: 512, height: 256 });
});

test("accounts are masked before they reach the admin page", () => {
  assert.equal(maskAccount("kaleb@example.com"), "ka…@example.com");
  assert.equal(maskAccount(undefined), undefined);
});

test("discovery looks where the installers put programs, not only on PATH", () => {
  const dirs = knownInstallDirs("/home/dm", "linux");
  assert.ok(dirs.includes("/home/dm/.local/bin"));
  assert.ok(dirs.includes("/home/dm/.npm-global/bin"));
  assert.ok(dirs.includes("/home/dm/.opencode/bin"));
  // Codex's own Windows installer (install.ps1) puts the binary here.
  const win = knownInstallDirs("C:\\Users\\dm", "win32");
  assert.ok(win.some((entry) => entry.endsWith("Programs\\OpenAI\\Codex\\bin")), "Codex's Windows install dir");
});

removeTempDir(dir);
console.log(`harness logic: ${passed} checks passed`);
