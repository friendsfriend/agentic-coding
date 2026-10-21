// Write one reviewed flow (`add-stage-flow-replay`, task 1.3/1.9). Rendering is
// pure; formatting, type-checking and the atomic file write are the generator's
// boundary.

import fs from "node:fs";
import path from "node:path";
import {
	buildFlowManifest,
	canonicalInputsHash,
	type FlowGenerationIssue,
	type FlowManifest,
	type FlowSource,
	flowInputContract,
	parseFlowManifest,
	routeHashFor,
	STAGE_FLOW_DIRECTORY,
} from "./flow.ts";
import { renderFlowSpec } from "./flow-spec.ts";
import type { StageBlockRegistry } from "./registry.ts";
import { canonicalHash, type JsonValue } from "./schema.ts";

export interface GenerateFlowOptions {
	readonly root: string;
	readonly source: FlowSource;
	readonly registry: StageBlockRegistry;
	readonly secretValues?: readonly string[];
	/** `false` is only for a unit test of rendering; a real save type-checks. */
	readonly typeCheck?: boolean;
	readonly format?: boolean;
}

export interface GeneratedFlow {
	readonly manifest?: FlowManifest;
	readonly spec?: string;
	readonly specPath?: string;
	readonly manifestPath?: string;
	readonly routeHash?: string;
	readonly specHash?: string;
	readonly inputsHash?: string;
	readonly issues: readonly FlowGenerationIssue[];
	readonly existing?: boolean;
}

function issue(
	code: string,
	message: string,
	field?: string,
): FlowGenerationIssue {
	return { code, message, ...(field === undefined ? {} : { field }) };
}

function containsSecret(value: JsonValue, secrets: readonly string[]): boolean {
	if (typeof value === "string")
		return secrets.some((secret) => secret !== "" && value.includes(secret));
	if (Array.isArray(value))
		return value.some((entry) => containsSecret(entry, secrets));
	if (value !== null && typeof value === "object")
		return Object.values(value).some((entry) =>
			containsSecret(entry as JsonValue, secrets),
		);
	return false;
}

function looksLikeLiteralInputs(
	spec: string,
	inputs: Readonly<Record<string, JsonValue>>,
): string[] {
	const leaked: string[] = [];
	for (const [name, value] of Object.entries(inputs)) {
		if (typeof value === "string" && value.length >= 4 && spec.includes(value))
			leaked.push(name);
	}
	return leaked;
}

function run(
	command: readonly string[],
	cwd: string,
): {
	readonly ok: boolean;
	readonly output: string;
} {
	const child = Bun.spawnSync([...command], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		ok: child.exitCode === 0,
		output: `${child.stdout.toString()}${child.stderr.toString()}`.trim(),
	};
}

export async function generateFlow(
	options: GenerateFlowOptions,
): Promise<GeneratedFlow> {
	const issues: FlowGenerationIssue[] = [];
	const { root, source, registry } = options;
	if (!/^[a-z][a-z0-9-]{0,62}$/.test(source.flowId))
		issues.push(
			issue(
				"flow-id",
				"flowId must start with a lowercase letter and contain lowercase letters, digits or -",
				"flowId",
			),
		);
	if (source.steps.length === 0)
		issues.push(
			issue("flow-empty", "a saved flow needs at least one block step"),
		);
	for (const step of source.steps) {
		const app = step.definition.app;
		if (app === "*")
			issues.push(
				issue(
					"flow-cross-app-block",
					`block ${step.definition.id} is cross-application and has no application barrel`,
					step.id,
				),
			);
		else if (
			!fs.existsSync(
				path.join(root, "src/stage-blocks/blocks", app, "index.ts"),
			)
		)
			issues.push(
				issue(
					"flow-block-barrel",
					`block ${step.definition.id} has no barrel at src/stage-blocks/blocks/${app}/index.ts`,
					step.id,
				),
			);
		if (step.definition.exportName === undefined)
			issues.push(
				issue(
					"flow-export-name",
					`block ${step.definition.id} has no exportName for the generated import`,
					step.id,
				),
			);
		if (containsSecret(step.args, options.secretValues ?? []))
			issues.push(
				issue(
					"flow-secret-literal",
					`step ${step.id} contains a configured secret value`,
					step.id,
				),
			);
	}
	if (containsSecret(source.inputs, options.secretValues ?? []))
		issues.push(
			issue(
				"flow-secret-literal",
				"the approved input values contain a configured secret",
				"inputs",
			),
		);
	const contract = flowInputContract(source, registry);
	issues.push(...contract.issues);
	if (issues.length > 0) return { issues };

	const rendered = renderFlowSpec(source, contract.schema);
	const leaked = looksLikeLiteralInputs(rendered.source, source.inputs);
	if (leaked.length > 0)
		issues.push(
			issue(
				"flow-input-leaked",
				`generated spec contains the value of ${leaked.join(", ")}; input values belong in the approved plan/sidecar, not code`,
				"inputs",
			),
		);
	if (issues.length > 0) return { issues };

	const directory = path.join(root, STAGE_FLOW_DIRECTORY, source.flowId);
	const specPath = path.join(directory, "flow.spec.ts");
	const manifestPath = path.join(directory, "flow.json");
	const tempPath = path.join(directory, "flow.spec.tmp.ts");
	const specRelative = path.relative(root, specPath);
	const manifestRelative = path.relative(root, manifestPath);
	const routeHash = routeHashFor(source);
	let existingManifest: ReturnType<typeof parseFlowManifest> | undefined;
	if (fs.existsSync(manifestPath)) {
		try {
			existingManifest = parseFlowManifest(
				JSON.parse(fs.readFileSync(manifestPath, "utf8")),
			);
		} catch (error) {
			return {
				issues: [
					issue(
						"flow-manifest",
						`existing flow.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
					),
				],
			};
		}
	}
	if (existingManifest !== undefined) {
		if (
			existingManifest.manifest === undefined ||
			existingManifest.issues.length > 0
		)
			return {
				issues:
					existingManifest.issues.length > 0
						? existingManifest.issues
						: [issue("flow-manifest", "existing flow.json is invalid")],
			};
		if (existingManifest.manifest.routeHash !== routeHash)
			return {
				issues: [
					issue(
						"flow-route-changed",
						`${source.flowId} already exists with a different route hash; save the changed route under a new flowId`,
						"flowId",
					),
				],
			};
	}

	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(tempPath, rendered.source, { mode: 0o644 });
	if (options.format !== false) {
		const formatted = run(
			["bunx", "biome", "check", "--write", "--linter-enabled=false", tempPath],
			root,
		);
		if (!formatted.ok) {
			fs.rmSync(tempPath, { force: true });
			return {
				issues: [
					issue(
						"flow-spec-format",
						`the generated spec could not be formatted: ${formatted.output.slice(0, 1_000)}`,
					),
				],
			};
		}
	}
	const spec = fs.readFileSync(tempPath, "utf8");
	const specHash = canonicalHash(spec);
	if (
		existingManifest?.manifest !== undefined &&
		existingManifest.manifest.specHash === specHash
	) {
		fs.rmSync(tempPath, { force: true });
		return {
			manifest: existingManifest.manifest,
			spec: fs.existsSync(specPath) ? fs.readFileSync(specPath, "utf8") : spec,
			specPath: specRelative,
			manifestPath: manifestRelative,
			routeHash,
			specHash,
			inputsHash: canonicalInputsHash(source.inputs),
			issues: [],
			existing: true,
		};
	}
	const built = buildFlowManifest(source, registry, specHash);
	const blocking = built.issues.filter(
		(entry) => entry.code !== "flow-expectation-uncovered",
	);
	if (built.manifest === undefined || blocking.length > 0)
		return {
			issues:
				blocking.length > 0
					? blocking
					: [issue("flow-manifest", "the flow manifest could not be built")],
		};
	if (options.typeCheck !== false) {
		const checked = run(
			[
				"bunx",
				"tsc",
				"--ignoreConfig",
				"--noEmit",
				"--strict",
				"--skipLibCheck",
				"--target",
				"es2022",
				"--types",
				"node",
				"--module",
				"esnext",
				"--moduleResolution",
				"bundler",
				"--allowImportingTsExtensions",
				tempPath,
			],
			root,
		);
		if (!checked.ok) {
			fs.rmSync(tempPath, { force: true });
			return {
				issues: [
					issue(
						"flow-spec-typecheck",
						`the generated spec does not type-check: ${checked.output.slice(0, 2_000)}`,
					),
				],
			};
		}
	}
	const tempManifestPath = path.join(
		directory,
		`.flow-manifest-${process.pid}-${Date.now()}.json`,
	);
	fs.writeFileSync(
		tempManifestPath,
		`${JSON.stringify(built.manifest, null, "\t")}\n`,
		{ mode: 0o644 },
	);
	if (options.format !== false) {
		const formatted = run(
			[
				"bunx",
				"biome",
				"check",
				"--write",
				"--linter-enabled=false",
				tempManifestPath,
			],
			root,
		);
		if (!formatted.ok) {
			fs.rmSync(tempPath, { force: true });
			fs.rmSync(tempManifestPath, { force: true });
			return {
				issues: [
					issue(
						"flow-manifest-format",
						`the generated manifest could not be formatted: ${formatted.output.slice(0, 1_000)}`,
					),
				],
			};
		}
	}
	const manifestSource = fs.readFileSync(tempManifestPath, "utf8");
	fs.writeFileSync(specPath, spec, { mode: 0o644 });
	fs.writeFileSync(manifestPath, manifestSource, { mode: 0o644 });
	fs.rmSync(tempPath, { force: true });
	fs.rmSync(tempManifestPath, { force: true });
	return {
		manifest: built.manifest,
		spec,
		specPath: specRelative,
		manifestPath: manifestRelative,
		routeHash,
		specHash,
		inputsHash: canonicalInputsHash(source.inputs),
		issues: [],
	};
}
