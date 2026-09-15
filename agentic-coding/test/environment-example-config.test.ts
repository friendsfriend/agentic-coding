// Example configuration parity
// (`port-environment-runtimes-to-bun`, tasks 1.2 and 4.4).
//
// `test/fixtures/environment/example-config.json` is Go's own output
// (`server/pkg/exampleconfig/fixtures_test.go`), so this asserts the Bun
// generator reproduces the tree byte-for-byte rather than a hand-written
// expectation. The guard rules are asserted separately: a refused run must
// leave the filesystem untouched.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	exampleConfigFileMode,
	exampleConfigFiles,
	generateExampleConfig,
} from "../src/server/environment/example-config.ts";

interface Fixture {
	files: Record<string, string>;
	executables: string[];
}

const fixture: Fixture = JSON.parse(
	fs.readFileSync(
		path.join(import.meta.dir, "fixtures/environment/example-config.json"),
		"utf8",
	),
);

function tempRoots(): { configDir: string; homeDir: string; root: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "devenv-example-"));
	return {
		root,
		configDir: path.join(root, "config"),
		homeDir: path.join(root, "home"),
	};
}

/** Substitutes the fixture's recipe keys with this run's temp roots. */
function expand(value: string, configDir: string, homeDir: string): string {
	return value
		.replaceAll("{{CONFIG}}", configDir)
		.replaceAll("{{HOME}}", homeDir);
}

function readTree(configDir: string, homeDir: string): Record<string, string> {
	const files: Record<string, string> = {};
	for (const [key, dir] of [
		["config", configDir],
		["home", homeDir],
	] as const) {
		const walk = (current: string): void => {
			for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
				const full = path.join(current, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				const relative = path.relative(dir, full).split(path.sep).join("/");
				files[`${key}/${relative}`] = fs.readFileSync(full, "utf8");
			}
		};
		if (fs.existsSync(dir)) walk(dir);
	}
	return files;
}

describe("example configuration generator", () => {
	test("reproduces the Go-generated tree byte-for-byte", () => {
		const { configDir, homeDir, root } = tempRoots();
		generateExampleConfig({ configDir, homeDir });
		const generated = readTree(configDir, homeDir);
		expect(Object.keys(generated).sort()).toEqual(
			Object.keys(fixture.files).sort(),
		);
		for (const [key, content] of Object.entries(fixture.files)) {
			expect(generated[key]).toBe(expand(content, configDir, homeDir));
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("marks the fixture's executables executable and nothing else", () => {
		const { configDir, homeDir, root } = tempRoots();
		generateExampleConfig({ configDir, homeDir });
		const executableKeys = Object.keys(fixture.files)
			.filter((key) => {
				const scope = key.slice(0, key.indexOf("/"));
				const relative = key.slice(scope.length + 1);
				const base = scope === "config" ? configDir : homeDir;
				const mode = fs.statSync(path.join(base, relative)).mode;
				return (mode & 0o111) !== 0;
			})
			.sort();
		expect(executableKeys).toEqual([...fixture.executables].sort());
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("the mode rule follows Go's path test", () => {
		const options = { configDir: "/c", homeDir: "/h" };
		expect(exampleConfigFileMode("/h/scripts/hello.sh", options)).toBe(0o755);
		// Only a script directly in the scripts directory is executable; a nested
		// one is not, matching Go's exact-directory comparison.
		expect(exampleConfigFileMode("/h/scripts/nested/hello.py", options)).toBe(
			0o644,
		);
		expect(exampleConfigFileMode("/c/apps/run/dev.sh", options)).toBe(0o755);
		expect(
			exampleConfigFileMode("/c/infrastructure/scripts/clock.sh", options),
		).toBe(0o755);
		expect(exampleConfigFileMode("/c/apps/build/dev.ps1", options)).toBe(0o644);
		expect(exampleConfigFileMode("/c/apps/definitions/app.json", options)).toBe(
			0o644,
		);
	});

	test("the file list is the fixture's file list", () => {
		const files = exampleConfigFiles({ configDir: "/c", homeDir: "/h" });
		expect(files).toHaveLength(Object.keys(fixture.files).length);
		expect(new Set(files.map(([target]) => target)).size).toBe(files.length);
	});

	test("a non-empty config directory is refused without any write", () => {
		const { configDir, homeDir, root } = tempRoots();
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "keep"), "x");
		expect(() => generateExampleConfig({ configDir, homeDir })).toThrow(
			"config directory",
		);
		expect(fs.existsSync(path.join(homeDir, "scripts"))).toBe(false);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("a non-empty scripts directory is refused without any write", () => {
		const { configDir, homeDir, root } = tempRoots();
		const scriptsDir = path.join(homeDir, "scripts");
		fs.mkdirSync(scriptsDir, { recursive: true });
		fs.writeFileSync(path.join(scriptsDir, "keep"), "x");
		expect(() => generateExampleConfig({ configDir, homeDir })).toThrow(
			"scripts directory",
		);
		expect(fs.existsSync(configDir)).toBe(false);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("the preserved paths never block generation or get overwritten", () => {
		const { configDir, homeDir, root } = tempRoots();
		const envPath = path.join(configDir, ".env");
		const providerPath = path.join(configDir, "providers", "github.json");
		const tuiPath = path.join(configDir, "tui.json");
		fs.mkdirSync(path.dirname(providerPath), { recursive: true });
		fs.writeFileSync(envPath, "DEVENV_HOME=/custom\n");
		fs.writeFileSync(providerPath, '{"name":"github","type":"github"}\n');
		fs.writeFileSync(tuiPath, '{"theme":"aura"}\n');
		generateExampleConfig({ configDir, homeDir });
		expect(fs.readFileSync(envPath, "utf8")).toBe("DEVENV_HOME=/custom\n");
		expect(fs.readFileSync(providerPath, "utf8")).toBe(
			'{"name":"github","type":"github"}\n',
		);
		expect(fs.readFileSync(tuiPath, "utf8")).toBe('{"theme":"aura"}\n');
		expect(
			fs.existsSync(
				path.join(configDir, "apps", "definitions", "go-rest-postgres.json"),
			),
		).toBe(true);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("empty startup-created directories are allowed", () => {
		const { configDir, homeDir, root } = tempRoots();
		for (const dir of [
			path.join(configDir, "providers"),
			path.join(configDir, "apps", "definitions"),
			path.join(configDir, "libraries", "definitions"),
			path.join(configDir, "infrastructure", "definitions"),
			path.join(homeDir, "scripts", "nested"),
		]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		generateExampleConfig({ configDir, homeDir });
		expect(
			fs.existsSync(
				path.join(configDir, "apps", "definitions", "go-rest-postgres.json"),
			),
		).toBe(true);
		fs.rmSync(root, { recursive: true, force: true });
	});
});
