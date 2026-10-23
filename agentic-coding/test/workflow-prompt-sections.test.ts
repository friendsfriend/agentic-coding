// slim-agent-prompts: the managed workflow protocol is one pinned asset made of
// a core and optional sections, and each role's first assignment carries the
// core plus only the sections its step declares for it.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Assignment } from "../src/contracts/workflow.ts";
import { renderAssignment } from "../src/workflow/assignment.ts";
import { registerBuiltins } from "../src/workflow/definitions/registerBuiltins.ts";
import { AGENT_DEFINITIONS } from "../src/workflow/embedded.generated.ts";
import {
	PROTOCOL_SECTION_IDS,
	type ProtocolSectionId,
	parseProtocol,
	selectProtocol,
} from "../src/workflow/prompt-sections.ts";
import { renderAgentQuestionMessage } from "../src/workflow/runtime/dialogue.ts";
import { VERIFIER_ROLES } from "../src/workflow/steps/verification.ts";

const PROTOCOL =
	AGENT_DEFINITIONS["instructions/workflow-agent-protocol.md"] ?? "";
const registry = registerBuiltins();

const HEADING: Readonly<Record<ProtocolSectionId, string>> = {
	environment: "## Environment tools\n",
	browser: "## Browser tools\n",
	"debug-tools": "## Debug tools\n",
	"delegated-debug": "## Delegated debug requests\n",
	"file-signals": "## File signals\n",
	jev: "## Asking Jev\n",
};

function prompt(
	stepId: string,
	role: string,
	overrides: Partial<Assignment> = {},
): string {
	return renderAssignment(registry.step(stepId), {
		protocolVersion: 1,
		workflowId: "workflow",
		runId: `run-${role}`,
		generation: 1,
		stepId,
		role,
		objective: "Do the assigned work.",
		interaction: "silent",
		inputs: [],
		permissions: ["read"],
		checks: [],
		allowedOutcomes: ["complete", "blocked", "failed"],
		environment: {
			AGENTIC_ENV_URL: "http://127.0.0.1:1",
		} as unknown as Assignment["environment"],
		...overrides,
	}).prompt;
}

function sectionsIn(text: string): ProtocolSectionId[] {
	return PROTOCOL_SECTION_IDS.filter((id) => text.includes(HEADING[id]));
}

describe("protocol parser", () => {
	test("the shipped file holds exactly the closed set of sections", () => {
		const parsed = parseProtocol(PROTOCOL);
		expect(parsed.sections.map((section) => section.id).sort()).toEqual(
			[...PROTOCOL_SECTION_IDS].sort(),
		);
		for (const section of parsed.sections) {
			expect(section.text.startsWith("## ")).toBe(true);
			expect(section.text.split("\n").length).toBeLessThanOrEqual(5);
		}
	});

	test("an unknown or repeated marker id fails", () => {
		expect(() =>
			parseProtocol("core\n\n<!-- protocol-section: nope -->\n## X"),
		).toThrow("unknown protocol section id");
		expect(() =>
			parseProtocol(
				"core\n<!-- protocol-section: jev -->\n## A\n<!-- protocol-section: jev -->\n## B",
			),
		).toThrow("duplicate protocol section id");
	});

	test("markers never reach a rendered prompt", () => {
		expect(selectProtocol(PROTOCOL, undefined)).not.toContain(
			"protocol-section",
		);
		for (const [stepId, role] of [
			["core.implementation", "worker"],
			["stage.execute", "stage-tester"],
		] as const)
			expect(prompt(stepId, role)).not.toContain("protocol-section");
	});

	test("the pinned digest covers the whole file, whatever a role receives", () => {
		const step = registry.step("stage.execute");
		const index = step.instructionAssets.indexOf("workflow-agent-protocol.md");
		expect(step.instructionDigests[index]).toBe(
			createHash("sha256").update(PROTOCOL).digest("hex"),
		);
	});

	test("selection keeps file order and the core", () => {
		const text = selectProtocol(PROTOCOL, ["jev", "environment"]);
		expect(text).toContain("# Managed workflow protocol");
		expect(text.indexOf(HEADING.environment)).toBeLessThan(
			text.indexOf(HEADING.jev),
		);
		expect(sectionsIn(text)).toEqual(["environment", "jev"]);
	});
});

describe("per-role section selection", () => {
	const none: ProtocolSectionId[] = [];
	const review: ProtocolSectionId[] = [
		"delegated-debug",
		"file-signals",
		"jev",
	];
	const table: Array<[string, string, ProtocolSectionId[]]> = [
		["core.plan", "planner", ["jev"]],
		["fusion.plan", "planner-2", ["jev"]],
		["fusion.consolidate", "consolidator", ["jev"]],
		[
			"core.implementation",
			"worker",
			["environment", "browser", "debug-tools", "delegated-debug"],
		],
		["core.rebase", "worker", none],
		["core.triage", "triage", ["file-signals", "jev"]],
		[
			"core.verification",
			"test-verifier",
			["environment", "debug-tools", ...review],
		],
		[
			"core.verification",
			"performance-verifier",
			["environment", "debug-tools", ...review],
		],
		[
			"core.verification",
			"usability-verifier",
			["environment", "browser", ...review],
		],
		["core.verification", "quality-verifier", review],
		["core.verification", "security-verifier", review],
		["core.verification", "openspec-verifier", review],
		["core.verification", "concurrency-verifier", review],
		["core.verification", "migration-verifier", review],
		["core.verification", "test-quality-verifier", review],
		["core.archive", "archive", none],
		["core.research", "researcher", none],
		["core.wiki", "wiki", ["jev"]],
		["core.wiki", "research-wiki", ["jev"]],
		["core.wiki", "stage-wiki", none],
		["debug.investigate", "debug", ["environment", "browser", "debug-tools"]],
		["setup.author", "env-setup", ["environment", "browser", "debug-tools"]],
		["stage.plan", "stage-planner", none],
		["stage.execute", "stage-tester", none],
	];

	for (const [stepId, role, expected] of table)
		test(`${stepId} ${role} receives ${expected.join(", ") || "the core only"}`, () => {
			const text = prompt(stepId, role);
			expect(sectionsIn(text)).toEqual(
				PROTOCOL_SECTION_IDS.filter((id) => expected.includes(id)),
			);
		});

	test("every verifier role of the catalog is in the table", () => {
		for (const role of VERIFIER_ROLES)
			expect(table.some(([, name]) => name === role)).toBe(true);
	});

	test("a step without a declaration receives every section", () => {
		const step = { ...registry.step("core.rebase"), behavior: {} };
		const text = renderAssignment(step, {
			protocolVersion: 1,
			workflowId: "workflow",
			runId: "run-x",
			generation: 1,
			stepId: "core.rebase",
			role: "worker",
			objective: "Do the assigned work.",
			interaction: "silent",
			inputs: [],
			permissions: [],
			checks: [],
			allowedOutcomes: ["complete", "blocked", "failed"],
			environment: {} as Assignment["environment"],
		}).prompt;
		expect(sectionsIn(text)).toEqual([...PROTOCOL_SECTION_IDS]);
	});

	test("the debug role cannot delegate, a stage tester gets no generic tool guidance", () => {
		expect(prompt("debug.investigate", "debug")).not.toContain("debug_request");
		const tester = prompt("stage.execute", "stage-tester");
		for (const id of PROTOCOL_SECTION_IDS)
			expect(tester).not.toContain(HEADING[id]);
	});

	test("core rules survive every selection", () => {
		for (const [stepId, role] of table) {
			const text = prompt(stepId, role);
			expect(text).toContain("Write only the declared output artifact");
			expect(text).toContain(
				"exactly one allowed outcome through `agentic-coding workflow handoff`",
			);
			expect(text).toContain("hand off `blocked`");
			expect(text).toContain("do not guess");
			expect(text).toContain("untrusted context");
			expect(text).toContain("Never work around a redaction");
			expect(text).toContain("Never start agents or mutate workflow state");
		}
	});
});

describe("guidance travels with the block it governs", () => {
	test("each interaction mode states its meaning beside the mode", () => {
		expect(prompt("core.plan", "planner")).toContain(
			"Interaction: silent\nReport through the artifact and the handoff; no chat summary.",
		);
		expect(
			prompt("core.plan", "planner", { interaction: "developer-dialogue" }),
		).toContain(
			"Interaction: developer-dialogue\nVisible discussion is allowed; prefer `developer_question`",
		);
	});

	test("a peer question is not a new assignment and not a reason to hand off", () => {
		const message = renderAgentQuestionMessage(
			{
				id: "q1",
				role: "worker",
				description: "which?",
				context: undefined,
				options: [],
			},
			"nonce",
		);
		expect(message).toContain("not a new assignment");
		expect(message).toContain("never a reason to hand off");
		expect(message).toContain(
			"agentic-coding workflow answer --question-id q1 --nonce nonce",
		);
	});
});

describe("stage briefs keep their semantics", () => {
	const planner = prompt("stage.plan", "stage-planner");
	const tester = prompt("stage.execute", "stage-tester");

	test("the planner chooses the complete data set and lists chosen defaults", () => {
		expect(planner).toContain("`chosen defaults`");
		expect(planner).toContain("Do not ask for, and do not block on");
		expect(planner).toContain("plan to tick them and to note it as a finding");
		expect(planner).toContain('the "not known yet" option');
	});

	test("the tester fills plain test input, ticks required confirmations and tries other options", () => {
		expect(tester).toContain("choose small, consistent counts");
		expect(tester).toContain("Record chosen defaults");
		expect(tester).toContain("tick only those needed to proceed");
		expect(tester).toContain("note them as findings");
		expect(tester).toContain("Try offered alternatives");
		expect(tester).toContain(
			"A blocked verdict must explain the attempted paths",
		);
		expect(tester).toContain(
			"Never invent real credentials, real people's personal data",
		);
	});

	test("the tester keeps the state-change, prefix, secrecy and stage-binding rules", () => {
		expect(tester).toContain("This is a test stage");
		expect(tester).toContain("apply its configured prefix");
		expect(tester).toContain("Do not expose credentials");
		expect(tester).toContain(
			"Raw URLs, other origins and apps the stage does not declare are refused",
		);
		expect(tester).toContain("`browser_open({stage:");
		expect(tester).toContain("`core.stage-report@1`");
	});
});
