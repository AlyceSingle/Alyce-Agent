import * as esbuild from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(workspaceRoot, "dist");
const watchMode = process.argv.includes("--watch");
const withSourceMaps = process.argv.includes("--sourcemap") || watchMode;
// Minify can make the first cold V8 parse slower on Windows; keep off by default.
const minify = process.argv.includes("--minify") || process.env.ALYCE_BUILD_MINIFY === "1";

const externalPackages = [
  "@lydell/node-pty",
  "@lydell/node-pty/*",
  "typescript"
];

const REQUIRE_SHIM = `import { createRequire as __alyceCreateRequire } from "node:module";
var require = __alyceCreateRequire(import.meta.url);
`;

/**
 * 冷启动优先：单文件 app bundle 在 Windows 上显著快于数百个 ESM 模块解析。
 * Single-file app bundle wins cold start on Windows: one sequential file open
 * beats hundreds of ESM modules + node_modules graph walks.
 */
const sharedOptions = {
  absWorkingDir: workspaceRoot,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: withSourceMaps,
  logLevel: "info",
  packages: "bundle",
  external: externalPackages,
  splitting: false,
  jsx: "automatic",
  jsxImportSource: "react",
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production")
  },
  legalComments: "none",
  minify,
  treeShaking: true,
  banner: {
    js: REQUIRE_SHIM
  }
};

const entryPoints = {
  app: path.join(workspaceRoot, "src/index.ts"),
  LspRuntimeWorker: path.join(workspaceRoot, "src/services/lsp/LspRuntimeWorker.ts"),
  typeScriptDiagnosticsWorker: path.join(
    workspaceRoot,
    "src/tools/internal/typeScriptDiagnosticsWorker.ts"
  )
};

async function cleanDist() {
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });
}

async function writeLauncher() {
  const launcher = `#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import process from "node:process";

// Enable V8 compile cache before loading the app graph. Best-effort only.
try {
  if (typeof enableCompileCache === "function") {
    enableCompileCache();
  }
} catch {
  // Compile cache is an optimization; never block startup.
}

try {
  await import("./app.js");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
`;
  const launcherPath = path.join(distDir, "index.js");
  await fs.writeFile(launcherPath, launcher, "utf8");
  try {
    await fs.chmod(launcherPath, 0o755);
  } catch {
    // Windows may not support chmod the same way.
  }
}

async function normalizeBundleEntrypoints() {
  const files = ["app.js", "LspRuntimeWorker.js", "typeScriptDiagnosticsWorker.js"];
  for (const fileName of files) {
    const filePath = path.join(distDir, fileName);
    let source = await fs.readFile(filePath, "utf8");
    source = source.replace(/^#!.*\r?\n/, "");
    if (!source.startsWith("import { createRequire as __alyceCreateRequire }")) {
      source = REQUIRE_SHIM + source;
    }
    await fs.writeFile(filePath, source, "utf8");
  }
}

async function buildOnce() {
  const startedAt = Date.now();
  await cleanDist();

  await esbuild.build({
    ...sharedOptions,
    entryPoints,
    outdir: distDir
  });

  await normalizeBundleEntrypoints();
  await writeLauncher();
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `alyce build complete in ${elapsedMs}ms -> ${path.relative(workspaceRoot, distDir)} (minify=${minify})`
  );
}

async function buildWatch() {
  await cleanDist();
  await writeLauncher();

  const context = await esbuild.context({
    ...sharedOptions,
    entryPoints,
    outdir: distDir,
    plugins: [
      {
        name: "alyce-postprocess",
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length === 0) {
              await normalizeBundleEntrypoints();
              await writeLauncher();
              console.log("alyce watch rebuild complete");
            }
          });
        }
      }
    ]
  });

  await context.watch();
  console.log("alyce build watching for changes...");
}

if (watchMode) {
  await buildWatch();
} else {
  await buildOnce();
}
