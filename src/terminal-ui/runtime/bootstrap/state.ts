let lastInteractionTime = Date.now();
let pendingInteractionFlush = false;

export function markScrollActivity(): void {
  pendingInteractionFlush = true;
}

export function updateLastInteractionTime(): void {
  lastInteractionTime = Date.now();
  pendingInteractionFlush = false;
}

export function flushInteractionTime(): void {
  if (!pendingInteractionFlush) {
    return;
  }

  updateLastInteractionTime();
}

export function getLastInteractionTime(): number {
  return lastInteractionTime;
}
