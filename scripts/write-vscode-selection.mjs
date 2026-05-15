#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const outPath = readFlagValue(args, "--out");
const directSelection = readFlagValue(args, "--selection");

if (!outPath) {
  fail("Usage: node scripts/write-vscode-selection.mjs --out <file> [--selection <text>]");
}

const selection = directSelection ?? process.env.ALYCE_VSCODE_SELECTION ?? await readStdin();
if (!selection || selection.trim().length === 0) {
  fail("No selection text was provided. Pass --selection, set ALYCE_VSCODE_SELECTION, or pipe text on stdin.");
}

const absoluteOutPath = path.resolve(outPath);
await fs.mkdir(path.dirname(absoluteOutPath), { recursive: true });
await fs.writeFile(absoluteOutPath, selection, "utf8");
console.log(absoluteOutPath);

function readFlagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  const value = argv[index + 1];
  if (typeof value !== "string" || value.startsWith("--")) {
    fail(`Missing value for ${flag}.`);
  }

  return value;
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return undefined;
  }

  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += chunk;
  }

  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
