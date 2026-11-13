export type MermaidBlock = { source: string; start: number; end: number }
export type Cell = { width: number; aspect: number }
export function mermaidBlocks(text: string): MermaidBlock[]
export function foldBlocks(text: string, okFlags: boolean[], label: string): string
export function fitCells(
  width: number,
  height: number,
  viewport: { columns: number; rows: number },
  cell: Cell,
): { columns: number; rows: number; scale: number }
export function hashSource(text: string): string
export const LEGIBLE_SCALE: number
export const MAX_COLUMNS: number
export const MAX_ROWS: number
