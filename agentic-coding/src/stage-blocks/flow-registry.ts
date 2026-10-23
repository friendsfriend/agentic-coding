// The on-disk flow registry and the eligibility decision
// (`add-stage-flow-replay`, task 2). A flow is eligible only when its reviewed
// spec, its sidecar manifest, the current block registry and the inputs it is
// about to run with agree with each other; the replay needs no approved plan.

import fs from "node:fs";
import path from "node:path";
import { compileValidatedDataBlock, validateDataBlock } from "./data-block.ts";
import { blockDigest } from "./define-block.ts";
import {
	type FlowGenerationIssue,
	type FlowManifest,
	type FlowRouteStep,
	type FlowSource,
	parseFlowManifest,
	routeStepProjection,
	STAGE_FLOW_DIRECTORY,
} from "./flow.ts";
import type { NormalizedStageBlockPlan } from "./plan.ts";
import type { StageBlockRegistry } from "./registry.ts";
import {
	canonicalHash,
	type JsonSchema,
	type JsonValue,
	validateSchemaValue,
} from "./schema.ts";

export type FlowEligibilityCode =
	| "flow-not-found"
	| "flow-manifest-invalid"
	| "flow-id-mismatch"
	| "flow-stage-mismatch"
	| "flow-spec-missing"
	| "flow-spec-drift"
	| "flow-route-drift"
	| "flow-route-step-mismatch"
	| "flow-input-schema-mismatch"
	| "flow-inputs-missing"
	| "flow-inputs-extra"
	| "flow-inputs-invalid"
	| "flow-block-unknown"
	| "flow-block-version"
	| "flow-block-digest"
	| "flow-block-draft"
	| "flow-block-document-missing"
	| "flow-app-missing"
	| "flow-role-missing"
	| "flow-expectation-uncovered";

export interface FlowRegistryEntry {
	readonly manifest: FlowManifest;
	readonly spec: string;
	/** The digest of `spec`, computed where the file was read. Eligibility
	 * compares this against the manifest's `specHash` instead of hashing the
	 * spec again on the polled read path (`PERF-202`). */
	readonly specDigest: string;
	readonly directory: string;
	readonly specPath: string;
}

export interface FlowEligibility {
	readonly eligible: boolean;
	readonly issues: readonly FlowGenerationIssue[];
}

function issue(
	code: FlowEligibilityCode,
	message: string,
	field?: string,
): FlowGenerationIssue {
	return { code, message, ...(field === undefined ? {} : { field }) };
}

export function flowDirectory(root: string, flowId: string): string {
	return path.join(root, STAGE_FLOW_DIRECTORY, flowId);
}

/** Read one saved flow, without scanning its siblings.
 *
 * The eligibility path wants exactly one entry, and it sits behind the polled
 * workflow read model, so reading the whole `stage-flows` directory (and
 * hashing every spec in it) to find it is work that grows with accumulated
 * history rather than with the input (`PERF-101`). `readFlowRegistry` stays for
 * the listing surfaces, which want every entry once. */
export function readFlowEntry(
	root: string,
	flowId: string,
): {
	readonly entry?: FlowRegistryEntry;
	readonly issues: readonly FlowGenerationIssue[];
} {
	const entry = readFlowEntryAt(path.join(root, STAGE_FLOW_DIRECTORY, flowId));
	if (entry.entry === undefined) return entry;
	return { entry: entry.entry, issues: entry.issues };
}

function readFlowEntryAt(flowDir: string): {
	readonly entry?: FlowRegistryEntry;
	readonly issues: readonly FlowGenerationIssue[];
} {
	const name = path.basename(flowDir);
	const issues: FlowGenerationIssue[] = [];
	if (!fs.existsSync(flowDir)) return { issues };
	const manifestPath = path.join(flowDir, "flow.json");
	if (!fs.existsSync(manifestPath))
		return {
			issues: [
				issue(
					"flow-manifest-invalid",
					`stage-flows/${name} has no flow.json`,
					`stage-flows/${name}`,
				),
			],
		};
	let parsed: ReturnType<typeof parseFlowManifest>;
	try {
		parsed = parseFlowManifest(
			JSON.parse(fs.readFileSync(manifestPath, "utf8")),
		);
	} catch (error) {
		return {
			issues: [
				issue(
					"flow-manifest-invalid",
					`stage-flows/${name}/flow.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
					`stage-flows/${name}/flow.json`,
				),
			],
		};
	}
	if (parsed.manifest === undefined) return { issues: parsed.issues };
	if (parsed.manifest.flowId !== name)
		issues.push(
			issue(
				"flow-id-mismatch",
				`stage-flows/${name}/flow.json declares ${parsed.manifest.flowId}`,
				"flowId",
			),
		);
	const specPath = path.join(flowDir, "flow.spec.ts");
	if (!fs.existsSync(specPath))
		return {
			issues: [
				...issues,
				issue(
					"flow-spec-missing",
					`stage-flows/${name} has no flow.spec.ts`,
					`stage-flows/${name}/flow.spec.ts`,
				),
			],
		};
	const spec = fs.readFileSync(specPath, "utf8");
	const specDigest = canonicalHash(spec);
	if (specDigest !== parsed.manifest.specHash)
		issues.push(
			issue(
				"flow-spec-drift",
				`stage-flows/${name}/flow.spec.ts does not match its specHash`,
				`stage-flows/${name}/flow.spec.ts`,
			),
		);
	return {
		entry: {
			manifest: parsed.manifest,
			spec,
			specDigest,
			directory: flowDir,
			specPath,
		},
		issues,
	};
}

export function readFlowRegistry(root: string): {
	readonly entries: readonly FlowRegistryEntry[];
	readonly issues: readonly FlowGenerationIssue[];
} {
	const directory = path.join(root, STAGE_FLOW_DIRECTORY);
	const entries: FlowRegistryEntry[] = [];
	const issues: FlowGenerationIssue[] = [];
	if (!fs.existsSync(directory)) return { entries, issues };
	for (const name of fs.readdirSync(directory).sort()) {
		const flowDir = path.join(directory, name);
		if (!fs.statSync(flowDir).isDirectory()) continue;
		const manifestPath = path.join(flowDir, "flow.json");
		if (!fs.existsSync(manifestPath)) {
			issues.push(
				issue(
					"flow-manifest-invalid",
					`stage-flows/${name} has no flow.json`,
					`stage-flows/${name}`,
				),
			);
			continue;
		}
		let parsed: ReturnType<typeof parseFlowManifest>;
		try {
			parsed = parseFlowManifest(
				JSON.parse(fs.readFileSync(manifestPath, "utf8")),
			);
		} catch (error) {
			issues.push(
				issue(
					"flow-manifest-invalid",
					`stage-flows/${name}/flow.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
					`stage-flows/${name}/flow.json`,
				),
			);
			continue;
		}
		if (parsed.manifest === undefined) {
			issues.push(...parsed.issues);
			continue;
		}
		if (parsed.manifest.flowId !== name)
			issues.push(
				issue(
					"flow-id-mismatch",
					`stage-flows/${name}/flow.json declares ${parsed.manifest.flowId}`,
					"flowId",
				),
			);
		const specPath = path.join(flowDir, "flow.spec.ts");
		if (!fs.existsSync(specPath)) {
			issues.push(
				issue(
					"flow-spec-missing",
					`stage-flows/${name} has no flow.spec.ts`,
					`stage-flows/${name}/flow.spec.ts`,
				),
			);
			continue;
		}
		const spec = fs.readFileSync(specPath, "utf8");
		const specDigest = canonicalHash(spec);
		if (specDigest !== parsed.manifest.specHash)
			issues.push(
				issue(
					"flow-spec-drift",
					`stage-flows/${name}/flow.spec.ts does not match its specHash`,
					`stage-flows/${name}/flow.spec.ts`,
				),
			);
		entries.push({
			manifest: parsed.manifest,
			spec,
			specDigest,
			directory: flowDir,
			specPath,
		});
	}
	return { entries, issues };
}

export function flowManifestIssues(
	manifest: FlowManifest,
	registry: StageBlockRegistry,
): FlowGenerationIssue[] {
	const issues: FlowGenerationIssue[] = [];
	for (const step of manifest.routeSteps) {
		const block = registry.get(step.block);
		if (block === undefined) {
			issues.push(
				issue(
					"flow-block-unknown",
					`flow ${manifest.flowId} references unregistered block ${step.block}`,
					step.routeStepId,
				),
			);
			continue;
		}
		if (manifest.blockVersions[step.block] !== block.version)
			issues.push(
				issue(
					"flow-block-version",
					`flow ${manifest.flowId} pins ${step.block}@${manifest.blockVersions[step.block]}; the registry has ${block.version}`,
					step.routeStepId,
				),
			);
		// The registry hashed this block once; asking it again would re-serialise a
		// data-block document (up to 64 KiB) per route step, on a path that runs
		// from the polled read model (`PERF-102`).
		if (
			manifest.blockDigests[step.block] !==
			(registry.digest(step.block) ?? blockDigest(block))
		)
			issues.push(
				issue(
					"flow-block-digest",
					`flow ${manifest.flowId} pins a different source digest for ${step.block}@${block.version}`,
					step.routeStepId,
				),
			);
	}
	const declared =
		"type" in manifest.inputSchema && manifest.inputSchema.type === "object"
			? manifest.inputSchema.properties
			: {};
	for (const step of manifest.routeSteps)
		for (const name of step.inputs)
			if (!Object.hasOwn(declared, name))
				issues.push(
					issue(
						"flow-input-schema-mismatch",
						`flow ${manifest.flowId} step ${step.routeStepId} reads undeclared input ${name}`,
						name,
					),
				);
	return issues;
}

/** What one pinned sidecar document is, as far as eligibility needs to know.
 * Reading it costs a read, a parse, a validation, a compile and a hash, so the
 * verdict is cached by the file's own stamp: the eligibility answer is polled. */
type PinnedDocument =
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly message: string }
	| { readonly kind: "document"; readonly digest: string };

/** Bounded, stamp-keyed memo of pinned-document verdicts. A changed file has a
 * new stamp (`mtimeMs`/`size`), so an edited sidecar is re-read; an unchanged
 * one costs a `stat` instead of the whole pipeline (`PERF-202`). */
const PINNED_DOCUMENT_CACHE_MAX = 64;
const pinnedDocuments = new Map<
	string,
	{ readonly stamp: string; readonly verdict: PinnedDocument }
>();

function pinnedDocument(file: string): PinnedDocument {
	let stamp: string;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return { kind: "missing" };
		stamp = `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return { kind: "missing" };
	}
	const cached = pinnedDocuments.get(file);
	if (cached !== undefined && cached.stamp === stamp) return cached.verdict;
	let verdict: PinnedDocument;
	try {
		const stored: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		const validation = validateDataBlock(stored);
		verdict =
			validation.ok && validation.document !== undefined
				? {
						kind: "document",
						// Validated here, so the compile skips a second validation pass: a
						// data-block step costs one validation and one document hash
						// (`PERF-102`).
						digest: blockDigest(compileValidatedDataBlock(validation.document)),
					}
				: {
						kind: "invalid",
						message: validation.issues[0]?.message ?? "unknown issue",
					};
	} catch {
		verdict = { kind: "missing" };
	}
	if (pinnedDocuments.size >= PINNED_DOCUMENT_CACHE_MAX) {
		const oldest = pinnedDocuments.keys().next().value;
		if (oldest !== undefined) pinnedDocuments.delete(oldest);
	}
	pinnedDocuments.set(file, { stamp, verdict });
	return verdict;
}

/** Every data block a flow executes runs from the flow's own sidecar document,
 * not from whatever the live store holds, so the pinned document must be present
 * and hash to the digest the manifest recorded at save time. A checked-in block
 * needs no sidecar. Shared by replay eligibility and the checked-in flow gate. */
export function flowDocumentIssues(options: {
	readonly manifest: FlowManifest;
	readonly directory: string;
	readonly root: string;
	readonly registry: StageBlockRegistry;
}): FlowGenerationIssue[] {
	const { manifest, directory, root, registry } = options;
	const issues: FlowGenerationIssue[] = [];
	for (const step of manifest.routeSteps) {
		const block = registry.get(step.block);
		if (block?.data === undefined) continue;
		const recorded = manifest.blockFiles?.[step.block];
		// The manifest names the sidecar it pins. A document that is not in the
		// map was never written, so the flow cannot run from it.
		if (recorded === undefined) {
			issues.push(
				issue(
					"flow-block-document-missing",
					`flow ${manifest.flowId} records no reviewed document for ${step.block}`,
					step.routeStepId,
				),
			);
			continue;
		}
		const file = path.join(directory, recorded);
		const pinned = pinnedDocument(file);
		if (pinned.kind === "missing") {
			issues.push(
				issue(
					"flow-block-document-missing",
					`flow ${manifest.flowId} has no reviewed document for ${step.block} at ${path.relative(root, file)}`,
					step.routeStepId,
				),
			);
			continue;
		}
		if (pinned.kind === "invalid") {
			issues.push(
				issue(
					"flow-block-digest",
					`flow ${manifest.flowId} stores an invalid document for ${step.block}: ${pinned.message}`,
					step.routeStepId,
				),
			);
			continue;
		}
		if (pinned.digest !== manifest.blockDigests[step.block])
			issues.push(
				issue(
					"flow-block-digest",
					`flow ${manifest.flowId} stores a different source digest for ${step.block}@${manifest.blockVersions[step.block]}`,
					step.routeStepId,
				),
			);
	}
	return issues;
}

export function flowEligibility(options: {
	readonly flowId: string;
	readonly root: string;
	readonly stage: string;
	/** The input values this replay will use. Validated against the flow's own
	 * schema; the values themselves are never stored by the decision. */
	readonly inputs?: Readonly<Record<string, JsonValue>>;
	readonly registry: StageBlockRegistry;
	/** Blocks that exist only as this workflow's drafts. A flow never replays a
	 * draft: the reviewed document must be approved first. */
	readonly draftIds?: ReadonlySet<string>;
	readonly stages?: readonly string[];
	readonly apps?: Readonly<
		Record<string, { readonly roles?: readonly string[] }>
	>;
	readonly role?: string;
	/** The entry the caller already read, so a replay of one flow does not scan
	 * the whole registry a second time (`PERF-101`, `QUALITY-005`). */
	readonly entry?: FlowRegistryEntry;
}): FlowEligibility {
	const issues: FlowGenerationIssue[] = [];
	const entry =
		options.entry ?? readFlowEntry(options.root, options.flowId).entry;
	if (entry === undefined)
		return {
			eligible: false,
			issues: [
				issue(
					"flow-not-found",
					`flow ${options.flowId} is not saved under ${STAGE_FLOW_DIRECTORY}`,
					"flowId",
				),
			],
		};
	const manifest = entry.manifest;
	if (entry.specDigest !== manifest.specHash)
		issues.push(
			issue(
				"flow-spec-drift",
				`stage-flows/${manifest.flowId}/flow.spec.ts does not match its specHash`,
				`stage-flows/${manifest.flowId}/flow.spec.ts`,
			),
		);
	// A saved flow is data: it is checked against the current block registry and
	// the stage catalog, never against a plan of the run that replays it
	// (`remove-stage-test-planner`). Every check below answers "does this saved
	// flow still describe blocks and inputs that exist?".
	issues.push(...flowManifestIssues(manifest, options.registry));
	// A flow never replays a draft: the reviewed document must be approved first.
	for (const step of manifest.routeSteps) {
		if (options.draftIds?.has(step.block))
			issues.push(
				issue(
					"flow-block-draft",
					`flow ${manifest.flowId} uses ${step.block}, which is only a draft of the authoring workflow`,
					step.routeStepId,
				),
			);
	}
	issues.push(
		...flowDocumentIssues({
			manifest,
			directory: entry.directory,
			root: options.root,
			registry: options.registry,
		}),
	);
	if (
		manifest.stage !== options.stage &&
		(manifest.stages === undefined || !manifest.stages.includes(options.stage))
	)
		issues.push(
			issue(
				"flow-stage-mismatch",
				`flow ${manifest.flowId} is saved for ${manifest.stage}, not ${options.stage}`,
				"stage",
			),
		);
	const inputs = options.inputs ?? {};
	const inputProblems = validateSchemaValue(
		manifest.inputSchema,
		inputs,
		"inputs",
	);
	for (const problem of inputProblems) {
		const missing = problem.code === "schema-required";
		issues.push(
			issue(
				missing ? "flow-inputs-missing" : "flow-inputs-invalid",
				problem.message,
				problem.path,
			),
		);
	}
	const declared =
		"type" in manifest.inputSchema && manifest.inputSchema.type === "object"
			? manifest.inputSchema.properties
			: {};
	for (const name of Object.keys(inputs))
		if (!Object.hasOwn(declared, name))
			issues.push(
				issue(
					"flow-inputs-extra",
					`flow ${manifest.flowId} does not declare input ${name}`,
					name,
				),
			);
	for (const app of manifest.applications) {
		if (app === "*") continue;
		if (options.apps !== undefined && options.apps[app] === undefined)
			issues.push(
				issue(
					"flow-app-missing",
					`stage ${options.stage} does not declare application ${app}`,
					app,
				),
			);
	}
	// Check only applications the flow uses; an unrelated stage application's
	// role table cannot restrict this flow. Recorded roles are checked even
	// when the caller does not supply an override.
	if (
		options.role !== undefined &&
		manifest.roles.length > 0 &&
		!manifest.roles.includes(options.role)
	)
		issues.push(
			issue(
				"flow-role-missing",
				`flow ${manifest.flowId} was recorded as ${manifest.roles.join(", ")}, not ${options.role}`,
				"role",
			),
		);
	const roles = options.role === undefined ? manifest.roles : [options.role];
	for (const role of roles) {
		if (
			options.apps !== undefined &&
			!manifest.applications.some((app) =>
				options.apps?.[app]?.roles?.includes(role),
			)
		)
			issues.push(
				issue(
					"flow-role-missing",
					`stage ${options.stage} does not declare role ${role} on a flow application`,
					"role",
				),
			);
	}
	for (const step of manifest.routeSteps) {
		const block = options.registry.get(step.block);
		if (!block) continue;
		if (
			roles.length > 0 &&
			(block.roles ?? []).length > 0 &&
			!roles.some((role) => block.roles?.includes(role))
		)
			issues.push(
				issue(
					"flow-role-missing",
					`block ${step.block} is not approved for roles ${roles.join(", ")}`,
					step.routeStepId,
				),
			);
		if (
			options.role !== undefined &&
			options.apps !== undefined &&
			block.app !== "*" &&
			!options.apps[block.app]?.roles?.includes(options.role)
		)
			issues.push(
				issue(
					"flow-role-missing",
					`stage application ${block.app} does not declare role ${options.role}`,
					step.routeStepId,
				),
			);
	}
	return { eligible: issues.length === 0, issues };
}

export function compactFlowEntry(manifest: FlowManifest): {
	readonly flowId: string;
	readonly title: string;
	readonly stage: string;
	readonly applications: readonly string[];
	readonly roles: readonly string[];
	readonly routeHash: string;
	readonly specHash: string;
	readonly inputSchema: JsonSchema;
	readonly blockVersions: Readonly<Record<string, string>>;
} {
	return {
		flowId: manifest.flowId,
		title: manifest.title,
		stage: manifest.stage,
		applications: manifest.applications,
		roles: manifest.roles,
		routeHash: manifest.routeHash,
		specHash: manifest.specHash,
		inputSchema: manifest.inputSchema,
		blockVersions: manifest.blockVersions,
	};
}

export function sourceRouteSteps(source: FlowSource): readonly FlowRouteStep[] {
	return source.steps.map((step) =>
		routeStepProjection(
			step,
			source.routeMeta.find((meta) => meta.id === step.id),
		),
	);
}

export function normalizedPlanInputs(
	plan: NormalizedStageBlockPlan,
): Readonly<Record<string, JsonValue>> {
	return plan.inputs;
}
