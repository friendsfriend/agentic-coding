import fs from "node:fs";
import path from "node:path";
import { type Config, digest } from "../config.ts";
import { validateProjects } from "./catalog.ts";
import { compileComposeSource } from "./compose-config.ts";

/** Deliberately narrow public-source convention. No private inputs, links,
 * hard links, arbitrary filenames, tree walk, subprocess or source publication. */
export function publicComposePath(requested: string) {
	const parts = requested.split("/").filter((part) => part !== ".");
	if (
		!parts.length ||
		parts.length > 16 ||
		requested.includes("\\") ||
		parts.some(
			(part) =>
				!part ||
				part === ".." ||
				part.startsWith(".") ||
				/(?:^|[-_.])(providers?|credentials?|secrets?)(?:$|[-_.])/i.test(part),
		) ||
		!/^(?:docker-)?compose(?:\.[a-z0-9_-]+)?\.ya?ml$/i.test(parts.at(-1) ?? "")
	)
		throw new Error("Unsupported public source name");
	return parts.join("/");
}
function capture(repository: string, requested: string) {
	if (process.platform === "win32")
		throw new Error(
			"Source capture requires POSIX file identity/no-follow semantics",
		);
	const parts = publicComposePath(requested).split("/");
	if (fs.realpathSync(repository) !== repository)
		throw new Error("Repository binding changed");
	const directories = [repository];
	for (const part of parts.slice(0, -1))
		directories.push(path.join(directories.at(-1) ?? repository, part));
	const directoryStats = directories.map((directory) => {
		const stat = fs.lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("Source directory is not ordinary");
		return stat;
	});
	const file = path.join(repository, ...parts),
		before = fs.lstatSync(file);
	if (
		!before.isFile() ||
		before.isSymbolicLink() ||
		before.nlink !== 1 ||
		before.size > 65536
	)
		throw new Error("Source is not a bounded ordinary public file");
	const unchangedDirectories = () =>
		directories.every((directory, index) => {
			const current = fs.lstatSync(directory),
				original = directoryStats[index];
			return (
				original &&
				current.isDirectory() &&
				!current.isSymbolicLink() &&
				current.dev === original.dev &&
				current.ino === original.ino &&
				current.mtimeMs === original.mtimeMs &&
				current.ctimeMs === original.ctimeMs
			);
		});
	if (!unchangedDirectories()) throw new Error("Source directories changed");
	const fd = fs.openSync(
		file,
		fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
	);
	try {
		const opened = fs.fstatSync(fd);
		const same = (stat: fs.Stats) =>
			stat.isFile() &&
			stat.nlink === 1 &&
			stat.dev === before.dev &&
			stat.ino === before.ino &&
			stat.size === before.size &&
			stat.mtimeMs === before.mtimeMs &&
			stat.ctimeMs === before.ctimeMs;
		if (!same(opened) || !unchangedDirectories())
			throw new Error("Source changed before capture");
		const bytes = Buffer.alloc(65537);
		let length = 0;
		while (length < bytes.length) {
			const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		if (
			length > 65536 ||
			length !== opened.size ||
			!same(fs.fstatSync(fd)) ||
			!same(fs.lstatSync(file)) ||
			!unchangedDirectories()
		)
			throw new Error("Source changed during capture");
		const captured = bytes.subarray(0, length);
		return {
			source: new TextDecoder("utf-8", { fatal: true }).decode(captured),
			contentDigest: digest(captured.toString("base64")),
			bytes: length,
		};
	} finally {
		fs.closeSync(fd);
	}
}

export function inspectComposeSource(
	config: Config,
	content: string,
	app: string,
	targetId: string,
	staged?: { content: string; digest: string },
) {
	const scope = {
		repositoryDigest: digest(JSON.stringify(config.repositories)),
		kind: staged
			? ("staged-compose-source" as const)
			: ("compose-source" as const),
		app,
		target: targetId,
		sourceContentsChecked: false as const,
		runtimeChecked: false as const,
		dependenciesExpanded: false as const,
	};
	let checkedSource: { contentDigest: string; bytes: number } | null = null;
	try {
		const project = validateProjects(config, JSON.parse(content)).find(
			(project) => project.id === app,
		);
		const definition = project?.targets.find(
			(target) => target.id === targetId,
		)?.compose;
		if (!project || !definition) throw new Error("No exact Compose target");
		publicComposePath(definition.file);
		if (staged && digest(staged.content) !== staged.digest)
			throw new Error("Staged source digest mismatch");
		const captured = staged
			? {
					source: staged.content,
					contentDigest: digest(Buffer.from(staged.content).toString("base64")),
					bytes: Buffer.byteLength(staged.content),
				}
			: capture(project.repository, definition.file);
		checkedSource = {
			contentDigest: captured.contentDigest,
			bytes: captured.bytes,
		};
		const plan = compileComposeSource(project.repository, definition, captured);
		return {
			...scope,
			accepted: true,
			checkedSource,
			compiledDigest: digest(JSON.stringify(plan)),
			serviceCount: plan.services.length,
			origin: staged ? "private-staged-text" : "repository-file",
			stagedDigest: staged?.digest,
			base: staged
				? "not validated by parser; promotion unsupported"
				: undefined,
			message:
				"Selected Compose source accepted by the native strict subset parser. Only the selected bytes were parsed (staged text or opted-in repository capture); source text, commands, environment values and compiled plans are withheld. Bind paths are containment-checked, not validated as a complete source tree. No credential resolution, engine calls, runtime tests or promotion authority. Other sources remain unchecked.",
		};
	} catch {
		return {
			...scope,
			accepted: false,
			checkedSource,
			message:
				"Source check refused: invalid draft/selection, unsupported/private name, link/hard link, escaping/changed/unavailable/oversized/non-UTF8 file, or unsupported native Compose syntax/bind path. Values, source text and parser/filesystem errors withheld. No runtime validation or promotion authority.",
		};
	}
}
