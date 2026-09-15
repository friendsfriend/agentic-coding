#!/usr/bin/env bun
// Builds the single self-contained `agentic-coding` executable: the unified
// frontend (one renderer, one lifecycle owner), the workflow engine, the
// environment authority and the telemetry receivers — one Bun process, no
// embedded backend, no compiler at build or run time. Everything the packaged
// executable needs is bundled: generated instructions, the imported guides
// (text loader), the OTLP protocol definition and the OpenTUI native parser
// worker/font assets. One version source: the root package.json. Only the host
// target is built; the previous second (multi-platform) builder is gone, so
// packaging cannot drift between two scripts.
import fs from "node:fs";
import path from "node:path";
import { $ } from "bun";

const root = path.resolve(import.meta.dir, "..");
process.chdir(root);

const flags = new Set(process.argv.slice(2));
if (flags.has("--skip-go")) {
	console.warn(
		"--skip-go is gone: the Go backend was retired and this build never needs it",
	);
}
const appVersion = (await Bun.file(path.join(root, "package.json")).json())
	.version as string;

const solidPluginPath = path.join(
	root,
	"node_modules/@opentui/solid/scripts/solid-plugin.js",
);
if (!fs.existsSync(solidPluginPath)) {
	console.error("missing @opentui/solid; run `bun install` first");
	process.exit(1);
}
patchOpenTUISolidTransform();
const solidPlugin = (await import(solidPluginPath)).default;

function patchOpenTUISolidTransform() {
	// Bun 1.3.14 ESM/CJS interop for @opentui/solid's Babel module resolver.
	const transformPath = path.join(
		root,
		"node_modules/@opentui/solid/scripts/solid-transform.js",
	);
	if (!fs.existsSync(transformPath)) return;
	const source = fs.readFileSync(transformPath, "utf8");
	const oldImport =
		'import moduleResolver from "babel-plugin-module-resolver";';
	if (
		source.includes(oldImport) &&
		!source.includes("createRequire(import.meta.url)")
	) {
		fs.writeFileSync(
			transformPath,
			source.replace(
				oldImport,
				'import { createRequire } from "module";\nconst require = createRequire(import.meta.url);\nconst moduleResolver = require("babel-plugin-module-resolver");',
			),
		);
	}
}

// Bundle runtime-neutral instructions and explicitly injected bridges; the
// generated module is what materializes agent instructions without any
// source-relative path at runtime.
await $`bun run scripts/generate-embedded.ts`;

const agentDefDir = path.resolve(root, "..", "agent-definitions");
if (!fs.existsSync(agentDefDir)) {
	console.error(`agent-definitions not found at ${agentDefDir}`);
	process.exit(1);
}

const distDir = path.join(root, "dist");
fs.mkdirSync(distDir, { recursive: true });
const main = path.join(distDir, "agentic-coding");

// ---- Host-target executable ----
const parserWorker = fs.realpathSync(
	path.join(root, "node_modules/@opentui/core/parser.worker.js"),
);
const bunfsRoot =
	process.platform === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/";
const workerRelativePath = path
	.relative(root, parserWorker)
	.replaceAll("\\", "/");

await Bun.build({
	tsconfig: "./tsconfig.json",
	plugins: [solidPlugin],
	compile: {
		outfile: main,
		autoloadBunfig: false,
		autoloadDotenv: false,
		autoloadTsconfig: true,
		autoloadPackageJson: true,
		execArgv: [
			`--user-agent=agentic-coding/${appVersion}`,
			"--use-system-ca",
			"--",
		],
	},
	entrypoints: ["./src/cli.ts", parserWorker],
	define: {
		AGENTIC_CODING_VERSION: `'${appVersion}'`,
		OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
	},
});

console.log(`built ${main} (version ${appVersion})`);
console.log(
	"host target only (cross-platform artifacts are not built by this milestone)",
);
