import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-stream-repeat-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
register("./lib/register-alias.mjs", import.meta.url);

const { requestCustomMessage, requestLocalMessage } = await import("../src/lib/model-client.ts");
const { createStreamRepetitionGuard } = await import("../src/lib/stream-repetition.ts");
const realFetch = globalThis.fetch;
const paragraph = `The Archmage's eyes flare, a spark of humor dancing in the blue light. "It is a place of many doors. Choose yours wisely, Master Flamefinger. Even a scholar must know when to put down the book and pick up a glass of wine."`;
assert.ok(paragraph.length >= 160);
const second = "The torches gutter as a cold draft sweeps through the hall; somewhere below, chains rattle against stone and a low voice begins to count the hours until dawn arrives.";
const chant = "Ia, ia, the drowned one wakes beneath the black water; ia, ia, the tide returns what the land has stolen, and the moon bleeds silver on the altar of the deep.";

// Where the guard says a text's loop has its first copy end, the same
// however the text is cut into deltas: one character at a time, a few, a
// line's worth, or all at once.
function firstCopyEnd(text) {
  let found;
  for (const size of [1, 3, 23, 160, text.length]) {
    const guard = createStreamRepetitionGuard();
    for (const piece of text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))) {
      if (guard.push(piece)) break;
    }
    found ??= guard.firstCopyEnd;
    assert.equal(guard.firstCopyEnd, found, `deltas of ${size} characters changed the verdict`);
  }
  return found;
}

// The loop shapes small local models fall into, each cut after its first
// copy whatever separates the copies.
{
  const loops = [
    ["a two-paragraph cycle", (paragraph + "\n\n" + second + "\n\n").repeat(6), paragraph + "\n\n" + second],
    ["a paragraph and a closing question", (paragraph + "\n\nWhat do you do?\n\n").repeat(6), paragraph + "\n\nWhat do you do?"],
    ["copies a single newline apart", (paragraph + "\n").repeat(6), paragraph],
    ["copies a whitespace-only line apart", (paragraph + "\n \n").repeat(6), paragraph],
    ["copies a tab-only line apart", (paragraph + "\n\t\n").repeat(6), paragraph],
    ["copies with a rule between", (paragraph + "\n\n---\n\n").repeat(6), paragraph + "\n\n---"],
    ["a loop after an opening sentence on its line", "The door opens. " + (paragraph + "\n\n").repeat(4), "The door opens. " + paragraph],
  ];
  for (const [name, text, kept] of loops) {
    const end = firstCopyEnd(text);
    assert.ok(end > 0, `${name} is a loop`);
    assert.equal(text.slice(0, end).trim(), kept, `${name} keeps its first copy`);
  }

  // A sentence looping with no newline at all.
  const sentence = "The torches gutter and the shadows lengthen along the hall as the cold wind rises. ";
  const looped = sentence.repeat(40);
  const end = firstCopyEnd(looped);
  assert.ok(end > 0 && end < sentence.length * 4, "a loop with no newline is caught near its start");
  assert.equal(looped.slice(0, end), sentence.repeat(Math.ceil(160 / sentence.length)), "and cut after whole copies");

  // Narration wrapped in the JSON story object carries its breaks as a
  // literal \n.
  const wrapped = `{"storyText":"${(paragraph.replace(/"/g, '\\"') + "\\n\\n").repeat(8)}"}`;
  const wrappedEnd = firstCopyEnd(wrapped);
  assert.ok(wrappedEnd > 0, "a loop inside a JSON story object is caught");
  assert.equal(JSON.parse(`${wrapped.slice(0, wrappedEnd)}"}`).storyText, paragraph, "its first copy ends where the first paragraph does");
  console.log("ok: two-paragraph cycles, a closing question, any separator, no newline and JSON-wrapped loops halt, and the guard finds where their first copy ends");
}

// Writing that repeats without looping.
{
  const verses = [
    "Verse one of the ballad tells of Bram and the bandit at the ford, and the river ran red that day.",
    "Verse two of the ballad tells of the long march north through the snow and the wolves at its heels.",
    "Verse three tells of the return, and the feast in the hall of the Archmage when the snows had gone.",
  ];
  const fine = [
    ["short dialogue repeated", "Yes.\n\n".repeat(20)],
    ["short dialogue repeated on one line", "Yes. ".repeat(20)],
    ["a refrain between different verses", verses.flatMap((verse) => [verse, chant]).join("\n\n") + "\n\n"],
    ["varied narration", [paragraph, second, chant, "The goblin shrieks and swings its rusty blade at you."].join("\n\n") + "\n\n"],
    ["a three-item list", "You find:\n- a rusty dagger\n- a coil of rope\n- a hooded lantern\n"],
    ["a roster of identical entries", "The muster roll reads:\n" + "- A goblin spearman in a dented helm, crouched behind the barricade with a sling.\n".repeat(6) + "\nWhat do you do?"],
    ["a paragraph said twice", second + "\n\n" + paragraph + "\n\n" + paragraph + "\n\n"],
  ];
  for (const [name, text] of fine) {
    assert.equal(firstCopyEnd(text), -1, `${name} is not a loop`);
  }
  console.log("ok: short repeated lines, a refrain between verses, varied narration, lists and rosters are left alone");
}

const event = (delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
const toolEvent = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "request_roll", arguments: "{}" } }] } }] })}\n\n`;

async function callWithDeltas(deltas, holdOpen = false, toolFirst = false) {
  let signal;
  let cancelled = false;
  let closeTimer;
  globalThis.fetch = async (_url, init) => {
    signal = init.signal;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode((toolFirst ? toolEvent : "") + deltas.map(event).join("") + toolEvent + "data: [DONE]\n\n"));
        if (holdOpen) {
          closeTimer = setTimeout(() => { try { controller.close(); } catch {} }, 200);
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
        clearTimeout(closeTimer);
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  };
  let shown = "";
  const result = await requestCustomMessage(
    "http://127.0.0.1:8080/v1",
    "test-model",
    "",
    [{ role: "user", content: "Continue the scene." }],
    { onDelta: (text) => { shown += text; } },
  );
  return { result, shown, signal, cancelled };
}

try {
  const repeated = await callWithDeltas(
    (paragraph + "\n\n").repeat(5).match(/.{1,37}/gs),
    true,
    true,
  );
  assert.ok(repeated.result.error, "a repeating long paragraph halts the model call");
  assert.match((await repeated.result.error.json()).error, /repeat/i);
  assert.equal(repeated.signal.aborted, true, "the upstream request is aborted");
  assert.equal(repeated.cancelled, true, "the buffered stream reader is cancelled");
  assert.equal(repeated.result.message, undefined, "partial tool calls cannot be returned as a completed reply");
  assert.ok(repeated.shown.length < paragraph.length * 4, "the loop is cut near its start");
  console.log("ok: repeated long paragraphs halt and cancel the stream before tool calls are accepted");

  const punctuationShift = await callWithDeltas([
    paragraph.replace("Archmage's", "Archmage’s") + "\n\n",
    (paragraph + "\n\n").repeat(4),
  ]);
  assert.ok(punctuationShift.result.error, "a punctuation change before the stable loop does not hide it");
  assert.match((await punctuationShift.result.error.json()).error, /repeat/i);
  console.log("ok: the sample's curly-to-straight punctuation change still leads to a halt");

  const crlf = await callWithDeltas((paragraph + "\r\n\r\n").repeat(4).match(/.{1,31}/gs));
  assert.ok(crlf.result.error, "CRLF paragraph boundaries also halt the loop");
  assert.match((await crlf.result.error.json()).error, /repeat/i);
  console.log("ok: CRLF paragraph boundaries are detected across arbitrary deltas");

  const normal = await callWithDeltas([
    paragraph + "\n\n",
    "The iron door opens toward a quiet staircase with a view of the harbor.\n\n",
    "A bell sounds from the tower and the watch changes in the square.\n\n",
  ]);
  assert.equal(normal.result.error, undefined);
  assert.equal(normal.result.message?.content, normal.shown);
  assert.equal(normal.result.message?.tool_calls?.[0]?.function?.name, "request_roll");
  console.log("ok: varied narration still streams and accepts complete tool calls");

  const short = await callWithDeltas(["Yes.\n\n".repeat(20)]);
  assert.equal(short.result.error, undefined);
  assert.equal(short.result.message?.content, "Yes.\n\n".repeat(20));
  console.log("ok: short repeated dialogue does not trip the guard");

  let localSignal;
  globalThis.fetch = async (_url, init) => {
    localSignal = init.signal;
    const content = (paragraph + "\n\n").repeat(4);
    const lines = [...content.match(/.{1,41}/gs)].map((piece) => JSON.stringify({ message: { content: piece } }) + "\n").join("");
    return new Response(lines, { headers: { "Content-Type": "application/x-ndjson" } });
  };
  const local = await requestLocalMessage("test-model", [{ role: "user", content: "Continue." }], { onDelta: () => {} });
  assert.ok(local.error, "Ollama's streamed narration also halts");
  assert.match((await local.error.json()).error, /repeat/i);
  assert.equal(localSignal.aborted, true);
  assert.equal(local.message, undefined);
  console.log("ok: Ollama NDJSON also aborts a repeated passage");

  // OpenAI's own host starts every model on Chat Completions and learns the
  // Responses route from the 400 that names it, so the stub refuses Chat
  // with that answer and streams the repeated passage on the retry.
  const tool = { type: "function", function: { name: "request_roll", description: "Roll", parameters: { type: "object", properties: {} } } };
  const urls = [];
  let responsesSignal;
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith("/chat/completions")) {
      return Response.json({ error: { message: "Function tools with reasoning_effort are not supported for test-reasoner in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", type: "invalid_request_error", param: "reasoning_effort", code: null } }, { status: 400 });
    }
    responsesSignal = init.signal;
    const content = (paragraph + "\n\n").repeat(4);
    const events = [...content.match(/.{1,43}/gs)]
      .map((piece) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: piece })}\n\n`)
      .join("");
    return new Response(events + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  };
  const responses = await requestCustomMessage("https://api.openai.com/v1", "test-reasoner", "sk-test", [{ role: "user", content: "Continue." }], { tools: [tool], onDelta: () => {} });
  assert.ok(urls.some((url) => url.endsWith("/responses")), `the case reached /v1/responses: ${urls.join(", ")}`);
  assert.ok(responses.error, "Responses API streamed narration also halts");
  assert.match((await responses.error.json()).error, /repeat/i);
  assert.equal(responsesSignal.aborted, true);
  assert.equal(responses.message, undefined);
  console.log("ok: Responses API also aborts a repeated passage");
} finally {
  globalThis.fetch = realFetch;
  removeTempDir(dir);
}
