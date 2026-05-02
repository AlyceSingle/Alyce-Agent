#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import process from "node:process";

const DEP0040_DISABLE_FLAG = "--disable-warning=DEP0040";
const DEP0040_RELAUNCH_ENV = "ALYCE_DEP0040_SUPPRESSED";

function hasDep0040Suppression() {
  return (
    process.execArgv.includes(DEP0040_DISABLE_FLAG) ||
    process.env.NODE_OPTIONS?.includes(DEP0040_DISABLE_FLAG) === true ||
    process.env[DEP0040_RELAUNCH_ENV] === "1"
  );
}

async function relaunchWithDep0040Suppressed() {
  if (hasDep0040Suppression()) {
    return false;
  }

  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  const child = spawn(
    process.execPath,
    [...process.execArgv, DEP0040_DISABLE_FLAG, entrypoint, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        [DEP0040_RELAUNCH_ENV]: "1"
      }
    }
  );

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }

      resolve(signal ? 1 : 0);
    });
  });

  process.exitCode = exitCode;
  return true;
}

async function main() {
  if (await relaunchWithDep0040Suppressed()) {
    return;
  }

  const { startReactUiMode } = await import("./cli/startReactUiMode.js");
  const argv = process.argv.slice(2);
  await startReactUiMode(argv, process.env);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
