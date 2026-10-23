import { expect, test } from "bun:test";
import type { StageDataBlockDocument } from "../src/stage-blocks/data-block.ts";
import type { StageTestReport } from "../src/workflow/definitions/contracts.ts";
import { stageReportMarkdown } from "../src/workflow/effect-runner.ts";

test("untrusted report values stay on one escaped Markdown line", () => {
	const report = {
		applicationVersions: [],
		expectations: [
			{
				id: "expectation",
				verdict: "pass",
				statement: "A finding\n## forged\n- [approve](url)",
				expected: "expected",
				observed: "observed",
				stepIds: [],
				evidenceIds: [],
			},
		],
		blocksUsed: [],
		blocksCreated: [],
		blocksAdjusted: [
			{ block: "example.block", version: "1.0.0", digest: "digest" },
		],
		createdData: [
			{
				description: "Created data\n## forged data",
				cleanupHint: "remove [record](target)",
			},
		],
		knowledgeObservations: [
			{
				kind: "new",
				concept: "process\n## forged",
				statement:
					"Business fact\n## forged statement\n[approve](statement-url)",
				observed: "Observed\n## forged observation\n[approve](observed-url)",
			},
		],
		notTested: [
			{ expectationId: "not-tested", reason: "Not tested\n## forged reason" },
		],
	} as unknown as StageTestReport;
	const journal = [
		{
			seq: 1,
			app: "stage",
			label: "submit\n## forged journal",
			expected: "accepted",
			observed: "blocked",
			role: "operator",
		},
	] as never;
	const evidence = [
		{
			id: "evidence-1",
			kind: "screenshot",
			caption: "Evidence\n## forged evidence",
			file: "image.png",
		},
	] as never;
	const approved = {
		id: "example.block",
		version: "1.0.0",
		app: "web",
		title: "Example",
		description: "Example block",
		effects: ["read"],
		idempotent: true,
		params: {},
		returns: {},
		examples: [],
		postcondition: "Page is visible",
		operations: [
			{
				op: "step",
				label: "before\n## forged operation",
				operations: [{ op: "capture", label: "before" }],
			},
		],
	} as unknown as StageDataBlockDocument;
	const draft = {
		...approved,
		operations: [
			{
				op: "step",
				label: "after",
				operations: [{ op: "capture", label: "capture\n## forged action" }],
			},
		],
	} as StageDataBlockDocument;
	const markdown = stageReportMarkdown(
		"grid-int",
		undefined,
		{ environment: "test", system: "grid-allocation", access: "read-only" },
		report,
		journal,
		evidence,
		"2025-01-01T00:00:00.000Z",
		{
			drafts: [{ document: draft, proofs: [] }],
			approved: [approved],
		},
	);
	expect(markdown).toContain(
		"A finding \\#\\# forged - \\[approve\\]\\(url\\)",
	);
	expect(markdown).toContain("process \\#\\# forged");
	expect(markdown).toContain(
		"Business fact \\#\\# forged statement \\[approve\\]\\(statement-url\\)",
	);
	expect(markdown).toContain(
		"Observed \\#\\# forged observation \\[approve\\]\\(observed-url\\)",
	);
	expect(markdown).toContain("submit \\#\\# forged journal");
	expect(markdown).toContain("Evidence \\#\\# forged evidence");
	expect(markdown).toContain("Created data \\#\\# forged data");
	expect(markdown).toContain("Not tested \\#\\# forged reason");
	expect(markdown).toContain("before \\#\\# forged operation");
	expect(markdown).toContain("capture capture \\#\\# forged action");
	expect(markdown).not.toContain("\n## forged");
});
