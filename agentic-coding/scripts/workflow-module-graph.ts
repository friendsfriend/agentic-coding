// Utilities backing the split-workflow-god-modules structural guards and the
// source-layer-boundaries architecture checks:
//   - export-surface diffing (test/workflow-module-exports.test.ts),
//   - the import-cycle check (test/workflow-module-import-cycles.test.ts),
//   - the layer/purity ownership checks
//     (test/workflow-source-layer-boundaries.test.ts).
// Kept as a script rather than src/ code since nothing at runtime depends on
// it. Scans .ts and .tsx sources with the installed TypeScript parser,
// resolving extensionless, explicit-extension, and index targets, and
// collecting static imports/re-exports, literal dynamic-import, and literal
// require() edges.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Sorted list of every name a module makes available via `export`, syntactic
 * only (no type resolution) — enough to diff a barrel's re-export surface
 * against the original file it replaces. */
export function listExportedNames(filePath: string): string[] {
	const sourceText = fs.readFileSync(filePath, "utf8");
	const sourceFile = ts.createSourceFile(
		filePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const names = new Set<string>();
	const addBindingNames = (name: ts.BindingName) => {
		if (ts.isIdentifier(name)) {
			names.add(name.text);
			return;
		}
		for (const element of name.elements)
			if (ts.isBindingElement(element)) addBindingNames(element.name);
	};
	for (const statement of sourceFile.statements) {
		const isExported =
			ts.canHaveModifiers(statement) &&
			ts
				.getModifiers(statement)
				?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
		if (isExported) {
			if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations)
					addBindingNames(declaration.name);
			} else if (
				(ts.isFunctionDeclaration(statement) ||
					ts.isClassDeclaration(statement) ||
					ts.isInterfaceDeclaration(statement) ||
					ts.isTypeAliasDeclaration(statement) ||
					ts.isEnumDeclaration(statement)) &&
				statement.name
			) {
				names.add(statement.name.text);
			}
		}
		if (
			ts.isExportDeclaration(statement) &&
			statement.exportClause &&
			ts.isNamedExports(statement.exportClause)
		) {
			for (const element of statement.exportClause.elements)
				names.add(element.name.text);
		}
		if (ts.isExportAssignment(statement)) names.add("default");
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

function sourceFileFor(file: string): ts.SourceFile {
	const text = fs.readFileSync(file, "utf8");
	return ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}

/** True when a static import/export declaration binds at least one value.
 * `import type` / all-type-only named bindings / `export type` are erased by
 * Bun and tsc, so they cannot form a real ESM load-order cycle (design D5
 * relies on exactly this to let types cross the dependency direction). */
function hasValueBinding(
	clause: ts.ImportClause | ts.NamedExportBindings | undefined,
	declaration: ts.ImportDeclaration | ts.ExportDeclaration,
): boolean {
	if (ts.isExportDeclaration(declaration) && declaration.isTypeOnly)
		return false; // `export type ... from`
	if (ts.isImportDeclaration(declaration)) {
		const importClause = declaration.importClause;
		if (!importClause) return true; // side-effect import
		if (importClause.isTypeOnly) return false; // `import type ... from`
		if (importClause.name) return true;
		const named = importClause.namedBindings;
		if (!named) return false;
		if (ts.isNamespaceImport(named)) return true;
		return named.elements.some((element) => !element.isTypeOnly);
	}
	if (!declaration.moduleSpecifier) return true;
	if (!clause) return true; // `export * from "..."` re-exports values
	if (ts.isNamedExports(clause))
		return clause.elements.some((element) => !element.isTypeOnly);
	return ts.isNamespaceExport(clause);
}

function positionOf(
	sourceFile: ts.SourceFile,
	node: ts.Node,
): { line: number; column: number } {
	const start = node.getStart(sourceFile);
	const loc = sourceFile.getLineAndCharacterOfPosition(start);
	return { line: loc.line + 1, column: loc.character + 1 };
}

const IMPORT_KEYWORD = ts.SyntaxKind.ImportKeyword;

/** Every module dependency a source file declares, including type-only edges,
 * literal dynamic `import()` targets, and literal `require()` calls. */
export function analyzeModule(file: string): ModuleAnalysis {
	const sourceFile = sourceFileFor(file);
	const edges: ModuleEdge[] = [];
	const computedLoading: Array<{ line: number; column: number }> = [];

	const addEdge = (
		node: ts.Node,
		specifier: string,
		kind: ModuleEdgeKind,
		typeOnly: boolean,
	): void => {
		edges.push({
			specifier,
			kind,
			typeOnly,
			...positionOf(sourceFile, node),
			resolved: specifier.startsWith(".")
				? resolveRelative(file, specifier)
				: null,
		});
	};

	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
			addEdge(
				statement.moduleSpecifier,
				statement.moduleSpecifier.text,
				"static",
				!hasValueBinding(statement.importClause, statement),
			);
		} else if (ts.isExportDeclaration(statement)) {
			if (!statement.moduleSpecifier) continue;
			if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
			addEdge(
				statement.moduleSpecifier,
				statement.moduleSpecifier.text,
				"static",
				!hasValueBinding(statement.exportClause, statement),
			);
		}
	}

	const visitCall = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const expression = node.expression;
			if (expression.kind === IMPORT_KEYWORD && node.arguments.length >= 1) {
				const argument = node.arguments[0];
				if (ts.isStringLiteral(argument))
					addEdge(argument, argument.text, "dynamic", false);
				else computedLoading.push(positionOf(sourceFile, argument));
			} else if (
				ts.isIdentifier(expression) &&
				expression.text === "require" &&
				node.arguments.length >= 1
			) {
				const argument = node.arguments[0];
				if (ts.isStringLiteral(argument))
					addEdge(argument, argument.text, "require", false);
				else computedLoading.push(positionOf(sourceFile, argument));
			}
		}
		ts.forEachChild(node, visitCall);
	};
	for (const statement of sourceFile.statements) visitCall(statement);

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
