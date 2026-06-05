#!/usr/bin/env node
import "dotenv/config";
import process from "node:process";
import {
  logStartupTiming,
  measureStartupTiming
} from "./core/startup/startupTiming.js";

async function main(): Promise<void> {
  logStartupTiming("index:entered", {
    cwd: process.cwd(),
    argvLength: process.argv.length
  });
  const { startReactUiMode } = await measureStartupTiming(
    "index:importStartReactUiMode",
    () => import("./cli/startReactUiMode.js")
  );
  const argv = process.argv.slice(2);
  await measureStartupTiming("index:startReactUiMode", () =>
    startReactUiMode(argv, process.env)
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logStartupTiming("index:error", { error: message });
  console.error(message);
  process.exitCode = 1;
});
