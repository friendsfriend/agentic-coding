import { drawSequenceDiagramGrid } from "./drawing.ts"
import { parseMermaidSequenceDiagram } from "./parser.ts"
import { renderSequenceGridText } from "./render-grid.ts"
import type { SequenceDiagramRenderOptions } from "./types.ts"

export function renderSequenceDiagram(content: string, options: SequenceDiagramRenderOptions = {}): string {
  return renderSequenceGridText(drawSequenceDiagramGrid(parseMermaidSequenceDiagram(content), options))
}
