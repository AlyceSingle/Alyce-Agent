import assert from "node:assert/strict";
import {
  isTurnInterruptedError,
  toTurnInterruptedError
} from "./abort.js";

async function runTests() {
  testStringAbortReasonIsInterrupted();
  testErrorAbortReasonIsInterrupted();
  testUnrelatedStringIsNotInterrupted();
  console.log("abort tests passed");
}

function testStringAbortReasonIsInterrupted() {
  const controller = new AbortController();
  controller.abort("user-cancel");

  assert.equal(isTurnInterruptedError("user-cancel", controller.signal), true);

  const error = toTurnInterruptedError("user-cancel", controller.signal);
  assert.equal(error.reason, "user-cancel");
  assert.equal(error.message, "Request interrupted by user");
}

function testErrorAbortReasonIsInterrupted() {
  const controller = new AbortController();
  controller.abort("user-cancel");

  assert.equal(isTurnInterruptedError(new Error("user-cancel"), controller.signal), true);
}

function testUnrelatedStringIsNotInterrupted() {
  const controller = new AbortController();
  controller.abort("user-cancel");

  assert.equal(isTurnInterruptedError("network-failure", controller.signal), false);
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
