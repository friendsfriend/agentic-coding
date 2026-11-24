import * as z from "zod/v4";
import { executionIntentSchema } from "../domain/execution.ts";
import type { GitStatusPort } from "../domain/git-status.ts";
import { OperationRefusal } from "../domain/operation.ts";
import type { createCatalogService } from "../services/catalog-service.ts";
import type { ExecutionSession } from "../services/execution-service.ts";

export type CapabilityAnnotations = {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
};
export type Capability = {
	name: string;
	description: string;
	inputSchema: z.ZodType;
	outputSchema: z.ZodType;
	annotations: CapabilityAnnotations;
	/** Neutral label for the OpenTUI/plugin surface; carries no styling. */
	ui: { label: string };
	invoke(
		input: Record<string, unknown>,
		context: { signal: AbortSignal },
	): Promise<Record<string, unknown>>;
};
export type CapabilityContext = { signal: AbortSignal };
export type EnvironmentCapabilities = {
	list(): readonly Capability[];
	invoke(
		name: string,
		input: unknown,
		context: CapabilityContext,
	): Promise<Record<string, unknown>>;
};

const output = z.record(z.string(), z.unknown());
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

function capability<I extends z.ZodType>(
	name: string,
	label: string,
	description: string,
	inputSchema: I,
	annotations: CapabilityAnnotations,
	invoke: (
		input: z.output<I>,
		context: CapabilityContext,
	) => Promise<Record<string, unknown>>,
): Capability {
	return {
		name,
		description,
		inputSchema,
		outputSchema: output,
		annotations,
		ui: { label },
		async invoke(raw, context) {
			const input = inputSchema.parse(raw);
			const result = await invoke(input, context);
			if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024)
				throw new Error("capability-result-limit");
			return result;
		},
	};
}

/** The single capability registry. MCP and OpenTUI both enumerate and invoke
 * this list; neither owns a separate action table or implementation. */
export function createCapabilities(deps: {
	catalog: ReturnType<typeof createCatalogService>;
	repositories: readonly string[];
	git: GitStatusPort;
	execution?: ExecutionSession;
	refresh?: () => Record<string, unknown>;
}): EnvironmentCapabilities {
	const capabilities: Capability[] = [
		capability(
			"env_list",
			"List environments",
			"Inspect configured applications, targets and dependency declarations. Metadata only: no commands, credentials, execution validation, readiness probes or resource control. Follow nextOffset for all applications.",
			z.strictObject({
				repository: z.string().min(1).max(4096).optional(),
				offset: z.number().int().min(0).max(64).default(0),
				limit: z.number().int().min(1).max(10).default(10),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async (input) => ({
				...deps.catalog.list(input),
				executionAvailable: Boolean(deps.execution),
			}),
		),
		capability(
			"env_git_changes",
			"List repository changes",
			"List bounded changed paths and their staged/worktree status for one authorized repository. Read-only: no diff contents, fetch, checkout, stage or commit.",
			z.strictObject({
				repository: z.string().min(1).max(4096),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repository }, { signal }) => {
				if (!deps.repositories.includes(repository))
					throw new OperationRefusal("repository-unauthorized");
				return deps.git.changes(repository, signal);
			},
		),
		capability(
			"env_git_diff",
			"Read repository diff",
			"Read one bounded unified diff for a path reported by env_git_changes. Untracked regular files are diffed against /dev/null; binaries and symlinks are refused. Read-only: no fetch, checkout, stage or commit.",
			z.strictObject({
				repository: z.string().min(1).max(4096),
				path: z.string().min(1).max(4096),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repository, path }, { signal }) => {
				if (!deps.repositories.includes(repository))
					throw new OperationRefusal("repository-unauthorized");
				return deps.git.diff(repository, path, signal);
			},
		),
		capability(
			"env_git",
			"Read repository git status",
			"Read bounded branch, dirty-file, ahead/behind and detached-HEAD status for authorized repositories. Read-only: no fetch, checkout, stage or commit.",
			z.strictObject({
				repositories: z
					.array(z.string().min(1).max(4096))
					.min(1)
					.max(64)
					.optional(),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repositories }, { signal }) => {
				const requested = repositories
					? [...new Set(repositories)]
					: [...deps.repositories];
				if (
					requested.some(
						(repository) => !deps.repositories.includes(repository),
					)
				)
					throw new OperationRefusal("repository-unauthorized");
				return {
					repositories: await deps.git.status(requested, signal),
				};
			},
		),
	];
	const refresh = deps.refresh;
	if (refresh)
		capabilities.push(
			capability(
				"env_refresh",
				"Refresh configuration",
				"Reload validated environment definitions for future execution without restarting the server. Refuses while any client has active work or owned resources. Repository authorization, client credentials and secret values are not reloaded; changing them requires a restart. Invalid configuration leaves execution unchanged.",
				z.strictObject({}),
				{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
				async () => refresh(),
			),
		);
	const history = deps.execution?.history;
	if (history) {
		capabilities.push(
			capability(
				"env_history",
				"Operation history",
				"List recent durable receipts owned by this scope. Summaries only: no frozen plans, credentials, borrowed identities or resource handles. Use env_operation for one receipt.",
				z.strictObject({
					offset: z.number().int().min(0).max(128).default(0),
					limit: z.number().int().min(1).max(20).default(20),
					repository: z.string().min(1).max(4096).optional(),
				}),
				{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
				async ({ offset, limit, repository }) =>
					history(offset, limit, repository),
			),
		);
	}
	const sharedSession = deps.execution;
	if (sharedSession) {
		capabilities.push(
			capability(
				"env_services",
				"Shared services",
				"Inspect configured service bindings, their optional start app/target and controller-wide start/lease state. Observation only; start through env_execute on the declared target. Borrowed services never grant cleanup authority.",
				z.strictObject({}),
				{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
				async () => {
					const listed = deps.catalog.list({ offset: 0, limit: 1 });
					return {
						services: listed.services.map((service) => ({
							...service,
							shared: sharedSession.sharedService(service.id) ?? null,
						})),
					};
				},
			),
		);
	}
	if (deps.execution) {
		const execution = deps.execution;
		capabilities.push(
			capability(
				"env_operation",
				"Read operation receipt",
				"Read one durable receipt owned by this fixed scope, or the live output of an issued operation. Pass progressOffset to receive only output written after that offset; a reset result replaces the buffered output. Immediate observation only; live or historical output grants no runtime execution or restored resource authority.",
				z.strictObject({
					operationId: z.uuid(),
					progressOffset: z.number().int().min(0).max(2147483647).optional(),
				}),
				{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
				async ({ operationId, progressOffset }) =>
					execution.read(operationId, progressOffset),
			),
			capability(
				"env_execute",
				"Execute target",
				"Execute one configured build, test or run target. Admission and dispatch are one step; missing declared secret references refuse before dispatch. Nonzero exits are failures. Borrowed dependencies are revalidated before dispatch and never enter cleanup. Use env_wait for a bounded observation of the settled receipt.",
				executionIntentSchema.extend({
					requestId: z.string().trim().min(1).max(256),
				}),
				{
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: true,
					openWorldHint: true,
				},
				async ({ requestId, ...intent }, { signal }) =>
					execution.executeIntent(requestId, intent, signal),
			),
			capability(
				"env_wait",
				"Wait for operation",
				"Wait up to waitSec for one dispatched operation to settle, then return its current receipt. A timeout leaves it issued/running.",
				z.strictObject({
					operationId: z.uuid(),
					waitSec: z.number().int().min(1).max(120).default(30),
				}),
				{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
				async ({ operationId, waitSec }, { signal }) =>
					execution.wait(operationId, waitSec, signal),
			),
			capability(
				"env_status",
				"Show scope status",
				"Read the client scope state, owned resource identities and current revision. When one client is authorized for several repositories, pass repository to select one. Borrowed dependencies never appear here.",
				z.strictObject({
					repository: z.string().min(1).max(4096).optional(),
				}),
				{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
				async ({ repository }) => execution.status(repository),
			),
			capability(
				"env_stop",
				"Stop owned resources",
				"Stop only containers, shell processes or Helm releases this scope created for one app. Pass repository when the client is authorized for several repositories and the app identity is ambiguous. Borrowed services and volumes are never in the owned list.",
				z.strictObject({
					app: identifier,
					repository: z.string().min(1).max(4096).optional(),
				}),
				{
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: false,
					openWorldHint: true,
				},
				async ({ app, repository }, { signal }) =>
					execution.stop(app, signal, repository),
			),
			capability(
				"env_telemetry",
				"Run telemetry",
				"Read the bounded in-memory OTLP/HTTP JSON logs and trace summaries captured for one owned shell, Compose collector or container run. A traceId returns its spans and parent/child tree. Borrowed services are never captured.",
				z.strictObject({
					app: identifier,
					traceId: z
						.string()
						.regex(/^[a-f0-9]{32}$/)
						.optional(),
					repository: z.string().min(1).max(4096).optional(),
				}),
				{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
				async ({ app, traceId, repository }) =>
					execution.telemetry(app, traceId, repository),
			),
			capability(
				"env_logs",
				"Show owned logs",
				"Read bounded recent logs from containers or shell processes this scope created for one app. `grep` is a literal line filter; tail is applied first. Native Helm chart workload logs are not inferred and are reported as unavailable. After a successful stop, return the last retained redacted window with historical=true for this controller lifetime. Borrowed services are never readable.",
				z.strictObject({
					app: identifier,
					tail: z.number().int().min(1).max(1000).default(200),
					grep: z.string().min(1).max(256).optional(),
					repository: z.string().min(1).max(4096).optional(),
				}),
				{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
				async ({ app, tail, grep, repository }, { signal }) =>
					execution.logs(app, tail, signal, grep, repository),
			),
		);
	}
	return {
		list: () => capabilities,
		invoke(name, input, context) {
			const action = capabilities.find((candidate) => candidate.name === name);
			if (!action) throw new Error("unknown-capability");
			return action.invoke((input ?? {}) as Record<string, unknown>, context);
		},
	};
}
