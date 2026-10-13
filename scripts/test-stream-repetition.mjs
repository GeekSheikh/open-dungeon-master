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
const realFetch = globalThis.fetch;
const paragraph = `The Archmage's eyes flare, a spark of humor dancing in the blue light. "It is a place of many doors. Choose yours wisely, Master Flamefinger. Even a scholar must know when to put down the book and pick up a glass of wine."`;
assert.ok(paragraph.length >= 160);

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

  let responsesSignal;
  globalThis.fetch = async (_url, init) => {
    responsesSignal = init.signal;
    const content = (paragraph + "\n\n").repeat(4);
    const events = [...content.match(/.{1,43}/gs)]
      .map((piece) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: piece })}\n\n`)
      .join("");
    return new Response(events + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  };
  const responses = await requestCustomMessage("https://api.openai.com/v1", "gpt-6.1-sol", "sk-test", [{ role: "user", content: "Continue." }], { onDelta: () => {} });
  assert.ok(responses.error, "Responses API streamed narration also halts");
  assert.match((await responses.error.json()).error, /repeat/i);
  assert.equal(responsesSignal.aborted, true);
  assert.equal(responses.message, undefined);
  console.log("ok: Responses API also aborts a repeated passage");
} finally {
  globalThis.fetch = realFetch;
  removeTempDir(dir);
}
