import type { StyledText } from "@opentui/core"
import type { DiagramCanvas } from "../core/canvas.ts"
import { renderDiagramGridStyledText } from "../core/render-grid.ts"
import type { TimelineStyleColors } from "./style.ts"
import type { TimelineCellStyle } from "./types.ts"

export type TimelineGrid = DiagramCanvas<TimelineCellStyle>

export function renderTimelineGridText(grid: TimelineGrid): string {
  return grid.toString({ trimBottom: true })
}

export function renderTimelineGridStyledText(grid: TimelineGrid, colors: TimelineStyleColors): StyledText {
  return renderDiagramGridStyledText(grid, (run) => (run.style ? colors[run.style] : undefined), undefined, {
    trimBottom: true,
  })
}
