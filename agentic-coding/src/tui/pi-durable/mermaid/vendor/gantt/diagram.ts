import { drawGanttDiagramGrid } from "./drawing.ts"
import { parseMermaidGanttDiagram } from "./parser.ts"
import { renderGanttGridText } from "./render-grid.ts"
import type { GanttDiagramRenderOptions } from "./types.ts"

export function renderGanttDiagram(content: string, options: GanttDiagramRenderOptions = {}): string {
  return renderGanttGridText(drawGanttDiagramGrid(parseMermaidGanttDiagram(content), options))
}
