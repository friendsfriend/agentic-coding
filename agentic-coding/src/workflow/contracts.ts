import path from "node:path";

export type ActorKind = "agent" | "developer" | "system";
export type WorkflowStatus =
	| "active"
	| "paused"
	| "attention-required"
	| "completed"
	| "closed";
export type RunStatus =
	| "pending"
	| "working"
	| "completed"
	| "blocked"
	| "failed"
	| "expired";
export type EffectStatus =
	| "pending"
	| "running"
	| "retry"
	| "completed"
	| "failed"
	| "expired";
export type RuntimeId = "pi" | "opencode" | "opencode-v2" | (string & {});
export type AdapterCapability =
	| "interactive"
	| "prompt"
	| "persistent-session"
	| "run-environment"
	| "observe"
	| "read-only"
	| "shell"
	| "edit"
	| "runtime-bridge";
export type EffectKind =
	| "workspace.setup"
	| "artifact.write"
	| "agent.launch"
	| "agent.prompt"
	| "agent.stop"
	| "notification.show"
	| "openspec.validate"
	| "delivery.commit"
	| "delivery.push"
	| "pull-request.create"
	| "workspace.close"
	| "workspace.cleanup";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ContractError {
	path: string;
	message: string;
}
export class ContractFailure extends Error {
	constructor(
		readonly contractId: string,
		readonly issues: ContractError[],
	) {
		super(
			`${contractId}: ${issues
				.slice(0, 8)
				.map((issue) => `${issue.path}: ${issue.message}`)
				.join("; ")}`,
		);
	}
}
export interface Contract<T> {
	readonly id: string;
	readonly version: number;
	parse(value: unknown): T;
}

function object(value: unknown, at: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ContractFailure(at, [{ path: at, message: "expected object" }]);
	return value as Record<string, unknown>;
}
function text(value: unknown, at: string, max = 4096): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new ContractFailure(at, [
			{ path: at, message: `expected non-empty string <= ${max} bytes` },
		]);
	return value;
}
function boundedText(value: unknown, at: string, max = 4096): string {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string" || value.length > max)
		throw new ContractFailure(at, [
			{ path: at, message: `expected string <= ${max} bytes` },
		]);
	return value;
}
function integer(value: unknown, at: string, min = 0): number {
	if (!Number.isInteger(value) || Number(value) < min)
		throw new ContractFailure(at, [
			{ path: at, message: `expected integer >= ${min}` },
		]);
	return Number(value);
}
function strings(value: unknown, at: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
		throw new ContractFailure(at, [
			{ path: at, message: "expected string array" },
		]);
	return value as string[];
}
function enumValue<const T extends readonly string[]>(
	value: unknown,
	at: string,
	values: T,
): T[number] {
	if (typeof value !== "string" || !values.includes(value as T[number]))
		throw new ContractFailure(at, [
			{ path: at, message: `expected ${values.join("|")}` },
		]);
	return value as T[number];
}
export const validation = {
	object,
	text,
	boundedText,
	integer,
	strings,
	enumValue,
};

export interface DefinitionPin {
	id: string;
	version: number;
	digest: string;
}
export interface ResolvedProfile {
	name: string;
	runtime: RuntimeId;
	executable: string;
	model?: string;
	agent?: string;
	thinking?: string;
	tools: readonly string[];
	extensions: readonly string[];
	readOnly: boolean;
	capabilities: readonly AdapterCapability[];
	digest: string;
}
export interface WorkflowRouting {
	defaultProfile: string;
	routes: readonly {
		stepId: string;
		role?: string;
		profile: ResolvedProfile;
	}[] /** @deprecated ignored legacy snapshot data */;
	diversity?: readonly { routes: string[]; satisfied: boolean }[];
}
export interface StepAttemptState {
	attempt: number;
	mode?: "apply" | "fix" | "review-fix";
	activeRunIds: string[];
	completedRunIds: string[];
	selectedRoles: string[];
	testRunStarted: boolean;
	context?: JsonValue;
	results: Array<{
		runId: string;
		role: string;
		critical: number;
		outputDigest?: string;
	}>;
}
export interface WorkflowMetadata {
	repository: string;
	worktree: string;
	changeId: string;
	branch: string;
	baseBranch: string;
	baseCommit: string;
	workspace?: string;
	task?: string;
	ticket?: string;
	createdAt: string;
	updatedAt: string;
	stepEnteredAt: string;
}
export interface WorkflowSnapshot {
	schemaVersion: 1;
	workflowId: string;
	revision: number;
	definition: DefinitionPin;
	status: WorkflowStatus;
	currentStep: string;
	step: StepAttemptState;
	metadata: WorkflowMetadata;
	routing: WorkflowRouting;
	evidence: Array<{ kind: string; path: string; digest: string }>;
	loopCounts: Record<string, number>;
	attention: string[];
	repaired?: { reason: string; fromStep: string; at: string };
	repinned?: { fromDigest: string; at: string };
}
export interface WorkflowRun {
	id: string;
	workflowId: string;
	stepId: string;
	role: string;
	generation: number;
	attempt: number;
	status: RunStatus;
	profile: ResolvedProfile;
	issuedRevision: number;
	allowedOutcomes: readonly ("complete" | "blocked" | "failed")[];
	capabilityHash: string;
	capabilityExpiresAt: string;
	assignmentPath: string;
	outputPath?: string;
	outputSchema?: { id: string; version: number };
	outputDigest?: string;
	handle?: AgentHandle;
	createdAt: string;
	completedAt?: string;
}
export interface AgentHandle {
	runtime: RuntimeId;
	name: string;
	paneId: string;
	tabId?: string;
	sessionId?: string;
}
export interface WorkflowEffect {
	id: string;
	workflowId: string;
	revision: number;
	kind: EffectKind;
	idempotencyKey: string;
	payload: JsonValue;
	status: EffectStatus;
	attempts: number;
	maxAttempts: number;
	lease?: string;
	leaseExpiresAt?: string;
	nextAttemptAt?: string;
	lastError?: string;
}
export interface Assignment {
	protocolVersion: 1;
	workflowId: string;
	runId: string;
	generation: number;
	stepId: string;
	role: string;
	objective: string;
	interaction: "developer-dialogue" | "silent";
	inputs: readonly string[];
	permissions: readonly string[];
	checks: readonly string[];
	output?: {
		path: string;
		schemaId: string;
		schemaVersion: number;
		maxBytes: number;
	};
	allowedOutcomes: readonly ("complete" | "blocked" | "failed")[];
	environment: Readonly<
		Record<
			| "HERDR_WORKFLOW_ID"
			| "HERDR_CHANGE_ID"
			| "HERDR_RUN_ID"
			| "HERDR_RUN_GENERATION"
			| "HERDR_RUN_TOKEN"
			| "HERDR_OUTPUT"
			| "HERDR_OUTPUT_SCHEMA_ID"
			| "HERDR_OUTPUT_SCHEMA_VERSION"
			| "HERDR_STEP_ID"
			| "HERDR_ROLE"
			| "HERDR_PROFILE"
			| "HERDR_RUNTIME"
			| "HERDR_TELEMETRY_PATH"
			| "TRACEPARENT",
			string
		>
	>;
}
export interface WorkflowActionView {
	id: string;
	label: string;
	input?: { schemaId: string; schemaVersion: number };
	confirmation: "none" | "confirm" | "reason";
}
export interface WorkflowView {
	workflowId: string;
	changeId: string;
	revision: number;
	definition: DefinitionPin & { label: string };
	status: WorkflowStatus;
	repository: string;
	worktree: string;
	branch: string;
	baseCommit: string;
	workspace?: string;
	task?: string;
	createdAt: string;
	updatedAt: string;
	currentStep: {
		id: string;
		label: string;
		attempt: number;
		enteredAt: string;
	};
	runs: Array<{
		id: string;
		stepId: string;
		role: string;
		attempt: number;
		status: RunStatus;
		runtime: RuntimeId;
		profile: string;
		model?: string;
		paneId?: string;
		outputPath?: string;
		outputDigest?: string;
	}>;
	routing: WorkflowRouting;
	effects: Array<{
		id: string;
		kind: EffectKind;
		status: EffectStatus;
		attempts: number;
		lastError?: string;
	}>;
	observations: Array<{
		runId: string;
		runtime: RuntimeId;
		status: string;
		at: string;
	}>;
	health: { valid: boolean; attention: string[]; diagnostic?: string };
	availableActions: WorkflowActionView[];
}

export type WorkflowCommand =
	| {
			type: "developer.action";
			workflowId: string;
			revision: number;
			actionId: string;
			input?: unknown;
	  }
	| {
			type: "agent.handoff";
			runId: string;
			generation: number;
			token: string;
			outcome: "complete" | "blocked" | "failed";
			artifact?: string;
			message?: string;
	  }
	| {
			type: "effect.result";
			effectId: string;
			lease: string;
			outcome: "complete" | "retry" | "failed";
			data?: unknown;
	  }
	| {
			type: "operator.repair";
			workflowId: string;
			revision: number;
			targetStep: string;
			reason: string;
	  }
	| { type: "operator.repin"; workflowId: string; revision: number }
	| { type: "operator.resume"; workflowId: string; revision: number };

export const commandContract: Contract<WorkflowCommand> = {
	id: "core.workflow-command",
	version: 1,
	parse(value: unknown): WorkflowCommand {
		const input = object(value, "$");
		const type = text(input.type, "$.type", 64);
		if (type === "developer.action")
			return {
				type,
				workflowId: text(input.workflowId, "$.workflowId"),
				revision: integer(input.revision, "$.revision"),
				actionId: text(input.actionId, "$.actionId"),
				input: input.input,
			};
		if (type === "agent.handoff")
			return {
				type,
				runId: text(input.runId, "$.runId"),
				generation: integer(input.generation, "$.generation", 1),
				token: text(input.token, "$.token", 1024),
				outcome: enumValue(input.outcome, "$.outcome", [
					"complete",
					"blocked",
					"failed",
				]),
				...(input.artifact === undefined
					? {}
					: { artifact: text(input.artifact, "$.artifact") }),
				...(input.message === undefined
					? {}
					: { message: text(input.message, "$.message", 4096) }),
			};
		if (type === "effect.result")
			return {
				type,
				effectId: text(input.effectId, "$.effectId"),
				lease: text(input.lease, "$.lease"),
				outcome: enumValue(input.outcome, "$.outcome", [
					"complete",
					"retry",
					"failed",
				]),
				data: input.data,
			};
		if (type === "operator.repair")
			return {
				type,
				workflowId: text(input.workflowId, "$.workflowId"),
				revision: integer(input.revision, "$.revision"),
				targetStep: text(input.targetStep, "$.targetStep"),
				reason: boundedText(input.reason, "$.reason", 2048),
			};
		if (type === "operator.repin")
			return {
				type,
				workflowId: text(input.workflowId, "$.workflowId"),
				revision: integer(input.revision, "$.revision"),
			};
		if (type === "operator.resume")
			return {
				type,
				workflowId: text(input.workflowId, "$.workflowId"),
				revision: integer(input.revision, "$.revision"),
			};
		throw new ContractFailure("core.workflow-command", [
			{ path: "$.type", message: "unknown command" },
		]);
	},
};

function profile(value: unknown, at: string): ResolvedProfile {
	const input = object(value, at);
	const runtime = text(input.runtime, `${at}.runtime`, 64);
	const capabilities = strings(
		input.capabilities,
		`${at}.capabilities`,
	) as AdapterCapability[];
	const allowed: AdapterCapability[] = [
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
	if (capabilities.some((item) => !allowed.includes(item)))
		throw new ContractFailure("core.agent-profile", [
			{ path: `${at}.capabilities`, message: "unknown adapter capability" },
		]);
	if (typeof input.readOnly !== "boolean")
		throw new ContractFailure("core.agent-profile", [
			{ path: `${at}.readOnly`, message: "expected boolean" },
		]);
	return {
		name: text(input.name, `${at}.name`),
		runtime,
		executable: text(input.executable, `${at}.executable`),
		...(input.model === undefined
			? {}
			: { model: text(input.model, `${at}.model`) }),
		...(input.agent === undefined
			? {}
			: { agent: text(input.agent, `${at}.agent`) }),
		...(input.thinking === undefined
			? {}
			: { thinking: text(input.thinking, `${at}.thinking`) }),
		tools: strings(input.tools, `${at}.tools`),
		extensions: strings(input.extensions, `${at}.extensions`),
		readOnly: input.readOnly,
		capabilities,
		digest: text(input.digest, `${at}.digest`),
	};
}

export function parseSnapshot(value: unknown): WorkflowSnapshot {
	const input = object(value, "$");
	const definition = object(input.definition, "$.definition");
	const metadata = object(input.metadata, "$.metadata");
	const step = object(input.step, "$.step");
	const routing = object(input.routing, "$.routing");
	const snapshot: WorkflowSnapshot = {
		schemaVersion: integer(input.schemaVersion, "$.schemaVersion", 1) as 1,
		workflowId: text(input.workflowId, "$.workflowId"),
		revision: integer(input.revision, "$.revision"),
		definition: {
			id: text(definition.id, "$.definition.id"),
			version: integer(definition.version, "$.definition.version", 1),
			digest: text(definition.digest, "$.definition.digest"),
		},
		status: enumValue(input.status, "$.status", [
			"active",
			"paused",
			"attention-required",
			"completed",
			"closed",
		]),
		currentStep: text(input.currentStep, "$.currentStep"),
		step: {
			attempt: integer(step.attempt, "$.step.attempt", 1),
			...(step.mode === undefined
				? {}
				: {
						mode: enumValue(step.mode, "$.step.mode", [
							"apply",
							"fix",
							"review-fix",
						]),
					}),
			activeRunIds: strings(step.activeRunIds, "$.step.activeRunIds"),
			completedRunIds: strings(step.completedRunIds, "$.step.completedRunIds"),
			selectedRoles: strings(step.selectedRoles, "$.step.selectedRoles"),
			testRunStarted: (() => {
				if (typeof step.testRunStarted !== "boolean")
					throw new ContractFailure("core.workflow-snapshot", [
						{ path: "$.step.testRunStarted", message: "expected boolean" },
					]);
				return step.testRunStarted;
			})(),
			...(step.context === undefined
				? {}
				: { context: JSON.parse(JSON.stringify(step.context)) as JsonValue }),
			results: (() => {
				if (!Array.isArray(step.results))
					throw new ContractFailure("core.workflow-snapshot", [
						{ path: "$.step.results", message: "expected array" },
					]);
				return step.results.map((entry, i) => {
					const item = object(entry, `$.step.results[${i}]`);
					return {
						runId: text(item.runId, `$.step.results[${i}].runId`),
						role: text(item.role, `$.step.results[${i}].role`),
						critical: integer(item.critical, `$.step.results[${i}].critical`),
						...(item.outputDigest === undefined
							? {}
							: {
									outputDigest: text(
										item.outputDigest,
										`$.step.results[${i}].outputDigest`,
									),
								}),
					};
				});
			})(),
		},
		metadata: {
			repository: path.resolve(
				text(metadata.repository, "$.metadata.repository"),
			),
			worktree: path.resolve(text(metadata.worktree, "$.metadata.worktree")),
			changeId: text(metadata.changeId, "$.metadata.changeId"),
			branch: text(metadata.branch, "$.metadata.branch"),
			baseBranch: text(metadata.baseBranch, "$.metadata.baseBranch"),
			baseCommit: text(metadata.baseCommit, "$.metadata.baseCommit"),
			...(metadata.workspace === undefined
				? {}
				: { workspace: text(metadata.workspace, "$.metadata.workspace") }),
			...(metadata.task === undefined
				? {}
				: { task: text(metadata.task, "$.metadata.task", 65536) }),
			...(metadata.ticket === undefined
				? {}
				: { ticket: text(metadata.ticket, "$.metadata.ticket") }),
			createdAt: text(metadata.createdAt, "$.metadata.createdAt"),
			updatedAt: text(metadata.updatedAt, "$.metadata.updatedAt"),
			stepEnteredAt: text(metadata.stepEnteredAt, "$.metadata.stepEnteredAt"),
		},
		routing: {
			defaultProfile: text(routing.defaultProfile, "$.routing.defaultProfile"),
			routes: (() => {
				if (!Array.isArray(routing.routes))
					throw new ContractFailure("core.workflow-snapshot", [
						{ path: "$.routing.routes", message: "expected array" },
					]);
				return routing.routes.map((entry, i) => {
					const item = object(entry, `$.routing.routes[${i}]`);
					return {
						stepId: text(item.stepId, `$.routing.routes[${i}].stepId`),
						...(item.role === undefined
							? {}
							: { role: text(item.role, `$.routing.routes[${i}].role`) }),
						profile: profile(item.profile, `$.routing.routes[${i}].profile`),
					};
				});
			})(),
		},
		evidence: (() => {
			if (!Array.isArray(input.evidence))
				throw new ContractFailure("core.workflow-snapshot", [
					{ path: "$.evidence", message: "expected array" },
				]);
			return input.evidence.map((entry, i) => {
				const item = object(entry, `$.evidence[${i}]`);
				return {
					kind: text(item.kind, `$.evidence[${i}].kind`),
					path: text(item.path, `$.evidence[${i}].path`),
					digest: text(item.digest, `$.evidence[${i}].digest`),
				};
			});
		})(),
		loopCounts: (() => {
			const counts = object(input.loopCounts, "$.loopCounts");
			return Object.fromEntries(
				Object.entries(counts).map(([key, value]) => [
					key,
					integer(value, `$.loopCounts.${key}`),
				]),
			);
		})(),
		attention: strings(input.attention, "$.attention"),
		...(input.repaired && typeof input.repaired === "object"
			? (() => {
					const item = object(input.repaired, "$.repaired");
					return {
						repaired: {
							reason: boundedText(item.reason, "$.repaired.reason"),
							fromStep: text(item.fromStep, "$.repaired.fromStep"),
							at: text(item.at, "$.repaired.at"),
						},
					};
				})()
			: {}),
	};
	if (snapshot.schemaVersion !== 1)
		throw new ContractFailure("core.workflow-snapshot", [
			{ path: "$.schemaVersion", message: "expected 1" },
		]);
	if (
		snapshot.status === "active" &&
		["core.completed", "core.closed"].includes(snapshot.currentStep)
	)
		throw new ContractFailure("core.workflow-snapshot", [
			{ path: "$.status", message: "terminal step cannot be active" },
		]);
	if (
		new Set(snapshot.step.activeRunIds).size !==
		snapshot.step.activeRunIds.length
	)
		throw new ContractFailure("core.workflow-snapshot", [
			{ path: "$.step.activeRunIds", message: "duplicate run ID" },
		]);
	return snapshot;
}
