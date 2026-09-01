import { createHash } from "node:crypto";
import path from "node:path";
import type {
	AdapterCapability,
	Contract,
	EffectKind,
	JsonValue,
	WorkflowSnapshot,
} from "./contracts.ts";
import { ContractFailure, validation } from "./contracts.ts";
import { AGENT_DEFINITIONS } from "./embedded.generated.ts";
import {
	type Reduction,
	type StepDefinition,
	type WorkflowManifest,
	WorkflowRegistry,
} from "./registry.ts";

const EFFECTS: EffectKind[] = [
	"workspace.setup",
	"artifact.write",
	"agent.launch",
	"agent.prompt",
	"agent.stop",
	"notification.show",
	"openspec.validate",
	"wiki.verify",
	"delivery.commit",
	"delivery.push",
	"pull-request.create",
	"workspace.close",
	"workspace.cleanup",
];
const CAPABILITIES: AdapterCapability[] = [
	"interactive",
	"prompt",
	"persistent-session",
	"run-environment",
	"observe",
	"read-only",
	"shell",
	"edit",
	"runtime-bridge",
];

export type WorkflowCatalogEntry = Readonly<{
	id: string;
	label: string;
	description: string;
	alias?: string;
}>;

export const PUBLIC_WORKFLOW_CATALOG: readonly WorkflowCatalogEntry[] =
	Object.freeze([
		Object.freeze({
			id: "openspec-full",
			label: "Openspec",
			description:
				"Standard openspec flow with explore, propose, plan review, apply, verify, developer review, wiki, wiki review, archive phases",
		}),
		Object.freeze({
			id: "openspec-apply",
			label: "Openspec apply",
			description:
				"Openspec flow with reduced apply, verify, developer-review, wiki, wiki-review, archive phases",
		}),
		Object.freeze({
			id: "no-openspec",
			label: "No OpenSpec",
			description:
				"Workflow for repositories without openspec. Has apply, review, developer-review, wiki, wiki-review phases.",
			alias: "quick",
		}),
		Object.freeze({
			id: "openspec-fusion-full",
			label: "Openspec fusion",
			description:
				"Openspec fusion flow that spawns multiple explorers that consolidate to one plan. Has fusion-plan, fusion-consolidate, plan review, apply, verify, developer review, wiki, wiki-review, archive phases",
		}),
		Object.freeze({
			id: "openspec-propose",
			label: "Openspec Propose Only",
			description:
				"Openspec flow with reduced explore, propose, plan review phases",
		}),
		Object.freeze({
			id: "openspec-fusion-propose",
			label: "Openspec fusion propose",
			description:
				"Openspec fusion workflow with reduced fusion plan, fusion consolidate, plan review phases",
		}),
		Object.freeze({
			id: "wiki",
			label: "Wiki",
			description: "Wiki workflow used for interacting with the wiki",
		}),
		Object.freeze({
			id: "research",
			label: "Research",
			description: "Research with research, wiki, wiki review phases",
		}),
	] as const);

const passthrough: Contract<JsonValue> = {
	id: "core.json",
	version: 1,
	parse(value) {
		if (value === undefined) return null;
		try {
			return JSON.parse(JSON.stringify(value)) as JsonValue;
		} catch {
			throw new ContractFailure("core.json", [
				{ path: "$", message: "not JSON serializable" },
			]);
		}
	},
};
const empty: Contract<null> = {
	id: "core.empty",
	version: 1,
	parse(value) {
		if (value !== undefined && value !== null)
			throw new ContractFailure("core.empty", [
				{ path: "$", message: "expected empty output" },
			]);
		return null;
	},
};
const findings: Contract<{ critical: number }> = {
	id: "core.findings",
	version: 1,
	parse(value) {
		const item = validation.object(value, "$");
		if (!Array.isArray(item.findings))
			throw new ContractFailure("core.findings", [
				{ path: "$.findings", message: "expected findings array" },
			]);
		const ids = new Set<string>();
		let critical = 0;
		item.findings.forEach((value, index) => {
			const finding = validation.object(value, `$.findings[${index}]`);
			const id = validation.text(finding.id, `$.findings[${index}].id`);
			if (ids.has(id))
				throw new ContractFailure("core.findings", [
					{ path: `$.findings[${index}].id`, message: "duplicate stable ID" },
				]);
			ids.add(id);
			const severity = validation.enumValue(
				finding.severity,
				`$.findings[${index}].severity`,
				["critical", "warning", "info"],
			);
			validation.text(finding.detail, `$.findings[${index}].detail`);
			validation.text(finding.path, `$.findings[${index}].path`);
			validation.integer(finding.line, `$.findings[${index}].line`, 1);
			if (severity === "critical") critical++;
		});
		return { critical };
	},
};
export interface ResearchHandoff {
	subject: string;
	canonicalTarget?: string;
	findings: string;
	citations: string[];
	noSourcesUsed: boolean;
}
const MAX_RESEARCH_HANDOFF_CITATIONS = 32;
const MAX_RESEARCH_HANDOFF_BYTES = 48 * 1024;
export const researchHandoffContract: Contract<ResearchHandoff> = {
	id: "core.research-handoff",
	version: 1,
	parse(value) {
		const item = validation.object(value, "$");
		const subject = validation.text(item.subject, "$.subject", 512);
		const canonicalTarget =
			item.canonicalTarget === undefined || item.canonicalTarget === null
				? undefined
				: validation.text(item.canonicalTarget, "$.canonicalTarget", 512);
		const findingsSummary = validation.text(item.findings, "$.findings", 16384);
		const noSourcesUsed = item.noSourcesUsed === true;
		if (
			item.citations !== undefined &&
			(!Array.isArray(item.citations) ||
				item.citations.length > MAX_RESEARCH_HANDOFF_CITATIONS)
		)
			throw new ContractFailure("core.research-handoff", [
				{
					path: "$.citations",
					message: `expected at most ${MAX_RESEARCH_HANDOFF_CITATIONS} source citations`,
				},
			]);
		const citations = Array.isArray(item.citations)
			? item.citations.map((entry, index) =>
					validation.text(entry, `$.citations[${index}]`, 1024),
				)
			: [];
		if (!noSourcesUsed && !citations.length)
			throw new ContractFailure("core.research-handoff", [
				{
					path: "$.citations",
					message:
						"expected at least one source citation, or noSourcesUsed set to true",
				},
			]);
		const parsed: ResearchHandoff = {
			subject,
			...(canonicalTarget === undefined ? {} : { canonicalTarget }),
			findings: findingsSummary,
			citations,
			noSourcesUsed,
		};
		if (
			Buffer.byteLength(JSON.stringify(parsed), "utf8") >
			MAX_RESEARCH_HANDOFF_BYTES
		)
			throw new ContractFailure("core.research-handoff", [
				{
					path: "$",
					message: `handoff exceeds ${MAX_RESEARCH_HANDOFF_BYTES} bytes serialized`,
				},
			]);
		return parsed;
	},
};
const triage: Contract<{
	roles: string[];
	assignments: Array<{ role: string; reason: string; files: string[] }>;
}> = {
	id: "core.triage-plan",
	version: 1,
	parse(value) {
		const item = validation.object(value, "$");
		if (!Array.isArray(item.roles))
			throw new ContractFailure("core.triage-plan", [
				{ path: "$.roles", message: "expected role assignment array" },
			]);
		const roles = item.roles.map((value, index) => {
			const entry = validation.object(value, `$.roles[${index}]`);
			const role = validation.text(entry.role, `$.roles[${index}].role`);
			validation.text(entry.reason, `$.roles[${index}].reason`);
			const files = validation.strings(entry.files, `$.roles[${index}].files`);
			if (
				!files.length ||
				files.some(
					(file) =>
						path.isAbsolute(file) || file.split(path.sep).includes(".."),
				)
			)
				throw new ContractFailure("core.triage-plan", [
					{
						path: `$.roles[${index}].files`,
						message: "expected scoped repository-relative files",
					},
				]);
			if (entry.hunks !== undefined) {
				const hunks = validation.object(entry.hunks, `$.roles[${index}].hunks`);
				for (const [file, ids] of Object.entries(hunks))
					if (
						!files.includes(file) ||
						!Array.isArray(ids) ||
						ids.some(
							(id) => !Number.isInteger(id) || Number(id) < 1 || Number(id) > 8,
						)
					)
						throw new ContractFailure("core.triage-plan", [
							{
								path: `$.roles[${index}].hunks`,
								message: "invalid scoped hunk IDs",
							},
						]);
			}
			return { role, reason: String(entry.reason), files };
		});
		const roleNames = roles.map((item) => item.role);
		if (new Set(roleNames).size !== roleNames.length)
			throw new ContractFailure("core.triage-plan", [
				{ path: "$.roles", message: "duplicate role" },
			]);
		return { roles: roleNames, assignments: roles };
	},
};
const planDraft: Contract<{
	approach: string;
	files: Array<{ path: string; change: string }>;
	risks: Array<{ detail: string }>;
	questions: Array<{ detail: string }>;
}> = {
	id: "core.plan-draft",
	version: 1,
	parse(value) {
		const item = validation.object(value, "$");
		const approach = validation.text(item.approach, "$.approach", 8192);
		if (!Array.isArray(item.files))
			throw new ContractFailure("core.plan-draft", [
				{ path: "$.files", message: "expected file plan array" },
			]);
		if (!item.files.length)
			throw new ContractFailure("core.plan-draft", [
				{ path: "$.files", message: "expected at least one planned file" },
			]);
		const files = item.files.map((entry, index) => {
			const file = validation.object(entry, `$.files[${index}]`);
			const filePath = validation.text(
				file.path,
				`$.files[${index}].path`,
				1024,
			);
			validation.text(file.change, `$.files[${index}].change`, 4096);
			if (path.isAbsolute(filePath) || filePath.split(path.sep).includes(".."))
				throw new ContractFailure("core.plan-draft", [
					{
						path: `$.files[${index}].path`,
						message: "expected repository-relative file path",
					},
				]);
			return { path: filePath, change: String(file.change) };
		});
		const section = (field: "risks" | "questions") => {
			if (!Array.isArray(item[field]))
				throw new ContractFailure("core.plan-draft", [
					{ path: `$.${field}`, message: `expected ${field} array` },
				]);
			return item[field].map((entry, index) => {
				const detail = validation.object(entry, `$.${field}[${index}]`);
				return {
					detail: validation.text(
						detail.detail,
						`$.${field}[${index}].detail`,
						4096,
					),
				};
			});
		};
		return {
			approach,
			files,
			risks: section("risks"),
			questions: section("questions"),
		};
	},
};
function unchanged(snapshot: WorkflowSnapshot): Reduction {
	return { snapshot: structuredClone(snapshot), effects: [] };
}

const INSTRUCTION_BY_STEP: Record<string, string[]> = {
	"core.plan": ["workflow-agent-protocol.md", "planning.md"],
	"core.implementation": ["workflow-agent-protocol.md", "implementation.md"],
	"core.triage": ["workflow-agent-protocol.md", "triage.md"],
	"core.verification": [
		"workflow-agent-protocol.md",
		"verification.md",
		"verification-security.md",
		"verification-quality.md",
		"verification-performance.md",
		"verification-openspec.md",
		"verification-usability.md",
		"verification-test.md",
	],
	"core.wiki": ["workflow-agent-protocol.md", "wiki.md"],
	"core.research": ["workflow-agent-protocol.md", "research.md"],
	"core.archive": ["workflow-agent-protocol.md", "archive.md"],
	"fusion.plan": ["workflow-agent-protocol.md", "planning-fusion.md"],
	"fusion.consolidate": [
		"workflow-agent-protocol.md",
		"fusion-consolidation.md",
	],
};
function instructionDigest(name: string): string {
	const content = AGENT_DEFINITIONS[`instructions/${name}`];
	if (content === undefined)
		throw new Error(`missing instruction asset: ${name}`);
	return createHash("sha256").update(content).digest("hex");
}
function step(
	id: string,
	label: string,
	actor: "agent" | "developer" | "system",
	outcomes: string[],
	options: Partial<
		Pick<
			StepDefinition,
			"requirements" | "allowedEffects" | "retryLimit" | "output"
		>
	> = {},
): StepDefinition {
	const assets = INSTRUCTION_BY_STEP[id] ?? [];
	return {
		id,
		version: 1,
		label,
		actor,
		instructionAssets: assets,
		instructionDigests: assets.map(instructionDigest),
		requirements:
			options.requirements ??
			(actor === "agent" ? ["prompt", "run-environment", "observe"] : []),
		input: passthrough,
		output: options.output ?? (actor === "agent" ? passthrough : empty),
		outcomes,
		retryLimit: options.retryLimit,
		allowedEffects:
			options.allowedEffects ??
			(actor === "agent"
				? ["artifact.write", "agent.launch", "agent.prompt", "agent.stop"]
				: []),
		enter: unchanged,
		reduce(snapshot, command) {
			if (!outcomes.includes(command.outcome))
				throw new Error(`illegal ${id} outcome: ${command.outcome}`);
			return unchanged(snapshot);
		},
	};
}

export function registerBuiltins(
	registry = new WorkflowRegistry(EFFECTS, CAPABILITIES),
	maxVerificationRounds = 6,
): WorkflowRegistry {
	if (
		!Number.isInteger(maxVerificationRounds) ||
		maxVerificationRounds < 1 ||
		maxVerificationRounds > 20
	)
		throw new Error("max_verification_rounds must be an integer from 1 to 20");
	const catalog: StepDefinition[] = [
		step("core.plan", "Planning", "agent", ["complete", "blocked", "failed"], {
			retryLimit: 3,
			allowedEffects: [
				"artifact.write",
				"agent.launch",
				"agent.prompt",
				"agent.stop",
				"openspec.validate",
				"notification.show",
			],
		}),
		step(
			"fusion.plan",
			"Fusion planning",
			"agent",
			["complete", "blocked", "failed"],
			{
				output: planDraft,
				retryLimit: 3,
				allowedEffects: [
					"artifact.write",
					"agent.launch",
					"agent.prompt",
					"agent.stop",
					"openspec.validate",
					"notification.show",
				],
			},
		),
		step(
			"fusion.consolidate",
			"Plan fusion",
			"agent",
			["complete", "blocked", "failed"],
			{
				retryLimit: 3,
				allowedEffects: [
					"artifact.write",
					"agent.launch",
					"agent.prompt",
					"agent.stop",
					"openspec.validate",
					"notification.show",
				],
			},
		),
		step("core.plan-approval", "Plan approval", "developer", [
			"approve",
			"reject",
			"comments",
		]),
		step(
			"core.implementation",
			"Implementation",
			"agent",
			["complete", "blocked", "failed"],
			{ retryLimit: 6 },
		),
		step(
			"core.triage",
			"Verification triage",
			"agent",
			["complete", "blocked", "failed"],
			{ output: triage, retryLimit: 3 },
		),
		step(
			"core.verification",
			"Verification",
			"agent",
			["pass", "fix", "limit", "blocked", "failed"],
			{
				requirements: ["prompt", "run-environment", "observe", "read-only"],
				output: findings,
				retryLimit: 20,
			},
		),
		step("core.developer-review", "Developer review", "developer", [
			"approve",
			"comments",
		]),
		step(
			"core.wiki",
			"Wiki documentation",
			"agent",
			["complete", "blocked", "failed"],
			{
				requirements: ["prompt", "run-environment", "observe", "shell", "edit"],
				retryLimit: 3,
			},
		),
		step(
			"core.wiki-approval",
			"Wiki approval",
			"developer",
			["approve", "comments"],
			{
				allowedEffects: ["wiki.verify"],
			},
		),
		step(
			"core.research",
			"Research",
			"agent",
			["blocked", "failed", "request-wiki", "close-research"],
			{
				retryLimit: 3,
				requirements: [
					"interactive",
					"prompt",
					"persistent-session",
					"run-environment",
					"observe",
				],
			},
		),
		step(
			"core.archive",
			"OpenSpec archive",
			"agent",
			["complete", "blocked", "failed"],
			{
				requirements: ["prompt", "run-environment", "observe", "shell", "edit"],
				retryLimit: 3,
				allowedEffects: [
					"artifact.write",
					"agent.launch",
					"agent.prompt",
					"agent.stop",
					"openspec.validate",
					"wiki.verify",
				],
			},
		),
		step("core.delivery", "Delivery", "system", ["complete", "failed"], {
			allowedEffects: ["delivery.commit", "delivery.push"],
		}),
		step("core.completed", "Completed", "developer", ["close", "create-pr"], {
			allowedEffects: ["pull-request.create", "workspace.close"],
		}),
		step("core.closed", "Closed", "system", ["closed"], {
			allowedEffects: ["workspace.close", "workspace.cleanup"],
		}),
	];
	for (const item of catalog) registry.registerStep(item);
	const common = [
		"core.implementation",
		"core.triage",
		"core.verification",
		"core.developer-review",
	];
	const manifests = (
		rounds: number,
		version: number,
		wikiGate = true,
		wikiBeforeArchive = true,
	): WorkflowManifest[] => [
		{
			id: "openspec-full",
			version,
			label: "Openspec",
			initial: "core.plan",
			terminal: ["core.closed"],
			steps: [
				"core.plan",
				"core.plan-approval",
				...common,
				...(wikiGate && wikiBeforeArchive
					? ["core.wiki", "core.wiki-approval"]
					: []),
				"core.archive",
				...(wikiGate && !wikiBeforeArchive ? ["core.wiki-approval"] : []),
				"core.delivery",
				"core.completed",
				"core.closed",
			],
			edges: [
				{ from: "core.plan", outcome: "complete", to: "core.plan-approval" },
				{
					from: "core.plan",
					outcome: "blocked",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan",
					outcome: "failed",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "approve",
					to: "core.implementation",
				},
				{
					from: "core.plan-approval",
					outcome: "reject",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "comments",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				...workflowEdges(true, rounds, wikiGate, wikiBeforeArchive),
			],
		},
		{
			id: "openspec-propose",
			version,
			label: "Openspec Propose Only",
			initial: "core.plan",
			terminal: ["core.closed"],
			steps: [
				"core.plan",
				"core.plan-approval",
				"core.completed",
				"core.closed",
			],
			edges: [
				{ from: "core.plan", outcome: "complete", to: "core.plan-approval" },
				{
					from: "core.plan",
					outcome: "blocked",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan",
					outcome: "failed",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "approve",
					to: "core.completed",
				},
				{
					from: "core.plan-approval",
					outcome: "reject",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "comments",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.completed",
					outcome: "create-pr",
					to: "core.completed",
					loop: { maxAttempts: 3 },
				},
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			],
		},
		{
			id: "openspec-apply",
			version,
			label: "Openspec apply",
			initial: "core.implementation",
			terminal: ["core.closed"],
			steps: [
				...common,
				...(wikiGate && wikiBeforeArchive
					? ["core.wiki", "core.wiki-approval"]
					: []),
				"core.archive",
				...(wikiGate && !wikiBeforeArchive ? ["core.wiki-approval"] : []),
				"core.delivery",
				"core.completed",
				"core.closed",
			],
			edges: workflowEdges(true, rounds, wikiGate, wikiBeforeArchive),
		},
		{
			id: "no-openspec",
			version,
			label: "No OpenSpec",
			initial: "core.implementation",
			terminal: ["core.closed"],
			steps: [...common, "core.delivery", "core.completed", "core.closed"],
			edges: workflowEdges(false, rounds),
		},
		{
			id: "openspec-fusion-full",
			version,
			label: "Openspec fusion",
			initial: "fusion.plan",
			terminal: ["core.closed"],
			steps: [
				"fusion.plan",
				"fusion.consolidate",
				"core.plan-approval",
				...common,
				...(wikiGate && wikiBeforeArchive
					? ["core.wiki", "core.wiki-approval"]
					: []),
				"core.archive",
				...(wikiGate && !wikiBeforeArchive ? ["core.wiki-approval"] : []),
				"core.delivery",
				"core.completed",
				"core.closed",
			],
			edges: [
				{
					from: "fusion.plan",
					outcome: "complete",
					to: "fusion.consolidate",
				},
				{
					from: "fusion.plan",
					outcome: "blocked",
					to: "fusion.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "fusion.plan",
					outcome: "failed",
					to: "fusion.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "fusion.consolidate",
					outcome: "complete",
					to: "core.plan-approval",
				},
				{
					from: "fusion.consolidate",
					outcome: "blocked",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "fusion.consolidate",
					outcome: "failed",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "approve",
					to: "core.implementation",
				},
				{
					from: "core.plan-approval",
					outcome: "reject",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "comments",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				...workflowEdges(true, rounds, wikiGate, wikiBeforeArchive),
			],
		},
		{
			id: "openspec-fusion-propose",
			version,
			label: "Openspec fusion propose",
			initial: "fusion.plan",
			terminal: ["core.closed"],
			steps: [
				"fusion.plan",
				"fusion.consolidate",
				"core.plan-approval",
				"core.completed",
				"core.closed",
			],
			edges: [
				{ from: "fusion.plan", outcome: "complete", to: "fusion.consolidate" },
				{
					from: "fusion.plan",
					outcome: "blocked",
					to: "fusion.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "fusion.plan",
					outcome: "failed",
					to: "fusion.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "fusion.consolidate",
					outcome: "complete",
					to: "core.plan-approval",
				},
				{
					from: "fusion.consolidate",
					outcome: "blocked",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "fusion.consolidate",
					outcome: "failed",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "approve",
					to: "core.completed",
				},
				{
					from: "core.plan-approval",
					outcome: "reject",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "comments",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.completed",
					outcome: "create-pr",
					to: "core.completed",
					loop: { maxAttempts: 3 },
				},
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			],
		},
		...(wikiGate
			? [
					{
						id: "research",
						version,
						label: "Research",
						initial: "core.research",
						terminal: ["core.closed"],
						steps: [
							"core.research",
							"core.wiki",
							"core.wiki-approval",
							"core.closed",
						],
						allowedOutcomes: {
							"core.research": [
								"blocked",
								"failed",
								"request-wiki",
								"close-research",
							],
						},
						edges: [
							{
								from: "core.research",
								outcome: "request-wiki",
								to: "core.wiki",
							},
							{
								from: "core.research",
								outcome: "blocked",
								to: "core.research",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.research",
								outcome: "failed",
								to: "core.research",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.research",
								outcome: "close-research",
								to: "core.closed",
							},
							{
								from: "core.wiki",
								outcome: "complete",
								to: "core.wiki-approval",
							},
							{
								from: "core.wiki",
								outcome: "blocked",
								to: "core.wiki",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.wiki",
								outcome: "failed",
								to: "core.wiki",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.wiki-approval",
								outcome: "approve",
								to: "core.closed",
								effects: [
									{
										kind: "wiki.verify",
										idempotencyKey: "wiki.verify",
										payload: {},
									},
								],
							},
							{
								from: "core.wiki-approval",
								outcome: "comments",
								to: "core.wiki",
								loop: { maxAttempts: 6 },
							},
						] as const,
					},
				]
			: []),
		...(wikiGate
			? [
					{
						id: "wiki",
						version,
						label: "Wiki",
						initial: "core.wiki",
						terminal: ["core.closed"],
						steps: [
							"core.wiki",
							"core.wiki-approval",
							"core.completed",
							"core.closed",
						],
						allowedOutcomes: { "core.completed": ["close"] },
						edges: [
							{
								from: "core.wiki",
								outcome: "complete",
								to: "core.wiki-approval",
							},
							{
								from: "core.wiki",
								outcome: "blocked",
								to: "core.wiki",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.wiki",
								outcome: "failed",
								to: "core.wiki",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.wiki-approval",
								outcome: "approve",
								to: "core.completed",
								effects: [
									{
										kind: "wiki.verify",
										idempotencyKey: "wiki.verify",
										payload: {},
									},
								],
							},
							{
								from: "core.wiki-approval",
								outcome: "comments",
								to: "core.wiki",
								loop: { maxAttempts: 6 },
							},
							{ from: "core.completed", outcome: "close", to: "core.closed" },
						] as const,
					},
					{
						id: "wiki-comments",
						version,
						label: "Wiki Comments",
						initial: "core.wiki",
						terminal: ["core.closed"],
						steps: ["core.wiki", "core.completed", "core.closed"],
						allowedOutcomes: { "core.completed": ["close"] },
						edges: [
							{
								from: "core.wiki",
								outcome: "complete",
								to: "core.completed",
								effects: [
									{
										kind: "wiki.verify",
										idempotencyKey: "wiki.verify",
										payload: {},
									},
								],
							},
							{
								from: "core.wiki",
								outcome: "blocked",
								to: "core.wiki",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.wiki",
								outcome: "failed",
								to: "core.wiki",
								loop: { maxAttempts: 3 },
							},
							{ from: "core.completed", outcome: "close", to: "core.closed" },
						] as const,
					},
				]
			: []),
	];
	for (const rounds of Array.from({ length: 20 }, (_, index) => index + 1)) {
		const legacyVersion = rounds === 6 ? 1 : rounds === 1 ? 21 : rounds;
		for (const definition of manifests(rounds, legacyVersion, false))
			registry.registerWorkflow(definition);
		const version = definitionVersionForPolicy(rounds);
		for (const definition of manifests(rounds, version, true))
			registry.registerWorkflow(definition);
		if (rounds === 6)
			for (const definition of manifests(20, 1000, true, false))
				registry.registerWorkflow(definition);
	}
	return registry;
}
export function definitionVersionForPolicy(rounds: number): number {
	return rounds + 100;
}
function workflowEdges(
	archive: boolean,
	maxVerificationRounds: number,
	wikiGate = true,
	wikiBeforeArchive = true,
): WorkflowManifest["edges"] {
	const approved = archive
		? wikiGate && wikiBeforeArchive
			? "core.wiki"
			: "core.archive"
		: "core.delivery";
	return [
		{ from: "core.implementation", outcome: "complete", to: "core.triage" },
		{
			from: "core.implementation",
			outcome: "blocked",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		{
			from: "core.implementation",
			outcome: "failed",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		{ from: "core.triage", outcome: "complete", to: "core.verification" },
		{
			from: "core.triage",
			outcome: "blocked",
			to: "core.triage",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.triage",
			outcome: "failed",
			to: "core.triage",
			loop: { maxAttempts: 3 },
		},
		{ from: "core.verification", outcome: "pass", to: "core.developer-review" },
		{
			from: "core.verification",
			outcome: "fix",
			to: "core.implementation",
			loop: { maxAttempts: maxVerificationRounds },
		},
		{
			from: "core.verification",
			outcome: "limit",
			to: "core.verification",
			loop: { maxAttempts: 1 },
		},
		{
			from: "core.verification",
			outcome: "blocked",
			to: "core.verification",
			loop: { maxAttempts: maxVerificationRounds },
		},
		{
			from: "core.verification",
			outcome: "failed",
			to: "core.implementation",
			loop: { maxAttempts: maxVerificationRounds },
		},
		{ from: "core.developer-review", outcome: "approve", to: approved },
		{
			from: "core.developer-review",
			outcome: "comments",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		...(archive
			? wikiGate
				? wikiBeforeArchive
					? ([
							{
								from: "core.wiki",
								outcome: "complete",
								to: "core.wiki-approval",
							},
							{
								from: "core.wiki",
								outcome: "blocked",
								to: "core.wiki",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.wiki",
								outcome: "failed",
								to: "core.wiki",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.wiki-approval",
								outcome: "approve",
								to: "core.archive",
								effects: [
									{
										kind: "wiki.verify",
										idempotencyKey: "wiki.verify",
										payload: {},
									},
								],
							},
							{
								from: "core.wiki-approval",
								outcome: "comments",
								to: "core.wiki",
								loop: { maxAttempts: 6 },
							},
							{
								from: "core.archive",
								outcome: "complete",
								to: "core.delivery",
							},
							{
								from: "core.archive",
								outcome: "blocked",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.archive",
								outcome: "failed",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
						] as const)
					: ([
							{
								from: "core.archive",
								outcome: "complete",
								to: "core.wiki-approval",
							},
							{
								from: "core.wiki-approval",
								outcome: "approve",
								to: "core.delivery",
								effects: [
									{
										kind: "wiki.verify",
										idempotencyKey: "wiki.verify",
										payload: {},
									},
								],
							},
							{
								from: "core.wiki-approval",
								outcome: "comments",
								to: "core.archive",
								loop: { maxAttempts: 6 },
							},
							{
								from: "core.archive",
								outcome: "blocked",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.archive",
								outcome: "failed",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
						] as const)
				: ([
						{ from: "core.archive", outcome: "complete", to: "core.delivery" },
						{
							from: "core.archive",
							outcome: "blocked",
							to: "core.archive",
							loop: { maxAttempts: 3 },
						},
						{
							from: "core.archive",
							outcome: "failed",
							to: "core.archive",
							loop: { maxAttempts: 3 },
						},
					] as const)
			: []),
		{ from: "core.delivery", outcome: "complete", to: "core.completed" },
		{
			from: "core.delivery",
			outcome: "failed",
			to: "core.delivery",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.completed",
			outcome: "create-pr",
			to: "core.completed",
			loop: { maxAttempts: 3 },
		},
		{ from: "core.completed", outcome: "close", to: "core.closed" },
	];
}
export const BUILTIN_EFFECTS = EFFECTS;
export const BUILTIN_CAPABILITIES = CAPABILITIES;
