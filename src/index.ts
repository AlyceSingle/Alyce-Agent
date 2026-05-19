#!/usr/bin/env node
import "dotenv/config";
import process from "node:process";

async function main(): Promise<void> {
  const { startReactUiMode } = await import("./cli/startReactUiMode.js");
  const argv = process.argv.slice(2);
  await startReactUiMode(argv, process.env);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
