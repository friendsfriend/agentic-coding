import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readV2Configuration } from "../configuration/v2-configuration.ts";
import type {
	ConfigurationMutation,
	ConfigurationMutationResult,
	ConfigurationPreview,
	ConfigurationRevision,
} from "../domain/configuration-write.ts";
import { OperationRefusal } from "../domain/operation.ts";

const fileByteLimit = 4 * 1024 * 1024;
const backupLimit = 10;
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const actionValues = ["build", "test", "run"] as const;
const kindValues = ["app", "library", "infrastructure"] as const;

type RawObject = Record<string, unknown>;
type RawProject = RawObject & {
	id: string;
	repository: string;
	kind?: string;
	defaults?: Record<string, string>;
	targets: RawObject[];
};
type RawTarget = RawObject & {
	id: string;
	action: string;
	runtime: string;
	profile?: string;
	prerequisites?: { app: string; target: string }[];
};

const object = (value: unknown): RawObject =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as RawObject)
		: {};
const array = (value: unknown): unknown[] =>
	Array.isArray(value) ? value : [];
const text = (value: unknown) =>
	typeof value === "string" ? value : undefined;
const digest = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
const invalid = () => new OperationRefusal("config-invalid");
const digestOfMutation = (
	expectedDigest: string,
	mutation: ConfigurationMutation,
) => digest(JSON.stringify({ expectedDigest, mutation }));

function projects(document: RawObject): RawProject[] {
	if (document.version !== 1) throw invalid();
	return array(document.projects).map((entry) => {
		const project = object(entry);
		if (
			typeof project.id !== "string" ||
			typeof project.repository !== "string"
		)
			throw invalid();
		const targets = array(project.targets).map((target) => object(target));
		return {
			...project,
			id: project.id,
			repository: project.repository,
			targets,
		} as RawProject;
	});
}

function targetOf(project: RawProject, id: string) {
	const target = project.targets.find((entry) => entry.id === id);
	if (!target) throw new OperationRefusal("target-not-found");
	return target as RawTarget;
}

function validateProfile(profile: string | undefined) {
	if (
		profile !== undefined &&
		(!profile.trim() || profile.length > 64 || /[\0\r\n]/.test(profile))
	)
		throw invalid();
}

function validateStringRecord(
	value: Record<string, string> | undefined,
	limit = 16000,
) {
	if (!value) return;
	if (Object.keys(value).length > 64) throw invalid();
	for (const [key, entry] of Object.entries(value))
		if (
			!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
			typeof entry !== "string" ||
			entry.length > limit ||
			entry.includes("\0")
		)
			throw invalid();
}

function references(
	document: RawObject,
	app: string,
	target: string,
	skip?: RawTarget,
) {
	for (const project of projects(document))
		for (const entry of project.targets)
			if (entry !== skip && Array.isArray(entry.prerequisites))
				for (const prerequisite of entry.prerequisites) {
					const value = object(prerequisite);
					if (value.app === app && value.target === target) return true;
				}
	return false;
}

function validateDocument(
	document: RawObject,
	repositories: readonly string[],
) {
	const appIds = new Set<string>();
	let targetTotal = 0;
	const allTargets: { app: string; target: RawTarget }[] = [];
	for (const project of projects(document)) {
		if (
			!idPattern.test(project.id) ||
			appIds.has(project.id) ||
			!repositories.includes(project.repository)
		)
			throw invalid();
		appIds.add(project.id);
		if (
			project.kind !== undefined &&
			!kindValues.includes(project.kind as (typeof kindValues)[number])
		)
			throw invalid();
		const targets = project.targets as RawTarget[];
		const targetIds = new Set<string>();
		for (const target of targets) {
			targetTotal++;
			if (
				typeof target.id !== "string" ||
				!idPattern.test(target.id) ||
				targetIds.has(target.id) ||
				!actionValues.includes(
					target.action as (typeof actionValues)[number],
				) ||
				typeof target.runtime !== "string" ||
				!target.runtime
			)
				throw invalid();
			targetIds.add(target.id);
			validateProfile(text(target.profile));
			if (Array.isArray(target.prerequisites)) {
				if (target.prerequisites.length > 16 || target.action !== "run")
					throw invalid();
				for (const prerequisite of target.prerequisites) {
					const value = object(prerequisite);
					if (typeof value.app !== "string" || typeof value.target !== "string")
						throw invalid();
				}
			}
			allTargets.push({ app: project.id, target });
		}
		for (const [action, targetId] of Object.entries(project.defaults ?? {})) {
			if (!actionValues.includes(action as (typeof actionValues)[number]))
				throw invalid();
			const target = targets.find((entry) => entry.id === targetId);
			if (!target || target.action !== action) throw invalid();
		}
	}
	for (const { app, target } of allTargets)
		for (const prerequisite of target.prerequisites ?? []) {
			const source = projects(document).find(
				(entry) => entry.id === prerequisite.app,
			);
			if (!source?.targets.some((entry) => entry.id === prerequisite.target))
				throw invalid();
			if (prerequisite.app === app && prerequisite.target === target.id)
				throw invalid();
		}
	return { apps: appIds.size, targets: targetTotal };
}

function summaryFor(mutation: ConfigurationMutation) {
	if (mutation.operation === "app-create")
		return `create ${mutation.app.kind ?? "app"} ${mutation.app.id}`;
	if (mutation.operation === "app-update")
		return `update application ${mutation.id}`;
	if (mutation.operation === "app-delete")
		return `delete application ${mutation.id}${mutation.deleteTargets ? " and targets" : ""}`;
	if (mutation.operation === "target-create")
		return mutation.mode === "duplicate"
			? `duplicate target ${mutation.sourceTarget} as ${mutation.id}`
			: `create shell target ${mutation.id}`;
	if (mutation.operation === "target-update")
		return `update target ${mutation.app}/${mutation.id}`;
	return `delete target ${mutation.app}/${mutation.id}`;
}

function applyMutation(
	document: RawObject,
	mutation: ConfigurationMutation,
	repositories: readonly string[],
) {
	const list = projects(document);
	if (mutation.operation === "app-create") {
		if (!idPattern.test(mutation.app.id)) throw invalid();
		if (!repositories.includes(mutation.app.repository)) throw invalid();
		if (list.some((project) => project.id === mutation.app.id))
			throw new OperationRefusal("app-exists");
		const defaults = mutation.app.defaults ?? {};
		if (Object.keys(defaults).length) throw invalid();
		list.push({
			id: mutation.app.id,
			kind: mutation.app.kind ?? "app",
			repository: mutation.app.repository,
			defaults,
			targets: [],
		});
	} else if (mutation.operation === "app-update") {
		const project = list.find((entry) => entry.id === mutation.id);
		if (!project) throw new OperationRefusal("app-not-found");
		if (mutation.kind !== undefined) project.kind = mutation.kind;
		if (
			mutation.repository !== undefined &&
			mutation.repository !== project.repository
		) {
			if (project.targets.length) throw new OperationRefusal("app-has-targets");
			if (!repositories.includes(mutation.repository)) throw invalid();
			project.repository = mutation.repository;
		}
		if (mutation.defaults !== undefined)
			project.defaults = { ...mutation.defaults };
	} else if (mutation.operation === "app-delete") {
		const index = list.findIndex((entry) => entry.id === mutation.id);
		if (index < 0) throw new OperationRefusal("app-not-found");
		const project = list[index];
		if (project.targets.length && !mutation.deleteTargets)
			throw new OperationRefusal("app-has-targets");
		for (const target of project.targets)
			if (references(document, project.id, String(target.id)))
				throw new OperationRefusal("target-referenced");
		list.splice(index, 1);
	} else if (mutation.operation === "target-create") {
		const project = list.find((entry) => entry.id === mutation.app);
		if (!project) throw new OperationRefusal("app-not-found");
		if (!idPattern.test(mutation.id)) throw invalid();
		if (project.targets.some((target) => target.id === mutation.id))
			throw new OperationRefusal("target-exists");
		if (mutation.mode === "duplicate") {
			const sourceProject = list.find(
				(entry) => entry.id === mutation.sourceApp,
			);
			if (!sourceProject) throw new OperationRefusal("app-not-found");
			const source = targetOf(sourceProject, mutation.sourceTarget);
			const duplicate = structuredClone(source) as RawTarget;
			duplicate.id = mutation.id;
			if (mutation.profile !== undefined) {
				validateProfile(mutation.profile);
				duplicate.profile = mutation.profile;
			}
			project.targets.push(duplicate);
		} else {
			validateProfile(mutation.profile);
			validateStringRecord(mutation.environment);
			validateStringRecord(mutation.secretRefs);
			if (!mutation.command.trim() || mutation.command.length > 65536)
				throw invalid();
			if (mutation.readyText !== undefined && mutation.action !== "run")
				throw invalid();
			project.targets.push({
				id: mutation.id,
				action: mutation.action,
				runtime: "shell",
				command: mutation.command,
				...(mutation.profile !== undefined
					? { profile: mutation.profile }
					: {}),
				...(mutation.timeoutSec !== undefined
					? { timeoutMs: mutation.timeoutSec * 1000 }
					: {}),
				...(mutation.environment
					? { environment: { ...mutation.environment } }
					: {}),
				...(mutation.secretRefs
					? { secretRefs: { ...mutation.secretRefs } }
					: {}),
				...(mutation.readyText !== undefined
					? { readyText: mutation.readyText }
					: {}),
			});
		}
	} else if (mutation.operation === "target-update") {
		const project = list.find((entry) => entry.id === mutation.app);
		if (!project) throw new OperationRefusal("app-not-found");
		const target = targetOf(project, mutation.id);
		if (mutation.profile !== undefined) {
			if (mutation.profile === null) delete target.profile;
			else {
				validateProfile(mutation.profile);
				target.profile = mutation.profile;
			}
		}
		if (mutation.action !== undefined) target.action = mutation.action;
		if (mutation.command !== undefined) {
			if (target.runtime !== "shell" && target.runtime !== "systemshell")
				throw invalid();
			if (!mutation.command.trim() || mutation.command.length > 65536)
				throw invalid();
			target.command = mutation.command;
		}
		if (mutation.timeoutSec !== undefined)
			target.timeoutMs = mutation.timeoutSec * 1000;
		if (mutation.readyText !== undefined) {
			if (mutation.readyText === null) delete target.readyText;
			else {
				if (target.action !== "run") throw invalid();
				target.readyText = mutation.readyText;
			}
		}
		if (mutation.dependsOn !== undefined)
			target.dependsOn = mutation.dependsOn.map((entry) => ({ ...entry }));
		if (mutation.prerequisites !== undefined) {
			if (mutation.prerequisites.length > 16) throw invalid();
			target.prerequisites = mutation.prerequisites.map((entry) => ({
				app: entry.app,
				target: entry.target,
			}));
		}
		if (mutation.endpoints !== undefined)
			target.endpoints = { ...mutation.endpoints };
		if (mutation.endpointServices !== undefined)
			target.endpointServices = { ...mutation.endpointServices };
	} else {
		const project = list.find((entry) => entry.id === mutation.app);
		if (!project) throw new OperationRefusal("app-not-found");
		const index = project.targets.findIndex(
			(target) => target.id === mutation.id,
		);
		if (index < 0) throw new OperationRefusal("target-not-found");
		if (Object.values(project.defaults ?? {}).includes(mutation.id))
			throw new OperationRefusal("target-is-default");
		if (
			references(
				document,
				mutation.app,
				mutation.id,
				project.targets[index] as RawTarget,
			)
		)
			throw new OperationRefusal("target-referenced");
		project.targets.splice(index, 1);
	}
	document.projects = list;
	const counts = validateDocument(document, repositories);
	return { document, counts, summary: summaryFor(mutation) };
}

export type ConfigurationWriteService = ReturnType<
	typeof createConfigurationWriteService
>;

export function createConfigurationWriteService(options: {
	configDir: string;
	repositories: readonly string[];
	refresh: () => Record<string, unknown>;
}) {
	const root = fs.realpathSync(options.configDir);
	const file = path.join(root, "environments.json");
	let queue: Promise<unknown> = Promise.resolve();
	const serialize = <T>(action: () => Promise<T> | T): Promise<T> => {
		const next = queue.then(action, action);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
	const readRaw = () => {
		const stat = fs.lstatSync(file);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.nlink !== 1 ||
			stat.size > fileByteLimit
		)
			throw new OperationRefusal("config-write-unavailable");
		const bytes = fs.readFileSync(file);
		if (bytes.length > fileByteLimit)
			throw new OperationRefusal("config-write-unavailable");
		let document: RawObject;
		try {
			document = object(JSON.parse(bytes.toString("utf8")));
		} catch {
			throw invalid();
		}
		return { bytes, digest: digest(bytes), document, mode: stat.mode & 0o777 };
	};
	const writeAtomic = (target: string, bytes: Buffer, mode: number) => {
		const temp = path.join(root, `.environments.json.mcp-tmp-${randomUUID()}`);
		const fd = fs.openSync(temp, "wx", 0o600);
		try {
			fs.writeFileSync(fd, bytes);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		try {
			fs.chmodSync(temp, mode);
			fs.renameSync(temp, target);
		} catch (error) {
			try {
				fs.rmSync(temp, { force: true });
			} catch {
				/* Best effort. */
			}
			throw error;
		}
	};
	const backup = (bytes: Buffer, mode: number) => {
		const name = `environments.json.mcp-bak-${new Date()
			.toISOString()
			.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
		const target = path.join(root, name);
		const fd = fs.openSync(target, "wx", 0o600);
		try {
			fs.writeFileSync(fd, bytes);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.chmodSync(target, mode);
		const backups = fs
			.readdirSync(root)
			.filter((entry) => entry.startsWith("environments.json.mcp-bak-"))
			.sort();
		for (const stale of backups.slice(
			0,
			Math.max(0, backups.length - backupLimit),
		))
			try {
				fs.rmSync(path.join(root, stale), { force: true });
			} catch {
				/* Best effort. */
			}
		return target;
	};
	const preview = (mutation: ConfigurationMutation): ConfigurationPreview => {
		const current = readRaw();
		const clone = structuredClone(current.document);
		const applied = applyMutation(clone, mutation, options.repositories);
		const next = `${JSON.stringify(applied.document, null, 2)}\n`;
		const expectedDigest = current.digest;
		return {
			status: "confirmation-required",
			expectedDigest,
			nextDigest: digest(next),
			confirm: digestOfMutation(expectedDigest, mutation),
			summary: applied.summary,
		};
	};
	const apply = (
		mutation: ConfigurationMutation,
		expectedDigest: string,
		confirm: string,
	): Promise<ConfigurationMutationResult> =>
		serialize(() => {
			const current = readRaw();
			if (current.digest !== expectedDigest)
				throw new OperationRefusal("config-stale");
			const clone = structuredClone(current.document);
			const applied = applyMutation(clone, mutation, options.repositories);
			const next = Buffer.from(
				`${JSON.stringify(applied.document, null, 2)}\n`,
			);
			const expectedConfirm = digestOfMutation(expectedDigest, mutation);
			if (confirm !== expectedConfirm)
				return {
					status: "confirmation-required" as const,
					expectedDigest,
					nextDigest: digest(next),
					confirm: expectedConfirm,
					summary: applied.summary,
				};
			if (digest(fs.readFileSync(file)) !== expectedDigest)
				throw new OperationRefusal("config-stale");
			const backupFile = backup(current.bytes, current.mode);
			writeAtomic(file, next, current.mode);
			try {
				readV2Configuration(root);
			} catch {
				writeAtomic(file, current.bytes, current.mode);
				throw new OperationRefusal("config-invalid");
			}
			try {
				options.refresh();
			} catch {
				writeAtomic(file, current.bytes, current.mode);
				try {
					options.refresh();
				} catch {
					/* The on-disk configuration is restored; report refresh refusal. */
				}
				throw new OperationRefusal("configuration-refresh-invalid");
			}
			return {
				status: "completed" as const,
				digest: digest(next),
				summary: `${applied.summary} (backup ${path.basename(backupFile)})`,
			};
		});
	return {
		revision(): ConfigurationRevision {
			const current = readRaw();
			const list = projects(current.document);
			return {
				digest: current.digest,
				apps: list.length,
				targets: list.reduce(
					(total, project) => total + project.targets.length,
					0,
				),
				repositories: [...options.repositories],
			};
		},
		preview,
		apply,
	};
}
