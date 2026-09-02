import { createHash } from "node:crypto";
import type {
	ActorKind,
	AdapterCapability,
	Contract,
	EffectKind,
	WorkflowSnapshot,
} from "./contracts.ts";
import type { StepBehavior } from "./steps/types.ts";

export type { StepBehavior } from "./steps/types.ts";

export interface Reduction {
	snapshot: WorkflowSnapshot;
	effects: Array<{
		kind: EffectKind;
		idempotencyKey: string;
		payload: unknown;
	}>;
}
export interface StepCommand<T = unknown> {
	outcome: string;
	output?: T;
	actionId?: string;
	input?: unknown;
	role?: string;
}
export interface StepDefinition<Input = unknown, Output = unknown> {
	id: string;
	version: number;
	label: string;
	actor: ActorKind;
	instructionAssets: readonly string[];
	instructionDigests: readonly string[];
	/** Engine-internal step semantics; excluded from step and definition digests. */
	behavior?: StepBehavior;
	requirements: readonly AdapterCapability[];
	input: Contract<Input>;
	output: Contract<Output>;
	outcomes: readonly string[];
	retryLimit?: number;
	allowedEffects: readonly EffectKind[];
	enter(snapshot: WorkflowSnapshot): Reduction;
	reduce(snapshot: WorkflowSnapshot, command: StepCommand<Output>): Reduction;
}
export interface WorkflowEdge {
	from: string;
	outcome: string;
	to: string;
	loop?: { maxAttempts: number };
	effects?: readonly {
		kind: EffectKind;
		idempotencyKey: string;
		payload: unknown;
	}[];
}
export type WorkflowTargetKind = "repository" | "wiki" | "research";
/** Declarative replacement for the engine's former `isWikiWorkflowTarget` /
 * `isResearchWorkflowTarget` / definition-id array checks at workflow start
 * time (design D1). Optional so pre-policy definition versions keep
 * registering — and keep their existing digest — unchanged; only manifests
 * that opt in are validated below. */
export interface WorkflowManifestPolicy {
	targetKind: WorkflowTargetKind;
	/** Repository-target workflows that must run against the checkout itself
	 * (no worktree) — proposal-only flows and the repository-backed `wiki`
	 * workflow. Meaningless (must be false) outside the repository target. */
	checkoutRequired: boolean;
	/** Only the research workflow's entry role must be forced read-only. */
	requiresReadOnlyResearcher: boolean;
}
const TARGET_KINDS: readonly WorkflowTargetKind[] = [
	"repository",
	"wiki",
	"research",
];
export interface WorkflowManifest {
	id: string;
	version: number;
	label: string;
	initial: string;
	terminal: readonly string[];
	steps: readonly string[];
	edges: readonly WorkflowEdge[];
	/** Optional per-manifest restriction for steps that expose more outcomes
	 * than this workflow can legally use (for example, wiki completion). */
	allowedOutcomes?: Readonly<Record<string, readonly string[]>>;
	defaultProfile?: string;
	policy?: WorkflowManifestPolicy;
}
export interface CompiledWorkflowDefinition extends WorkflowManifest {
	digest: string;
	stepDigests: Readonly<Record<string, string>>;
}
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
function serializable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(serializable);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, serializable(entry)]),
		);
	return value;
}
export function stableJson(value: unknown): string {
	return JSON.stringify(serializable(value));
}
export function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}
function stepDigest(step: StepDefinition): string {
	// Instruction assets are a rendering concern (the assignment pins each asset
	// digest at render time); they must not change the state-machine contract,
	// otherwise instruction edits break every pinned workflow (pin mismatch).
	// Behavior is engine-internal for the same reason and must never enter this digest.
	return digest({
		id: step.id,
		version: step.version,
		actor: step.actor,
		requirements: [...step.requirements],
		input: { id: step.input.id, version: step.input.version },
		output: { id: step.output.id, version: step.output.version },
		outcomes: [...step.outcomes],
		retryLimit: step.retryLimit ?? null,
		effects: [...step.allowedEffects],
	});
}

export class WorkflowRegistry {
	readonly #effects: ReadonlySet<EffectKind>;
	readonly #capabilities: ReadonlySet<AdapterCapability>;
	readonly #steps = new Map<string, Readonly<StepDefinition>>();
	readonly #definitions = new Map<
		string,
		Readonly<CompiledWorkflowDefinition>
	>();
	constructor(
		effects: Iterable<EffectKind>,
		capabilities: Iterable<AdapterCapability>,
	) {
		this.#effects = new Set(effects);
		this.#capabilities = new Set(capabilities);
	}
	registerStep(step: StepDefinition): Readonly<StepDefinition> {
		if (
			!ID.test(step.id) ||
			!Number.isInteger(step.version) ||
			step.version < 1
		)
			throw new Error(`invalid step identity: ${step.id}@${step.version}`);
		if (!["agent", "developer", "system"].includes(step.actor))
			throw new Error(`unknown actor for ${step.id}: ${step.actor}`);
		if (step.actor === "agent") {
			if (!step.behavior)
				throw new Error(`missing step behavior for agent step ${step.id}`);
			if (!step.behavior.roles)
				throw new Error(`missing role behavior for agent step ${step.id}`);
			if (!step.behavior.candidateRoles)
				throw new Error(`missing candidate roles for agent step ${step.id}`);
		}
		if (
			!step.input?.id ||
			!step.output?.id ||
			step.input.version < 1 ||
			step.output.version < 1
		)
			throw new Error(`invalid contracts for ${step.id}`);
		if (
			!step.outcomes.length ||
			new Set(step.outcomes).size !== step.outcomes.length ||
			step.outcomes.some((outcome) => !ID.test(outcome))
		)
			throw new Error(`invalid outcomes for ${step.id}`);
		if (
			step.retryLimit !== undefined &&
			(!Number.isInteger(step.retryLimit) || step.retryLimit < 1)
		)
			throw new Error(`invalid retry limit for ${step.id}`);
		for (const effect of step.allowedEffects)
			if (!this.#effects.has(effect))
				throw new Error(`unknown effect ${effect} in ${step.id}`);
		for (const requirement of step.requirements)
			if (!this.#capabilities.has(requirement))
				throw new Error(
					`unknown adapter requirement ${requirement} in ${step.id}`,
				);
		if (step.instructionAssets.length !== step.instructionDigests.length)
			throw new Error(`instruction digest mismatch for ${step.id}`);
		if (step.behavior?.candidateRoles) {
			const roles = step.behavior.candidateRoles({
				definitionId: step.id,
				fusionPlannerCount: 1,
			});
			if (!Array.isArray(roles))
				throw new Error(
					`invalid candidate roles for ${step.id}: expected array`,
				);
		}
		const key = `${step.id}@${step.version}`;
		if (this.#steps.has(key))
			throw new Error(`step already registered: ${key}`);
		const frozen = Object.freeze({
			...step,
			instructionAssets: Object.freeze([...step.instructionAssets]),
			instructionDigests: Object.freeze([...step.instructionDigests]),
			requirements: Object.freeze([...step.requirements]),
			outcomes: Object.freeze([...step.outcomes]),
			allowedEffects: Object.freeze([...step.allowedEffects]),
		});
		this.#steps.set(key, frozen);
		return frozen;
	}
	registerWorkflow(
		manifest: WorkflowManifest,
	): Readonly<CompiledWorkflowDefinition> {
		if (
			!ID.test(manifest.id) ||
			!Number.isInteger(manifest.version) ||
			manifest.version < 1
		)
			throw new Error(
				`invalid workflow identity: ${manifest.id}@${manifest.version}`,
			);
		if (
			!manifest.steps.length ||
			new Set(manifest.steps).size !== manifest.steps.length
		)
			throw new Error(`invalid step list in ${manifest.id}`);
		if (manifest.policy) {
			const { targetKind, checkoutRequired, requiresReadOnlyResearcher } =
				manifest.policy;
			if (!TARGET_KINDS.includes(targetKind))
				throw new Error(
					`unknown policy target kind in ${manifest.id}: ${targetKind}`,
				);
			if (requiresReadOnlyResearcher && targetKind !== "research")
				throw new Error(
					`contradictory policy in ${manifest.id}: requiresReadOnlyResearcher without research target`,
				);
			if (checkoutRequired && targetKind !== "repository")
				throw new Error(
					`contradictory policy in ${manifest.id}: checkoutRequired outside repository target`,
				);
		}
		const steps = new Map(manifest.steps.map((id) => [id, this.step(id)]));
		for (const [id, step] of steps) {
			if (step.actor !== "agent") continue;
			if (!step.behavior) throw new Error(`missing step behavior: ${id}`);
			const candidateRoles = step.behavior.candidateRoles;
			if (!candidateRoles)
				throw new Error(`missing candidate roles for agent step ${id}`);
			const roles = candidateRoles({
				definitionId: manifest.id,
				// Fusion planner count is supplied only once routing is selected;
				// zero is a valid catalog-time candidate set for that fan-out step.
				fusionPlannerCount: id === "fusion.plan" ? 0 : 1,
			});
			if (!Array.isArray(roles))
				throw new Error(`invalid candidate roles for ${id}: expected array`);
			if (id !== "fusion.plan" && !roles.length)
				throw new Error(`empty candidate roles for agent step ${id}`);
		}
		if (!steps.has(manifest.initial))
			throw new Error(`missing initial step: ${manifest.initial}`);
		if (
			!manifest.terminal.length ||
			manifest.terminal.some((id) => !steps.has(id))
		)
			throw new Error(`missing terminal step in ${manifest.id}`);
		const allowedOutcomes = manifest.allowedOutcomes ?? {};
		for (const [id, outcomes] of Object.entries(allowedOutcomes)) {
			const step = steps.get(id);
			if (!step) throw new Error(`unknown outcome restriction step: ${id}`);
			if (
				!Array.isArray(outcomes) ||
				!outcomes.length ||
				new Set(outcomes).size !== outcomes.length ||
				outcomes.some((outcome) => !step.outcomes.includes(outcome))
			)
				throw new Error(`invalid outcome restriction for ${id}`);
		}
		const edgeKeys = new Set<string>();
		const adjacency = new Map(
			manifest.steps.map((id) => [id, [] as WorkflowEdge[]]),
		);
		for (const edge of manifest.edges) {
			for (const effect of edge.effects ?? [])
				if (!this.#effects.has(effect.kind))
					throw new Error(`unknown effect ${effect.kind} in edge ${edge.from}`);
			const source = steps.get(edge.from);
			if (!source || !steps.has(edge.to))
				throw new Error(
					`dangling edge ${edge.from}/${edge.outcome}->${edge.to}`,
				);
			if (!source.outcomes.includes(edge.outcome))
				throw new Error(`illegal outcome ${edge.outcome} from ${edge.from}`);
			const key = `${edge.from}:${edge.outcome}`;
			if (edgeKeys.has(key)) throw new Error(`duplicate edge ${key}`);
			edgeKeys.add(key);
			if (
				edge.loop &&
				(!Number.isInteger(edge.loop.maxAttempts) || edge.loop.maxAttempts < 1)
			)
				throw new Error(`unbounded loop ${key}`);
			adjacency.get(edge.from)?.push(edge);
		}
		for (const [id, step] of steps) {
			if (manifest.terminal.includes(id)) continue;
			const outcomes = allowedOutcomes[id] ?? step.outcomes;
			const missing = outcomes.filter(
				(outcome) => !edgeKeys.has(`${id}:${outcome}`),
			);
			if (missing.length)
				throw new Error(`dangling outcomes in ${id}: ${missing.join(", ")}`);
		}
		const reachable = new Set<string>();
		const visit = (id: string) => {
			if (reachable.has(id)) return;
			reachable.add(id);
			for (const edge of adjacency.get(id) ?? []) visit(edge.to);
		};
		visit(manifest.initial);
		const unreachable = manifest.steps.filter((id) => !reachable.has(id));
		if (unreachable.length)
			throw new Error(`unreachable steps: ${unreachable.join(", ")}`);
		const canTerminate = new Set(manifest.terminal);
		let changed = true;
		while (changed) {
			changed = false;
			for (const edge of manifest.edges)
				if (canTerminate.has(edge.to) && !canTerminate.has(edge.from)) {
					canTerminate.add(edge.from);
					changed = true;
				}
		}
		const stranded = manifest.steps.filter((id) => !canTerminate.has(id));
		if (stranded.length)
			throw new Error(`no terminal path: ${stranded.join(", ")}`);
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const cycle = (id: string): void => {
			if (visiting.has(id)) throw new Error(`undeclared cycle at ${id}`);
			if (visited.has(id)) return;
			visiting.add(id);
			for (const edge of adjacency.get(id) ?? []) {
				if (visiting.has(edge.to) && !edge.loop)
					throw new Error(`undeclared cycle ${edge.from}->${edge.to}`);
				if (!visiting.has(edge.to)) cycle(edge.to);
			}
			visiting.delete(id);
			visited.add(id);
		};
		cycle(manifest.initial);
		const stepDigests = Object.fromEntries(
			[...steps].map(([id, step]) => [id, stepDigest(step)]),
		);
		const compiled: CompiledWorkflowDefinition = {
			...manifest,
			steps: Object.freeze([...manifest.steps]),
			terminal: Object.freeze([...manifest.terminal]),
			edges: Object.freeze(
				manifest.edges.map((edge) => Object.freeze({ ...edge })),
			),
			allowedOutcomes: Object.freeze(
				Object.fromEntries(
					Object.entries(allowedOutcomes).map(([id, outcomes]) => [
						id,
						Object.freeze([...outcomes]),
					]),
				),
			),
			stepDigests: Object.freeze(stepDigests),
			digest: digest({ ...manifest, stepDigests }),
			...(manifest.policy
				? { policy: Object.freeze({ ...manifest.policy }) }
				: {}),
		};
		const key = `${compiled.id}@${compiled.version}`;
		if (this.#definitions.has(key))
			throw new Error(`workflow already registered: ${key}`);
		const frozen = Object.freeze(compiled);
		this.#definitions.set(key, frozen);
		return frozen;
	}
	step(id: string, version = 1): Readonly<StepDefinition> {
		const step = this.#steps.get(`${id}@${version}`);
		if (!step) throw new Error(`missing step definition: ${id}@${version}`);
		return step;
	}
	definition(
		id: string,
		version: number,
		expectedDigest?: string,
	): Readonly<CompiledWorkflowDefinition> {
		const definition = this.#definitions.get(`${id}@${version}`);
		if (!definition)
			throw new Error(`missing workflow definition: ${id}@${version}`);
		if (expectedDigest && definition.digest !== expectedDigest)
			throw new Error(`workflow definition pin mismatch: ${id}@${version}`);
		return definition;
	}
	definitions(): readonly Readonly<CompiledWorkflowDefinition>[] {
		return Object.freeze([...this.#definitions.values()]);
	}
}
