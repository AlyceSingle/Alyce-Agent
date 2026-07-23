/** Merge incremental thinking/reasoning stream chunks without duplicating overlap. */
export function mergeThinkingContent(current: string, nextChunk: string): string {
  if (!nextChunk.trim()) {
    return current;
  }

  if (!current) {
    return nextChunk;
  }

  if (current === nextChunk) {
    return current;
  }

  if (nextChunk.startsWith(current)) {
    return nextChunk;
  }

  if (current.endsWith(nextChunk)) {
    return current;
  }

  const maxOverlap = Math.min(current.length, nextChunk.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (current.endsWith(nextChunk.slice(0, overlap))) {
      return `${current}${nextChunk.slice(overlap)}`;
    }
  }

  return `${current}${nextChunk}`;
}

/** Return only the newly added portion of a thinking snapshot. */
export function extractThinkingDelta(previous: string, next: string): string {
  if (!previous) {
    return next;
  }

  if (next === previous) {
    return "";
  }

  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }

  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.endsWith(next.slice(0, overlap))) {
      return next.slice(overlap);
    }
  }

  return next;
}
