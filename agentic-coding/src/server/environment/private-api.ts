// Bounded private environment operations (port-project-catalog-and-state-to-bun,
// task 3.1). The remaining Go services keep their existing StateStore/Manager
// call sites but, in migrated mode, their implementation is this typed request
// envelope instead of a writable SQLite handle.
//
// Deliberately narrow:
//   • one operation per request, decoded against an explicit schema — there is
//     no SQL text, table name or column on the wire;
//   • one logical operation per request, so an update that must be atomic
//     (`setAppState`, `addApp`, a history insert with its retention trim) stays
//     a single transaction on the owning side and is never split across calls;
//   • the private path is served from Bun's own state/catalog authority and
//     performs no outbound request, so it can never recurse back into Go.
import { Schema } from "effect";
import { decodeRequest, MAX_PATH_CHARS } from "../protocol.ts";
import type { App, InfraService, Project, ProjectCatalog } from "./config.ts";
import { newProjectCatalog } from "./config.ts";
import type { EnvironmentManager } from "./manager.ts";
import type {
	AppRunTargetInfo,
	AppState,
	DependencyLease,
	EnvironmentStateStore,
} from "./state-store.ts";

/** Private operation endpoint. Distinct from the delegated
 * `/api/v1/environment/*` prefix so ownership is unambiguous in the manifest. */
export const ENVIRONMENT_OPERATION_PATH = "/api/v1/environment/private/state";

/** Bounded serialized event payload (a single action event or log line). */
export const MAX_EVENT_JSON_CHARS = 2 * 1024 * 1024;
/** Bounded script-argument payload. */
export const MAX_ARGS_JSON_CHARS = 64 * 1024;

export class EnvironmentOperationError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, status: number, message: string) {
		super(message);
		this.name = "EnvironmentOperationError";
		this.code = code;
		this.status = status;
	}
}

/** The authority the private operations read and write: the single environment
 * state store and the configured-environment manager that owns it. */
export interface EnvironmentAuthority {
	readonly state: EnvironmentStateStore;
	readonly manager: EnvironmentManager;
}

const boundedText = Schema.String.pipe(Schema.maxLength(MAX_PATH_CHARS));
const boundedOptionalText = Schema.optional(boundedText);
const eventJson = Schema.String.pipe(Schema.maxLength(MAX_EVENT_JSON_CHARS));
const argsJson = Schema.Record({
	key: boundedText,
	value: Schema.String.pipe(Schema.maxLength(MAX_PATH_CHARS)),
});
/** Retention limits are clamped by the store as well; the wire bound only
 * keeps a caller from asking for an unbounded scan. */
const limit = Schema.Number.pipe(Schema.int(), Schema.between(0, 50000));
const timestamp = Schema.String.pipe(Schema.maxLength(64));

const appStateSchema = Schema.Struct({
	ident: boundedText,
	branch: boundedText,
	activeWorktree: boundedText,
	mainWorktreeBranch: boundedText,
});

const runTargetSchema = Schema.Struct({
	runtime: boundedText,
	launchMode: boundedText,
	label: boundedText,
	profile: boundedText,
	targetId: boundedText,
	sourcePath: boundedText,
	startedAt: boundedText,
	display: boundedText,
});

const leaseSchema = Schema.Struct({
	targetId: boundedText,
	ownerRunId: boundedText,
	ownerApp: boundedText,
	lifecycle: boundedText,
	updatedAt: boundedText,
});

const appSchema = Schema.Struct({
	ident: boundedText,
	displayName: boundedText,
	repositoryPath: boundedText,
	appType: boundedText,
	containerBaseName: boundedOptionalText,
	sourceType: boundedOptionalText,
	provider: boundedOptionalText,
	gitMode: boundedOptionalText,
	localDirectoryPath: boundedText,
	branch: boundedText,
	activeWorktree: boundedOptionalText,
	mainWorktreeBranch: boundedOptionalText,
});

/** Every accepted operation, with its bounded parameters. */
export const environmentOperationSchema = Schema.Union(
	// ---- state store ----
	Schema.Struct({
		operation: Schema.Literal("state.getAppState"),
		params: Schema.Struct({ ident: boundedText }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.setAppState"),
		params: appStateSchema,
	}),
	Schema.Struct({
		operation: Schema.Literal("state.setBranch"),
		params: Schema.Struct({ ident: boundedText, branch: boundedText }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.setActiveWorktree"),
		params: Schema.Struct({ ident: boundedText, worktree: boundedText }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.setMainWorktreeBranch"),
		params: Schema.Struct({ ident: boundedText, branch: boundedText }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.getAppRunTargetInfo"),
		params: Schema.Struct({ ident: boundedText }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.setAppRunTargetInfo"),
		params: Schema.Struct({ ident: boundedText, info: runTargetSchema }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.clearAppRunTargetInfo"),
		params: Schema.Struct({ ident: boundedText }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.getScriptArgsHistory"),
		params: Schema.Struct({ relativePath: boundedText, limit }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.addScriptArgsHistory"),
		params: Schema.Struct({
			relativePath: boundedText,
			values: argsJson,
			maxEntries: limit,
		}),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.getActionEvents"),
		params: Schema.Struct({ limit }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.getActionEventsSince"),
		params: Schema.Struct({ limit, since: timestamp }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.getActionEventsBetween"),
		params: Schema.Struct({ limit, since: timestamp, before: timestamp }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.addActionEvent"),
		params: Schema.Struct({ eventJson, maxEntries: limit }),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.getActionLogEvents"),
		params: Schema.Struct({
			runId: boundedText,
			stepId: boundedText,
			limit,
		}),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.addActionLogEvent"),
		params: Schema.Struct({
			runId: boundedText,
			stepId: boundedText,
			eventJson,
			maxEntries: limit,
		}),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.getDependencyLeases"),
		params: Schema.Struct({}),
	}),
	Schema.Struct({
		operation: Schema.Literal("state.setDependencyLease"),
		params: leaseSchema,
	}),
	Schema.Struct({
		operation: Schema.Literal("state.deleteDependencyLease"),
		params: Schema.Struct({ targetId: boundedText, ownerRunId: boundedText }),
	}),
	// ---- configured environment (manager/catalog) ----
	Schema.Struct({
		operation: Schema.Literal("manager.getApps"),
		params: Schema.Struct({}),
	}),
	Schema.Struct({
		operation: Schema.Literal("manager.getInfraServices"),
		params: Schema.Struct({}),
	}),
	Schema.Struct({
		operation: Schema.Literal("manager.loadConfig"),
		params: Schema.Struct({}),
	}),
	Schema.Struct({
		operation: Schema.Literal("manager.loadCatalogConfig"),
		params: Schema.Struct({}),
	}),
	Schema.Struct({
		operation: Schema.Literal("manager.getProjectCatalog"),
		params: Schema.Struct({}),
	}),
	Schema.Struct({
		operation: Schema.Literal("manager.addApp"),
		params: Schema.Struct({ app: appSchema }),
	}),
	Schema.Struct({
		operation: Schema.Literal("manager.removeApp"),
		params: Schema.Struct({ ident: boundedText, deleteDir: Schema.Boolean }),
	}),
	Schema.Struct({
		operation: Schema.Literal("manager.saveConfig"),
		params: Schema.Struct({}),
	}),
	Schema.Struct({
		operation: Schema.Literal("manager.updateAppActiveWorktree"),
		params: Schema.Struct({ ident: boundedText, branch: boundedText }),
	}),
	Schema.Struct({
		operation: Schema.Literal("manager.setMainWorktreeBranch"),
		params: Schema.Struct({ ident: boundedText, branch: boundedText }),
	}),
);

export type EnvironmentOperation = typeof environmentOperationSchema.Type;

interface ManagerSnapshot {
	readonly apps: App[];
	readonly infraServices: InfraService[];
}

function snapshotOf(manager: EnvironmentManager): ManagerSnapshot {
	return {
		apps: manager.getApps(),
		infraServices: manager.getInfraServices(),
	};
}

/**
 * Execute one decoded operation against the authority. Every branch is either a
 * single store call (which is itself transactional where the Go operation was)
 * or one manager call that performs its own atomic unit of work.
 */
export function runEnvironmentOperation(
	authority: EnvironmentAuthority,
	operation: EnvironmentOperation,
): unknown {
	const { state, manager } = authority;
	const params = operation.params;
	switch (operation.operation) {
		case "state.getAppState":
			return state.getAppState((params as { ident: string }).ident);
		case "state.setAppState":
			state.setAppState(params as AppState);
			return null;
		case "state.setBranch": {
			const value = params as { ident: string; branch: string };
			state.setBranch(value.ident, value.branch);
			return null;
		}
		case "state.setActiveWorktree": {
			const value = params as { ident: string; worktree: string };
			state.setActiveWorktree(value.ident, value.worktree);
			return null;
		}
		case "state.setMainWorktreeBranch": {
			const value = params as { ident: string; branch: string };
			state.setMainWorktreeBranch(value.ident, value.branch);
			return null;
		}
		case "state.getAppRunTargetInfo":
			return (
				state.getAppRunTargetInfo((params as { ident: string }).ident) ?? null
			);
		case "state.setAppRunTargetInfo": {
			const value = params as { ident: string; info: AppRunTargetInfo };
			state.setAppRunTargetInfo(value.ident, value.info);
			return null;
		}
		case "state.clearAppRunTargetInfo":
			state.clearAppRunTargetInfo((params as { ident: string }).ident);
			return null;
		case "state.getScriptArgsHistory": {
			const value = params as { relativePath: string; limit: number };
			return state.getScriptArgsHistory(value.relativePath, value.limit);
		}
		case "state.addScriptArgsHistory": {
			const value = params as {
				relativePath: string;
				values: Record<string, string>;
				maxEntries: number;
			};
			state.addScriptArgsHistory(
				value.relativePath,
				value.values,
				value.maxEntries,
			);
			return null;
		}
		case "state.getActionEvents":
			return state.getActionEvents((params as { limit: number }).limit);
		case "state.getActionEventsSince": {
			const value = params as { limit: number; since: string };
			return state.getActionEventsSince(value.limit, new Date(value.since));
		}
		case "state.getActionEventsBetween": {
			const value = params as { limit: number; since: string; before: string };
			return state.getActionEventsBetween(
				value.limit,
				new Date(value.since),
				new Date(value.before),
			);
		}
		case "state.addActionEvent": {
			const value = params as { eventJson: string; maxEntries: number };
			state.addActionEvent(value.eventJson, value.maxEntries);
			return null;
		}
		case "state.getActionLogEvents": {
			const value = params as { runId: string; stepId: string; limit: number };
			return state.getActionLogEvents(value.runId, value.stepId, value.limit);
		}
		case "state.addActionLogEvent": {
			const value = params as {
				runId: string;
				stepId: string;
				eventJson: string;
				maxEntries: number;
			};
			state.addActionLogEvent(
				value.runId,
				value.stepId,
				value.eventJson,
				value.maxEntries,
			);
			return null;
		}
		case "state.getDependencyLeases":
			return state.getDependencyLeases();
		case "state.setDependencyLease":
			state.setDependencyLease(params as DependencyLease);
			return null;
		case "state.deleteDependencyLease": {
			const value = params as { targetId: string; ownerRunId: string };
			state.deleteDependencyLease(value.targetId, value.ownerRunId);
			return null;
		}
		case "manager.getApps":
			return snapshotOf(manager);
		case "manager.getInfraServices":
			return manager.getInfraServices();
		// A reload delegates to the Bun authority: the manager re-reads the
		// definition files and returns the new snapshot in the same response, so
		// a caller never observes a partially published configuration.
		case "manager.loadConfig":
			manager.loadConfig();
			return snapshotOf(manager);
		case "manager.loadCatalogConfig":
			manager.loadCatalogConfig();
			return snapshotOf(manager);
		case "manager.getProjectCatalog":
			return newProjectCatalog(
				manager.getProjectCatalog(),
			) satisfies ProjectCatalog;
		case "manager.addApp":
			manager.addApp((params as { app: App }).app);
			return snapshotOf(manager);
		case "manager.removeApp": {
			const value = params as { ident: string; deleteDir: boolean };
			manager.removeApp(value.ident, value.deleteDir);
			return snapshotOf(manager);
		}
		case "manager.saveConfig":
			manager.saveConfig();
			return null;
		case "manager.updateAppActiveWorktree": {
			const value = params as { ident: string; branch: string };
			manager.updateAppActiveWorktree(value.ident, value.branch);
			return snapshotOf(manager);
		}
		case "manager.setMainWorktreeBranch": {
			const value = params as { ident: string; branch: string };
			manager.setMainWorktreeBranch(value.ident, value.branch);
			return snapshotOf(manager);
		}
		default: {
			const exhaustive: never = operation;
			throw new EnvironmentOperationError(
				"unknown-operation",
				400,
				`unsupported environment operation ${JSON.stringify(
					(exhaustive as { operation?: string }).operation ?? "unknown",
				)}`,
			);
		}
	}
}

/** Decode and run one private request body. Transport-agnostic: `app.ts` owns
 * the HTTP shape, this owns the operation contract. */
export function decodeEnvironmentOperation(
	body: unknown,
): EnvironmentOperation {
	try {
		return decodeRequest(
			"environment.operation",
			environmentOperationSchema,
			body,
		);
	} catch (error) {
		throw new EnvironmentOperationError(
			"invalid-operation",
			400,
			error instanceof Error ? error.message.slice(0, 512) : String(error),
		);
	}
}

/** Run a private operation, mapping an expected failure to its bounded code. */
export function executeEnvironmentOperation(
	authority: EnvironmentAuthority,
	body: unknown,
): unknown {
	const operation = decodeEnvironmentOperation(body);
	try {
		return runEnvironmentOperation(authority, operation);
	} catch (error) {
		if (error instanceof EnvironmentOperationError) throw error;
		throw new EnvironmentOperationError(
			"operation-failed",
			409,
			error instanceof Error ? error.message.slice(0, 512) : String(error),
		);
	}
}

export type { Project };
