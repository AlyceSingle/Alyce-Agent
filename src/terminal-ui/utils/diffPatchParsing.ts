export type DiffPatchHunkHeader = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
};

type DiffPatchHeaderPathOptions = {
  stripGitPrefix?: boolean;
};

export type DiffPatchHunkTracker = {
  oldRemaining?: number;
  newRemaining?: number;
};

export function createDiffPatchHunkTracker(): DiffPatchHunkTracker {
  return {};
}

export function isInsideDiffPatchHunk(tracker: DiffPatchHunkTracker) {
  return tracker.oldRemaining !== undefined &&
    tracker.newRemaining !== undefined &&
    (tracker.oldRemaining > 0 || tracker.newRemaining > 0);
}

export function setDiffPatchHunkTracker(
  tracker: DiffPatchHunkTracker,
  hunk: Pick<DiffPatchHunkHeader, "oldLines" | "newLines">
) {
  tracker.oldRemaining = hunk.oldLines;
  tracker.newRemaining = hunk.newLines;
}

export function advanceDiffPatchHunkTracker(tracker: DiffPatchHunkTracker, line: string) {
  if (!isInsideDiffPatchHunk(tracker)) {
    return;
  }

  if (line.startsWith("+")) {
    tracker.newRemaining = Math.max(0, (tracker.newRemaining ?? 0) - 1);
    return;
  }

  if (line.startsWith("-")) {
    tracker.oldRemaining = Math.max(0, (tracker.oldRemaining ?? 0) - 1);
    return;
  }

  if (line.startsWith(" ")) {
    tracker.oldRemaining = Math.max(0, (tracker.oldRemaining ?? 0) - 1);
    tracker.newRemaining = Math.max(0, (tracker.newRemaining ?? 0) - 1);
  }
}

export function parseDiffPatchHeaderPath(
  line: string,
  options: DiffPatchHeaderPathOptions = {}
) {
  const pathText = line.slice(4).trim().split(/\t/)[0]?.trim();
  if (!pathText || pathText === "/dev/null") {
    return undefined;
  }

  return options.stripGitPrefix ? pathText.replace(/^[ab]\//, "") : pathText;
}

export function parseDiffPatchHunkHeader(line: string): DiffPatchHunkHeader | null {
  const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
  if (!match) {
    return null;
  }

  const oldStart = Number.parseInt(match[1]!, 10);
  const oldLines = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
  const newStart = Number.parseInt(match[3]!, 10);
  const newLines = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);
  if (
    !Number.isFinite(oldStart) ||
    !Number.isFinite(oldLines) ||
    !Number.isFinite(newStart) ||
    !Number.isFinite(newLines)
  ) {
    return null;
  }

  return {
    oldStart,
    oldLines,
    newStart,
    newLines
  };
}

export function countDiffPatchFileHeaders(
  lines: readonly string[],
  options: DiffPatchHeaderPathOptions = {}
) {
  let count = 0;
  let pendingOldPath: string | undefined;
  const tracker = createDiffPatchHunkTracker();

  for (const line of lines) {
    const insideHunk = isInsideDiffPatchHunk(tracker);

    if (!insideHunk && line.startsWith("--- ")) {
      pendingOldPath = parseDiffPatchHeaderPath(line, options);
      continue;
    }

    if (!insideHunk && line.startsWith("+++ ")) {
      if (parseDiffPatchHeaderPath(line, options) ?? pendingOldPath) {
        count += 1;
      }
      pendingOldPath = undefined;
      continue;
    }

    const hunk = parseDiffPatchHunkHeader(line);
    if (hunk) {
      setDiffPatchHunkTracker(tracker, hunk);
      continue;
    }

    advanceDiffPatchHunkTracker(tracker, line);
  }

  return count;
}
