// Self-correcting tool failures (efficiency backlog item 12). Two kinds of
// check: the module's own pure logic and path search against a fake filesystem
// (`tool-suggestions.ts`), and the tool path itself — pi-durable's `read` and
// `edit` wrapped by `suggestingCodingTools()` over a real `NodeExecutionEnv` in a
// temporary tree — so what the model actually reads back from a failure is
// asserted, not just what the module returns.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	type DirectoryEntry,
	editFailureHint,
	matchingLineNumbers,
	nearestExistingPath,
	nearestMatchWindow,
	overlappingEditIndexes,
	pathFailureHint,
	renderMatchWindow,
	renderPathSuggestion,
	type SuggestionDeps,
	type SuggestionFs,
	type SuggestionLimits,
	suggestingCodingTools,
	TOOL_SUGGESTION_LIMITS,
} from "../src/agent-host/tool-suggestions.ts";

const FILE = [
	"export function a() {",
	"\tconst x = 1;",
	"\treturn x;",
	"}",
	"",
	"export function b() {",
	"\tconst x = 1;",
	"}",
].join("\n");

/** A filesystem built from two literal trees: directory listings by absolute
 * path, and file text by absolute path. Records what the search read. */
function fakeFs(input: {
	readonly dirs?: Record<string, readonly DirectoryEntry[]>;
	readonly files?: Record<string, string>;
}) {
	const dirs = input.dirs ?? {};
	const files = input.files ?? {};
	const probes: string[] = [];
	const listings: string[] = [];
	const fsFacade: SuggestionFs = {
		async kind(target) {
			probes.push(target);
			if (target in dirs) return "directory";
			if (target in files) return "file";
			return undefined;
		},
		async list(target) {
			listings.push(target);
			return dirs[target] ?? [];
		},
		async readText(target) {
			return files[target];
		},
	};
	return { probes, listings, fs: fsFacade };
}

function depsFor(
	cwd: string,
	fsFacade: SuggestionFs,
	limits?: Partial<SuggestionLimits>,
): SuggestionDeps {
	return {
		cwd,
		fs: fsFacade,
		limits: { ...TOOL_SUGGESTION_LIMITS, ...limits },
		resolve: async (requested) => path.resolve(cwd, requested),
	};
}

describe("edit failure suggestions", () => {
	test("a not-found oldText names the nearest whitespace-normalised region", () => {
		const window = nearestMatchWindow(
			FILE,
			"export function a() {\n  const x = 1;\n  return x;",
		);
		expect(window).toEqual({
			startLine: 1,
			endLine: 3,
			matchedLines: 3,
			totalLines: 3,
		});
		const hint = editFailureHint({
			message:
				"Could not find the exact text in src/a.ts. The old text must match exactly including all whitespace and newlines.",
			displayPath: "src/a.ts",
			edits: [
				{
					oldText: "export function a() {\n  const x = 1;\n  return x;",
					newText: "x",
				},
			],
			content: FILE,
		});
		expect(hint).toContain("did you mean lines 1-3 of src/a.ts");
		expect(hint).toContain(
			"nearest match, 3/3 lines equal ignoring whitespace",
		);
		// The excerpt reads as the file does, line numbers included.
		expect(hint).toContain("> 1 | export function a() {");
		expect(hint).toContain("> 2 | \tconst x = 1;");
	});

	test("an indentation-only difference still matches, a different text does not", () => {
		expect(nearestMatchWindow(FILE, "  const x = 1;  ")).toEqual({
			startLine: 2,
			endLine: 2,
			matchedLines: 1,
			totalLines: 1,
		});
		expect(nearestMatchWindow(FILE, "const y = 42;")).toBeUndefined();
		expect(
			editFailureHint({
				message:
					"Could not find edits[0] in src/a.ts. The oldText must match exactly.",
				displayPath: "src/a.ts",
				edits: [{ oldText: "const y = 42;", newText: "z" }],
				content: FILE,
			}),
		).toBeUndefined();
	});

	test("a non-unique oldText lists the lines it occurs at", () => {
		expect(matchingLineNumbers(FILE, "\tconst x = 1;")).toEqual([2, 7]);
		const hint = editFailureHint({
			message:
				"Found 2 occurrences of edits[0] in src/a.ts. Each oldText must be unique. Please provide more context to make it unique.",
			displayPath: "src/a.ts",
			edits: [{ oldText: "\tconst x = 1;", newText: "z" }],
			content: FILE,
		});
		expect(hint).toContain("did you mean one of these?");
		expect(hint).toContain("line 2, line 7");
		expect(hint).toContain("add surrounding context to make it unique");
	});

	test("overlapping edits are named by index and line", () => {
		const pairs = overlappingEditIndexes(FILE, [
			{ oldText: "export function a() {\n\tconst x = 1;", newText: "y" },
			{ oldText: "\tconst x = 1;\n\treturn x;", newText: "y" },
			{ oldText: "export function b() {", newText: "y" },
		]);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]?.first).toBe(0);
		expect(pairs[0]?.second).toBe(1);
		const hint = editFailureHint({
			message:
				"edits[0] and edits[1] overlap in src/a.ts. Merge them into one edit or target disjoint regions.",
			displayPath: "src/a.ts",
			edits: [
				{ oldText: "export function a() {\n\tconst x = 1;", newText: "y" },
				{ oldText: "\tconst x = 1;\n\treturn x;", newText: "y" },
			],
			content: FILE,
		});
		expect(hint).toContain(
			"edits[0] (lines 1-2) and edits[1] (lines 2-3) overlap",
		);
		expect(hint).toContain("merge each pair into one edit");
	});

	test("an unrelated edit failure gains nothing", () => {
		expect(
			editFailureHint({
				message:
					"No changes made to src/a.ts. The replacements produced identical content.",
				displayPath: "src/a.ts",
				edits: [{ oldText: "a", newText: "a" }],
				content: FILE,
			}),
		).toBeUndefined();
	});

	test("the excerpt is bounded by the line and character caps", () => {
		const long = Array.from(
			{ length: 400 },
			(_, index) => `line ${index}`,
		).join("\n");
		const window = nearestMatchWindow(long, "line 0");
		if (window === undefined) throw new Error("expected a match");
		const rendered = renderMatchWindow(long, window, "big.ts", {
			...TOOL_SUGGESTION_LIMITS,
			maxLines: 4,
			maxChars: 120,
			contextLines: 3,
		});
		expect(rendered.split("\n").length).toBeLessThanOrEqual(4);
		expect(rendered.length).toBeLessThanOrEqual(120);
		expect(rendered.endsWith("…")).toBe(true);
	});
});

describe("missing path suggestions", () => {
	const wrongRoot = {
		"/repo": [{ name: "agentic-coding", kind: "directory" }],
		"/repo/agentic-coding": [{ name: "src", kind: "directory" }],
		"/repo/agentic-coding/src": [{ name: "x.ts", kind: "file" }],
	};
	const wrongRootFiles = {
		"/repo/agentic-coding/src/x.ts": "export const x = 1;\n",
	};

	test("a path under a descendant directory is suggested", async () => {
		const fake = fakeFs({ dirs: wrongRoot, files: wrongRootFiles });
		const deps = depsFor("/repo", fake.fs);
		const suggestion = await nearestExistingPath("src/x.ts", deps);
		expect(suggestion).toEqual({
			requested: "src/x.ts",
			kind: "file",
			path: "agentic-coding/src/x.ts",
		});
		expect(await pathFailureHint("src/x.ts", deps)).toBe(
			"did you mean agentic-coding/src/x.ts? (src/x.ts resolves from the run's working directory /repo)",
		);
	});

	test("the same path under an ancestor directory is suggested", async () => {
		const fake = fakeFs({
			dirs: {
				"/repo": [],
				"/repo/agentic-coding": [{ name: "src", kind: "directory" }],
				"/repo/agentic-coding/src": [],
			},
			files: { "/repo/src/x.ts": "export const x = 1;\n" },
		});
		const deps = depsFor("/repo/agentic-coding", fake.fs);
		expect(await nearestExistingPath("src/x.ts", deps)).toEqual({
			requested: "src/x.ts",
			kind: "file",
			path: "../src/x.ts",
		});
	});

	test("a same-named file is the fallback when no joined path exists", async () => {
		const fake = fakeFs({
			dirs: {
				"/repo": [{ name: "shallow", kind: "directory" }],
				"/repo/shallow": [
					{ name: "y.ts", kind: "file" },
					{ name: "inner", kind: "directory" },
				],
				"/repo/shallow/inner": [{ name: "y.ts", kind: "file" }],
			},
			files: {
				"/repo/shallow/y.ts": "a",
				"/repo/shallow/inner/y.ts": "b",
			},
		});
		const deps = depsFor("/repo", fake.fs);
		const suggestion = await nearestExistingPath("elsewhere/y.ts", deps);
		// The closest same-named file wins: one level down, not two.
		expect(suggestion?.path).toBe("shallow/y.ts");
	});

	test("nothing close is no suggestion at all", async () => {
		const fake = fakeFs({ dirs: { "/repo": [] } });
		const deps = depsFor("/repo", fake.fs);
		expect(await nearestExistingPath("src/x.ts", deps)).toBeUndefined();
		expect(await pathFailureHint("src/x.ts", deps)).toBeUndefined();
	});

	test("a directory is named as one, with its first entries", async () => {
		const fake = fakeFs({
			dirs: {
				"/repo": [{ name: "src", kind: "directory" }],
				"/repo/src": [
					{ name: "a.ts", kind: "file" },
					{ name: "b.ts", kind: "file" },
					{ name: "nested", kind: "directory" },
				],
			},
		});
		const deps = depsFor("/repo", fake.fs);
		const suggestion = await nearestExistingPath("src", deps);
		if (suggestion === undefined) throw new Error("expected a suggestion");
		expect(suggestion.kind).toBe("directory");
		expect(renderPathSuggestion(suggestion, deps)).toBe(
			"did you mean a file inside src? that path is a directory; its first entries are a.ts, b.ts, nested/.",
		);
	});

	test("the entries of a directory suggestion are bounded", async () => {
		const many = Array.from({ length: 40 }, (_, index) => ({
			name: `f${index}.ts`,
			kind: "file",
		}));
		const fake = fakeFs({
			dirs: {
				"/repo": [{ name: "src", kind: "directory" }],
				"/repo/src": many,
			},
		});
		const deps = depsFor("/repo", fake.fs, { maxDirectoryEntries: 3 });
		const suggestion = await nearestExistingPath("src", deps);
		if (suggestion === undefined) throw new Error("expected a suggestion");
		const rendered = renderPathSuggestion(suggestion, deps);
		expect(rendered).toContain(
			"first entries are f0.ts, f1.ts, f2.ts (and 37 more)",
		);
	});

	test("the search reads no more than the entry cap and stops at the depth cap", async () => {
		const wide = Array.from({ length: 5_000 }, (_, index) => ({
			name: `dir${index}`,
			kind: "directory",
		}));
		const capped = fakeFs({ dirs: { "/repo": wide } });
		const deps = depsFor("/repo", capped.fs, { maxEntries: 50 });
		expect(await nearestExistingPath("src/x.ts", deps)).toBeUndefined();
		expect(capped.listings).toEqual(["/repo"]);
		expect(capped.probes.length).toBeLessThanOrEqual(51);

		const deep = fakeFs({
			dirs: {
				"/repo": [{ name: "a", kind: "directory" }],
				"/repo/a": [{ name: "b", kind: "directory" }],
				"/repo/a/b": [{ name: "c", kind: "directory" }],
				"/repo/a/b/c": [],
			},
			files: { "/repo/a/b/c/x.ts": "deep" },
		});
		expect(
			await nearestExistingPath(
				"x.ts",
				depsFor("/repo", deep.fs, { maxDepth: 2 }),
			),
		).toBeUndefined();
		expect(
			(
				await nearestExistingPath(
					"x.ts",
					depsFor("/repo", deep.fs, { maxDepth: 4 }),
				)
			)?.path,
		).toBe("a/b/c/x.ts");
	});
});

// ---------------------------------------------------------------------------
// Through the tool itself
// ---------------------------------------------------------------------------

function suggestingTool(name: string): ToolRegistration {
	const tool = (suggestingCodingTools().tools ?? []).find(
		(item) => item.name === name,
	);
	if (!tool) throw new Error(`${name} tool not found`);
	return tool;
}

/** Run a tool the way the harness does: what the model would see is the content
 * the call published plus the error text a throw records. */
async function callTool(
	tool: ToolRegistration,
	args: Record<string, unknown>,
	env: unknown,
): Promise<{ readonly error?: Error; readonly text: string }> {
	const chunks: string[] = [];
	const api = {
		conversationId: 1,
		callId: "call-1",
		env,
		output: (chunk: string | Uint8Array) => {
			chunks.push(
				typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
			);
		},
		diagnostic: () => {},
		details: async () => {},
	};
	try {
		await tool.execute(
			args as never,
			api as never,
			BACKGROUND_CONTEXT as never,
		);
		return { text: chunks.join("") };
	} catch (error) {
		return { error: error as Error, text: chunks.join("") };
	}
}

/** A temporary repository whose package lives one level down — the wrong-root
 * mistake item 12 measured nine times in one run. */
function repository(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tool-suggestions-"));
	fs.mkdirSync(path.join(root, "pkg", "src"), { recursive: true });
	return root;
}

describe("the tools a durable run is offered", () => {
	test("an edit under the wrong root suggests the path the file really has", async () => {
		const root = repository();
		try {
			fs.writeFileSync(path.join(root, "pkg/src/x.ts"), FILE);
			const env = new NodeExecutionEnv({ cwd: root, shellEnv: {} });
			const result = await callTool(
				suggestingTool("edit"),
				{ path: "src/x.ts", edits: [{ oldText: "x", newText: "y" }] },
				env,
			);
			// The tool's own message stays first; the suggestion follows it.
			expect(
				result.error?.message.startsWith("Could not edit file: src/x.ts."),
			).toBe(true);
			expect(result.error?.message).toContain("did you mean pkg/src/x.ts?");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("an edit whose text cannot be found points at the nearest region", async () => {
		const root = repository();
		try {
			fs.writeFileSync(path.join(root, "pkg/src/x.ts"), FILE);
			const env = new NodeExecutionEnv({ cwd: root, shellEnv: {} });
			const result = await callTool(
				suggestingTool("edit"),
				{
					path: "pkg/src/x.ts",
					edits: [
						{
							oldText: "export function a() {\nconst x = 1;\n}",
							newText: "export function a() { return 1; }",
						},
					],
				},
				env,
			);
			expect(result.error?.message).toContain(
				"Could not find the exact text in pkg/src/x.ts.",
			);
			expect(result.error?.message).toContain(
				"did you mean lines 1-3 of pkg/src/x.ts",
			);
			expect(result.error?.message).toContain("> 2 | \tconst x = 1;");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("reading a directory says so and lists its entries", async () => {
		const root = repository();
		try {
			fs.writeFileSync(path.join(root, "pkg/src/x.ts"), "x\n");
			const env = new NodeExecutionEnv({ cwd: root, shellEnv: {} });
			const result = await callTool(
				suggestingTool("read"),
				{ path: "pkg/src" },
				env,
			);
			expect(result.error).toBeDefined();
			expect(result.error?.message).toContain(
				"did you mean a file inside pkg/src?",
			);
			expect(result.error?.message).toContain("its first entries are x.ts");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a read of a path that is not there suggests the nearest existing one", async () => {
		const root = repository();
		try {
			fs.writeFileSync(path.join(root, "pkg/src/x.ts"), "x\n");
			const env = new NodeExecutionEnv({ cwd: root, shellEnv: {} });
			const result = await callTool(
				suggestingTool("read"),
				{ path: "src/x.ts" },
				env,
			);
			expect(result.error?.message).toContain("ENOENT");
			expect(result.error?.message).toContain("did you mean pkg/src/x.ts?");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("an unrelated failure is left exactly as the tool wrote it", async () => {
		const root = repository();
		try {
			fs.writeFileSync(path.join(root, "pkg/src/x.ts"), FILE);
			const env = new NodeExecutionEnv({ cwd: root, shellEnv: {} });
			const result = await callTool(
				suggestingTool("edit"),
				{ path: "pkg/src/x.ts", edits: [{ oldText: "", newText: "a" }] },
				env,
			);
			expect(result.error?.message).toBe(
				"oldText must not be empty in pkg/src/x.ts.",
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
