import type { RGBA, StyledText } from "@opentui/core"
import type { DiagramCanvas } from "../core/canvas.ts"
import { renderDiagramGridStyledTextByStyle } from "../core/render-grid.ts"
import type { StateStyleColors } from "./style.ts"
import type { StateCellStyle } from "./types.ts"

export type StateGrid = DiagramCanvas<StateCellStyle>

export function renderStateGridText(grid: StateGrid): string {
  return grid.toString({ trimTop: true, trimBottom: true })
}

export function renderStateGridStyledText(
  grid: StateGrid,
  colors: StateStyleColors,
  backgrounds?: Partial<Record<StateCellStyle, RGBA>>,
): StyledText {
  return renderDiagramGridStyledTextByStyle(grid, colors, backgrounds, {
    trimTop: true,
    trimBottom: true,
  })
}
