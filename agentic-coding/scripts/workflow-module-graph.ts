// Utilities backing the split-workflow-god-modules structural guards and the
// source-layer-boundaries architecture checks:
//   - export-surface diffing (test/workflow-module-exports.test.ts),
//   - the import-cycle check (test/workflow-module-import-cycles.test.ts),
//   - the layer/purity ownership checks
//     (test/workflow-source-layer-boundaries.test.ts).
// Kept as a script rather than src/ code since nothing at runtime depends on
// it. Scans .ts and .tsx sources with the Babel parser (TypeScript 7 removed
// the synchronous `ts.createSourceFile` API),
// resolving extensionless, explicit-extension, and index targets, and
// collecting static imports/re-exports, literal dynamic-import, and literal
// require() edges.
import fs from "node:fs";
import path from "node:path";
import {
	isCallExpression,
	isClassDeclaration,
	isExportAllDeclaration,
	isExportDefaultDeclaration,
	isExportNamedDeclaration,
	isFunctionDeclaration,
	isIdentifier,
	isImportDeclaration,
	isOptionalCallExpression,
	isStringLiteral,
	isTSEnumDeclaration,
	isTSInterfaceDeclaration,
	isTSTypeAliasDeclaration,
	isVariableDeclaration,
	type Node,
	traverseFast,
} from "@babel/types";
import {
	collectBindingNames,
	exportBindsValue,
	exportedName,
	importBindsValue,
	parseSource,
	positionOf,
} from "./source-ast.ts";

/** Sorted list of every name a module makes available via `export`, syntactic
 * only (no type resolution) — enough to diff a barrel's re-export surface
 * against the original file it replaces. */
export function listExportedNames(filePath: string): string[] {
	const source = parseSource(filePath, fs.readFileSync(filePath, "utf8"));
	const names = new Set<string>();
	for (const statement of source.statements) {
		if (isExportNamedDeclaration(statement)) {
			const declaration = statement.declaration;
			if (declaration) {
				if (isVariableDeclaration(declaration)) {
					for (const declarator of declaration.declarations)
						collectBindingNames(declarator.id, names);
				} else if (
					(isFunctionDeclaration(declaration) ||
						isClassDeclaration(declaration) ||
						isTSInterfaceDeclaration(declaration) ||
						isTSTypeAliasDeclaration(declaration) ||
						isTSEnumDeclaration(declaration)) &&
					declaration.id
				) {
					names.add(declaration.id.name);
				}
			}
			for (const specifier of statement.specifiers)
				if (specifier.type === "ExportSpecifier") {
					const name = exportedName(specifier);
					if (name) names.add(name);
				}
		} else if (
			isExportDefaultDeclaration(statement) ||
			statement.type === "TSExportAssignment"
		) {
			names.add("default");
		}
	}
	return Array.from(names).sort();
}

/** How a module-level dependency is expressed. */
export type ModuleEdgeKind = "static" | "dynamic" | "require";

/** One dependency reference found in a source module. */
export interface ModuleEdge {
	/** Raw specifier text (relative, external, or builtin). */
	specifier: string;
	kind: ModuleEdgeKind;
	/** True when the reference is fully erased at runtime (`import type`,
	 * `export type ... from`, or a type-position dynamic import). Such edges
	 * cannot close an ESM load-order cycle but still express architectural
	 * coupling. */
	typeOnly: boolean;
	/** 1-based location of the reference, for actionable diagnostics. */
	line: number;
	column: number;
	/** Absolute resolved target for project-relative specifiers, or null when
	 * the relative target does not resolve. */
	resolved: string | null;
}

export interface ModuleAnalysis {
	file: string;
	edges: ModuleEdge[];
	/** Relative runtime targets that could not be resolved. */
	unresolved: ModuleEdge[];
	/** Non-relative specifiers (builtin or bare package). */
	external: ModuleEdge[];
	/** `import(<expression>)` / `require(<expression>)` calls with a
	 * non-literal argument, which escape static resolution. */
	computedLoading: Array<{ line: number; column: number }>;
}

/** Every module dependency a source file declares, including type-only edges,
 * literal dynamic `import()` targets, and literal `require()` calls. */
export function analyzeModule(file: string): ModuleAnalysis {
	const source = parseSource(file, fs.readFileSync(file, "utf8"));
	const edges: ModuleEdge[] = [];
	const computedLoading: Array<{ line: number; column: number }> = [];

	const addEdge = (
		node: Node,
		specifier: string,
		kind: ModuleEdgeKind,
		typeOnly: boolean,
	): void => {
		edges.push({
			specifier,
			kind,
			typeOnly,
			...positionOf(node),
			resolved: specifier.startsWith(".")
				? resolveRelative(file, specifier)
				: null,
		});
	};

	for (const statement of source.statements) {
		if (isImportDeclaration(statement) && isStringLiteral(statement.source)) {
			addEdge(
				statement.source,
				statement.source.value,
				"static",
				!importBindsValue(statement),
			);
		} else if (
			(isExportNamedDeclaration(statement) ||
				isExportAllDeclaration(statement)) &&
			statement.source &&
			isStringLiteral(statement.source)
		) {
			addEdge(
				statement.source,
				statement.source.value,
				"static",
				!exportBindsValue(statement),
			);
		}
	}

	const visitCall = (node: Node): void => {
		if (isCallExpression(node) || isOptionalCallExpression(node)) {
			const expression = node.callee;
			if (expression.type === "Import" && node.arguments.length >= 1) {
				const argument = node.arguments[0];
				if (isStringLiteral(argument))
					addEdge(argument, argument.value, "dynamic", false);
				else computedLoading.push(positionOf(argument));
			} else if (
				isIdentifier(expression) &&
				expression.name === "require" &&
				node.arguments.length >= 1
			) {
				const argument = node.arguments[0];
				if (isStringLiteral(argument))
					addEdge(argument, argument.value, "require", false);
				else computedLoading.push(positionOf(argument));
			}
		}
	};
	for (const statement of source.statements) traverseFast(statement, visitCall);

	return {
		file,
		edges,
		unresolved: edges.filter(
			(edge) =>
				edge.specifier.startsWith(".") &&
				!edge.typeOnly &&
				edge.resolved === null,
		),
		external: edges.filter((edge) => !edge.specifier.startsWith(".")),
		computedLoading,
	};
}

/** Resolve a project-relative specifier against the importing file using the
 * repository's conventions: explicit extensions (.ts/.tsx/.json),
 * extensionless files, and index.ts/index.tsx/index.json directories. */
export function resolveRelative(
	fromFile: string,
	specifier: string,
): string | null {
	const base = path.resolve(path.dirname(fromFile), specifier);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.json`,
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
		path.join(base, "index.json"),
	];
	for (const candidate of candidates)
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
			return candidate;
	return null;
}

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listSourceFiles(full));
		else if (
			entry.isFile() &&
			(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
		)
			out.push(full);
	}
	return out;
}

/** Type/analysis information for every `.ts`/`.tsx` file under `dir`. */
export function buildSourceAnalysis(dir: string): Map<string, ModuleAnalysis> {
	const analysis = new Map<string, ModuleAnalysis>();
	for (const file of listSourceFiles(dir))
		analysis.set(file, analyzeModule(file));
	return analysis;
}

/** Runtime relative edges of a module analysis — value imports/re-exports and
 * literal dynamic/require targets, excluding type-only references. */
export function runtimeRelativeTargets(analysis: ModuleAnalysis): string[] {
	const targets: string[] = [];
	for (const edge of analysis.edges) {
		if (edge.typeOnly) continue;
		if (!edge.specifier.startsWith(".")) continue;
		if (edge.resolved) targets.push(edge.resolved);
	}
	return targets;
}

/** Adjacency map (absolute file path -> absolute file paths it imports via a
 * relative runtime specifier) for every `.ts`/`.tsx` file under `dir`.
 * Backing the import-cycle checks: type-only references are excluded because
 * Bun/tsc elide them entirely, so they cannot form a real ESM load-order
 * cycle; literal dynamic imports and require() calls are included. */
export function buildImportGraph(dir: string): Map<string, string[]> {
	const graph = new Map<string, string[]>();
	for (const [file, analysis] of buildSourceAnalysis(dir)) {
		graph.set(file, runtimeRelativeTargets(analysis));
	}
	return graph;
}

/** First cycle found as a list of file paths (closing back on the first
 * element), or `null` if the graph is acyclic. */
export function findImportCycle(graph: Map<string, string[]>): string[] | null {
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];
	const visit = (node: string): string[] | null => {
		state.set(node, "visiting");
		stack.push(node);
		for (const next of graph.get(node) ?? []) {
			const nextState = state.get(next);
			if (nextState === "visiting") {
				const start = stack.indexOf(next);
				return [...stack.slice(start), next];
			}
			if (nextState !== "done") {
				const found = visit(next);
				if (found) return found;
			}
		}
		stack.pop();
		state.set(node, "done");
		return null;
	};
	for (const node of graph.keys()) {
		if (state.get(node) !== "done") {
			const found = visit(node);
			if (found) return found;
		}
	}
	return null;
}
