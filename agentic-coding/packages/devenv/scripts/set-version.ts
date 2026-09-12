#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

const version = process.argv[2];

if (!version) {
	console.error("Usage: bun set-version <version>");
	process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
	console.error(`Invalid version: ${version}`);
	console.error("Expected semver like 0.12.0");
	process.exit(1);
}

const rootDir = path.resolve(import.meta.dir, "..");
const ignoredDirs = new Set(["node_modules", ".git", "dist"]);

function findPackageJsonFiles(dir: string, result: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (ignoredDirs.has(entry.name)) continue;
			findPackageJsonFiles(path.join(dir, entry.name), result);
			continue;
		}

		if (entry.isFile() && entry.name === "package.json") {
			result.push(path.join(dir, entry.name));
		}
	}

	return result;
}

function updatePackageJson(file: string) {
	const raw = fs.readFileSync(file, "utf8");
	const packageJson = JSON.parse(raw) as Record<string, unknown>;
	packageJson.version = version;
	fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function updateGoServerVersion() {
	const file = path.join(rootDir, "server", "pkg", "version", "version.go");
	const content = `package version\n\n// Version is the DevEnv server version.\nconst Version = "${version}"\n`;
	fs.writeFileSync(file, content);
	return file;
}

const packageJsonFiles = findPackageJsonFiles(rootDir).sort();
for (const file of packageJsonFiles) {
	updatePackageJson(file);
}

const goVersionFile = updateGoServerVersion();

console.log(`Set project version to ${version}`);
for (const file of packageJsonFiles) {
	console.log(`  ${path.relative(rootDir, file)}`);
}
console.log(`  ${path.relative(rootDir, goVersionFile)}`);
