import fs from "node:fs";
import path from "node:path";
import { type Config, digest } from "../config.ts";
import { discardStagedTree, stagingRoot } from "./definition-staged-tree.ts";

/** Metadata only, for one durable intent's exact temporary name; never a sweep.
 * Ordinary replacement is fenced. Path-based checks are not an OS sandbox. */
export function temporaryTreeObservation(config: Config, name: string) {
	if (!/^tree-[a-f0-9]{64}$/.test(name))
		throw new Error("Invalid temporary tree intent name");
	const root = path.join(stagingRoot(config), name);
	try {
		const entries: {
			pathDigest: string;
			dev: number;
			ino: number;
			mode: number;
			size: number;
			mtime: number;
			ctime: number;
		}[] = [];
		let bytes = 0;
		const walk = (file: string, depth: number) => {
			if (depth > 4 || entries.length >= 32)
				throw new Error("Temporary tree exceeds observation bounds");
			const stat = fs.lstatSync(file);
			if (
				stat.isSymbolicLink() ||
				(!stat.isFile() && !stat.isDirectory()) ||
				(stat.mode & 0o077) !== 0 ||
				(stat.isFile() && stat.nlink !== 1)
			)
				throw new Error("Unsafe temporary tree");
			if (stat.isFile()) {
				bytes += stat.size;
				if (stat.size > 65536 || bytes > 196608)
					throw new Error("Temporary tree exceeds source bounds");
			}
			entries.push({
				pathDigest: digest(path.relative(root, file)),
				dev: stat.dev,
				ino: stat.ino,
				mode: stat.mode,
				size: stat.size,
				mtime: stat.mtimeMs,
				ctime: stat.ctimeMs,
			});
			if (stat.isDirectory())
				for (const child of fs.readdirSync(file).sort())
					walk(path.join(file, child), depth + 1);
		};
		const stat = fs.lstatSync(root);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("Unsafe temporary tree root");
		walk(root, 0);
		return {
			state: "present" as const,
			fingerprint: digest(JSON.stringify(entries)),
			entries: entries.length,
		};
	} catch {
		// Only absence of the root is absence; a missing descendant is uncertainty.
		try {
			fs.lstatSync(root);
		} catch (rootError) {
			if ((rootError as NodeJS.ErrnoException).code === "ENOENT")
				return { state: "absent" as const };
		}
		return { state: "unavailable" as const };
	}
}
export function releaseTemporaryTree(
	config: Config,
	name: string,
	fingerprint: string,
) {
	const observed = temporaryTreeObservation(config, name);
	if (observed.state !== "present" || observed.fingerprint !== fingerprint)
		throw new Error(
			"Temporary tree identity changed or is unavailable; inspect before a new cleanup request",
		);
	discardStagedTree(path.join(stagingRoot(config), name));
	return { removed: true as const };
}
