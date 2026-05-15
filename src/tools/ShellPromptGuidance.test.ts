import assert from "node:assert/strict";
import { BASH_TOOL_DESCRIPTION } from "./BashTool/BashTool.js";
import { POWERSHELL_TOOL_DESCRIPTION } from "./PowerShellTool/PowerShellTool.js";

function runTests() {
  testBashWarnsAgainstForegroundDevServers();
  testPowerShellWarnsAgainstForegroundDevServers();
  console.log("shell prompt guidance tests passed");
}

function testBashWarnsAgainstForegroundDevServers() {
  assert.match(BASH_TOOL_DESCRIPTION, /Do not use this foreground runner/);
  assert.match(BASH_TOOL_DESCRIPTION, /npm run dev/);
  assert.match(BASH_TOOL_DESCRIPTION, /ProcessStart/);
  assert.match(BASH_TOOL_DESCRIPTION, /PtyCreate/);
  assert.match(BASH_TOOL_DESCRIPTION, /cannot keep a long-running server alive/);
}

function testPowerShellWarnsAgainstForegroundDevServers() {
  assert.match(POWERSHELL_TOOL_DESCRIPTION, /Do not use this foreground runner/);
  assert.match(POWERSHELL_TOOL_DESCRIPTION, /npm run dev/);
  assert.match(POWERSHELL_TOOL_DESCRIPTION, /ProcessStart/);
  assert.match(POWERSHELL_TOOL_DESCRIPTION, /PtyCreate/);
  assert.match(POWERSHELL_TOOL_DESCRIPTION, /cannot keep a long-running server alive/);
}

runTests();
