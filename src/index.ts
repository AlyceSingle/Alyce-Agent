#!/usr/bin/env node
import "dotenv/config";
import process from "node:process";
import { startReactUiMode } from "./cli/startReactUiMode.js";

async function main() {
  const argv = process.argv.slice(2);
  await startReactUiMode(argv, process.env);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
