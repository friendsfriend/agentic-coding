#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dir = path.resolve(__dirname, "..");
// Hoisted workspace install places dependencies at the agentic-coding root,
// not inside packages/devenv, so resolve build tooling from there.
const nodeModulesDir = path.resolve(dir, "../../node_modules");
const workspaceRoot = path.resolve(dir, "../..");

process.chdir(dir);

function cleanupBunBuildArtifacts() {
	for (const entry of fs.readdirSync(dir)) {
		if (!entry.endsWith(".bun-build")) continue;
		fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
	}
}

process.on("exit", cleanupBunBuildArtifacts);
process.on("SIGINT", () => {
	cleanupBunBuildArtifacts();
	process.exit(130);
});
process.on("SIGTERM", () => {
	cleanupBunBuildArtifacts();
	process.exit(143);
});

cleanupBunBuildArtifacts();

function patchOpenTUISolidTransform() {
	// Work around Bun 1.3.14 ESM/CJS interop for @opentui/solid's Babel module resolver import.
	// babel-plugin-module-resolver is CommonJS and may not expose a synthetic default during Bun.build.
	const solidTransformPath = path.resolve(
		nodeModulesDir,
		"@opentui/solid/scripts/solid-transform.js",
	);
	if (!fs.existsSync(solidTransformPath)) return;
	const source = fs.readFileSync(solidTransformPath, "utf8");
	const oldImport =
		'import moduleResolver from "babel-plugin-module-resolver";';
	if (
		source.includes(oldImport) &&
		!source.includes("createRequire(import.meta.url)")
	) {
		fs.writeFileSync(
			solidTransformPath,
			source.replace(
				oldImport,
				'import { createRequire } from "module";\nconst require = createRequire(import.meta.url);\nconst moduleResolver = require("babel-plugin-module-resolver");',
			),
		);
	}
}

patchOpenTUISolidTransform();

// Import solid plugin dynamically to avoid module resolution issues
const solidPluginPath = path.resolve(
	nodeModulesDir,
	"@opentui/solid/scripts/solid-plugin.js",
);
const solidPlugin = (await import(solidPluginPath)).default;

import cliPkg from "../cli/package.json";
import rootPkg from "../package.json";

const appVersion = rootPkg.version;

const singleFlag = process.argv.includes("--single");
const baselineFlag = process.argv.includes("--baseline");
const skipInstall = process.argv.includes("--skip-install");

const allTargets: {
	os: string;
	arch: "arm64" | "x64";
	abi?: "musl";
	avx2?: false;
}[] = [
	{
		os: "linux",
		arch: "arm64",
	},
	{
		os: "linux",
		arch: "x64",
	},
	{
		os: "linux",
		arch: "x64",
		avx2: false,
	},
	{
		os: "linux",
		arch: "arm64",
		abi: "musl",
	},
	{
		os: "linux",
		arch: "x64",
		abi: "musl",
	},
	{
		os: "linux",
		arch: "x64",
		abi: "musl",
		avx2: false,
	},
	{
		os: "darwin",
		arch: "arm64",
	},
	{
		os: "darwin",
		arch: "x64",
	},
	{
		os: "darwin",
		arch: "x64",
		avx2: false,
	},
	{
		os: "win32",
		arch: "x64",
	},
	{
		os: "win32",
		arch: "x64",
		avx2: false,
	},
];

const targets = singleFlag
	? allTargets.filter((item) => {
			if (item.os !== process.platform || item.arch !== process.arch) {
				return false;
			}

			// When building for the current platform, prefer a single native binary by default.
			// Baseline binaries require additional Bun artifacts and can be flaky to download.
			if (item.avx2 === false) {
				return baselineFlag;
			}

			return true;
		})
	: allTargets;

await $`rm -rf dist`;

const binaries: Record<string, string> = {};
if (!skipInstall) {
	await $`bun install --os="*" --cpu="*" @opentui/core@${cliPkg.dependencies["@opentui/core"]}`.cwd(
		workspaceRoot,
	);
}

patchOpenTUISolidTransform();

// Build Go server binaries for each platform first
const projectRoot = path.resolve(dir, "../../..");
const serverDir = path.join(projectRoot, "server");
const serverDistDir = path.join(dir, "server-binaries");
await $`mkdir -p ${serverDistDir}`;

console.log("🏗️  Building Go server binaries...");
const goPlatformMap: Record<string, { GOOS: string; GOARCH: string }> = {
	"linux-arm64": { GOOS: "linux", GOARCH: "arm64" },
	"linux-x64": { GOOS: "linux", GOARCH: "amd64" },
	"darwin-arm64": { GOOS: "darwin", GOARCH: "arm64" },
	"darwin-x64": { GOOS: "darwin", GOARCH: "amd64" },
	"win32-x64": { GOOS: "windows", GOARCH: "amd64" },
};

// Build unique Go binaries (skip baseline/musl variants - they use same Go binary)
const builtGoBinaries = new Set<string>();
for (const item of targets) {
	const goPlatformKey = `${item.os === "win32" ? "win32" : item.os}-${item.arch}`;
	if (builtGoBinaries.has(goPlatformKey)) continue;

	const goPlatform = goPlatformMap[goPlatformKey];
	if (!goPlatform) {
		console.warn(
			`⚠️  Skipping Go build for unsupported platform: ${goPlatformKey}`,
		);
		continue;
	}

	const extension = item.os === "win32" ? ".exe" : "";
	const outputPath = path.join(
		serverDistDir,
		`devenv-${goPlatformKey}${extension}`,
	);

	console.log(`  Building ${goPlatformKey}...`);
	await $`cd ${serverDir} && GOOS=${goPlatform.GOOS} GOARCH=${goPlatform.GOARCH} go build -o ${outputPath} .`;
	builtGoBinaries.add(goPlatformKey);
}

for (const item of targets) {
	const name = [
		"devenv",
		// changing to win32 flags npm for some reason
		item.os === "win32" ? "windows" : item.os,
		item.arch,
		item.avx2 === false ? "baseline" : undefined,
		item.abi === undefined ? undefined : item.abi,
	]
		.filter(Boolean)
		.join("-");
	console.log(`building ${name}`);
	await $`mkdir -p dist/${name}/bin`;

	const parserWorker = fs.realpathSync(
		path.resolve(nodeModulesDir, "@opentui/core/parser.worker.js"),
	);

	// Get the Go binary for this platform
	const goPlatformKey = `${item.os === "win32" ? "win32" : item.os}-${item.arch}`;
	const extension = item.os === "win32" ? ".exe" : "";
	const serverBinary = path.join(
		serverDistDir,
		`devenv-${goPlatformKey}${extension}`,
	);

	// Use platform-specific bunfs root path based on target OS
	const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/";
	const workerRelativePath = path
		.relative(dir, parserWorker)
		.replaceAll("\\", "/");

	// Read the server binary and convert to base64 for embedding
	const serverBinaryData = await Bun.file(serverBinary).arrayBuffer();
	const serverBinaryBase64 = Buffer.from(serverBinaryData).toString("base64");

	await Bun.build({
		tsconfig: "./tsconfig.json",
		plugins: [solidPlugin],
		sourcemap: "external",
		compile: {
			autoloadBunfig: false,
			autoloadDotenv: false,
			autoloadTsconfig: true,
			autoloadPackageJson: true,
			target: name.replace("devenv", "bun") as Bun.Build.CompileTarget,
			outfile: `dist/${name}/bin/devenv`,
			execArgv: [`--user-agent=devenv/${appVersion}`, "--use-system-ca", "--"],
			windows: {},
		},
		entrypoints: ["./cli/src/spawn.ts", parserWorker],
		define: {
			DEVENV_VERSION: `'${appVersion}'`,
			OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
			EMBEDDED_SERVER_BINARY_BASE64: `'${serverBinaryBase64}'`,
			...(item.os === "linux"
				? {
						"process.env.OPENTUI_LIBC": JSON.stringify(
							item.abi === "musl" ? "musl" : "glibc",
						),
					}
				: {}),
		},
	});

	await Bun.file(`dist/${name}/package.json`).write(
		JSON.stringify(
			{
				name,
				version: appVersion,
				os: [item.os],
				cpu: [item.arch],
			},
			null,
			2,
		),
	);
	binaries[name] = appVersion;
}

cleanupBunBuildArtifacts();

export { binaries };
