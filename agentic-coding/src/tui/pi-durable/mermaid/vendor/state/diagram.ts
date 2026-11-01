import { drawStateDiagramGrid } from "./drawing.ts"
import { parseMermaidStateDiagram } from "./parser.ts"
import { renderStateGridText } from "./render-grid.ts"
import type { StateDiagramRenderOptions } from "./types.ts"

export function renderStateDiagram(content: string, options: StateDiagramRenderOptions = {}): string {
  return renderStateGridText(drawStateDiagramGrid(parseMermaidStateDiagram(content), options))
}
