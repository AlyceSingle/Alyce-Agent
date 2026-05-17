import assert from "node:assert/strict";
import {
  getBuiltInProviderConnectors
} from "./index.js";

function runTests() {
  testExperimentalConnectorsAreVisibleByDefault();
  testExperimentalConnectorsCanBeOmittedExplicitly();
  console.log("provider connector index tests passed");
}

function testExperimentalConnectorsAreVisibleByDefault() {
  const connectors = getBuiltInProviderConnectors();

  assert.deepEqual(connectors.map((connector) => connector.id), [
    "github-copilot",
    "codex"
  ]);
  assert.equal(connectors.every((connector) => connector.experimental), true);
}

function testExperimentalConnectorsCanBeOmittedExplicitly() {
  const connectors = getBuiltInProviderConnectors({ includeExperimental: false });

  assert.deepEqual(connectors.map((connector) => connector.id), []);
}

runTests();
