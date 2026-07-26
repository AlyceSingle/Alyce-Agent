import assert from "node:assert/strict";
import { readServerSentEvents, type ServerSentEvent } from "./sseStream.js";

async function runTests() {
  await testParsesDataAndEventFields();
  await testJoinsMultiLineDataAndSkipsComments();
  await testHandlesCrlfAndMissingTrailingBlankLine();
  console.log("sse stream tests passed");
}

function createSseResponse(payload: string): Response {
  return new Response(payload, {
    headers: { "content-type": "text/event-stream" }
  });
}

async function collect(response: Response): Promise<ServerSentEvent[]> {
  const events: ServerSentEvent[] = [];
  for await (const event of readServerSentEvents(response)) {
    events.push(event);
  }
  return events;
}

async function testParsesDataAndEventFields() {
  const events = await collect(createSseResponse(
    "event: message_start\ndata: {\"a\":1}\n\ndata: {\"b\":2}\n\n"
  ));

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { event: "message_start", data: "{\"a\":1}" });
  assert.deepEqual(events[1], { data: "{\"b\":2}" });
}

async function testJoinsMultiLineDataAndSkipsComments() {
  const events = await collect(createSseResponse(
    ": keep-alive\ndata: line1\ndata: line2\n\n"
  ));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, "line1\nline2");
}

async function testHandlesCrlfAndMissingTrailingBlankLine() {
  const events = await collect(createSseResponse(
    "event: delta\r\ndata: chunk\r\n\r\ndata: tail\n"
  ));

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { event: "delta", data: "chunk" });
  assert.deepEqual(events[1], { data: "tail" });
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
