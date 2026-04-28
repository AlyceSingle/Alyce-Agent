import { Event } from './event.js'

export type MouseEventAction = 'down' | 'move' | 'up'

/**
 * Mouse event fired for host components in fullscreen mode.
 *
 * Unlike ClickEvent, this is dispatched on press / drag / release so
 * components can implement richer interactions such as draggable gutters
 * and scroll thumbs.
 */
export class MouseEvent extends Event {
  /** 0-indexed screen column of the pointer event */
  readonly col: number
  /** 0-indexed screen row of the pointer event */
  readonly row: number
  /** Base mouse button code (0=left, 1=middle, 2=right, 3=no button) */
  readonly button: number
  /** Pointer phase */
  readonly action: MouseEventAction
  /** Pointer column relative to the current handler's Box */
  localCol = 0
  /** Pointer row relative to the current handler's Box */
  localRow = 0
  /** True when the hit cell has no visible content */
  readonly cellIsBlank: boolean

  constructor(
    col: number,
    row: number,
    button: number,
    action: MouseEventAction,
    cellIsBlank: boolean,
  ) {
    super()
    this.col = col
    this.row = row
    this.button = button
    this.action = action
    this.cellIsBlank = cellIsBlank
  }
}
