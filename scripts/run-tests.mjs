import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();
const sourceRoot = path.join(workspaceRoot, "src");
const testPattern = /\.test\.tsx?$/;
const args = process.argv.slice(2);
const filters = args.filter((arg) => !arg.startsWith("-"));
const failFast = args.includes("--fail-fast");

const testFiles = (await collectTestFiles(sourceRoot))
  .filter((filePath) => matchesFilters(filePath, filters))
  .sort((left, right) => left.localeCompare(right));

if (testFiles.length === 0) {
  console.error(filters.length > 0
    ? `No test files matched: ${filters.join(", ")}`
    : "No test files found.");
  process.exitCode = 1;
} else {
  console.log(`Running ${testFiles.length} test file(s)...`);
  const failures = [];
  const startedAt = Date.now();

  for (const [index, testFile] of testFiles.entries()) {
    const relativePath = toPosixRelative(testFile);
    console.log(`\n[${index + 1}/${testFiles.length}] ${relativePath}`);
    const result = await runTestFile(testFile);
    if (result !== 0) {
      failures.push({ file: relativePath, exitCode: result });
      if (failFast) {
        break;
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  if (failures.length > 0) {
    console.error(`\n${failures.length} test file(s) failed in ${durationMs} ms:`);
    for (const failure of failures) {
      console.error(`- ${failure.file} (exit ${failure.exitCode})`);
    }
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${testFiles.length} test file(s) passed in ${durationMs} ms.`);
  }
}

async function collectTestFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(fullPath));
      continue;
    }

    if (entry.isFile() && testPattern.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function matchesFilters(filePath, activeFilters) {
  if (activeFilters.length === 0) {
    return true;
  }

  const normalizedPath = toPosixRelative(filePath).toLowerCase();
  return activeFilters.some((filter) =>
    normalizedPath.includes(filter.replaceAll("\\", "/").toLowerCase())
  );
}

function runTestFile(filePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [resolveTsxCli(), filePath], {
      cwd: workspaceRoot,
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        NODE_ENV: "test"
      }
    });

    child.on("error", (error) => {
      console.error(`Failed to start test runner: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`Test runner exited with signal ${signal}`);
        resolve(1);
        return;
      }

      resolve(code ?? 1);
    });
  });
}

function resolveTsxCli() {
  return path.join(workspaceRoot, "node_modules", "tsx", "dist", "cli.mjs");
}

function toPosixRelative(filePath) {
  return path.relative(workspaceRoot, filePath).replaceAll(path.sep, "/");
}
