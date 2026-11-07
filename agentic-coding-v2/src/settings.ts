import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { type Config, digest, object, readProfiles } from "./config.ts";
import type {
	SettingsCandidate,
	SettingsDefinition,
	SettingsDocument,
} from "./protocol/index.ts";
import { readProviders } from "./providers/config.ts";

const maximum = 262144;
function canonical(dir: string): string {
	if (existsSync(dir)) return realpathSync(dir);
	return path.join(canonical(path.dirname(dir)), path.basename(dir));
}
function normalize(value: unknown): SettingsDefinition {
	const data = object(value);
	if (
		Object.keys(data).some(
			(key) =>
				![
					"profiles",
					"orchestratorProfile",
					"repositories",
					"providers",
				].includes(key),
		)
	)
		throw new Error("Unsupported settings field");
	const rawProfiles = object(data.profiles);
	if (Object.keys(rawProfiles).length > 32)
		throw new Error("Too many profiles");
	for (const [id, raw] of Object.entries(rawProfiles)) {
		const profile = object(raw);
		if (
			!id.length ||
			id.length > 128 ||
			/\s/.test(id) ||
			Object.keys(profile).some(
				(key) => !["model", "thinking", "description"].includes(key),
			) ||
			(profile.description !== undefined &&
				(typeof profile.description !== "string" ||
					profile.description.length > 2048))
		)
			throw new Error("Invalid profile settings");
	}
	const profiles = readProfiles(rawProfiles);
	if (
		typeof data.orchestratorProfile !== "string" ||
		(data.orchestratorProfile !== "" &&
			!profiles.some((profile) => profile.id === data.orchestratorProfile))
	)
		throw new Error("Invalid orchestrator profile");
	if (
		!Array.isArray(data.repositories) ||
		!data.repositories.length ||
		data.repositories.length > 64 ||
		!data.repositories.every(
			(repo) =>
				typeof repo === "string" &&
				path.isAbsolute(repo) &&
				repo.length <= 4096,
		)
	)
		throw new Error("Invalid repositories");
	const repositories = data.repositories.map((repo) => {
		const resolved = realpathSync(repo);
		if (!lstatSync(resolved).isDirectory())
			throw new Error("Repository must be a directory");
		return resolved;
	});
	if (!Array.isArray(data.providers) || data.providers.length > 32)
		throw new Error("Invalid providers");
	const providers = readProviders(
		data.providers.map((raw) => {
			const provider = object(raw);
			if (typeof provider.name !== "string" || /\s/.test(provider.name))
				throw new Error("Invalid provider name");
			if (
				Object.keys(provider).some(
					(key) =>
						!["name", "type", "baseUrl", "username", "tokenRef"].includes(key),
				)
			)
				throw new Error("Unsupported provider setting");
			if (
				provider.tokenRef !== undefined &&
				(typeof provider.tokenRef !== "string" ||
					(provider.tokenRef !== "" &&
						(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.tokenRef) ||
							/\s/.test(provider.tokenRef))))
			)
				throw new Error(
					"Only environment-variable token references are accepted",
				);
			if (provider.baseUrl !== undefined) {
				const url = new URL(String(provider.baseUrl));
				if (url.username || url.password || url.search || url.hash)
					throw new Error(
						"Provider URL must not include credentials, query or fragment",
					);
			}
			return {
				...provider,
				...(provider.username === "" ? { username: undefined } : {}),
				...(provider.tokenRef === "" ? { tokenRef: undefined } : {}),
			};
		}),
	).map(({ name, type, baseUrl, username, tokenRef }) => ({
		name,
		type,
		baseUrl,
		...(username ? { username } : {}),
		...(tokenRef ? { tokenRef } : {}),
	}));
	if (
		new Set(providers.map((provider) => provider.name)).size !==
		providers.length
	)
		throw new Error("Duplicate provider names");
	const settings: SettingsDefinition = {
		profiles: Object.fromEntries(
			profiles.map((profile) => [
				profile.id,
				{
					model: `${profile.provider}/${profile.modelId}`,
					thinking: profile.thinking,
					description: profile.description,
				},
			]),
		),
		orchestratorProfile: data.orchestratorProfile,
		repositories: [...new Set(repositories)],
		providers,
	};
	if (JSON.stringify(settings).length > 64000)
		throw new Error("Settings are oversized");
	return settings;
}

/** Fixed native config file, bounded ephemeral candidates. Saving never changes the running host or grants execution authority. */
export class Settings {
	private readonly root: string;
	private readonly candidates = new Map<
		string,
		{ view: SettingsCandidate; bytes: string }
	>();
	constructor(private readonly config: Config) {
		this.root = canonical(path.resolve(config.configDir));
	}
	private file() {
		if (process.platform === "win32")
			throw new Error("Native settings file editing is not enabled on Windows");
		if (canonical(path.resolve(this.config.configDir)) !== this.root)
			throw new Error("Configuration directory identity changed");
		return path.join(this.root, "config.json");
	}
	private stored() {
		const file = this.file();
		let fd: number;
		try {
			fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { revision: "missing", data: {} as Record<string, unknown> };
			throw new Error("Configuration file unavailable");
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum)
				throw new Error(
					"Configuration file must be a bounded private regular file",
				);
			const buffer = Buffer.alloc(maximum + 1);
			let size = 0;
			while (size < buffer.length) {
				const count = readSync(fd, buffer, size, buffer.length - size, size);
				if (!count) break;
				size += count;
			}
			if (size > maximum) throw new Error("Configuration file oversized");
			const bytes = buffer.subarray(0, size);
			const source = bytes.toString("utf8");
			if (!Buffer.from(source, "utf8").equals(bytes))
				throw new Error("Configuration must be valid UTF-8");
			const data = object(JSON.parse(source));
			if (data.skillDirectories !== undefined)
				throw new Error("Unsupported skillDirectories");
			return { revision: digest(bytes), data };
		} finally {
			closeSync(fd);
		}
	}
	read(): SettingsDocument {
		const stored = this.stored();
		const active = {
			profiles: Object.fromEntries(
				this.config.profiles.map((profile) => [
					profile.id,
					{
						model: `${profile.provider}/${profile.modelId}`,
						thinking: profile.thinking,
						description: profile.description,
					},
				]),
			),
			orchestratorProfile: this.config.orchestratorProfile,
			repositories: this.config.repositories,
			providers: this.config.providers.map(
				({ name, type, baseUrl, username, tokenRef }) => ({
					name,
					type,
					baseUrl,
					...(username ? { username } : {}),
					...(tokenRef ? { tokenRef } : {}),
				}),
			),
		};
		return {
			revision: stored.revision,
			settings: normalize(
				Object.fromEntries(
					Object.entries(active).map(([key, value]) => [
						key,
						Object.hasOwn(stored.data, key) ? stored.data[key] : value,
					]),
				),
			),
			restartRequired: true,
		};
	}
	preview(baseRevision: unknown, value: unknown): SettingsCandidate {
		const stored = this.stored();
		if (baseRevision !== stored.revision)
			throw new Error("Stale settings revision");
		const settings = normalize(value);
		const snapshot = JSON.stringify({ baseRevision, settings }, null, 2);
		const bytes = `${JSON.stringify({ ...stored.data, ...settings }, null, 2)}\n`;
		if (Buffer.byteLength(bytes) > maximum)
			throw new Error("Configuration file oversized");
		for (const [id, candidate] of this.candidates)
			if (candidate.view.expiresAt <= Date.now()) this.candidates.delete(id);
		if (this.candidates.size >= 16)
			throw new Error("Candidate capacity reached; wait for expiry");
		const view: SettingsCandidate = {
			id: crypto.randomUUID(),
			baseRevision: stored.revision,
			digest: digest(snapshot),
			snapshot,
			expiresAt: Date.now() + 600000,
			restartRequired: true,
		};
		this.candidates.set(view.id, { view, bytes });
		return { ...view };
	}
	apply(id: unknown, approval: unknown) {
		const candidate =
			typeof id === "string" ? this.candidates.get(id) : undefined;
		if (
			!candidate ||
			candidate.view.expiresAt <= Date.now() ||
			approval !== `approve:${candidate.view.digest}`
		)
			throw new Error("Exact unexpired settings confirmation required");
		const file = this.file();
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const lock = path.join(this.root, ".config.edit.lock");
		const lockFd = openSync(lock, "wx", 0o600);
		const lockIdentity = fstatSync(lockFd);
		let temp: string | null = null;
		try {
			if (this.stored().revision !== candidate.view.baseRevision)
				throw new Error("Stale settings revision");
			temp = path.join(this.root, `.config-${crypto.randomUUID()}.tmp`);
			const fd = openSync(temp, "wx", 0o600);
			try {
				writeFileSync(fd, candidate.bytes);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			if (this.stored().revision !== candidate.view.baseRevision)
				throw new Error("Stale settings revision");
			renameSync(temp, file);
			temp = null;
			if (typeof id === "string") this.candidates.delete(id);
			const dir = openSync(this.root, constants.O_RDONLY);
			try {
				fsyncSync(dir);
			} finally {
				closeSync(dir);
			}
			return {
				revision: digest(candidate.bytes),
				restartRequired: true as const,
			};
		} finally {
			if (temp !== null) unlinkSync(temp);
			closeSync(lockFd);
			const current = lstatSync(lock);
			if (current.ino === lockIdentity.ino && current.dev === lockIdentity.dev)
				unlinkSync(lock);
		}
	}
}
