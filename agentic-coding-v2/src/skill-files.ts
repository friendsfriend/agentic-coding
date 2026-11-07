import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type Config, digest } from "./config.ts";
import type {
	SkillFileCandidate,
	SkillFileDocument,
} from "./protocol/index.ts";

/** Fixed native CONFIG_DIR/skills/<slug>/SKILL.md authoring. Saving does not
 * reload skills, modify admitted tasks or grant a skill execution policy. */
function canonical(dir: string): string {
	if (fs.existsSync(dir)) return fs.realpathSync(dir);
	return path.join(canonical(path.dirname(dir)), path.basename(dir));
}
export class SkillFiles {
	private readonly root: string;
	private candidates = new Map<string, SkillFileCandidate>();
	constructor(private config: Config) {
		this.root = canonical(path.resolve(config.configDir));
	}
	private location(name: string) {
		if (process.platform === "win32")
			throw new Error("Skill file descriptor safety is not enabled on Windows");
		if (
			!/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
			this.config.skills.some(
				(skill) => skill.origin === "system" && skill.id === name,
			)
		)
			throw new Error("Only non-system flat user-skill slugs can be authored");
		const root = this.root;
		if (canonical(path.resolve(this.config.configDir)) !== root)
			throw new Error("Configuration directory binding changed");
		const loaded = this.config.skills.find(
			(skill) => skill.origin === "user" && skill.id === name,
		);
		if (
			loaded?.sourceFile &&
			canonical(loaded.sourceFile) !==
				path.join(root, "skills", name, "SKILL.md")
		)
			throw new Error(
				"Loaded nested/non-flat skill source is not this authoring destination",
			);
		const directories = [
			root,
			path.join(root, "skills"),
			path.join(root, "skills", name),
		];
		const identities: string[] = [];
		for (const directory of directories) {
			try {
				const stat = fs.lstatSync(directory);
				if (
					!stat.isDirectory() ||
					stat.isSymbolicLink() ||
					fs.realpathSync(directory) !== directory
				)
					throw new Error(
						"Skill directory must be a canonical non-symlink directory",
					);
				identities.push(`${stat.dev}:${stat.ino}`);
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code !== "ENOENT" ||
					directory === root
				)
					throw error;
				identities.push("missing");
			}
		}
		return {
			root,
			directories,
			file: path.join(directories[2] ?? root, "SKILL.md"),
			identity: identities.join("/"),
		};
	}
	read(name: string): SkillFileDocument {
		const location = this.location(name);
		let fd: number;
		try {
			fd = fs.openSync(
				location.file,
				fs.constants.O_RDONLY |
					fs.constants.O_NOFOLLOW |
					fs.constants.O_NONBLOCK,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return {
				name,
				revision: "missing",
				directoryIdentity: location.identity,
				content: "",
				restartRequired: true,
			};
		}
		try {
			const before = fs.fstatSync(fd);
			if (!before.isFile() || before.nlink !== 1 || before.size > 256000)
				throw new Error(
					"Skill file must be a bounded regular non-hard-linked file",
				);
			const buffer = Buffer.alloc(before.size + 1);
			let used = 0;
			while (used < buffer.length) {
				const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
				if (!count) break;
				used += count;
			}
			const after = fs.fstatSync(fd),
				current = fs.lstatSync(location.file);
			if (
				used !== before.size ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs ||
				before.dev !== current.dev ||
				before.ino !== current.ino ||
				current.nlink !== 1 ||
				!current.isFile() ||
				this.location(name).identity !== location.identity
			)
				throw new Error("Skill file/directory changed during read");
			const bytes = buffer.subarray(0, used),
				content = bytes.toString("utf8");
			if (content.length > 64000 || !Buffer.from(content).equals(bytes))
				throw new Error("Skill text must be bounded valid UTF-8");
			return {
				name,
				content,
				revision: digest(bytes),
				directoryIdentity: location.identity,
				restartRequired: true,
			};
		} finally {
			fs.closeSync(fd);
		}
	}
	preview(
		name: string,
		baseRevision: string,
		content: string,
	): SkillFileCandidate {
		if (
			content.length > 64000 ||
			Buffer.byteLength(content) > 256000 ||
			content.includes("\0") ||
			Buffer.from(content, "utf8").toString("utf8") !== content
		)
			throw new Error("Invalid skill text");
		const { frontmatter } = parseFrontmatter(content);
		if (
			frontmatter.name !== name ||
			typeof frontmatter.description !== "string" ||
			!frontmatter.description.trim() ||
			frontmatter.description.length > 1024
		)
			throw new Error(
				"Skill frontmatter requires the exact slug name and bounded non-empty description",
			);
		const stored = this.read(name);
		if (stored.revision !== baseRevision)
			throw new Error("Stale skill file revision");
		for (const [id, candidate] of this.candidates)
			if (candidate.expiresAt <= Date.now()) this.candidates.delete(id);
		if (this.candidates.size >= 16)
			throw new Error("Skill candidate capacity reached");
		const snapshot = JSON.stringify(
			{
				destination: this.location(name).file,
				name,
				baseRevision,
				directoryIdentity: stored.directoryIdentity,
				content,
			},
			null,
			2,
		);
		const candidate: SkillFileCandidate = {
			id: crypto.randomUUID(),
			name,
			baseRevision,
			directoryIdentity: stored.directoryIdentity,
			content,
			snapshot,
			digest: digest(snapshot),
			expiresAt: Date.now() + 600000,
			restartRequired: true,
		};
		this.candidates.set(candidate.id, candidate);
		return { ...candidate };
	}
	apply(id: string, approval: string) {
		const candidate = this.candidates.get(id);
		if (
			!candidate ||
			candidate.expiresAt <= Date.now() ||
			approval !== `approve:${candidate.digest}`
		)
			throw new Error("Exact unexpired skill snapshot approval required");
		// One attempt, not a durable/replayable file-write capability.
		this.candidates.delete(id);
		const location = this.location(candidate.name);
		if (location.identity !== candidate.directoryIdentity)
			throw new Error("Skill destination identity changed");
		const lock = path.join(location.root, ".skills.edit.lock"),
			lockFd = fs.openSync(lock, "wx", 0o600),
			lockIdentity = fs.fstatSync(lockFd);
		let temp: string | null = null;
		try {
			if (
				this.read(candidate.name).revision !== candidate.baseRevision ||
				this.location(candidate.name).identity !== candidate.directoryIdentity
			)
				throw new Error("Skill destination changed");
			for (const directory of location.directories.slice(1)) {
				try {
					fs.mkdirSync(directory, { mode: 0o700 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			}
			const established = this.location(candidate.name);
			const oldDirectories = candidate.directoryIdentity.split("/"),
				newDirectories = established.identity.split("/");
			if (
				oldDirectories.some(
					(identity, index) =>
						identity !== "missing" && identity !== newDirectories[index],
				)
			)
				throw new Error(
					"Existing skill directory identity changed during establishment",
				);
			if (this.read(candidate.name).revision !== candidate.baseRevision)
				throw new Error(
					"Skill revision changed during directory establishment",
				);
			temp = path.join(
				path.dirname(location.file),
				`.skill-${crypto.randomUUID()}.tmp`,
			);
			const fd = fs.openSync(temp, "wx", 0o600);
			try {
				fs.writeFileSync(fd, candidate.content);
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			if (
				this.read(candidate.name).revision !== candidate.baseRevision ||
				this.location(candidate.name).identity !== established.identity
			)
				throw new Error("Skill destination changed before replacement");
			fs.renameSync(temp, location.file);
			temp = null;
			for (const directory of [...established.directories].reverse()) {
				const dirFd = fs.openSync(
					directory,
					fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
				);
				try {
					fs.fsyncSync(dirFd);
				} finally {
					fs.closeSync(dirFd);
				}
			}
			return {
				name: candidate.name,
				revision: digest(candidate.content),
				restartRequired: true as const,
			};
		} finally {
			try {
				if (temp !== null) fs.unlinkSync(temp);
			} finally {
				fs.closeSync(lockFd);
				const current = fs.lstatSync(lock);
				if (
					current.dev === lockIdentity.dev &&
					current.ino === lockIdentity.ino &&
					current.isFile() &&
					current.nlink === 1
				)
					fs.unlinkSync(lock);
			}
		}
	}
}
