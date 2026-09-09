// Source-layer ownership and pure-domain guardrails backing
// test/workflow-source-layer-boundaries.test.ts (enforce-source-layer-
// boundaries). These are bounded static checks over the installed TypeScript
// AST: they are not a sandbox, a whole-program purity proof, or a linter.
//
// Layers (path classification):
//   domain       pure definitions, contracts, and step behavior
//   runtime      persistence, effects, engine internals, I/O helpers
//   application  shared orchestration (startup, operations, wiki, config)
//   cli          workflow CLI command modules and barrels
//   tui-feature  dashboard and observability feature implementations
//   tui-shared   shared TUI primitives and theme data
//   tui-app      TUI shell entry points and lifecycle glue
//   root         composition roots and foundational clients

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
	buildImportGraph,
	buildSourceAnalysis,
	findImportCycle,
} from "./workflow-module-graph.ts";

export type SourceLayer =
	| "domain"
	| "runtime"
	| "application"
	| "cli"
	| "tui-feature"
	| "tui-shared"
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
];
const RUNTIME_FILES = [
	"workflow/effects.ts",
	"workflow/effect-runner.ts",
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
];
const APPLICATION_FILES = [
	"workflow/startup.ts",
	"workflow/operations.ts",
	"workflow/application.ts", // named application composition root (CLI/dashboard), complete-workflow-effect-cutover task 1
];
const ROOT_FILES = ["cli.ts", "herdr-client.ts"];

/** Classify a project-relative source path (posix separators). */
export function classifySourcePath(relPath: string): SourceLayer | null {
	if (DOMAIN_FILES.includes(relPath)) return "domain";
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

	if (relPath.startsWith("tui/dash/") || relPath.startsWith("tui/otel/"))
		return "tui-feature";
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
		"tui-feature",
	]),
	"tui-shared": new Set(["tui-shared", "root"]),
	"tui-app": new Set([
		"domain",
		"runtime",
		"application",
		"root",
		"tui-shared",
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
	const sourceText = fs.readFileSync(file, "utf8");
	const sourceFile = ts.createSourceFile(
		file,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const found: Array<{ line: number; column: number; label: string }> = [];
	const locate = (node: ts.Node) => {
		const start = node.getStart(sourceFile);
		const loc = sourceFile.getLineAndCharacterOfPosition(start);
		return { line: loc.line + 1, column: loc.character + 1 };
	};
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (ts.isIdentifier(callee) && callee.text === "fetch") {
				found.push({ ...locate(callee), label: "fetch" });
			} else if (
				ts.isPropertyAccessExpression(callee) &&
				ts.isIdentifier(callee.expression) &&
				callee.expression.text === "Date" &&
				callee.name.text === "now"
			) {
				found.push({ ...locate(callee), label: "Date.now" });
			} else if (
				ts.isPropertyAccessExpression(callee) &&
				ts.isIdentifier(callee.expression) &&
				callee.expression.text === "Bun" &&
				["spawn", "spawnSync", "write", "read", "file"].includes(
					callee.name.text,
				)
			) {
				found.push({
					...locate(callee),
					label: `Bun.${callee.name.text}`,
				});
			} else if (
				ts.isPropertyAccessExpression(callee) &&
				ts.isIdentifier(callee.expression) &&
				callee.expression.text === "process" &&
				["cwd", "chdir", "exit", "stdout", "stderr", "stdin"].includes(
					callee.name.text,
				)
			) {
				found.push({
					...locate(callee),
					label: `process.${callee.name.text}`,
				});
			}
		} else if (
			ts.isNewExpression(node) &&
			node.expression.getText(sourceFile) === "Date" &&
			(node.arguments?.length ?? 0) === 0
		) {
			found.push({ ...locate(node), label: "new Date()" });
		}
		ts.forEachChild(node, visit);
	};
	for (const statement of sourceFile.statements) visit(statement);
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
	const sourceText = fs.readFileSync(file, "utf8");
	const sourceFile = ts.createSourceFile(
		file,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const found: Array<{ line: number; column: number; label: string }> = [];
	const locate = (node: ts.Node) => {
		const start = node.getStart(sourceFile);
		const loc = sourceFile.getLineAndCharacterOfPosition(start);
		return { line: loc.line + 1, column: loc.character + 1 };
	};
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (
				ts.isPropertyAccessExpression(callee) &&
				RUNTIME_EXECUTION_NAMES.has(callee.name.text) &&
				ts.isIdentifier(callee.expression) &&
				RUNTIME_EXECUTION_RECEIVERS.has(callee.expression.text)
			) {
				found.push({
					...locate(callee.name),
					label: `${callee.expression.text}.${callee.name.text}`,
				});
			} else if (
				ts.isIdentifier(callee) &&
				RUNTIME_EXECUTION_NAMES.has(callee.text)
			) {
				found.push({ ...locate(callee), label: callee.text });
			}
		}
		ts.forEachChild(node, visit);
	};
	for (const statement of sourceFile.statements) visit(statement);
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
		const sourceText = fs.readFileSync(moduleFile, "utf8");
		const sourceFile = ts.createSourceFile(
			moduleFile,
			sourceText,
			ts.ScriptTarget.Latest,
			true,
			moduleFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);
		const symbolSet = new Set(symbols);
		const locate = (node: ts.Node) => {
			const start = node.getStart(sourceFile);
			const loc = sourceFile.getLineAndCharacterOfPosition(start);
			return { line: loc.line + 1, column: loc.character + 1 };
		};
		const report = (name: string, node: ts.Node, kind: string) =>
			issues.push({
				file: moduleFile,
				...locate(node),
				rule: "shim:obsolete",
				message: `${moduleRel} ${kind} obsolete migration bridge symbol ${name}; consume the Effect application boundary instead`,
			});
		const declared = (name: string) => symbolSet.has(name);
		for (const statement of sourceFile.statements) {
			const isExported =
				ts.canHaveModifiers(statement) &&
				ts
					.getModifiers(statement)
					?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
			if (isExported) {
				if (ts.isVariableStatement(statement)) {
					for (const declaration of statement.declarationList.declarations) {
						const name = declaration.name.getText(sourceFile);
						if (declared(name)) report(name, statement, "declares exported");
					}
				}
				if (
					ts.isFunctionDeclaration(statement) &&
					statement.name &&
					declared(statement.name.text)
				)
					report(statement.name.text, statement, "declares exported");
				if (
					ts.isClassDeclaration(statement) &&
					statement.name &&
					declared(statement.name.text)
				)
					report(statement.name.text, statement, "declares exported");
				if (
					ts.isTypeAliasDeclaration(statement) &&
					statement.name &&
					declared(statement.name.text)
				)
					report(statement.name.text, statement, "declares type");
				if (
					ts.isInterfaceDeclaration(statement) &&
					statement.name &&
					declared(statement.name.text)
				)
					report(statement.name.text, statement, "declares interface");
				if (ts.isExportDeclaration(statement) && statement.exportClause) {
					const clause = statement.exportClause;
					if (ts.isNamedExports(clause)) {
						for (const element of clause.elements) {
							if (declared(element.name.text))
								report(element.name.text, element, "re-exports obsolete");
						}
					}
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
