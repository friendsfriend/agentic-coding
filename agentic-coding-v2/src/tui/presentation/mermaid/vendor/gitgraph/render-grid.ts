import type { StyledText } from "@opentui/core"
import type { DiagramCanvas } from "../core/canvas.ts"
import { renderDiagramGridStyledText } from "../core/render-grid.ts"
import type { GitGraphStyleColors } from "./style.ts"
import type { GitGraphCellStyle } from "./types.ts"

export type GitGraphGrid = DiagramCanvas<GitGraphCellStyle>

export function renderGitGraphGridText(grid: GitGraphGrid): string {
  return grid.toString({ trimBottom: true })
}

export function renderGitGraphGridStyledText(grid: GitGraphGrid, colors: GitGraphStyleColors): StyledText {
  return renderDiagramGridStyledText(grid, (run) => (run.style ? colors[run.style] : undefined), undefined, {
    trimBottom: true,
  })
}
