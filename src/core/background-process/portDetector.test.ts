import assert from "node:assert/strict";
import {
  detectDevServerReadiness,
  detectPortConflicts,
  detectPorts,
  detectUrls
} from "./portDetector.js";

function runTests() {
  testDetectsViteStyleUrls();
  testDetectsBareLocalhostPorts();
  testDetectsGenericPortText();
  testDetectsReadyStartedServerSignal();
  testDetectsPortInUseWarnings();
  testDetectsEaddrinuseWarnings();
  console.log("portDetector tests passed");
}

function testDetectsViteStyleUrls() {
  const output = "Local:   http://localhost:5173/\nNetwork: http://192.168.1.20:5173/";

  assert.deepEqual(detectUrls(output), [
    "http://localhost:5173/",
    "http://192.168.1.20:5173/"
  ]);
  assert.deepEqual(detectPorts(output), [5173]);
}

function testDetectsBareLocalhostPorts() {
  assert.deepEqual(detectUrls("ready on localhost:3000"), ["http://localhost:3000/"]);
  assert.deepEqual(detectPorts("ready on localhost:3000"), [3000]);
}

function testDetectsGenericPortText() {
  assert.deepEqual(detectPorts("server listening on port 8080"), [8080]);
}

function testDetectsReadyStartedServerSignal() {
  assert.equal(
    detectDevServerReadiness("ready started server on 0.0.0.0:3000"),
    "ready started server on"
  );
  assert.deepEqual(detectPorts("ready started server on 0.0.0.0:3000"), [3000]);
}

function testDetectsPortInUseWarnings() {
  const text = "Port 5173 is in use, trying another one...\nLocal: http://localhost:5174/";

  assert.deepEqual(detectPortConflicts(text), [
    {
      ports: [5173],
      message: "Port 5173 is already in use."
    }
  ]);
  assert.deepEqual(detectPorts(text), [5173, 5174]);
}

function testDetectsEaddrinuseWarnings() {
  const text = "Error: listen EADDRINUSE: address already in use 127.0.0.1:5173";

  assert.deepEqual(detectPortConflicts(text), [
    {
      ports: [5173],
      message: "Port 5173 is already in use (EADDRINUSE)."
    }
  ]);
  assert.deepEqual(detectPorts(text), [5173]);
}

runTests();
