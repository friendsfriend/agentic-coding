import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "../../env-file.ts";

/** Native command: never send template contents or resolved credentials to argv. */
export const BUILD_CONTEXT_COMMAND = "agentic-coding:build-context";

type Entry = { file: string; directory?: boolean; digest?: string };
type Manifest = { checkout: string; entries: Entry[] };
const digest = (data: Buffer) =>
	createHash("sha256").update(data).digest("hex");
const exists = (file: string) => {
	try {
		return fs.lstatSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
};

/** Dereference templates, render variables, and undo ONLY the files we created.
 * Existing checkout files are never overwritten, including during cleanup.
 * The manifest holds paths and hashes, not credentials or template contents.
 */
export function buildContext(
	args: readonly string[],
	runId = "standalone",
	environment: NodeJS.ProcessEnv = process.env,
): void {
	const [operation, configDir, checkoutDir, markerBase] = args;
	if (
		(operation !== "prepare" && operation !== "cleanup") ||
		!configDir ||
		!checkoutDir ||
		!markerBase
	) {
		throw new Error("Invalid build-context command arguments");
	}
	const marker = `${markerBase}-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
	const checkout = fs.realpathSync(checkoutDir);
	const cleanup = () => {
		if (!exists(marker)) return;
		const manifest = JSON.parse(fs.readFileSync(marker, "utf8")) as Manifest;
		if (manifest.checkout !== checkout || !Array.isArray(manifest.entries)) {
			throw new Error("Build-context manifest does not match checkout");
		}
		for (const entry of [...manifest.entries].reverse()) {
			const file = path.resolve(checkout, entry.file);
			if (!file.startsWith(`${checkout}${path.sep}`)) {
				throw new Error("Invalid build-context manifest path");
			}
			// Never follow a checkout symlink, including one created during a build.
			let parent = path.dirname(file);
			let safe = true;
			while (parent !== checkout) {
				if (exists(parent)?.isSymbolicLink()) safe = false;
				parent = path.dirname(parent);
			}
			if (!safe) continue;
			const stat = exists(file);
			if (!stat || stat.isSymbolicLink()) continue;
			if (entry.directory) {
				if (stat.isDirectory() && fs.readdirSync(file).length === 0) {
					fs.rmdirSync(file);
				}
			} else if (
				stat.isFile() &&
				entry.digest === digest(fs.readFileSync(file))
			) {
				fs.unlinkSync(file);
			}
		}
		fs.unlinkSync(marker);
	};
	if (operation === "cleanup") {
		cleanup();
		return;
	}
	if (exists(marker))
		throw new Error("Build context already prepared for this run");
	const templates = path.join(configDir, "templates");
	// Read the directory before creating a manifest; a missing source must fail.
	const names = fs.readdirSync(templates);
	const vars = {
		...Object.fromEntries(loadEnvFile(path.join(configDir, ".env"))),
		...environment,
	};
	const manifest: Manifest = { checkout, entries: [] };
	fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
	fs.writeFileSync(marker, JSON.stringify(manifest), {
		flag: "wx",
		mode: 0o600,
	});
	const record = (entry: Entry) => {
		manifest.entries.push(entry);
		fs.writeFileSync(marker, JSON.stringify(manifest), { mode: 0o600 });
	};
	const copy = (source: string, relative: string, ancestors: Set<string>) => {
		const real = fs.realpathSync(source);
		const target = path.join(checkout, relative);
		const stat = fs.statSync(real);
		const current = exists(target);
		if (current?.isSymbolicLink()) {
			throw new Error(
				`Build-context template conflicts with checkout symlink: ${relative}`,
			);
		}
		if (stat.isDirectory()) {
			if (ancestors.has(real))
				throw new Error("Cycle in build-context templates");
			if (current && !current.isDirectory()) {
				throw new Error(
					`Build-context template conflicts with checkout file: ${relative}`,
				);
			}
			if (!current) {
				record({ file: relative, directory: true });
				fs.mkdirSync(target, { mode: 0o700 });
			}
			const next = new Set(ancestors).add(real);
			for (const name of fs.readdirSync(real)) {
				copy(path.join(real, name), path.join(relative, name), next);
			}
		} else if (stat.isFile()) {
			if (current) return; // The developer's file takes precedence.
			const input = fs.readFileSync(real);
			const data = input.includes(0)
				? input
				: Buffer.from(
						input
							.toString("utf8")
							.replace(
								/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
								(_match, name: string) => {
									const value = vars[name];
									if (value === undefined)
										throw new Error(`Missing build-template variable: ${name}`);
									return value;
								},
							),
					);
			record({ file: relative, digest: digest(data) });
			fs.writeFileSync(target, data, { flag: "wx", mode: 0o600 });
		} else {
			throw new Error(`Unsupported build-context template: ${relative}`);
		}
	};
	try {
		for (const name of names) copy(path.join(templates, name), name, new Set());
	} catch (error) {
		cleanup();
		throw error;
	}
}
