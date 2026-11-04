import fs from "node:fs";
import path from "node:path";
import { digest } from "../config.ts";
import { publicComposePath } from "./definition-source-check.ts";

export type SourceBase = {
	version: 1;
	state: "absent" | "regular";
	fingerprint: string;
	contentDigest?: string;
	capturedAt: string;
	basis: "explicit-current-base-not-staging-time";
};
/** Conservative POSIX observation only, never an atomic publication primitive. */
export function observeSourceBase(
	repository: string,
	requested: string,
): SourceBase {
	try {
		if (
			process.platform === "win32" ||
			fs.realpathSync(repository) !== repository
		)
			throw Error();
		const file = publicComposePath(requested),
			parts = file.split("/"),
			parents: { file: string; stat: fs.Stats }[] = [];
		let missing: string | undefined;
		for (let index = 0; index < parts.length; index++) {
			const parent = path.join(repository, ...parts.slice(0, index));
			try {
				const stat = fs.lstatSync(parent);
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error();
				parents.push({ file: parent, stat });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || index === 0)
					throw error;
				missing = parent;
				break;
			}
		}
		const stableParents = () =>
			parents.every(({ file, stat }) => {
				const current = fs.lstatSync(file);
				return (
					current.isDirectory() &&
					!current.isSymbolicLink() &&
					current.dev === stat.dev &&
					current.ino === stat.ino &&
					current.mtimeMs === stat.mtimeMs &&
					current.ctimeMs === stat.ctimeMs
				);
			});
		const absent = (selected: string) => {
			try {
				fs.lstatSync(selected);
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
				throw error;
			}
		};
		const binding = {
			version: 1,
			repository,
			file,
			parents: parents.map(({ file, stat }) => ({
				path: path.relative(repository, file),
				dev: stat.dev,
				ino: stat.ino,
			})),
		};
		const result = (
			observation: Record<string, unknown>,
			contentDigest?: string,
		): SourceBase => ({
			version: 1,
			state: contentDigest === undefined ? "absent" : "regular",
			fingerprint: digest(JSON.stringify({ ...binding, ...observation })),
			contentDigest,
			capturedAt: new Date().toISOString(),
			basis: "explicit-current-base-not-staging-time",
		});
		if (missing) {
			if (!stableParents() || !absent(missing)) throw Error();
			return result({ missing: path.relative(repository, missing) });
		}
		const selected = path.join(repository, file);
		if (absent(selected)) {
			if (!stableParents() || !absent(selected)) throw Error();
			return result({ state: "absent" });
		}
		const before = fs.lstatSync(selected);
		const ordinary = (stat: fs.Stats) =>
			stat.isFile() &&
			!stat.isSymbolicLink() &&
			stat.nlink === 1 &&
			stat.size <= 65536;
		const same = (stat: fs.Stats) =>
			ordinary(stat) &&
			stat.dev === before.dev &&
			stat.ino === before.ino &&
			stat.size === before.size &&
			stat.mtimeMs === before.mtimeMs &&
			stat.ctimeMs === before.ctimeMs &&
			stat.mode === before.mode;
		if (!ordinary(before) || !stableParents()) throw Error();
		const fd = fs.openSync(
			selected,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		try {
			if (!same(fs.fstatSync(fd)) || !stableParents()) throw Error();
			const bytes = Buffer.alloc(65537);
			let length = 0;
			while (length < bytes.length) {
				const count = fs.readSync(
					fd,
					bytes,
					length,
					bytes.length - length,
					null,
				);
				if (!count) break;
				length += count;
			}
			if (
				length !== before.size ||
				length > 65536 ||
				!same(fs.fstatSync(fd)) ||
				!same(fs.lstatSync(selected)) ||
				!stableParents()
			)
				throw Error();
			const contentDigest = digest(bytes.subarray(0, length));
			return result(
				{
					state: "regular",
					dev: before.dev,
					ino: before.ino,
					size: before.size,
					mtime: before.mtimeMs,
					ctime: before.ctimeMs,
					mode: before.mode,
					contentDigest,
				},
				contentDigest,
			);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		throw new Error(
			"Source base unavailable/changed or unsupported: conventional contained POSIX ordinary files only; links, hard links and oversized sources refused. Values and filesystem errors withheld.",
		);
	}
}
export function inspectSourceBase(
	source: {
		repository: string;
		file: string;
		digest: string;
		base: SourceBase;
	},
	app: string,
	target: string,
) {
	const scope = {
		kind: "source-base-comparison" as const,
		app,
		target,
		sourceDigest: source.digest,
		baseFingerprint: source.base.fingerprint,
		sourceContentsChecked: false as const,
		runtimeChecked: false as const,
		dependenciesExpanded: false as const,
	};
	try {
		const current = observeSourceBase(source.repository, source.file);
		return {
			...scope,
			matches: current.fingerprint === source.base.fingerprint,
			observed: current,
			message:
				"Historical live-vs-established-base identity/content comparison only; not staged-text equality. No original staging-time base, atomic filesystem guarantee, runtime validation, review or promotion authority.",
		};
	} catch {
		return {
			...scope,
			matches: null,
			message:
				"Current source base unavailable/unsupported/changed during observation; values and errors withheld. No match or promotion authority.",
		};
	}
}
