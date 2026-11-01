import { drawTimelineDiagramGrid } from "./drawing.ts"
import { parseMermaidTimelineDiagram } from "./parser.ts"
import { renderTimelineGridText } from "./render-grid.ts"
import type { TimelineDiagramRenderOptions } from "./types.ts"

export function renderTimelineDiagram(content: string, options: TimelineDiagramRenderOptions = {}): string {
  return renderTimelineGridText(drawTimelineDiagramGrid(parseMermaidTimelineDiagram(content), options))
}
