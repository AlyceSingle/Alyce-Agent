declare module 'react-reconciler/constants.js' {
  export const ConcurrentRoot: number
  export const LegacyRoot: number
  export const ContinuousEventPriority: number
  export const DefaultEventPriority: number
  export const DiscreteEventPriority: number
  export const NoEventPriority: number
}

declare module 'bidi-js' {
  const bidiFactory: (...args: unknown[]) => unknown
  export default bidiFactory
}

declare const Bun:
  | undefined
  | {
      stringWidth?: (
        value: string,
        options?: Record<string, unknown>,
      ) => number
      wrapAnsi?: (
        value: string,
        columns: number,
        options?: Record<string, unknown>,
      ) => string
    }
