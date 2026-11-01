import { drawFlowchartDiagramGrid } from "./drawing.ts"
import type { FlowchartDiagramRenderOptions } from "./options.ts"
import { parseMermaidFlowchartDiagram } from "./parser.ts"

export function renderFlowchartDiagram(content: string, options: FlowchartDiagramRenderOptions = {}): string {
  return drawFlowchartDiagramGrid(parseMermaidFlowchartDiagram(content), options).toString({
    trimTop: true,
    trimBottom: true,
  })
}
