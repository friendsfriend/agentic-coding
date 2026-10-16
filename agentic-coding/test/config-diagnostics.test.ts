// Configuration diagnostics reach a rendering surface instead of raw stderr
// (a stderr write prints into an OpenTUI render), and only the current JSON
// configuration is read: an obsolete file is ignored rather than reported as a
// shadowed second source.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type ConfigDiagnosticKind,
	setConfigDiagnosticSink,
} from "../src/config-root.ts";
import { loadConfigWithProvenance } from "../src/workflow/effects.ts";

function fixtureRoot(): { dir: string; root: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-diagnostics-"));
	const root = path.join(dir, "agentic-coding");
	fs.mkdirSync(root, { recursive: true });
	return { dir, root };
}

function withRoot(root: string, body: () => void): void {
	const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
	process.env.AGENTIC_CODING_CONFIG_DIR = root;
	try {
		body();
	} finally {
		if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
		else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
	}
}

describe("configuration diagnostics", () => {
	test("an obsolete configuration file is ignored without a diagnostic", () => {
		const { dir, root } = fixtureRoot();
		try {
			fs.writeFileSync(path.join(root, "config.toml"), "[agents]\n");
			fs.writeFileSync(
				path.join(root, "config.json"),
				`${JSON.stringify({
					agents: { default_profile: "current" },
				})}\n`,
			);
			const seen: { message: string; kind: ConfigDiagnosticKind }[] = [];
			const dispose = setConfigDiagnosticSink((message, kind) =>
				seen.push({ message, kind }),
			);
			let loaded: ReturnType<typeof loadConfigWithProvenance> | undefined;
			try {
				withRoot(root, () => {
					loaded = loadConfigWithProvenance({});
				});
			} finally {
				dispose();
			}
			expect(seen).toEqual([]);
			expect(loaded?.provenance.files).toEqual([
				path.join(root, "config.json"),
			]);
			expect(
				(loaded?.config.agents as { default_profile?: string })
					?.default_profile,
			).toBe("current");
			// The obsolete file is neither read nor rewritten.
			expect(fs.readFileSync(path.join(root, "config.toml"), "utf8")).toBe(
				"[agents]\n",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("only an obsolete file present still resolves the built-in defaults", () => {
		const { dir, root } = fixtureRoot();
		try {
			const obsolete = path.join(root, "config.toml");
			fs.writeFileSync(obsolete, '[agents]\ndefault_profile = "legacy"\n');
			let loaded: ReturnType<typeof loadConfigWithProvenance> | undefined;
			withRoot(root, () => {
				loaded = loadConfigWithProvenance({});
			});
			expect(loaded?.provenance.source).toBe("default");
			expect(loaded?.provenance.files).toEqual([]);
			expect(fs.readFileSync(obsolete, "utf8")).toBe(
				'[agents]\ndefault_profile = "legacy"\n',
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a failed load is reported as an error and still throws", () => {
		const { dir, root } = fixtureRoot();
		try {
			fs.writeFileSync(path.join(root, "config.json"), "{ not json\n");
			const seen: ConfigDiagnosticKind[] = [];
			const dispose = setConfigDiagnosticSink((_message, kind) =>
				seen.push(kind),
			);
			try {
				withRoot(root, () => {
					expect(() => loadConfigWithProvenance({})).toThrow(
						/failed to parse config .*config\.json/,
					);
				});
			} finally {
				dispose();
			}
			expect(seen).toEqual(["error"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("without a sink the diagnostic keeps going to stderr", () => {
		const { dir, root } = fixtureRoot();
		try {
			fs.writeFileSync(path.join(root, "config.json"), "{ not json\n");
			const written: string[] = [];
			const original = process.stderr.write.bind(process.stderr);
			process.stderr.write = ((chunk: string | Uint8Array) => {
				written.push(String(chunk));
				return true;
			}) as typeof process.stderr.write;
			try {
				withRoot(root, () => {
					try {
						loadConfigWithProvenance({});
					} catch {
						/* the failure is asserted by the diagnostic below */
					}
				});
			} finally {
				process.stderr.write = original;
			}
			expect(written.join("")).toContain("[config] ");
			expect(written.join("")).toContain("failed to parse config");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
