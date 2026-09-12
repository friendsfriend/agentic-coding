#!/usr/bin/env bun
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface Options {
	configDir: string;
	homeDir: string;
	apps: number;
	scripts: number;
	clean: boolean;
}

const usage = `Create large DevEnv fixture config for TUI performance testing.

Usage:
  bun run scripts/create-perf-config.ts [options]

Options:
  --config-dir <path>  Config dir (default: /tmp/devenv-perf-config)
  --home-dir <path>    Home dir (default: /tmp/devenv-perf-home)
  --apps <count>       App/library definitions (default: 500)
  --scripts <count>    Script files (default: 0)
  --no-clean           Do not delete existing fixture dirs first
  -h, --help           Show help

Run TUI with:
  DEVENV_CONFIG_DIR=<config-dir> DEVENV_HOME=<home-dir> OTUI_SHOW_STATS=true bun run dev -p 4061
`;

function parseArgs(argv: string[]): Options {
	const opts: Options = {
		configDir: path.join(os.tmpdir(), "devenv-perf-config"),
		homeDir: path.join(os.tmpdir(), "devenv-perf-home"),
		apps: 500,
		scripts: 0,
		clean: true,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const next = argv[++i];
			if (!next) throw new Error(`Missing value for ${arg}`);
			return next;
		};

		if (arg === "--config-dir") opts.configDir = path.resolve(value());
		else if (arg === "--home-dir") opts.homeDir = path.resolve(value());
		else if (arg === "--apps") opts.apps = positiveInt(value(), arg);
		else if (arg === "--scripts") opts.scripts = positiveInt(value(), arg);
		else if (arg === "--no-clean") opts.clean = false;
		else if (arg === "-h" || arg === "--help") {
			console.log(usage);
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}\n\n${usage}`);
		}
	}

	return opts;
}

function positiveInt(raw: string, flag: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${flag} must be non-negative integer`);
	}
	return value;
}

async function ensureDir(dir: string) {
	await mkdir(dir, { recursive: true });
}

function appDefinition(i: number): string {
	const padded = String(i).padStart(4, "0");
	return `${JSON.stringify({
		ident: `perf-app-${padded}`,
		displayName: `Performance App ${padded}`,
		repositoryPath: `https://example.com/org/perf-app-${padded}.git`,
		containerBaseName: `perf-app-${padded}`,
		sourceType: "git",
		gitMode: "BRANCH",
	})}\n`;
}

function scriptContent(i: number): string {
	const padded = String(i).padStart(4, "0");
	return `#!/usr/bin/env sh\nset -eu\necho perf-script-${padded}\n`;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	if (opts.clean) {
		await rm(opts.configDir, { recursive: true, force: true });
		await rm(opts.homeDir, { recursive: true, force: true });
	}

	const appDefsDir = path.join(opts.configDir, "apps", "definitions");
	const libDefsDir = path.join(opts.configDir, "libraries", "definitions");
	const infraDefsDir = path.join(
		opts.configDir,
		"infrastructure",
		"definitions",
	);
	const scriptsDir = path.join(opts.homeDir, "scripts");

	await Promise.all([
		ensureDir(appDefsDir),
		ensureDir(libDefsDir),
		ensureDir(infraDefsDir),
		ensureDir(scriptsDir),
	]);

	await writeFile(
		path.join(opts.configDir, ".env"),
		`DEVENV_HOME=${opts.homeDir}\n`,
	);

	let appCount = 0;
	let libCount = 0;
	for (let i = 0; i < opts.apps; i++) {
		const isLibrary = i % 4 === 0;
		const dir = isLibrary ? libDefsDir : appDefsDir;
		if (isLibrary) libCount++;
		else appCount++;
		await writeFile(
			path.join(dir, `perf-app-${String(i).padStart(4, "0")}.json`),
			appDefinition(i),
		);
	}

	for (let i = 0; i < opts.scripts; i++) {
		const file = path.join(
			scriptsDir,
			`perf-script-${String(i).padStart(4, "0")}.sh`,
		);
		await writeFile(file, scriptContent(i));
		await chmod(file, 0o755);
	}

	console.log(`Created perf fixture:`);
	console.log(`  config:  ${opts.configDir}`);
	console.log(`  home:    ${opts.homeDir}`);
	console.log(`  apps:    ${appCount}`);
	console.log(`  libs:    ${libCount}`);
	console.log(`  scripts: ${opts.scripts}`);
	console.log("");
	console.log("Run:");
	console.log(
		`  DEVENV_CONFIG_DIR=${opts.configDir} DEVENV_HOME=${opts.homeDir} OTUI_SHOW_STATS=true bun run dev -p 4061`,
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
