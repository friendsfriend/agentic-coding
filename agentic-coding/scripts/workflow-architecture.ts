// Source-layer ownership and pure-domain guardrails backing
// test/workflow-source-layer-boundaries.test.ts (enforce-source-layer-
// boundaries). These are bounded static checks over the parsed Babel syntax
// tree: they are not a sandbox, a whole-program purity proof, or a linter.
//
// Layers (path classification):
//   domain       pure definitions, contracts, and step behavior
//   runtime      persistence, effects, engine internals, I/O helpers
//   application  shared orchestration (startup, operations, wiki, config)
//   cli          workflow CLI command modules and barrels
//   tui-feature  dashboard, observability and settings feature implementations
//   tui-shared   shared TUI primitives and theme data
//   tui-app      TUI shell entry points and lifecycle glue
//   root         composition roots and foundational clients

import path from "node:path";
import {
	isCallExpression,
	isClassDeclaration,
	isExportDefaultDeclaration,
	isExportNamedDeclaration,
	isFunctionDeclaration,
	isIdentifier,
	isMemberExpression,
	isNewExpression,
	isOptionalCallExpression,
	isOptionalMemberExpression,
	isTSInterfaceDeclaration,
	isTSTypeAliasDeclaration,
	isVariableDeclaration,
	type Node,
	traverseFast,
} from "@babel/types";
import {
	exportedName,
	parseSourceFile,
	positionOf,
	textOf,
} from "./source-ast.ts";
import {
	buildImportGraph,
	buildSourceAnalysis,
	findImportCycle,
	resolveRelative,
} from "./workflow-module-graph.ts";

export type SourceLayer =
	| "domain"
	| "runtime"
	| "application"
	| "cli"
	| "tui-feature"
	| "tui-shared"
	| "tui-data"
	| "tui-context"
	| "tui-app"
	| "root";

export interface ArchitectureIssue {
	/** Absolute path of the offending source module. */
	file: string;
	line: number;
	column: number;
	rule: string;
	message: string;
}

/** Exact-edge exception allowlist: key is `rel-from -> rel-to`, value is the
 * reviewed rationale and the precise condition under which the entry is no
 * longer needed. Unused entries fail validation so exceptions cannot become
 * permanent wildcard bypasses. */
export interface LayerException {
	rationale: string;
	removalCondition: string;
}

const DOMAIN_FILES = [
	"workflow/contracts.ts",
	"workflow/schema.ts", // Effect Schema-backed contract decoding (pure, declarative); the contract facades delegate here
	"workflow/format.ts",
	"workflow/registry.ts",
	"workflow/embedded.generated.ts",
	"workflow/definitions.ts", // re-export barrel over definitions/*
	"workflow/classifiers.ts", // pure classifier integration catalog (categories + parsing; I/O lives in classifier-runner.ts)
	"workflow/sidebar.ts", // pure Herdr sidebar projection: views + supplied observations -> display tokens and input ranks
	"workflow/notifications.ts", // pure developer-action notification projection + transition dedup
	"workflow/run-projections.ts", // pure run projections shared by the dashboard, server operations and gateway
];
const RUNTIME_FILES = [
	"workflow/effects.ts",
	"workflow/effect-runner.ts",
	"workflow/classifier-runner.ts", // bounded OpenSpec artifact collection + classifier model invocation
	"workflow/secure-fs.ts",
	"workflow/paths.ts",
	"workflow/assets.ts",
	"workflow/assignment.ts",
	"workflow/observability.ts",
	// Backend services shared by the engine and the TUI client: outward I/O
	// (wiki data, agent adapters, credentials, agent-extension config) lives
	// in the runtime layer; the application-operations layer only holds
	// orchestration (startup, operations).
	"workflow/wiki.ts",
	"workflow/adapters.ts",
	"workflow/credentials.ts",
	"workflow/profiles.ts",
	"workflow/agent-extensions.ts",
	"workflow/sidebar-sync.ts", // bounded Herdr metadata/view publication boundary
	"workflow/sidebar-observer.ts", // application-owned presentation lifecycle
	"workflow/notification-sync.ts", // bounded Herdr notification show/focus boundary
	"workflow/notification-observer.ts", // application-owned developer-action notification lifecycle
	"workflow/project-catalog.ts", // single asynchronous configured-project catalog client (HTTP + bounded headless invocation)
];
const APPLICATION_FILES = [
	"workflow/startup.ts",
	"workflow/operations.ts",
	"workflow/application.ts", // named application composition root (CLI/dashboard), complete-workflow-effect-cutover task 1
	"workflow/execution-coordinator.ts", // root-owned repository execution coordinators + dashboard application runtime (compose-unified-feature-shell task 1.2); no TUI imports, credential prompt injected
];
const ROOT_FILES = [
	"cli.ts",
	"config-command.ts", // `agentic-coding config` surface: explicit preview/apply/resume/rollback
	"config-migration.ts", // explicit configuration migration (root layer: reads runtime config loaders)
	"config-root.ts", // one configuration-root resolver shared by runtime, TUI-shared and TUI-feature layers
	"herdr-client.ts",
	"server-command.ts",
	// Unified Bun backend transport/client/build root (expose-unified-bun-backend):
	// the server owns workflow/telemetry and delegates environment routes; the
	// TUI/CLI reach it as a typed client, never through backend internals.
	"server/protocol.ts",
	"server/auth.ts",
	"server/app.ts",
	"server/client.ts",
	"server/events.ts",
	"server/credentials.ts",
	"server/handlers.ts",
	"server/lifecycle.ts",
];

/** Classify a project-relative source path (posix separators). */
export function classifySourcePath(relPath: string): SourceLayer | null {
	if (DOMAIN_FILES.includes(relPath)) return "domain";
	// The wire-contract layer is pure by construction: types and Effect
	// Schemas only, so every layer may import it and it may import no layer.
	if (relPath.startsWith("contracts/")) return "domain";
	if (
		relPath.startsWith("workflow/steps/") ||
		relPath.startsWith("workflow/definitions/")
	)
		return "domain";
	if (RUNTIME_FILES.includes(relPath)) return "runtime";
	if (relPath.startsWith("workflow/runtime/")) return "runtime";
	if (APPLICATION_FILES.includes(relPath)) return "application";
	if (relPath.startsWith("workflow/cli/") || relPath === "workflow/cli.ts")
		return "cli";
	if (
		relPath.startsWith("workflow/runtime/") ||
		relPath === "workflow/runtime.ts"
	)
		return "runtime";

	if (
		relPath.startsWith("tui/dash/") ||
		relPath.startsWith("tui/otel/") ||
		relPath.startsWith("tui/settings/")
	)
		return "tui-feature";
	// The dashboard data layer: the only place feature code reads server data.
	// It depends on the gateway port and the contract layer, never on a feature.
	if (relPath.startsWith("tui/data/")) return "tui-data";
	// Composition seams (providers + shell app actions) features consume.
	if (relPath.startsWith("tui/context/")) return "tui-context";
	if (
		relPath.startsWith("tui/shared/") ||
		relPath.startsWith("tui/themes/") ||
		relPath === "tui/clipboard.ts" ||
		relPath === "tui/lifecycle.ts"
	)
		return "tui-shared";
	if (relPath.startsWith("tui/")) return "tui-app";
	if (ROOT_FILES.includes(relPath)) return "root";
	return null;
}

/** Declared dependency directions. Anything outside this matrix for the
 * *from* layer is a violation — including type-only imports, which express
 * architectural coupling even when erased at runtime.
 *
 * Backend (domain/runtime) never reaches CLI composition or TUI presentation;
 * TUI never reaches CLI command modules/barrels; application orchestration is
 * the one layer allowed to compose CLI internals; shared TUI primitives never
 * depend on feature implementations. */
export const ALLOWED_TARGETS: Readonly<
	Record<SourceLayer, ReadonlySet<SourceLayer>>
> = {
	domain: new Set(["domain"]),
	runtime: new Set(["domain", "runtime", "root"]),
	application: new Set([
		"domain",
		"runtime",
		"application",
		"cli", // application orchestration composes CLI internals (git, registry, pane); the backend and TUI layers still never see the CLI
		"root",
	]),
	cli: new Set(["domain", "runtime", "application", "cli", "root"]),
	"tui-feature": new Set([
		"domain",
		"runtime",
		"application",
		"root",
		"tui-shared",
		"tui-data",
		"tui-context",
		"tui-feature",
	]),
	// Shared data layer: reads through the gateway port, so it may use the
	// contract layer and the application runtime, but no feature or shell code.
	"tui-data": new Set(["domain", "runtime", "application", "root", "tui-data"]),
	// These seams compose the runtime for the feature tree; they reach the
	// server and workflow layers on the features' behalf.
	"tui-context": new Set([
		"domain",
		"runtime",
		"application",
		"root",
		"tui-data",
		"tui-context",
	]),
	"tui-shared": new Set(["tui-shared", "root"]),
	"tui-app": new Set([
		"domain",
		"runtime",
		"application",
		"root",
		"tui-shared",
		"tui-data",
		"tui-context",
		"tui-feature",
		"tui-app",
	]),
	root: new Set([
		"domain",
		"runtime",
		"application",
		"cli",
		"root",
		"tui-shared",
		"tui-feature",
		"tui-app",
	]),
};

export const LAYER_LABELS: Readonly<Record<SourceLayer, string>> = {
	domain: "pure domain",
	runtime: "runtime",
	application: "application operations",
	cli: "CLI",
	"tui-feature": "TUI feature",
	"tui-data": "dashboard data layer",
	"tui-context": "composition seam",
	"tui-shared": "shared TUI primitive",
	"tui-app": "TUI shell",
	root: "root",
};

function toPosix(target: string): string {
	return target.split(path.sep).join("/");
}

function layerMessage(
	from: SourceLayer,
	to: SourceLayer,
	toRel: string,
): string {
	if (to === "cli" && (from === "tui-feature" || from === "tui-app"))
		return `TUI module imports workflow CLI orchestration from ${toRel}; consume the application-operations boundary (src/workflow/operations.ts) instead`;
	if (from === "tui-shared" && to === "tui-feature")
		return `shared TUI primitive depends on feature implementation ${toRel}; the dependency direction is reversed (features consume primitives)`;
	if (
		from === "domain" ||
		from === "runtime" ||
		from === "application" ||
		from === "cli"
	)
		if (to === "tui-feature" || to === "tui-app" || to === "tui-shared")
			return `workflow/backend module depends on TUI presentation ${toRel}; presentation must not be reached from backend code (type-only imports included)`;
	return `${LAYER_LABELS[from]} module must not import ${toRel} (${LAYER_LABELS[to]})`;
}

/** View components must not reach backend I/O directly (expose-unified-bun-
 * backend, task 3.5): feature `.tsx` components consume the typed client and
 * let the observation/engine adapters own the transitional seam. Adapters
 * (`.ts` modules such as `dash/observations.ts`, `dash/engine.ts`) are the
 * bounded exception, not view components. */
const VIEW_COMPONENT = /^tui\/(?:dash|otel)\/.*\.tsx$/;
const FORBIDDEN_VIEW_IMPORTS = [
	"workflow/effects.ts",
	"workflow/execution-coordinator.ts",
	"workflow/operations.ts",
	"workflow/application.ts",
	"workflow/startup.ts",
];
const FORBIDDEN_VIEW_BUILTINS = [
	"bun:sqlite",
	"bun:ffi",
	"node:fs",
	"node:fs/promises",
	"node:child_process",
];

/** Backend modules (server/CLI/application) must never reach TUI presentation,
 * type-only imports included. The layer matrix already forbids it for
 * domain/runtime/application/cli; the server transport is classified as root
 * (it composes the process), so it needs its own explicit check. */
export function checkServerBoundaries(
	root: string,
	exceptions: ReadonlyMap<string, LayerException> = new Map(),
): ArchitectureIssue[] {
	const analysis = buildSourceAnalysis(root);
	const issues: ArchitectureIssue[] = [];
	for (const [file, module] of analysis) {
		const fromRel = toPosix(path.relative(root, file));
		if (!fromRel.startsWith("server/")) continue;
		for (const edge of module.edges) {
			// an unresolved relative specifier still names the file it intends
			const intended = edge.resolved
				? edge.resolved
				: edge.specifier.startsWith(".")
					? (resolveRelative(file, edge.specifier) ??
						path.resolve(path.dirname(file), edge.specifier))
					: null;
			const target = intended
				? toPosix(path.relative(root, intended))
				: edge.specifier;
			if (edge.specifier === "@ui" || edge.specifier.startsWith("@ui/")) {
				issues.push({
					file,
					line: edge.line,
					column: edge.column,
					rule: "server:tui-import",
					message: `server module imports TUI presentation (${edge.specifier}); the backend may depend only on contracts, workflow and application modules`,
				});
				continue;
			}
			if (!intended) continue;
			const layer = classifySourcePath(target);
			const isTui =
				layer === "tui-feature" ||
				layer === "tui-shared" ||
				layer === "tui-app";
			if (!isTui) continue;
			if (exceptions.has(`${fromRel} -> ${target}`)) continue;
			issues.push({
				file,
				line: edge.line,
				column: edge.column,
				rule: "server:tui-import",
				message: `server module imports TUI presentation (${target}); the backend may depend only on contracts, workflow and application modules`,
			});
		}
	}
	return issues;
}

/** The presentational package must not depend on an application, domain,
 * server or workflow module (establish-opencode-boundaries, tasks 7.2/8.1).
 * `root` is the package root (a fixture root in tests). */
export function checkUiPackageBoundaries(root: string): ArchitectureIssue[] {
	const analysis = buildSourceAnalysis(root);
	const issues: ArchitectureIssue[] = [];
	for (const [file, module] of analysis) {
		const fromRel = toPosix(path.relative(root, file));
		if (!fromRel.startsWith("src/") && !fromRel.startsWith("packages/ui/"))
			continue;
		for (const edge of module.edges) {
			const target = edge.resolved
				? toPosix(path.relative(root, edge.resolved))
				: edge.specifier;
			const isDomain =
				edge.specifier.startsWith("@devenv/") ||
				target.includes("/src/server/") ||
				target.includes("/src/workflow/") ||
				target.includes("/src/contracts/") ||
				target.includes("/src/tui/");
			if (!isDomain) continue;
			issues.push({
				file,
				line: edge.line,
				column: edge.column,
				rule: "ui:domain-import",
				message: `presentational package imports application code (${target}); the framework owns its structural props and receives them from the surface`,
			});
		}
	}
	return issues;
}

export function checkViewBackendIsolation(root: string): ArchitectureIssue[] {
	const analysis = buildSourceAnalysis(root);
	const issues: ArchitectureIssue[] = [];
	for (const [file, module] of analysis) {
		const fromRel = toPosix(path.relative(root, file));
		if (!VIEW_COMPONENT.test(fromRel)) continue;
		for (const edge of module.edges) {
			if (FORBIDDEN_VIEW_BUILTINS.includes(edge.specifier)) {
				issues.push({
					file,
					line: edge.line,
					column: edge.column,
					rule: "view:backend-builtin",
					message: `${fromRel} imports backend I/O builtin '${edge.specifier}'; consume the typed client instead`,
				});
				continue;
			}
			if (!edge.specifier.startsWith(".") || !edge.resolved) continue;
			const toRel = toPosix(path.relative(root, edge.resolved));
			if (
				!toRel.startsWith("backend/") &&
				!FORBIDDEN_VIEW_IMPORTS.includes(toRel)
			)
				continue;
			issues.push({
				file,
				line: edge.line,
				column: edge.column,
				rule: "view:backend-import",
				message: `${fromRel} imports backend module ${toRel}; consume the typed client instead`,
			});
		}
	}
	return issues;
}

/** Layer-ownership violations across the whole tree, using every edge
 * including type-only references. Exceptional exact edges from the allowlist
 * are skipped. */
export function checkLayerOwnership(
	root: string,
	exceptions: ReadonlyMap<string, LayerException>,
): ArchitectureIssue[] {
	const analysis = buildSourceAnalysis(root);
	const issues: ArchitectureIssue[] = [];
	for (const [file, module] of analysis) {
		const fromRel = toPosix(path.relative(root, file));
		const fromLayer = classifySourcePath(fromRel);
		if (!fromLayer || fromLayer === "root") continue;
		for (const edge of module.edges) {
			if (!edge.specifier.startsWith(".") || !edge.resolved) continue;
			const toRel = toPosix(path.relative(root, edge.resolved));
			const toLayer = classifySourcePath(toRel);
			if (!toLayer) continue;
			if (fromLayer === toLayer) continue;
			if (ALLOWED_TARGETS[fromLayer].has(toLayer)) continue;
			if (exceptions.has(`${fromRel} -> ${toRel}`)) continue;
			issues.push({
				file,
				line: edge.line,
				column: edge.column,
				rule: `layer:${fromLayer}->${toLayer}`,
				message: layerMessage(fromLayer, toLayer, toRel),
			});
		}
	}
	return issues;
}

/** Builtins that do real process/network/filesystem work. Importing one of
 * these in a pure domain module is an immediate indicator the module needs
 * an explicit evidence/effect boundary. */
const IO_BUILTINS = [
	"node:fs",
	"node:fs/promises",
	"node:child_process",
	"node:net",
	"node:dgram",
	"node:http",
	"node:https",
	"node:tls",
	"node:readline",
	"node:tty",
	"node:worker_threads",
	"node:sqlite",
	"bun:ffi",
	"bun:sqlite",
];

/** Immediately recognized ambient I/O/clock globals that guarded pure
 * modules must reject (documented as a bound, alias-able guardrail, not a
 * sandbox). Passing a timestamp or `Date` as data stays valid — only
 * requesting one from the environment is flagged. */
function pureGlobalViolations(file: string): Array<{
	line: number;
	column: number;
	label: string;
}> {
	const source = parseSourceFile(file);
	const found: Array<{ line: number; column: number; label: string }> = [];
	const locate = (node: Node) => positionOf(node);
	const visit = (node: Node): void => {
		if (isCallExpression(node) || isOptionalCallExpression(node)) {
			const callee = node.callee;
			if (isIdentifier(callee) && callee.name === "fetch") {
				found.push({ ...locate(callee), label: "fetch" });
			} else if (
				(isMemberExpression(callee) || isOptionalMemberExpression(callee)) &&
				!callee.computed &&
				isIdentifier(callee.object) &&
				callee.object.name === "Date" &&
				isIdentifier(callee.property) &&
				callee.property.name === "now"
			) {
				found.push({ ...locate(callee), label: "Date.now" });
			} else if (
				(isMemberExpression(callee) || isOptionalMemberExpression(callee)) &&
				!callee.computed &&
				isIdentifier(callee.object) &&
				callee.object.name === "Bun" &&
				isIdentifier(callee.property) &&
				["spawn", "spawnSync", "write", "read", "file"].includes(
					callee.property.name,
				)
			) {
				found.push({
					...locate(callee),
					label: `Bun.${callee.property.name}`,
				});
			} else if (
				(isMemberExpression(callee) || isOptionalMemberExpression(callee)) &&
				!callee.computed &&
				isIdentifier(callee.object) &&
				callee.object.name === "process" &&
				isIdentifier(callee.property) &&
				["cwd", "chdir", "exit", "stdout", "stderr", "stdin"].includes(
					callee.property.name,
				)
			) {
				found.push({
					...locate(callee),
					label: `process.${callee.property.name}`,
				});
			}
		} else if (
			isNewExpression(node) &&
			isIdentifier(node.callee) &&
			node.callee.name === "Date" &&
			node.arguments.length === 0
		) {
			found.push({ ...locate(node), label: "new Date()" });
		}
	};
	for (const statement of source.statements) traverseFast(statement, visit);
	return found;
}

/** Shortest dependency path from one absolute file to another over all
 * resolved edges, or null. */
export function findDependencyPath(
	root: string,
	from: string,
	to: string,
): string[] | null {
	const analysis = buildSourceAnalysis(root);
	const visited = new Set<string>([from]);
	const queue: Array<[string, string[]]> = [[from, [from]]];
	while (queue.length > 0) {
		const next = queue.shift();
		if (!next) break;
		const [currentFile, trail] = next;
		const module = analysis.get(currentFile);
		if (!module) continue;
		for (const edge of module.edges) {
			if (!edge.specifier.startsWith(".") || !edge.resolved) continue;
			const target = edge.resolved;
			if (target === to) return [...trail, target];
			if (visited.has(target)) continue;
			visited.add(target);
			queue.push([target, [...trail, target]]);
		}
	}
	return null;
}

/** Pure-domain guardrails:
 * 1. direct/transitive reachability of anything outside the domain layer
 *    (persistence, effects, filesystem/process/network I/O, presentation),
 * 2. directly imported I/O builtins,
 * 3. recognized ambient I/O/clock globals with source locations,
 * 4. computed module loading (non-literal import()/require()). */
export function checkPureDomain(
	root: string,
	exceptions: ReadonlyMap<string, LayerException>,
): ArchitectureIssue[] {
	const analysis = buildSourceAnalysis(root);
	const issues: ArchitectureIssue[] = [];
	const relativeOf = (target: string) => toPosix(path.relative(root, target));
	for (const [file, module] of analysis) {
		const fileRel = relativeOf(file);
		if (classifySourcePath(fileRel) !== "domain") continue;
		// 1. reachability over every edge (type-only edges included): walk to
		// any non-domain node and report the dependency path.
		const visited = new Set<string>([file]);
		const queue: Array<{ trail: string[]; from: string; to: string }> = [];
		for (const edge of module.edges) {
			if (!edge.specifier.startsWith(".") || !edge.resolved) continue;
			if (visited.has(edge.resolved)) continue;
			visited.add(edge.resolved);
			queue.push({ trail: [file], from: file, to: edge.resolved });
		}
		while (queue.length > 0) {
			const next = queue.shift();
			if (!next) break;
			const { trail, from, to } = next;
			const toRel = relativeOf(to);
			if (classifySourcePath(toRel) !== "domain") {
				const fromRel = relativeOf(from);
				const alreadyExcepted = exceptions.has(`${fromRel} -> ${toRel}`);
				const fromModule = analysis.get(from);
				const edge = fromModule?.edges.find(
					(edge) => edge.specifier.startsWith(".") && edge.resolved === to,
				);
				if (!alreadyExcepted)
					issues.push({
						file,
						line: edge?.line ?? 1,
						column: edge?.column ?? 1,
						rule: "pure:reachability",
						message: `pure domain module transitively depends on ${toRel} (${[...trail, to].map(relativeOf).join(" -> ")}); pure step behavior must consume supplied validated evidence and may not reach persistence, effects, I/O, or presentation`,
					});
				continue;
			}
			const currentModule = analysis.get(to);
			for (const edge of currentModule?.edges ?? []) {
				if (!edge.specifier.startsWith(".") || !edge.resolved) continue;
				if (visited.has(edge.resolved)) continue;
				visited.add(edge.resolved);
				queue.push({ trail: [...trail, to], from: to, to: edge.resolved });
			}
		}
		// 2. I/O builtins
		for (const edge of module.external) {
			if (!IO_BUILTINS.includes(edge.specifier)) continue;
			if (exceptions.has(`${fileRel} -> ${edge.specifier}`)) continue;
			issues.push({
				file,
				line: edge.line,
				column: edge.column,
				rule: "pure:io-builtin",
				message: `pure domain module imports I/O builtin ${edge.specifier}; require explicit evidence/effect data instead`,
			});
		}
		// 3. recognized globals
		for (const violation of pureGlobalViolations(file)) {
			issues.push({
				file,
				line: violation.line,
				column: violation.column,
				rule: "pure:global",
				message: `pure domain module invokes recognized ambient I/O/clock API ${violation.label}; pass explicit data/effect boundaries instead`,
			});
		}
		// 4. computed module loading
		for (const computed of module.computedLoading) {
			issues.push({
				file,
				line: computed.line,
				column: computed.column,
				rule: "pure:computed-loading",
				message:
					"pure domain module performs computed module loading, which escapes static resolution; reject or make the target explicit",
			});
		}
	}
	return issues;
}

/** Project-relative runtime targets that do not resolve — actionable
 * source/specifier diagnostics. */
export function checkUnresolvedRuntimeTargets(
	root: string,
): ArchitectureIssue[] {
	const analysis = buildSourceAnalysis(root);
	const issues: ArchitectureIssue[] = [];
	for (const [file, module] of analysis) {
		const fileRel = toPosix(path.relative(root, file));
		for (const edge of module.unresolved) {
			issues.push({
				file,
				line: edge.line,
				column: edge.column,
				rule: "unresolved:runtime-target",
				message: `${fileRel} refers to unresolved project-relative runtime target '${edge.specifier}'`,
			});
		}
	}
	return issues;
}

/** Runtime import cycle in the tree (value edges only, .ts/.tsx, dynamic
 * imports and require() included). Returns the first cycle path or null. */
export function findRuntimeCycle(root: string): string[] | null {
	const cycle = findImportCycle(buildImportGraph(root));
	return cycle ? cycle.map((file) => toPosix(path.relative(root, file))) : null;
}

/** Recognized Effect runtime-execution call patterns (complete-workflow-
 * effect-cutover, task 3.2). A guarded workflow service must never spin up a
 * nested Effect runtime; only the named application composition roots run
 * programs. Forms: `Effect.runSync|runPromise|runFork|runSyncExit|
 * runPromiseExit`, `Runtime.runSync|runPromise|runFork`, and the bare
 * `runSync|runPromise|runFork` names re-exported from "effect". Calls like
 * `application.runSync(...)` (the application boundary's own surface) are
 * deliberately not flagged — the composition root owns program execution. */
const RUNTIME_EXECUTION_NAMES = new Set([
	"runSync",
	"runPromise",
	"runFork",
	"runSyncExit",
	"runPromiseExit",
]);
const RUNTIME_EXECUTION_RECEIVERS = new Set(["Effect", "Runtime"]);

/** Locate recognized runtime-execution call sites in a source file. */
function runtimeExecutionCalls(file: string): Array<{
	line: number;
	column: number;
	label: string;
}> {
	const source = parseSourceFile(file);
	const found: Array<{ line: number; column: number; label: string }> = [];
	const locate = (node: Node) => positionOf(node);
	const visit = (node: Node): void => {
		if (isCallExpression(node) || isOptionalCallExpression(node)) {
			const callee = node.callee;
			if (
				(isMemberExpression(callee) || isOptionalMemberExpression(callee)) &&
				!callee.computed &&
				isIdentifier(callee.property) &&
				RUNTIME_EXECUTION_NAMES.has(callee.property.name) &&
				isIdentifier(callee.object) &&
				RUNTIME_EXECUTION_RECEIVERS.has(callee.object.name)
			) {
				found.push({
					...locate(callee.property),
					label: `${callee.object.name}.${callee.property.name}`,
				});
			} else if (
				isIdentifier(callee) &&
				RUNTIME_EXECUTION_NAMES.has(callee.name)
			) {
				found.push({ ...locate(callee), label: callee.name });
			}
		}
	};
	for (const statement of source.statements) traverseFast(statement, visit);
	return found;
}

/** Effect runtime execution must stay at named application composition roots
 * (CLI invocation owner, dashboard application owner). A guarded workflow
 * service running its own runtime is a nested-runtime violation (spec
 * workflow-engine-runtime: "Service runs a nested runtime"). */
export function checkRuntimeBoundaries(
	root: string,
	compositionRoots: ReadonlySet<string>,
): ArchitectureIssue[] {
	const analysis = buildSourceAnalysis(root);
	const issues: ArchitectureIssue[] = [];
	for (const file of analysis.keys()) {
		const fileRel = toPosix(path.relative(root, file));
		if (compositionRoots.has(fileRel)) continue;
		for (const call of runtimeExecutionCalls(file)) {
			issues.push({
				file,
				line: call.line,
				column: call.column,
				rule: "runtime:nested",
				message: `${fileRel} invokes Effect runtime execution ${call.label} outside a named application composition root; run Effect programs only at the CLI/dashboard composition boundary`,
			});
		}
	}
	return issues;
}

/** Obsolete migration-only bridge symbols, keyed by the module that must
 * never declare or re-export them, and whole bridge modules that must never
 * be imported (spec workflow-engine-runtime: "Full workflow migration has
 * no legacy orchestration path"). Symbol-level registration matters because
 * the removals (commandContract, parseSnapshot, …) were symbols inside
 * modules that still exist — a reintroduced facade symbol in a live module
 * resolves to a live module, so only the declaration/re-export check can
 * catch it. */
export function checkObsoleteShims(
	root: string,
	obsolete: ReadonlyMap<string, readonly string[]>,
): ArchitectureIssue[] {
	if (obsolete.size === 0) return [];
	const analysis = buildSourceAnalysis(root);
	const issues: ArchitectureIssue[] = [];
	const relativeOf = (target: string) => toPosix(path.relative(root, target));
	for (const [moduleRel, symbols] of obsolete) {
		const moduleFile = [...analysis.keys()].find(
			(file) => relativeOf(file) === moduleRel,
		);
		if (!moduleFile) continue; // module already deleted; nothing to guard
		const source = parseSourceFile(moduleFile);
		const symbolSet = new Set(symbols);
		const locate = (node: Node) => positionOf(node);
		const report = (name: string, node: Node, kind: string) =>
			issues.push({
				file: moduleFile,
				...locate(node),
				rule: "shim:obsolete",
				message: `${moduleRel} ${kind} obsolete migration bridge symbol ${name}; consume the Effect application boundary instead`,
			});
		const declared = (name: string) => symbolSet.has(name);
		for (const statement of source.statements) {
			const declaration =
				isExportNamedDeclaration(statement) ||
				isExportDefaultDeclaration(statement)
					? statement.declaration
					: null;
			if (declaration) {
				if (isVariableDeclaration(declaration)) {
					for (const declarator of declaration.declarations) {
						const name = textOf(source, declarator.id);
						if (declared(name)) report(name, statement, "declares exported");
					}
				}
				if (
					isFunctionDeclaration(declaration) &&
					declaration.id &&
					declared(declaration.id.name)
				)
					report(declaration.id.name, statement, "declares exported");
				if (
					isClassDeclaration(declaration) &&
					declaration.id &&
					declared(declaration.id.name)
				)
					report(declaration.id.name, statement, "declares exported");
				if (
					isTSTypeAliasDeclaration(declaration) &&
					declared(declaration.id.name)
				)
					report(declaration.id.name, statement, "declares type");
				if (
					isTSInterfaceDeclaration(declaration) &&
					declared(declaration.id.name)
				)
					report(declaration.id.name, statement, "declares interface");
			}
			if (isExportNamedDeclaration(statement)) {
				for (const specifier of statement.specifiers) {
					if (specifier.type !== "ExportSpecifier") continue;
					const name = exportedName(specifier);
					if (name && declared(name))
						report(name, specifier, "re-exports obsolete");
				}
			}
		}
	}
	return issues;
}

/** Every exception entry must still match a currently-present source edge;
 * stale entries fail so exceptions cannot persist past their removal
 * condition. */
export function checkExceptionUsage(
	root: string,
	exceptions: ReadonlyMap<string, LayerException>,
): ArchitectureIssue[] {
	if (exceptions.size === 0) return [];
	const analysis = buildSourceAnalysis(root);
	const present = new Set<string>();
	for (const [file, module] of analysis) {
		const fileRel = toPosix(path.relative(root, file));
		for (const edge of module.edges) {
			if (!edge.resolved) continue;
			present.add(
				`${fileRel} -> ${toPosix(path.relative(root, edge.resolved))}`,
			);
		}
	}
	const issues: ArchitectureIssue[] = [];
	for (const [edge, entry] of exceptions) {
		if (present.has(edge)) continue;
		issues.push({
			file: root,
			line: 1,
			column: 1,
			rule: "exception:unused",
			message: `stale architecture exception ${edge} no longer matches any source edge (rationale: ${entry.rationale}); remove it once its removal condition holds: ${entry.removalCondition}`,
		});
	}
	return issues;
}
