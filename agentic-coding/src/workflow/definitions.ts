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
	const manifests = (rounds: number, version: number): WorkflowManifest[] => [
		{
			id: "standard",
			version,
			label: "Standard",
			initial: "core.plan",
			terminal: ["core.closed"],
			steps: [
				"core.plan",
				"core.plan-approval",
				...common,
				"core.archive",
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
				...workflowEdges(true, rounds),
			],
		},
		{
			id: "direct-apply",
			version,
			label: "Direct apply",
			initial: "core.implementation",
			terminal: ["core.closed"],
			steps: [
				...common,
				"core.archive",
				"core.delivery",
				"core.completed",
				"core.closed",
			],
			edges: workflowEdges(true, rounds),
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
			id: "plan-fusion",
			version,
			label: "Plan fusion",
			initial: "fusion.plan",
			terminal: ["core.closed"],
			steps: [
				"fusion.plan",
				"fusion.consolidate",
				"core.plan-approval",
				...common,
				"core.archive",
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
				...workflowEdges(true, rounds),
			],
		},
	];
	for (const [rounds, version] of [
		[6, 1],
		...Array.from({ length: 20 }, (_, index) => index + 1)
			.map((rounds) => [rounds, definitionVersionForPolicy(rounds)] as const)
			.filter(([, version]) => version !== 1),
	] as const)
		for (const definition of manifests(rounds, version))
			registry.registerWorkflow(definition);
	return registry;
}
export function definitionVersionForPolicy(rounds: number): number {
	return rounds === 6 ? 1 : rounds === 1 ? 21 : rounds;
}
function workflowEdges(
	archive: boolean,
	maxVerificationRounds: number,
): WorkflowManifest["edges"] {
	const approved = archive ? "core.archive" : "core.delivery";
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
			? ([
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
