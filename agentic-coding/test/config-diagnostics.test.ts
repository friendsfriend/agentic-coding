// Configuration diagnostics reach a rendering surface instead of raw stderr
// (a stderr write prints into an OpenTUI render): a leftover legacy file is a
// warning, a failed load is an error, and headless routes keep stderr.
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
	test("an inactive legacy file is a warning on the installed sink", () => {
		const { dir, root } = fixtureRoot();
		try {
			fs.writeFileSync(path.join(root, "config.toml"), "[agents]\n");
			fs.writeFileSync(path.join(root, "config.json"), "{}\n");
			const seen: { message: string; kind: ConfigDiagnosticKind }[] = [];
			const dispose = setConfigDiagnosticSink((message, kind) =>
				seen.push({ message, kind }),
			);
			try {
				withRoot(root, () => loadConfigWithProvenance({}));
			} finally {
				dispose();
			}
			expect(seen).toEqual([
				{
					message: `${path.join(root, "config.toml")} is inactive: config.json is the active workflow configuration`,
					kind: "warning",
				},
			]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a failed load is reported as an error and still throws", () => {
		const { dir, root } = fixtureRoot();
		try {
			fs.writeFileSync(path.join(root, "config.json"), "{}\n");
			const repository = path.join(dir, "repo");
			fs.mkdirSync(path.join(repository, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(repository, ".pi", "herdr-workflow.json"),
				"{}\n",
			);
			fs.writeFileSync(
				path.join(repository, ".pi", "herdr-workflow.toml"),
				"[agents]\n",
			);
			const seen: ConfigDiagnosticKind[] = [];
			const dispose = setConfigDiagnosticSink((_message, kind) =>
				seen.push(kind),
			);
			try {
				withRoot(root, () => {
					expect(() => loadConfigWithProvenance({ repository })).toThrow(
						/supplies both herdr-workflow\.json and herdr-workflow\.toml/,
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
			fs.writeFileSync(path.join(root, "config.toml"), "[agents]\n");
			fs.writeFileSync(path.join(root, "config.json"), "{}\n");
			const written: string[] = [];
			const original = process.stderr.write.bind(process.stderr);
			process.stderr.write = ((chunk: string | Uint8Array) => {
				written.push(String(chunk));
				return true;
			}) as typeof process.stderr.write;
			try {
				withRoot(root, () => loadConfigWithProvenance({}));
			} finally {
				process.stderr.write = original;
			}
			expect(written.join("")).toContain("[config] ");
			expect(written.join("")).toContain("is inactive");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
