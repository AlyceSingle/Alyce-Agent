import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { syncLspRuntimeFileClose } from "../../services/lsp/LspRuntimeService.js";
import {
  createStructuredPatch,
  derivePatchedContent,
  ensureTrailingNewline,
  parseApplyPatch,
  splitPatchLines,
  type ApplyPatchOperation,
  type ApplyPatchStructuredPatchHunk
} from "../internal/applyPatch.js";
import { withFileWriteLock } from "../internal/fileWriteLocks.js";
import { toWorkspaceRelative } from "../internal/pathSandbox.js";
import { resolveWritablePathWithExternalApproval } from "../internal/externalDirectoryAccess.js";
import {
  getAggregateFilePermissionDetails,
  getPatchPermissionPattern
} from "../internal/filePermissions.js";
import {
  runPostWriteChecks,
  type PostWriteChecksResult,
  type PostWriteDiagnosticsResult,
  type PostWriteFormatterResult
} from "../internal/postWriteChecks.js";
import { ensureFreshFileRead, recordWrittenTextFile } from "../internal/readState.js";
import {
  countTextLines,
  encodeTextFileContent,
  readTextFileBytesWithMetadata,
  readTextFileWithMetadata,
  writeTextFileWithMetadata,
  type TextFileMetadata,
  type WriteLineEndingMode
} from "../internal/textFileIO.js";
import {
  assertExistingFileBytesUnchangedAfterApproval,
  assertFileStillMissingAfterApproval
} from "../internal/writeSafety.js";
import type { ToolExecutionContext } from "../types.js";
import { FILE_APPLY_PATCH_TOOL_NAME, getApplyPatchToolDescription } from "./prompt.js";

export const FileApplyPatchInputSchema = z
  .object({
    patchText: z.string().describe("The full apply_patch patch text to apply")
  })
  .strict();

export interface FileApplyPatchFileResult {
  type: "add" | "update" | "delete" | "move";
  filePath: string;
  sourcePath?: string;
  bytes?: number;
  lineCount?: number;
  additions: number;
  deletions: number;
  matchStrategies: string[];
  formatter?: PostWriteFormatterResult;
  diagnostics?: PostWriteDiagnosticsResult;
}

export interface FileApplyPatchResult {
  filePath: string;
  operationCount: number;
  additions: number;
  deletions: number;
  files: FileApplyPatchFileResult[];
  structuredPatch: ApplyPatchStructuredPatchHunk[];
  formatter: PostWriteFormatterResult;
  diagnostics: PostWriteDiagnosticsResult;
}

type ResolvedPatchSpec = {
  operation: ApplyPatchOperation;
  sourcePath?: string;
  targetPath: string;
  sourceRelative?: string;
  targetRelative: string;
};

type WriteOptions = {
  encoding: TextFileMetadata["encoding"];
  hasBom: boolean;
  lineEndings: WriteLineEndingMode;
};

type PreparedPatchChange = {
  type: FileApplyPatchFileResult["type"];
  sourcePath?: string;
  targetPath: string;
  sourceRelative?: string;
  targetRelative: string;
  oldContent: string;
  newContent: string;
  additions: number;
  deletions: number;
  matchStrategies: string[];
  sourceOriginalBytes?: Buffer;
  targetOriginalBytes?: Buffer;
  targetExistedBeforeApproval: boolean;
  writeOptions?: WriteOptions;
  expectedWriteBytes?: Buffer;
};

type PatchRollbackEntry =
  | {
      absolutePath: string;
      existed: true;
      originalBytes: Buffer;
    }
  | {
      absolutePath: string;
      existed: false;
    };

type CompletedPatchChange = PreparedPatchChange & {
  finalContent: string;
  bytes?: number;
  lineCount?: number;
  formatter?: PostWriteFormatterResult;
  diagnostics?: PostWriteDiagnosticsResult;
};

export const FILE_APPLY_PATCH_TOOL_DESCRIPTION = getApplyPatchToolDescription();

export async function executeFileApplyPatch(
  input: z.infer<typeof FileApplyPatchInputSchema>,
  context: ToolExecutionContext
): Promise<FileApplyPatchResult> {
  if (!input.patchText.trim()) {
    throw new Error("patchText is required");
  }

  const operations = parsePatchForTool(input.patchText);
  const { specs, allowedRoots } = await resolvePatchSpecs(operations, context);
  assertNoDuplicateTouchedPaths(specs);

  return withFileWriteLocks(
    specs.flatMap((spec) => [spec.sourcePath, spec.targetPath].filter(isString)),
    () => executeFileApplyPatchLocked(specs, context, allowedRoots)
  );
}

async function executeFileApplyPatchLocked(
  specs: readonly ResolvedPatchSpec[],
  context: ToolExecutionContext,
  allowedRoots: readonly string[]
): Promise<FileApplyPatchResult> {
  const prepared = await preparePatchChanges(specs, context);
  const touchedPaths = getPreparedTouchedPaths(prepared);
  const permissionDetails = getAggregateFilePermissionDetails(context.workspaceRoot, touchedPaths);
  const approved = await context.requestApproval({
    kind: "file-write",
    toolName: FILE_APPLY_PATCH_TOOL_NAME,
    title: "Apply patch",
    summary: formatApprovalSummary(prepared),
    details: [
      ...buildApprovalDetails(prepared),
      ...permissionDetails.details
    ],
    permission: {
      permission: "file.patch",
      pattern: getPatchPermissionPattern(context.workspaceRoot, touchedPaths)
    },
    forceAsk: permissionDetails.forceAsk
  });
  if (!approved) {
    throw new Error("User rejected apply_patch tool request");
  }

  throwIfAborted(context.abortSignal);
  for (const change of prepared) {
    await assertChangeUnchangedAfterApproval(change);
  }

  await capturePatchSnapshots(prepared, context);
  const completed = await applyPreparedPatch(prepared, context, allowedRoots);
  return buildApplyPatchResult(completed);
}

function parsePatchForTool(patchText: string) {
  let operations: ApplyPatchOperation[];
  try {
    operations = parseApplyPatch(patchText);
  } catch (error) {
    throw new Error(`apply_patch verification failed: ${formatError(error)}`);
  }

  if (operations.length === 0) {
    const normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (normalized === "*** Begin Patch\n*** End Patch") {
      throw new Error("patch rejected: empty patch");
    }

    throw new Error("apply_patch verification failed: no hunks found");
  }

  return operations;
}

async function resolvePatchSpecs(
  operations: readonly ApplyPatchOperation[],
  context: ToolExecutionContext
): Promise<{
  specs: ResolvedPatchSpec[];
  allowedRoots: string[];
}> {
  let allowedRoots = context.allowedRoots;
  const specs: ResolvedPatchSpec[] = [];
  for (const operation of operations) {
    if (operation.type === "add") {
      const resolvedTarget = await resolvePatchPath(operation.path, context, allowedRoots);
      allowedRoots = resolvedTarget.allowedRoots;
      specs.push({
        operation,
        targetPath: resolvedTarget.absolutePath,
        targetRelative: toWorkspaceRelative(context.workspaceRoot, resolvedTarget.absolutePath)
      });
      continue;
    }

    const resolvedSource = await resolvePatchPath(operation.path, context, allowedRoots);
    allowedRoots = resolvedSource.allowedRoots;
    const sourcePath = resolvedSource.absolutePath;
    let targetPath = sourcePath;
    if (operation.type === "update" && operation.movePath) {
      const resolvedTarget = await resolvePatchPath(operation.movePath, context, allowedRoots);
      allowedRoots = resolvedTarget.allowedRoots;
      targetPath = resolvedTarget.absolutePath;
    }

    if (operation.type === "update" && operation.movePath && isSamePath(sourcePath, targetPath)) {
      throw new Error(`apply_patch verification failed: Move destination matches source: ${operation.path}`);
    }

    specs.push({
      operation,
      sourcePath,
      targetPath,
      sourceRelative: toWorkspaceRelative(context.workspaceRoot, sourcePath),
      targetRelative: toWorkspaceRelative(context.workspaceRoot, targetPath)
    });
  }

  return { specs, allowedRoots };
}

async function preparePatchChanges(
  specs: readonly ResolvedPatchSpec[],
  context: ToolExecutionContext
): Promise<PreparedPatchChange[]> {
  const changes: PreparedPatchChange[] = [];
  for (const spec of specs) {
    throwIfAborted(context.abortSignal);
    switch (spec.operation.type) {
      case "add":
        changes.push(await prepareAddChange(spec, context));
        break;
      case "delete":
        changes.push(await prepareDeleteChange(spec, context));
        break;
      case "update":
        changes.push(await prepareUpdateOrMoveChange(spec, context));
        break;
    }
  }

  return changes;
}

async function prepareAddChange(
  spec: ResolvedPatchSpec,
  context: ToolExecutionContext
): Promise<PreparedPatchChange> {
  if (spec.operation.type !== "add") {
    throw new Error("apply_patch internal error: add operation lost its patch data");
  }

  const stats = await statPath(spec.targetPath);
  if (stats?.isDirectory()) {
    throw new Error(`apply_patch verification failed: Add File target is a directory: ${spec.targetRelative}`);
  }

  const existingMetadata = stats ? await readExistingTargetForOverwrite(spec, context) : null;
  const newContent = ensureTrailingNewline(spec.operation.contents);
  const writeOptions = resolveWriteOptions(existingMetadata, existingMetadata?.lineEndings ?? "preserve");
  return {
    type: "add",
    targetPath: spec.targetPath,
    targetRelative: spec.targetRelative,
    oldContent: existingMetadata?.content ?? "",
    newContent,
    additions: spec.operation.additions,
    deletions: existingMetadata ? splitPatchLines(existingMetadata.content).length : 0,
    matchStrategies: [],
    targetOriginalBytes: existingMetadata?.rawBytes,
    targetExistedBeforeApproval: Boolean(existingMetadata),
    writeOptions,
    expectedWriteBytes: encodeTextFileContent(newContent, writeOptions)
  };
}

async function prepareDeleteChange(
  spec: ResolvedPatchSpec,
  context: ToolExecutionContext
): Promise<PreparedPatchChange> {
  if (!spec.sourcePath || !spec.sourceRelative) {
    throw new Error("apply_patch internal error: delete operation lost its source path");
  }

  await assertExistingFileForPatch(spec.sourcePath, spec.sourceRelative, "delete");
  await ensureFreshFileRead(spec.sourcePath, context, FILE_APPLY_PATCH_TOOL_NAME);
  const metadata = await readTextFileBytesWithMetadata(spec.sourcePath);
  return {
    type: "delete",
    sourcePath: spec.sourcePath,
    targetPath: spec.targetPath,
    sourceRelative: spec.sourceRelative,
    targetRelative: spec.targetRelative,
    oldContent: metadata.content,
    newContent: "",
    additions: 0,
    deletions: splitPatchLines(metadata.content).length,
    matchStrategies: [],
    sourceOriginalBytes: metadata.rawBytes,
    targetExistedBeforeApproval: true
  };
}

async function prepareUpdateOrMoveChange(
  spec: ResolvedPatchSpec,
  context: ToolExecutionContext
): Promise<PreparedPatchChange> {
  if (spec.operation.type !== "update" || !spec.sourcePath || !spec.sourceRelative) {
    throw new Error("apply_patch internal error: update operation lost its source path");
  }

  await assertExistingFileForPatch(spec.sourcePath, spec.sourceRelative, "update");
  await ensureFreshFileRead(spec.sourcePath, context, FILE_APPLY_PATCH_TOOL_NAME);
  const sourceMetadata = await readTextFileBytesWithMetadata(spec.sourcePath);
  const isMove = Boolean(spec.operation.movePath);
  const targetMetadata = isMove ? await readMoveTargetIfExists(spec, context) : null;
  const patched = deriveUpdateContentForTool(spec, sourceMetadata.content);

  if (!isMove && patched.content === sourceMetadata.content) {
    throw new Error(`apply_patch verification failed: Update produced no changes: ${spec.sourceRelative}`);
  }

  const resultOldContent = targetMetadata?.content ?? sourceMetadata.content;
  const overwritesDifferentTarget = Boolean(targetMetadata && targetMetadata.content !== patched.content);
  const writeOptions = resolveWriteOptions(sourceMetadata, sourceMetadata.lineEndings);
  return {
    type: isMove ? "move" : "update",
    sourcePath: spec.sourcePath,
    targetPath: spec.targetPath,
    sourceRelative: spec.sourceRelative,
    targetRelative: spec.targetRelative,
    oldContent: resultOldContent,
    newContent: patched.content,
    additions: overwritesDifferentTarget ? splitPatchLines(patched.content).length : patched.additions,
    deletions: overwritesDifferentTarget ? splitPatchLines(targetMetadata?.content ?? "").length : patched.deletions,
    matchStrategies: patched.matchStrategies,
    sourceOriginalBytes: sourceMetadata.rawBytes,
    targetOriginalBytes: isMove ? targetMetadata?.rawBytes : sourceMetadata.rawBytes,
    targetExistedBeforeApproval: isMove ? Boolean(targetMetadata) : true,
    writeOptions,
    expectedWriteBytes: encodeTextFileContent(patched.content, writeOptions)
  };
}

function deriveUpdateContentForTool(
  spec: ResolvedPatchSpec,
  sourceContent: string
) {
  if (spec.operation.type !== "update" || spec.operation.chunks.length === 0) {
    return {
      content: sourceContent,
      matchStrategies: [],
      additions: 0,
      deletions: 0
    };
  }

  try {
    return derivePatchedContent(spec.sourceRelative ?? spec.targetRelative, sourceContent, spec.operation.chunks);
  } catch (error) {
    throw new Error(`apply_patch verification failed: ${formatError(error)}`);
  }
}

async function readExistingTargetForOverwrite(
  spec: ResolvedPatchSpec,
  context: ToolExecutionContext
) {
  await ensureFreshFileRead(spec.targetPath, context, FILE_APPLY_PATCH_TOOL_NAME);
  return readTextFileBytesWithMetadata(spec.targetPath);
}

async function readMoveTargetIfExists(
  spec: ResolvedPatchSpec,
  context: ToolExecutionContext
) {
  const stats = await statPath(spec.targetPath);
  if (!stats) {
    return null;
  }

  if (stats.isDirectory()) {
    throw new Error(`apply_patch verification failed: Move destination is a directory: ${spec.targetRelative}`);
  }

  await ensureFreshFileRead(spec.targetPath, context, FILE_APPLY_PATCH_TOOL_NAME);
  return readTextFileBytesWithMetadata(spec.targetPath);
}

async function applyPreparedPatch(
  prepared: readonly PreparedPatchChange[],
  context: ToolExecutionContext,
  allowedRoots: readonly string[]
): Promise<CompletedPatchChange[]> {
  const completed: CompletedPatchChange[] = [];
  const rollbackEntries: PatchRollbackEntry[] = [];

  try {
    for (const change of prepared) {
      throwIfAborted(context.abortSignal);
      let wroteFile = false;

      switch (change.type) {
        case "add":
        case "update":
          wroteFile = await writePreparedTextFile(change, (entry) => rollbackEntries.push(entry));
          break;
        case "move":
          wroteFile = await writePreparedTextFile(change, (entry) => rollbackEntries.push(entry));
          rollbackEntries.push(buildSourceRollbackEntry(
            change,
            "apply_patch lost its move source snapshot during rollback."
          ));
          await fs.unlink(assertString(change.sourcePath));
          await syncDeletedFileWithLsp(change.sourcePath, context, allowedRoots);
          break;
        case "delete":
          rollbackEntries.push(buildSourceRollbackEntry(
            change,
            "apply_patch lost its delete snapshot during rollback."
          ));
          await fs.unlink(assertString(change.sourcePath));
          await syncDeletedFileWithLsp(change.sourcePath, context, allowedRoots);
          completed.push({
            ...change,
            finalContent: ""
          });
          continue;
      }

      const postWriteChecks = wroteFile
        ? await runPostWriteChecks({
            absolutePath: change.targetPath,
            workspaceRoot: context.workspaceRoot,
            allowedRoots,
            abortSignal: context.abortSignal
          })
        : createSkippedPostWriteChecks("Content already matched; no file write was performed.");

      const finalMetadata = await readTextFileWithMetadata(change.targetPath);
      const finalStats = await fs.stat(change.targetPath);
      const finalContent = finalMetadata.content;
      const lineCount = countTextLines(finalContent);
      await recordWrittenTextFile(
        change.targetPath,
        change.targetRelative,
        lineCount,
        context,
        finalContent
      );

      completed.push({
        ...change,
        finalContent,
        bytes: finalStats.size,
        lineCount,
        formatter: postWriteChecks.formatter,
        diagnostics: postWriteChecks.diagnostics
      });
    }

    return completed;
  } catch (error) {
    throw await rollbackAndWrapApplyPatchError(rollbackEntries, error);
  }
}

async function writePreparedTextFile(
  change: PreparedPatchChange,
  recordRollbackEntry: (entry: PatchRollbackEntry) => void
) {
  if (!change.writeOptions || !change.expectedWriteBytes) {
    throw new Error("apply_patch internal error: text write lost metadata");
  }

  if (change.targetOriginalBytes?.equals(change.expectedWriteBytes)) {
    return false;
  }

  await fs.mkdir(path.dirname(change.targetPath), { recursive: true });
  if (!change.targetExistedBeforeApproval) {
    await writeNewTextFileExclusive(change, recordRollbackEntry);
    return true;
  }

  recordRollbackEntry(buildTargetRollbackEntry(change));
  await writeTextFileWithMetadata(change.targetPath, change.newContent, change.writeOptions);
  return true;
}

async function writeNewTextFileExclusive(
  change: PreparedPatchChange,
  recordRollbackEntry: (entry: PatchRollbackEntry) => void
) {
  if (!change.expectedWriteBytes) {
    throw new Error("apply_patch internal error: text write lost encoded bytes");
  }

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(change.targetPath, "wx");
  } catch (error) {
    if (isEexistError(error)) {
      throw new Error(
        `apply_patch target was created before writing: ${change.targetRelative}. Use Read before modifying it.`
      );
    }

    throw error;
  }

  recordRollbackEntry({
    absolutePath: change.targetPath,
    existed: false
  });

  try {
    await handle.writeFile(change.expectedWriteBytes);
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new Error(
        `Failed to write ${change.targetRelative}: ${formatError(error)}\nFailed to close file handle: ${formatError(closeError)}`
      );
    }

    throw error;
  }

  try {
    await handle.close();
  } catch (error) {
    throw new Error(`Failed to close ${change.targetRelative}: ${formatError(error)}`);
  }
}

async function rollbackAndWrapApplyPatchError(
  entries: readonly PatchRollbackEntry[],
  error: unknown
) {
  try {
    await rollbackPreparedPatch(entries);
    return new Error(`apply_patch failed after approval; rolled back filesystem changes: ${formatError(error)}`);
  } catch (rollbackError) {
    return new Error(
      `apply_patch failed after approval: ${formatError(error)}\nRollback failed: ${formatError(rollbackError)}`
    );
  }
}

async function rollbackPreparedPatch(entries: readonly PatchRollbackEntry[]) {
  const failures: string[] = [];

  for (const entry of [...entries].reverse()) {
    try {
      if (entry.existed) {
        await fs.mkdir(path.dirname(entry.absolutePath), { recursive: true });
        await fs.writeFile(entry.absolutePath, entry.originalBytes);
        continue;
      }

      await fs.unlink(entry.absolutePath);
    } catch (error) {
      if (!entry.existed && isEnoentError(error)) {
        continue;
      }

      failures.push(`${entry.absolutePath}: ${formatError(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

function buildTargetRollbackEntry(change: PreparedPatchChange): PatchRollbackEntry {
  if (!change.targetExistedBeforeApproval) {
    return {
      absolutePath: change.targetPath,
      existed: false
    };
  }

  return {
    absolutePath: change.targetPath,
    existed: true,
    originalBytes: requireOriginalBytes(
      change.targetOriginalBytes,
      "apply_patch lost its target snapshot during rollback."
    )
  };
}

function buildSourceRollbackEntry(change: PreparedPatchChange, message: string): PatchRollbackEntry {
  return {
    absolutePath: assertString(change.sourcePath),
    existed: true,
    originalBytes: requireOriginalBytes(change.sourceOriginalBytes, message)
  };
}

function requireOriginalBytes(bytes: Buffer | undefined, message: string) {
  if (!bytes) {
    throw new Error(message);
  }

  return bytes;
}

async function capturePatchSnapshots(
  prepared: readonly PreparedPatchChange[],
  context: ToolExecutionContext
) {
  const captured = new Set<string>();
  for (const change of prepared) {
    for (const targetPath of getCapturePaths(change)) {
      const key = pathKey(targetPath);
      if (captured.has(key)) {
        continue;
      }

      captured.add(key);
      await context.captureFileBeforeWrite(targetPath);
    }
  }
}

async function assertChangeUnchangedAfterApproval(change: PreparedPatchChange) {
  switch (change.type) {
    case "add":
      await assertTargetUnchangedAfterApproval(change, "Add target");
      return;
    case "update":
      await assertSourceUnchangedAfterApproval(change, "modifying it");
      return;
    case "delete":
      await assertSourceUnchangedAfterApproval(change, "deleting it");
      return;
    case "move":
      await assertSourceUnchangedAfterApproval(change, "moving it");
      await assertTargetUnchangedAfterApproval(change, "Move destination");
      return;
  }
}

async function assertSourceUnchangedAfterApproval(
  change: PreparedPatchChange,
  changedRetryAction: string
) {
  if (!change.sourcePath || !change.sourceOriginalBytes) {
    throw new Error("apply_patch lost its source file snapshot before approval completed.");
  }

  await assertExistingFileBytesUnchangedAfterApproval(
    change.sourcePath,
    change.sourceOriginalBytes,
    {
      toolName: FILE_APPLY_PATCH_TOOL_NAME,
      deletedRetryAction: changedRetryAction,
      changedRetryAction
    }
  );
}

async function assertTargetUnchangedAfterApproval(
  change: PreparedPatchChange,
  label: string
) {
  if (!change.targetExistedBeforeApproval) {
    await assertFileStillMissingAfterApproval(
      change.targetPath,
      `${label} was created while apply_patch was awaiting approval. Use Read before modifying it.`
    );
    return;
  }

  if (!change.targetOriginalBytes) {
    throw new Error("apply_patch lost its target file snapshot before approval completed.");
  }

  await assertExistingFileBytesUnchangedAfterApproval(
    change.targetPath,
    change.targetOriginalBytes,
    {
      toolName: FILE_APPLY_PATCH_TOOL_NAME,
      deletedRetryAction: "modifying it",
      changedRetryAction: "modifying it"
    }
  );
}

function buildApplyPatchResult(completed: readonly CompletedPatchChange[]): FileApplyPatchResult {
  const files = completed.map(toFileResult);
  const structuredPatch = completed.flatMap((change) =>
    createStructuredPatch({
      oldContent: change.oldContent,
      newContent: change.finalContent
    })
  );
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return {
    filePath: summarizeResultPath(files),
    operationCount: files.length,
    additions,
    deletions,
    files,
    structuredPatch,
    formatter: aggregateFormatter(files),
    diagnostics: aggregateDiagnostics(files)
  };
}

function toFileResult(change: CompletedPatchChange): FileApplyPatchFileResult {
  return {
    type: change.type,
    filePath: change.targetRelative,
    sourcePath: change.type === "move" ? change.sourceRelative : undefined,
    bytes: change.bytes,
    lineCount: change.lineCount,
    additions: change.additions,
    deletions: change.deletions,
    matchStrategies: change.matchStrategies,
    formatter: change.formatter,
    diagnostics: change.diagnostics
  };
}

function aggregateFormatter(files: readonly FileApplyPatchFileResult[]): PostWriteFormatterResult {
  const results = files.flatMap((file) => file.formatter ?? []);
  if (results.length === 0) {
    return {
      status: "skipped",
      message: "No remaining files to format."
    };
  }

  if (results.some((result) => result.status === "failed")) {
    return {
      status: "failed",
      formatter: "multiple",
      message: `${results.filter((result) => result.status === "failed").length} formatter check(s) failed.`
    };
  }

  if (results.some((result) => result.status === "formatted")) {
    return {
      status: "formatted",
      formatter: "multiple",
      message: "One or more files were formatted."
    };
  }

  if (results.some((result) => result.status === "unchanged")) {
    return {
      status: "unchanged",
      formatter: "multiple",
      message: "Formatter checks completed without changing files."
    };
  }

  return {
    status: "skipped",
    message: "No configured formatter found for patched files."
  };
}

function aggregateDiagnostics(files: readonly FileApplyPatchFileResult[]): PostWriteDiagnosticsResult {
  const results = files.flatMap((file) => file.diagnostics ?? []);
  if (results.length === 0) {
    return {
      status: "skipped",
      issues: [],
      totalIssueCount: 0,
      truncated: false,
      message: "No remaining files to diagnose."
    };
  }

  const issues = results.flatMap((result) => result.issues);
  const totalIssueCount = results.reduce((sum, result) => sum + result.totalIssueCount, 0);
  const hasFailure = results.some((result) => result.status === "failed");
  const hasPending = results.some((result) => result.status === "pending");
  const hasOk = results.some((result) => result.status === "ok");
  const allSkipped = results.every((result) => result.status === "skipped");

  return {
    status: issues.length > 0
      ? "issues"
      : hasFailure
        ? "failed"
        : hasPending
          ? "pending"
          : hasOk
            ? "ok"
            : "skipped",
    backend: results.some((result) => result.backend === "typescript-language-service")
      ? "typescript-language-service"
      : undefined,
    issues,
    totalIssueCount,
    truncated: results.some((result) => result.truncated),
    message: allSkipped
      ? "Diagnostics currently support TypeScript/JavaScript files only."
      : hasPending
        ? "Diagnostics are running in the background."
        : undefined
  };
}

function formatApprovalSummary(prepared: readonly PreparedPatchChange[]) {
  const additions = prepared.reduce((sum, change) => sum + change.additions, 0);
  const deletions = prepared.reduce((sum, change) => sum + change.deletions, 0);
  return `${prepared.length} file(s), +${additions} -${deletions}`;
}

function buildApprovalDetails(prepared: readonly PreparedPatchChange[]) {
  const details = [
    `Files: ${prepared.length}`,
    `Additions: ${prepared.reduce((sum, change) => sum + change.additions, 0)}`,
    `Deletions: ${prepared.reduce((sum, change) => sum + change.deletions, 0)}`
  ];

  details.push(
    ...prepared.slice(0, 12).map((change) => {
      const prefix = change.type === "add"
        ? "A"
        : change.type === "delete"
          ? "D"
          : change.type === "move"
            ? "R"
            : "M";
      const pathLabel =
        change.type === "move" && change.sourceRelative
          ? `${change.sourceRelative} -> ${change.targetRelative}`
          : change.targetRelative;
      return `${prefix} ${pathLabel} (+${change.additions} -${change.deletions})`;
    })
  );

  if (prepared.length > 12) {
    details.push(`... ${prepared.length - 12} more file(s)`);
  }

  return details;
}

function getPreparedTouchedPaths(prepared: readonly PreparedPatchChange[]) {
  return [
    ...new Set(
      prepared
        .flatMap((change) => [change.sourcePath, change.targetPath])
        .filter(isString)
        .map((targetPath) => path.resolve(targetPath))
    )
  ];
}

function summarizeResultPath(files: readonly FileApplyPatchFileResult[]) {
  if (files.length === 1) {
    return files[0].filePath;
  }

  return `${files.length} files`;
}

async function resolvePatchPath(
  inputPath: string,
  context: ToolExecutionContext,
  currentAllowedRoots: readonly string[]
) {
  const normalized = inputPath.trim();
  if (!normalized) {
    throw new Error("apply_patch requires non-empty file paths");
  }

  return resolveWritablePathWithExternalApproval(context, normalized, {
    toolName: FILE_APPLY_PATCH_TOOL_NAME,
    title: "apply_patch external path",
    kind: "file",
    currentAllowedRoots
  });
}

async function assertExistingFileForPatch(
  absolutePath: string,
  displayPath: string,
  operation: "update" | "delete"
) {
  const stats = await statPath(absolutePath);
  if (!stats || stats.isDirectory()) {
    throw new Error(
      `apply_patch verification failed: Failed to read file to ${operation}: ${displayPath}`
    );
  }
}

function resolveWriteOptions(
  metadata: TextFileMetadata | null,
  lineEndings: WriteLineEndingMode
): WriteOptions {
  return {
    encoding: metadata?.encoding ?? "utf8",
    hasBom: metadata?.hasBom ?? false,
    lineEndings
  };
}

async function statPath(absolutePath: string) {
  try {
    return await fs.stat(absolutePath);
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    throw error;
  }
}

function assertNoDuplicateTouchedPaths(specs: readonly ResolvedPatchSpec[]) {
  const owners = new Map<string, string>();
  for (const spec of specs) {
    const touchedPaths = [...new Set([spec.sourcePath, spec.targetPath].filter(isString).map(pathKey))];
    for (const touchedPath of touchedPaths) {
      const previousOwner = owners.get(touchedPath);
      const owner = formatSpecOwner(spec);
      if (previousOwner) {
        throw new Error(
          `apply_patch verification failed: multiple operations touch the same path (${previousOwner}; ${owner})`
        );
      }

      owners.set(touchedPath, owner);
    }
  }
}

function formatSpecOwner(spec: ResolvedPatchSpec) {
  if (spec.operation.type === "update" && spec.operation.movePath) {
    return `${spec.sourceRelative} -> ${spec.targetRelative}`;
  }

  return spec.targetRelative;
}

function getCapturePaths(change: PreparedPatchChange) {
  return change.type === "move" && change.sourcePath
    ? [change.sourcePath, change.targetPath]
    : [change.targetPath];
}

function withFileWriteLocks<T>(
  absolutePaths: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const paths = [...new Map(absolutePaths.map((targetPath) => [pathKey(targetPath), targetPath])).values()]
    .sort((left, right) => pathKey(left).localeCompare(pathKey(right)));

  const lockedOperation = paths.reduceRight<() => Promise<T>>(
    (next, targetPath) => () => withFileWriteLock(targetPath, next),
    operation
  );
  return lockedOperation();
}

function pathKey(absolutePath: string) {
  const resolved = path.resolve(absolutePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSamePath(left: string, right: string) {
  return pathKey(left) === pathKey(right);
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

function assertString(value: string | undefined) {
  if (!value) {
    throw new Error("apply_patch internal error: expected path");
  }

  return value;
}

function isEnoentError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}

function isEexistError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EEXIST"
  );
}

async function syncDeletedFileWithLsp(
  absolutePath: string | undefined,
  context: ToolExecutionContext,
  allowedRoots: readonly string[]
) {
  if (!absolutePath) {
    return;
  }

  try {
    await syncLspRuntimeFileClose({
      filePath: absolutePath,
      workspaceRoot: context.workspaceRoot,
      allowedRoots,
      abortSignal: context.abortSignal
    });
  } catch {
    // apply_patch should not fail because runtime sync failed.
  }
}

function createSkippedPostWriteChecks(message: string): PostWriteChecksResult {
  return {
    formatter: {
      status: "skipped",
      message
    },
    diagnostics: {
      status: "skipped",
      issues: [],
      totalIssueCount: 0,
      truncated: false,
      message
    }
  };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
