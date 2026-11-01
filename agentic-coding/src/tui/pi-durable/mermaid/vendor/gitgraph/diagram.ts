import { drawGitGraphDiagramGrid } from "./drawing.ts"
import { parseMermaidGitGraphDiagram } from "./parser.ts"
import { renderGitGraphGridText } from "./render-grid.ts"
import type { GitGraphDiagramRenderOptions } from "./types.ts"

export function renderGitGraphDiagram(content: string, options: GitGraphDiagramRenderOptions = {}): string {
  return renderGitGraphGridText(drawGitGraphDiagramGrid(parseMermaidGitGraphDiagram(content), options))
}
