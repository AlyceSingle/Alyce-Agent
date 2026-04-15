declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-root': Record<string, unknown>;
      'ink-box': Record<string, unknown>;
      'ink-text': Record<string, unknown>;
      'ink-link': Record<string, unknown>;
      'ink-virtual-text': Record<string, unknown>;
    }
  }
}

export {};
