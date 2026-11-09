import { expect, test } from "bun:test";
import { detectMermaidDiagram } from "../src/tui/presentation/mermaid/vendor/detect.ts";
import { drawFlowchartDiagramGrid } from "../src/tui/presentation/mermaid/vendor/flowchart/drawing.ts";
import { parseMermaidFlowchartDiagram } from "../src/tui/presentation/mermaid/vendor/flowchart/parser.ts";
import { drawGanttDiagramGrid } from "../src/tui/presentation/mermaid/vendor/gantt/drawing.ts";
import { parseMermaidGanttDiagram } from "../src/tui/presentation/mermaid/vendor/gantt/parser.ts";
import { drawGitGraphDiagramGrid } from "../src/tui/presentation/mermaid/vendor/gitgraph/drawing.ts";
import { parseMermaidGitGraphDiagram } from "../src/tui/presentation/mermaid/vendor/gitgraph/parser.ts";
import { drawSequenceDiagramGrid } from "../src/tui/presentation/mermaid/vendor/sequence/drawing.ts";
import { parseMermaidSequenceDiagram } from "../src/tui/presentation/mermaid/vendor/sequence/parser.ts";
import { drawStateDiagramGrid } from "../src/tui/presentation/mermaid/vendor/state/drawing.ts";
import { parseMermaidStateDiagram } from "../src/tui/presentation/mermaid/vendor/state/parser.ts";
import { drawTimelineDiagramGrid } from "../src/tui/presentation/mermaid/vendor/timeline/drawing.ts";
import { parseMermaidTimelineDiagram } from "../src/tui/presentation/mermaid/vendor/timeline/parser.ts";

// Pure vendored parser/layout checks in this runtime: the local presentation
// binding is a palette and a Markdown code-block hook, so it stays untested
// here. No renderable, mounting, snapshot or terminal acceptance is implied.

const size = (grid: {
	getTextSize: (options?: object) => { width: number; height: number };
}) => grid.getTextSize({ trimTop: true, trimBottom: true });

test("vendored Mermaid detection keeps each supported family distinct and leaves EOF and empty source unrendered", () => {
	const families = {
		flowchart: "flowchart TD\n  A[Start] --> B[Done]",
		sequence: "sequenceDiagram\n  Alice->>Bob: Hello",
		state: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Done",
		timeline: "timeline\n  title Release\n  2024 : First",
		gantt: "gantt\n  title Plan\n  section Build\n  Task :a1, 2024-01-01, 3d",
		gitGraph: 'gitGraph\n  commit id: "one"',
	} as const;
	for (const kind of Object.keys(families))
		expect(detectMermaidDiagram(families[kind as keyof typeof families])).toBe(
			kind as ReturnType<typeof detectMermaidDiagram>,
		);
	// Everything else stays readable ordinary source rather than a guessed diagram.
	for (const source of [
		"",
		"   ",
		"graph TD but not a keyword",
		"flowchart TD",
	])
		expect(detectMermaidDiagram(source)).not.toBe("sequence");
	expect(detectMermaidDiagram("")).toBeUndefined();
});

test("vendored Mermaid parsers and layouts produce bounded grids without executing or resolving supplied content", () => {
	const flowchart = size(
		drawFlowchartDiagramGrid(
			parseMermaidFlowchartDiagram(
				'flowchart LR\n  A["Start 😀e\\u0301"] --> B[End]',
			),
			{ compact: true, layoutMaxWidth: 40 },
		),
	);
	expect(flowchart.width).toBeGreaterThan(0);
	expect(flowchart.height).toBeGreaterThan(0);
	const sequence = size(
		drawSequenceDiagramGrid(
			parseMermaidSequenceDiagram(
				"sequenceDiagram\n  participant A as Alice\n  A->>A: local note",
			),
			{ compact: true },
		),
	);
	expect(sequence.height).toBeGreaterThan(0);
	const state = size(
		drawStateDiagramGrid(
			parseMermaidStateDiagram(
				"stateDiagram-v2\n  [*] --> Idle\n  Idle --> [*]",
			),
			{ layoutMaxWidth: 40 },
		),
	);
	expect(state.height).toBeGreaterThan(0);
	const timeline = size(
		drawTimelineDiagramGrid(
			parseMermaidTimelineDiagram(
				"timeline\n  title Release\n  2024 : First : Second",
			),
		),
	);
	expect(timeline.height).toBeGreaterThan(0);
	const gantt = size(
		drawGanttDiagramGrid(
			parseMermaidGanttDiagram(
				"gantt\n  title Plan\n  section Build\n  Compile :a1, 2024-01-01, 3d",
			),
			{ layoutMaxWidth: 60 },
		),
	);
	expect(gantt.height).toBeGreaterThan(0);
	const gitGraph = size(
		drawGitGraphDiagramGrid(
			parseMermaidGitGraphDiagram(
				'gitGraph\n  commit id: "one"\n  branch side\n  commit',
			),
		),
	);
	expect(gitGraph.height).toBeGreaterThan(0);
});
