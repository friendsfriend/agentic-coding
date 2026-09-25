// Babel-backed source parsing shared by the workflow structural guards
// (scripts/workflow-module-graph.ts, scripts/workflow-architecture.ts).
//
// TypeScript 7 removed the synchronous compiler API (`ts.createSourceFile`,
// `ts.SyntaxKind`, `ts.is*`) these guards were built on, so they parse with
// `@babel/parser` instead. This module owns the parse configuration and the
// small AST helpers both guards need; everything else stays in the guards.
import fs from "node:fs";
import { type ParserPlugin, parse } from "@babel/parser";
import {
	type ExportAllDeclaration,
	type ExportNamedDeclaration,
	type ExportSpecifier,
	type ImportDeclaration,
	isArrayPattern,
	isAssignmentPattern,
	isIdentifier,
	isObjectPattern,
	isRestElement,
	type Node,
	type Statement,
} from "@babel/types";

/** TypeScript syntax plugins. JSX is only enabled for `.tsx` so generic arrow
 * functions and angle-bracket assertions in `.ts` are not read as JSX. */
const TS_PLUGINS: ParserPlugin[] = [
	"typescript",
	"decorators-legacy",
	"importAttributes",
	"explicitResourceManagement",
];

export interface ParsedSource {
	file: string;
	text: string;
	/** Top-level statements of the module. */
	statements: Statement[];
}

/** Parse a module's text. Mirrors the old `ts.createSourceFile` entry point:
 * a syntax tree with `statements`, no program/type resolution. */
export function parseSource(file: string, text: string): ParsedSource {
	const plugins = file.endsWith(".tsx")
		? [...TS_PLUGINS, "jsx" as ParserPlugin]
		: TS_PLUGINS;
	const ast = parse(text, {
		sourceType: "module",
		plugins,
		errorRecovery: false,
	});
	return { file, text, statements: ast.program.body };
}

/** Read + parse one source file. */
export function parseSourceFile(file: string): ParsedSource {
	return parseSource(file, fs.readFileSync(file, "utf8"));
}

/** 1-based line / column of a node's start, matching the previous TypeScript
 * diagnostics (`getStart` + `getLineAndCharacterOfPosition`). */
export function positionOf(node: Node): { line: number; column: number } {
	const start = node.loc?.start;
	return { line: start?.line ?? 1, column: (start?.column ?? 0) + 1 };
}

/** Exact source slice a node covers. */
export function textOf(source: ParsedSource, node: Node): string {
	if (node.start === null || node.end === null) return "";
	return source.text.slice(node.start, node.end);
}

/** Every identifier a binding pattern introduces, including destructured,
 * defaulted, and rest bindings. */
export function collectBindingNames(pattern: Node, out: Set<string>): void {
	if (isIdentifier(pattern)) {
		out.add(pattern.name);
		return;
	}
	if (isObjectPattern(pattern)) {
		for (const property of pattern.properties) {
			if (property.type === "ObjectProperty")
				collectBindingNames(property.value, out);
			else if (isRestElement(property))
				collectBindingNames(property.argument, out);
		}
		return;
	}
	if (isArrayPattern(pattern)) {
		for (const element of pattern.elements)
			if (element) collectBindingNames(element, out);
		return;
	}
	if (isAssignmentPattern(pattern)) {
		collectBindingNames(pattern.left, out);
		return;
	}
	if (isRestElement(pattern)) collectBindingNames(pattern.argument, out);
}

/** The exported name of an `export { local as exported }` specifier. */
export function exportedName(specifier: ExportSpecifier): string | undefined {
	return specifier.exported.type === "Identifier"
		? specifier.exported.name
		: specifier.exported.value;
}

/** True when a static import declaration binds at least one value. `import
 * type` / all-type-only named bindings are erased by Bun and tsc, so they
 * cannot form a real ESM load-order cycle (design D5 relies on exactly this
 * to let types cross the dependency direction). */
export function importBindsValue(declaration: ImportDeclaration): boolean {
	if (declaration.importKind === "type") return false;
	if (declaration.specifiers.length === 0) return true; // side-effect import
	return declaration.specifiers.some((specifier) => {
		if (
			specifier.type === "ImportDefaultSpecifier" ||
			specifier.type === "ImportNamespaceSpecifier"
		)
			return true;
		return (
			specifier.type === "ImportSpecifier" &&
			specifier.importKind !== "type" &&
			specifier.importKind !== "typeof"
		);
	});
}

/** Value-binding counterpart of {@link importBindsValue} for module-specifier
 * exports: `export * from` re-exports values, `export type ...` is erased. */
export function exportBindsValue(
	declaration: ExportNamedDeclaration | ExportAllDeclaration,
): boolean {
	if (declaration.type === "ExportAllDeclaration")
		return declaration.exportKind !== "type";
	if (declaration.exportKind === "type") return false;
	if (declaration.specifiers.length === 0) return false; // `export {} from`
	return declaration.specifiers.some((specifier) => {
		if (specifier.type === "ExportNamespaceSpecifier") return true;
		return (
			specifier.type === "ExportSpecifier" && specifier.exportKind !== "type"
		);
	});
}
