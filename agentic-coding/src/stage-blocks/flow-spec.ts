// The readable `@playwright/test` projection of a validated flow
// (`add-stage-flow-replay`, task 1.3). Nothing here formats files or runs a
// compiler: the generator owns those boundaries.

import type { FlowSource } from "./flow.ts";
import type { JsonSchema, JsonValue } from "./schema.ts";

export interface RenderedFlowSpec {
	readonly source: string;
	readonly imports: readonly string[];
}

function camel(value: string): string {
	const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
	const head = parts[0] ?? "step";
	const rest = parts
		.slice(1)
		.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`);
	const joined = `${head[0]?.toLowerCase() ?? "s"}${head.slice(1)}${rest.join("")}`;
	return /^[A-Za-z_]/.test(joined) ? joined : `step${joined}`;
}

function variableName(ids: readonly string[]): Map<string, string> {
	const used = new Set<string>();
	const names = new Map<string, string>();
	for (const [index, id] of ids.entries()) {
		let base = `r_${camel(id)}`;
		if (used.has(base)) base = `${base}_${index + 1}`;
		used.add(base);
		names.set(id, base);
	}
	return names;
}

function propertyAccess(path: string): string {
	return path
		.split(".")
		.map((segment) =>
			/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
				? `.${segment}`
				: `[${JSON.stringify(segment)}]`,
		)
		.join("");
}

function typeForSchema(schema: JsonSchema): string {
	if ("anyOf" in schema) {
		return schema.anyOf.map(typeForSchema).join(" | ");
	}
	switch (schema.type) {
		case "string":
			return schema.enum === undefined
				? "string"
				: schema.enum.map((value) => JSON.stringify(value)).join(" | ");
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return `Array<${typeForSchema(schema.items)}>`;
		case "object": {
			const required = new Set(schema.required ?? []);
			const members = Object.entries(schema.properties).map(
				([name, child]) =>
					`${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${typeForSchema(child)}`,
			);
			return members.length === 0
				? "Record<string, never>"
				: `{ ${members.join("; ")} }`;
		}
	}
}

function inputExpression(name: string, schema: JsonSchema | undefined): string {
	const type = schema === undefined ? "unknown" : typeForSchema(schema);
	return `stage.input<${type}>(${JSON.stringify(name)})`;
}

function renderValue(
	value: JsonValue,
	inputSchema: JsonSchema,
	names: ReadonlyMap<string, string>,
	indent: number,
): string {
	const pad = "\t".repeat(indent);
	const childPad = "\t".repeat(indent + 1);
	if (typeof value === "string") {
		const input = /^\{\{\s*inputs\.([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
		if (input) {
			const name = input[1] as string;
			const properties =
				"type" in inputSchema && inputSchema.type === "object"
					? inputSchema.properties
					: {};
			return inputExpression(name, properties[name]);
		}
		const output =
			/^\{\{\s*steps\.([A-Za-z0-9][A-Za-z0-9_-]*)\.outputs\.([A-Za-z0-9_.-]+)\s*\}\}$/.exec(
				value,
			);
		if (output) {
			const variable = names.get(output[1] as string);
			if (variable === undefined)
				throw new Error(
					`output reference ${value} has no generated local variable`,
				);
			return `${variable}${propertyAccess(output[2] as string)}`;
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return `[\n${value
			.map(
				(entry) =>
					`${childPad}${renderValue(entry, inputSchema, names, indent + 1)},`,
			)
			.join("\n")}\n${pad}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length === 0) return "{}";
		return `{\n${entries
			.map(
				([key, entry]) =>
					`${childPad}${JSON.stringify(key)}: ${renderValue(
						entry as JsonValue,
						inputSchema,
						names,
						indent + 1,
					)},`,
			)
			.join("\n")}\n${pad}}`;
	}
	return JSON.stringify(value);
}

export function renderFlowSpec(
	source: FlowSource,
	inputSchema: JsonSchema,
): RenderedFlowSpec {
	return renderWithSchema(source, inputSchema);
}

function renderWithSchema(
	source: FlowSource,
	inputSchema: JsonSchema,
): RenderedFlowSpec {
	const routes = new Map(source.routeMeta.map((meta) => [meta.id, meta]));
	const usedByOthers = new Set<string>();
	for (const step of source.steps)
		for (const text of JSON.stringify(step.args).matchAll(
			/\{\{\s*steps\.([A-Za-z0-9][A-Za-z0-9_-]*)\.outputs\./g,
		))
			usedByOthers.add(text[1] as string);
	const names = variableName(
		source.steps.map((step) => step.id).filter((id) => usedByOthers.has(id)),
	);
	const blocksByApp = new Map<
		string,
		Array<{ blockId: string; importName: string; localName: string }>
	>();
	const usedLocals = new Set<string>();
	for (const step of source.steps) {
		const app = step.definition.app;
		if (app === "*")
			throw new Error(
				`block ${step.definition.id} is cross-application and needs a global import barrel`,
			);
		if (step.definition.exportName === undefined)
			throw new Error(`block ${step.definition.id} has no exportName`);
		const list = blocksByApp.get(app) ?? [];
		const sameBlock = list.find(
			(entry) => entry.blockId === step.definition.id,
		);
		if (sameBlock === undefined) {
			const importName = step.definition.exportName;
			let localName = importName;
			if (usedLocals.has(localName)) localName = `${importName}_${camel(app)}`;
			let suffix = 2;
			while (usedLocals.has(localName))
				localName = `${importName}_${camel(app)}${suffix++}`;
			usedLocals.add(localName);
			list.push({ blockId: step.definition.id, importName, localName });
		}
		blocksByApp.set(app, list);
	}
	const importLines = [...blocksByApp.entries()].map(([app, blocks]) => {
		const names = blocks.map(({ importName, localName }) =>
			importName === localName ? importName : `${importName} as ${localName}`,
		);
		return `import {\n${names.map((name) => `\t${name},`).join("\n")}\n} from ${JSON.stringify(`../../src/stage-blocks/blocks/${app}/index.ts`)};`;
	});
	const lines: string[] = [
		"// Generated by `stage_run save`. Edit the block or the approved plan, not this file.",
		...importLines,
		'import { test } from "../../src/stage-blocks/fixture.ts";',
		"",
		`test.describe(${JSON.stringify(source.title ?? source.flowId)}, () => {`,
		`\ttest(${JSON.stringify(source.flowId)}, async ({ stage }) => {`,
	];
	for (const step of source.steps) {
		const app = step.definition.app;
		const imported = blocksByApp
			.get(app)
			?.find((entry) => entry.blockId === step.definition.id);
		if (imported === undefined)
			throw new Error(`block ${step.definition.id} has no import`);
		const meta = routes.get(step.id);
		if (meta === undefined)
			throw new Error(`route step ${step.id} has no metadata`);
		lines.push(
			`\t\t// route: ${step.id} (${step.definition.id}@${step.definition.version})`,
		);
		const args = renderValue(step.args as JsonValue, inputSchema, names, 2);
		const call = `await stage.run(${JSON.stringify(step.id)}, ${imported.localName}, ${args})`;
		const variable = names.get(step.id);
		lines.push(
			`\t\t${variable === undefined ? call : `const ${variable} = ${call}`};`,
		);
	}
	lines.push("\t});", "});", "");
	return {
		source: lines.join("\n"),
		imports: importLines,
	};
}
