// The `define` command (persist-custom-workflow-definitions): validate an
// operator-supplied manifest against the current step catalog and the
// newest-tier invariants, store it in the target store, and print the
// content-addressed identity and the digest a later `start` pins.
import fs from "node:fs";
import path from "node:path";
import type { WorkflowApplication } from "../../application.ts";
import type { WorkflowManifest, WorkflowRegistry } from "../../registry.ts";
import {
	type StoredDefinitionIdentity,
	storeDefinition,
	validateDefinition,
} from "../../runtime/definitions.ts";
import { initializeStore, openStore } from "../../runtime/store.ts";
import type { WorkflowEngine } from "../../runtime.ts";
import { requireFlag } from "../args.ts";
import { managedAgent } from "../caller-environment.ts";

/** The manifest fields the compiler reads before it can report anything
 * useful; a hand-written file that omits or mistypes one is named here instead
 * of surfacing a JavaScript `undefined is not an object` from deep inside the
 * registry. */
const REQUIRED_MANIFEST_FIELDS = ["steps", "edges", "terminal"] as const;

/** The interactive proof a durable trust-root write needs beyond the channel
 * test: an operator at a terminal, or an explicit acknowledgement from a
 * script. A run's child that cleared its own launch environment cannot present
 * either by accident. */
const OPERATOR_FLAG = "--operator";

/** Whether the caller presented the interactive-operator proof. Exported so the
 * predicate is testable without a terminal and without an ancestry the test
 * cannot fabricate. */
export function operatorChannelConfirmed(
	argv: readonly string[],
	isTTY: boolean | undefined,
): boolean {
	return argv.includes(OPERATOR_FLAG) || isTTY === true;
}

/** Every rejection this command raises in its own voice, naming the manifest
 * file the operator passed. */
function fail(file: string, reason: string): never {
	throw new Error(`define: ${file}: ${reason}`);
}

/**
 * Validate a manifest file and store it in the target store. Separated from
 * the command handler so the channel gate (which only the interactive
 * operator may pass) is not entangled with the validation and storage work.
 *
 * Ordering is deliberate: the manifest is compiled — including the
 * newest-tier invariants — *before* the store is initialized, so a rejected
 * manifest cannot migrate (or otherwise change) the repository's store.
 */
export function defineWorkflow(
	registry: WorkflowRegistry,
	repo: string,
	file: string,
	now: () => Date,
): StoredDefinitionIdentity {
	const resolved = path.resolve(file);
	let text: string;
	try {
		text = fs.readFileSync(resolved, "utf8");
	} catch (error) {
		fail(resolved, `cannot read the manifest (${(error as Error).message})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		fail(resolved, `manifest is not valid JSON (${(error as Error).message})`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		fail(resolved, "manifest must be a JSON object");
	const manifest = parsed as WorkflowManifest;
	// Key first, then type: a field the operator did write is never reported as
	// missing just because its value has the wrong shape.
	for (const field of REQUIRED_MANIFEST_FIELDS) {
		if (!(field in manifest)) fail(resolved, `manifest is missing "${field}"`);
		if (!Array.isArray(manifest[field]))
			fail(resolved, `manifest "${field}" must be an array`);
	}
	if (!("initial" in manifest)) fail(resolved, 'manifest is missing "initial"');
	else if (typeof manifest.initial !== "string" || !manifest.initial)
		fail(resolved, 'manifest "initial" must be a non-empty string');
	if ("stepRefs" in manifest && !Array.isArray(manifest.stepRefs))
		fail(
			resolved,
			'manifest "stepRefs" must be an array of { id, version, behaviorVersion }',
		);
	let identity: ReturnType<typeof validateDefinition>;
	try {
		identity = validateDefinition(registry, manifest);
	} catch (error) {
		fail(resolved, (error as Error).message);
	}
	initializeStore(repo);
	const db = openStore(repo);
	try {
		return storeDefinition(
			registry,
			db,
			identity.manifest,
			{ kind: "operator", command: "workflow define" },
			now().toISOString(),
		);
	} catch (error) {
		fail(resolved, (error as Error).message);
	} finally {
		db.close();
	}
}

export async function runDefine(
	rest: string[],
	workflowEngine: WorkflowEngine,
	repo: string,
	application?: WorkflowApplication,
): Promise<void> {
	// A definition is a durable trust root for every workflow in the target
	// store, so only the interactive operator channel may write one. A managed
	// agent (or an unauthenticated caller, which fails closed as managed) is
	// refused before anything is read or written, and a non-interactive caller
	// must acknowledge the invocation explicitly: the channel test is an
	// ancestry heuristic, so the durable write does not rest on it alone.
	if (managedAgent())
		throw new Error("define requires the interactive operator channel");
	if (!operatorChannelConfirmed(rest, process.stdin.isTTY))
		throw new Error(
			`define requires an interactive operator session; pass ${OPERATOR_FLAG} to confirm a non-interactive invocation`,
		);
	const stored = defineWorkflow(
		workflowEngine.registry,
		repo,
		requireFlag(rest, "file"),
		application?.clock ?? (() => new Date()),
	);
	console.log(JSON.stringify(stored, null, 2));
}
