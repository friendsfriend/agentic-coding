// Server-side blueprint operations (add-orchestrator-blueprint-workflows): the
// step catalog the orchestrator reads, the side-effect-free compile behind the
// validate route, and the compile-and-store step a blueprint start runs before
// the existing start path.
//
// The compiler is pure, so validation never touches a store; only a start
// compiles *and stores* a definition, and only after compilation succeeded — a
// rejected blueprint is refused before anything is written. The registry is the
// process-lifetime builtin catalog (the same one `startup.ts` resolves through),
// so the digest the validate route answers is the digest the start pins.
import fs from "node:fs";
import path from "node:path";
import type {
	BlueprintDiagnostic,
	BlueprintStepCatalog,
	BlueprintSummary,
	BlueprintValidation,
	StartedBy,
	WorkflowPrincipal,
} from "../../contracts/workflow.ts";
import {
	BLUEPRINT_STEP_CATALOG,
	compileBlueprint,
} from "../../workflow/blueprints/index.ts";
import { registry } from "../../workflow/cli/registry.ts";
import { storeDefinition } from "../../workflow/runtime/definitions.ts";
import { initializeStore, openStore } from "../../workflow/runtime/store.ts";
import {
	type PreparedWorkflowStart,
	prepareWorkflowStart,
} from "../../workflow/startup.ts";

/** The blueprint step catalog as the wire schema describes it. Fresh arrays,
 * because the shared catalog is frozen and the wire value is serialized. */
export function blueprintStepCatalog(): BlueprintStepCatalog {
	return BLUEPRINT_STEP_CATALOG.map((entry) => ({
		id: entry.id,
		label: entry.label,
		actor: entry.actor,
		outcomes: [...entry.outcomes],
		description: entry.description,
	}));
}

function toDiagnostics(
	diagnostics: readonly {
		readonly rule: string;
		readonly message: string;
		readonly path?: readonly string[];
	}[],
): BlueprintDiagnostic[] {
	return diagnostics.map((diagnostic) => ({
		rule: diagnostic.rule,
		message: diagnostic.message,
		...(diagnostic.path ? { path: [...diagnostic.path] } : {}),
	}));
}

/** Compile a blueprint without any side effect: the validate route's whole
 * body. A blueprint the compiler rejects is answered with its diagnostics
 * rather than thrown, so the model author can fix it. */
export function validateWorkflowBlueprint(
	blueprint: unknown,
): BlueprintValidation {
	const compiled = compileBlueprint(registry, blueprint);
	if (!compiled.ok)
		return { ok: false, diagnostics: toDiagnostics(compiled.diagnostics) };
	const summary: BlueprintSummary = {
		label: compiled.summary.label,
		rationale: compiled.summary.rationale,
		steps: [...compiled.summary.steps],
		initial: compiled.summary.initial,
		terminal: [...compiled.summary.terminal],
		stepCount: compiled.summary.stepCount,
		edgeCount: compiled.summary.edgeCount,
		verificationRounds: compiled.summary.verificationRounds,
	};
	return {
		ok: true,
		digest: compiled.digest,
		definitionId: compiled.definitionId,
		summary,
		diagnostics: [],
	};
}

/** The bounded refusal text a rejected blueprint start raises: the compiler's
 * own diagnostics, so the caller relays why the shape was refused instead of a
 * generic failure. */
function blueprintRefusal(
	diagnostics: readonly {
		readonly rule: string;
		readonly message: string;
	}[],
): string {
	const named = diagnostics
		.slice(0, 8)
		.map((diagnostic) => `${diagnostic.rule}: ${diagnostic.message}`)
		.join("; ");
	return `blueprint rejected: ${named}`;
}

/** The compiled-and-stored blueprint identity a start pins. */
export interface PreparedBlueprintDefinition {
	/** The `custom.` identifier the started workflow pins. */
	readonly definitionId: string;
	/** The compiled manifest digest the workflow pins (the digest the validate
	 * route answered for the same document). */
	readonly digest: string;
	readonly label: string;
	readonly rationale: string;
	/** The compiled policy's checkout contract, so the start forces checkout
	 * mode exactly like a built-in family that declares it. */
	readonly checkoutRequired: boolean;
}

/**
 * Compile a blueprint and store its definition in the target repository's
 * store. Nothing is written unless compilation succeeds, and the definition is
 * stored under its content-addressed `custom.` identity with its origin, so a
 * retried start reuses one row instead of minting another.
 */
export function prepareBlueprintDefinition(
	repo: string,
	blueprint: unknown,
	principal: WorkflowPrincipal,
	now: () => Date,
): PreparedBlueprintDefinition {
	const compiled = compileBlueprint(registry, blueprint);
	if (!compiled.ok) throw new Error(blueprintRefusal(compiled.diagnostics));
	initializeStore(repo);
	const db = openStore(repo);
	try {
		const stored = storeDefinition(
			registry,
			db,
			compiled.manifest,
			{
				kind: "blueprint",
				principal,
				digest: compiled.digest,
				label: compiled.summary.label,
			},
			now().toISOString(),
		);
		return {
			definitionId: stored.id,
			digest: stored.definitionDigest,
			label: compiled.summary.label,
			rationale: compiled.summary.rationale,
			checkoutRequired: compiled.manifest.policy?.checkoutRequired === true,
		};
	} finally {
		db.close();
	}
}

/** Everything the start boundary needs to compile, store and prepare a
 * blueprint start. */
export interface BlueprintWorkflowStartInput {
	readonly repo: string;
	readonly workflowId: string;
	readonly blueprint: unknown;
	readonly task?: string;
	readonly ticket?: string;
	readonly mode?: "worktree" | "checkout";
	readonly preset?: string;
	/** The authenticated principal, recorded on the stored definition's origin. */
	readonly principal?: WorkflowPrincipal;
	readonly enforceHumanReviewGates?: boolean;
	readonly startedBy?: StartedBy;
	readonly now?: () => Date;
}

/**
 * Compile and store a blueprint, then prepare the ordinary workflow start that
 * pins it: one shared start path for built-in and custom shapes after
 * compilation. The definition's own policy decides the checkout contract, so a
 * blueprint that declares `checkoutRequired` forces checkout mode the same way
 * a built-in family does.
 */
export function prepareBlueprintWorkflowStart(
	input: BlueprintWorkflowStartInput,
): PreparedWorkflowStart {
	const repo = fs.realpathSync(path.resolve(input.repo));
	const definition = prepareBlueprintDefinition(
		repo,
		input.blueprint,
		input.principal ?? "operator",
		input.now ?? (() => new Date()),
	);
	const mode = definition.checkoutRequired ? "checkout" : input.mode;
	return prepareWorkflowStart({
		repo,
		workflowId: input.workflowId,
		definitionId: definition.definitionId,
		...(mode ? { mode } : {}),
		...(input.task ? { task: input.task } : {}),
		...(input.ticket ? { ticket: input.ticket } : {}),
		...(input.preset ? { preset: input.preset } : {}),
		...(input.enforceHumanReviewGates ? { enforceHumanReviewGates: true } : {}),
		...(input.startedBy ? { startedBy: input.startedBy } : {}),
		blueprint: {
			label: definition.label,
			rationale: definition.rationale,
			digest: definition.digest,
		},
	});
}
