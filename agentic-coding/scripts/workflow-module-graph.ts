// Utilities backing the split-workflow-god-modules structural guards:
// export-surface diffing (test/workflow-module-exports.test.ts) and the
// import-cycle check (test/workflow-module-import-cycles.test.ts). Kept as a
// script rather than src/ code since nothing at runtime depends on it.
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

/** Relative specifiers this file imports at runtime — `import type` and
 * `export type ... from` declarations are excluded because Bun/tsc elide
 * them entirely, so they cannot form a real ESM load-order cycle (design
 * D5 relies on exactly this to let types cross the dependency direction). */
function runtimeImportSpecifiers(sourceFile: ts.SourceFile): string[] {
	const specifiers: string[] = [];
	for (const statement of sourceFile.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			!statement.importClause?.isTypeOnly
		) {
			const clause = statement.importClause;
			const hasValueBinding =
				!clause ||
				clause.name !== undefined ||
				(clause.namedBindings &&
					(ts.isNamespaceImport(clause.namedBindings) ||
						clause.namedBindings.elements.some(
							(element) => !element.isTypeOnly,
						)));
			if (hasValueBinding && ts.isStringLiteral(statement.moduleSpecifier))
				specifiers.push(statement.moduleSpecifier.text);
		}
		if (
			ts.isExportDeclaration(statement) &&
			!statement.isTypeOnly &&
			statement.moduleSpecifier &&
			ts.isStringLiteral(statement.moduleSpecifier)
		) {
			const clause = statement.exportClause;
			const hasValueBinding =
				!clause ||
				(ts.isNamedExports(clause) &&
					clause.elements.some((element) => !element.isTypeOnly)) ||
				ts.isNamespaceExport(clause);
			if (hasValueBinding) specifiers.push(statement.moduleSpecifier.text);
		}
	}
	return specifiers;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
	const base = path.resolve(path.dirname(fromFile), specifier);
	const candidates = [base, `${base}.ts`, path.join(base, "index.ts")];
	for (const candidate of candidates)
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
			return candidate;
	return null;
}

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listTsFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** Adjacency map (absolute file path -> absolute file paths it imports via a
 * relative specifier) for every `.ts` file under `dir`. */
export function buildImportGraph(dir: string): Map<string, string[]> {
	const graph = new Map<string, string[]>();
	for (const file of listTsFiles(dir)) {
		const text = fs.readFileSync(file, "utf8");
		const sourceFile = ts.createSourceFile(
			file,
			text,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		const targets: string[] = [];
		for (const specifier of runtimeImportSpecifiers(sourceFile)) {
			if (!specifier.startsWith(".")) continue;
			const resolved = resolveRelative(file, specifier);
			if (resolved) targets.push(resolved);
		}
		graph.set(file, targets);
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
