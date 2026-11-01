import type { StyledText } from "@opentui/core"
import type { DiagramCanvas } from "../core/canvas.ts"
import { renderDiagramGridStyledText } from "../core/render-grid.ts"
import type { GanttStyleColors } from "./style.ts"
import type { GanttCellStyle } from "./types.ts"

export type GanttGrid = DiagramCanvas<GanttCellStyle>

export function renderGanttGridText(grid: GanttGrid): string {
  return grid.toString({ trimBottom: true })
}

export function renderGanttGridStyledText(grid: GanttGrid, colors: GanttStyleColors): StyledText {
  return renderDiagramGridStyledText(grid, (run) => (run.style ? colors[run.style] : undefined), undefined, {
    trimBottom: true,
  })
}
