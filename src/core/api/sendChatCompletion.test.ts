import assert from "node:assert/strict";
import {
  computeReconnectDelayMs,
  getRetryAfterMs,
  parseRetryAfterValue
} from "./sendChatCompletion.js";

async function runTests() {
  testExponentialBackoffWithJitter();
  testBackoffIsCapped();
  testRetryAfterSecondsWins();
  testRetryAfterFromHeaders();
  testRetryAfterHttpDate();
  testRetryAfterIsCapped();
  console.log("send chat completion tests passed");
}

function testExponentialBackoffWithJitter() {
  const minDelay = computeReconnectDelayMs(1, new Error("boom"), () => 0);
  const maxDelay = computeReconnectDelayMs(1, new Error("boom"), () => 1);
  assert.equal(minDelay, 500);
  assert.equal(maxDelay, 1000);

  const attempt3Min = computeReconnectDelayMs(3, new Error("boom"), () => 0);
  const attempt3Max = computeReconnectDelayMs(3, new Error("boom"), () => 1);
  assert.equal(attempt3Min, 2000);
  assert.equal(attempt3Max, 4000);
}

function testBackoffIsCapped() {
  const delay = computeReconnectDelayMs(20, new Error("boom"), () => 1);
  assert.equal(delay, 60_000);
}

function testRetryAfterSecondsWins() {
  const error = Object.assign(new Error("rate limited"), { retryAfterMs: 15_000 });
  assert.equal(computeReconnectDelayMs(1, error, () => 1), 15_000);
}

function testRetryAfterFromHeaders() {
  const withHeadersObject = Object.assign(new Error("rate limited"), {
    headers: { "Retry-After": "3" }
  });
  assert.equal(getRetryAfterMs(withHeadersObject), 3000);

  const withFetchHeaders = Object.assign(new Error("rate limited"), {
    headers: new Headers({ "retry-after": "2" })
  });
  assert.equal(getRetryAfterMs(withFetchHeaders), 2000);

  assert.equal(getRetryAfterMs(new Error("no headers")), undefined);
}

function testRetryAfterHttpDate() {
  const future = new Date(Date.now() + 30_000).toUTCString();
  const parsed = parseRetryAfterValue(future);
  assert.ok(parsed !== undefined && parsed > 20_000 && parsed <= 31_000);

  const past = new Date(Date.now() - 30_000).toUTCString();
  assert.equal(parseRetryAfterValue(past), 0);
  assert.equal(parseRetryAfterValue("not-a-date"), undefined);
}

function testRetryAfterIsCapped() {
  const error = Object.assign(new Error("rate limited"), { retryAfterMs: 3_600_000 });
  assert.equal(computeReconnectDelayMs(1, error, () => 1), 300_000);
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
