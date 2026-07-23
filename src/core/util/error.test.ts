import assert from "node:assert/strict";
import { getErrorMessage } from "./error.js";

function runTests() {
  assert.equal(getErrorMessage(new Error("boom")), "boom");
  assert.equal(getErrorMessage("plain"), "plain");
  assert.equal(getErrorMessage(42), "42");
  console.log("error util tests passed");
}

runTests();
