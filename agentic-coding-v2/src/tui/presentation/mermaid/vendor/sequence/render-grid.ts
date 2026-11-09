import type { StyledText } from "@opentui/core"
import type { DiagramCanvas } from "../core/canvas.ts"
import { renderDiagramGridStyledText } from "../core/render-grid.ts"
import { sequenceStyleBackgroundColor, sequenceStyleColor, type SequenceStyleColors } from "./style.ts"
import type { SequenceCellStyle } from "./types.ts"

export type SequenceGrid = DiagramCanvas<SequenceCellStyle>

export function renderSequenceGridText(grid: SequenceGrid): string {
  return grid.toString()
}

export function renderSequenceGridStyledText(
  grid: SequenceGrid,
  colors: Parameters<typeof sequenceStyleColor>[1],
): StyledText {
  return renderDiagramGridStyledText(
    grid,
    (run) => sequenceStyleColor(run.style, colors),
    (run) => sequenceStyleBackgroundColor(run.style, colors as Required<SequenceStyleColors>),
  )
}
