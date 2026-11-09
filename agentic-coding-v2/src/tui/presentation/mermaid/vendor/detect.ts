import type { MermaidDiagramKind } from "./diagnostics.ts"
import { isMermaidFlowchartDiagram } from "./flowchart/parser.ts"
import { isMermaidGanttDiagram } from "./gantt/parser.ts"
import { isMermaidGitGraphDiagram } from "./gitgraph/parser.ts"
import { isMermaidSequenceDiagram } from "./sequence/parser.ts"
import { isMermaidStateDiagram } from "./state/parser.ts"
import { isMermaidTimelineDiagram } from "./timeline/parser.ts"

export function detectMermaidDiagram(content: string): MermaidDiagramKind | undefined {
  if (isMermaidFlowchartDiagram(content)) return "flowchart"
  if (isMermaidGanttDiagram(content)) return "gantt"
  if (isMermaidGitGraphDiagram(content)) return "gitGraph"
  if (isMermaidSequenceDiagram(content)) return "sequence"
  if (isMermaidStateDiagram(content)) return "state"
  if (isMermaidTimelineDiagram(content)) return "timeline"
  return undefined
}
