import * as z from "zod/v4";
import type {
	ConfigurationMutation,
	ConfigurationMutationResult,
} from "../domain/configuration-write.ts";
import { executionIntentSchema } from "../domain/execution.ts";
import type { GitActionPort } from "../domain/git-actions.ts";
import type { GitStatusPort } from "../domain/git-status.ts";
import type { KubernetesPort } from "../domain/kubernetes.ts";
import { OperationRefusal } from "../domain/operation.ts";
import type { ProviderPort } from "../domain/provider.ts";
import { providerRepositoryMatches } from "../domain/provider-repository.ts";
import type { createCatalogService } from "../services/catalog-service.ts";
import type { ConfigurationWriteService } from "../services/configuration-write-service.ts";
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
	gitActions: GitActionPort;
	providers?: ProviderPort;
	kubernetes?: KubernetesPort;
	config?: ConfigurationWriteService;
	execution?: ExecutionSession;
	refresh?: () => Record<string, unknown>;
}): EnvironmentCapabilities {
	const providers = deps.providers;
	const providerName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
	const providerRepository = z.string().min(1).max(256);
	const providerState = z.enum(["open", "closed", "all"]).default("open");
	const providerNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
	const providerRequestId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
	const providerConfirm = z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional();
	const providerScope = z.enum(["change", "issue"]);
	const providerDiscussionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
	const providerLabels = z
		.array(
			z
				.string()
				.trim()
				.min(1)
				.max(100)
				.refine((value) => !value.includes(",")),
		)
		.min(1)
		.max(50);
	const providerAssignees = z
		.array(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/))
		.min(1)
		.max(10);
	const providerCapabilities: Capability[] = providers
		? [
				capability(
					"env_providers",
					"List providers",
					"List configured GitHub/GitLab providers with type, base URL, username and whether a token reference resolves. Read-only; token values are never returned.",
					z.strictObject({}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
					async () => ({ providers: providers.list() }),
				),
				capability(
					"env_provider_repos",
					"Search provider repositories",
					"Search at most 20 repositories on one configured provider by name or namespace. Read-only. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						query: z.string().trim().min(1).max(256),
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, query }, { signal }) => ({
						provider,
						query,
						repositories: await providers.repositories(provider, query, signal),
					}),
				),
				capability(
					"env_provider_repository",
					"Resolve provider repository",
					"Resolve one local repository's git remotes to configured GitHub/GitLab provider repository references without a network call. Read-only; token values are never returned. Pass session: true for the current working-directory repository outside the configured allowlist.",
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
					async ({ repository, session }, { signal }) => {
						if (!session && !deps.repositories.includes(repository))
							throw new OperationRefusal("repository-unauthorized");
						const remotes = await deps.gitActions.remotes(repository, signal);
						const matches = remotes.remotes
							.flatMap((remote) =>
								providerRepositoryMatches(providers.list(), remote.fetchUrl),
							)
							.filter(
								(match, index, all) =>
									all.findIndex(
										(candidate) =>
											candidate.provider === match.provider &&
											candidate.reference === match.reference,
									) === index,
							);
						return { repository, matches };
					},
				),
				capability(
					"env_provider_changes",
					"List provider changes",
					"List at most 50 pull requests or merge requests for one repository on a configured provider. Read-only: no comments, approvals, merges or other writes. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						state: providerState,
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, repository, state }, { signal }) => ({
						provider,
						repository,
						state,
						changes: await providers.changes(
							provider,
							repository,
							state,
							signal,
						),
					}),
				),
				capability(
					"env_provider_change",
					"Show provider change",
					"Read one pull request or merge request with title, state, branches, author, body and bounded counts. Read-only. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, repository, number }, { signal }) => ({
						provider,
						repository,
						number,
						change: await providers.change(
							provider,
							repository,
							number,
							signal,
						),
					}),
				),
				capability(
					"env_provider_change_files",
					"List provider change files",
					"List at most 100 changed files for one pull request or merge request with status, counts and at most 48 KiB of aggregate patch text. Read-only. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, repository, number }, { signal }) => ({
						provider,
						repository,
						number,
						...(await providers.changeFiles(
							provider,
							repository,
							number,
							signal,
						)),
					}),
				),
				capability(
					"env_provider_change_versions",
					"List provider change versions",
					"List at most 100 commits or versions for one pull request or merge request with SHA, message and author/date when available. Read-only. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, repository, number }, { signal }) => ({
						provider,
						repository,
						number,
						versions: await providers.changeVersions(
							provider,
							repository,
							number,
							signal,
						),
					}),
				),
				capability(
					"env_provider_issues",
					"List provider issues",
					"List at most 50 issues for one repository on a configured provider. GitHub pull-request entries are excluded. Read-only. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						state: providerState,
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, repository, state }, { signal }) => ({
						provider,
						repository,
						state,
						issues: await providers.issues(provider, repository, state, signal),
					}),
				),
				capability(
					"env_provider_issue",
					"Show provider issue",
					"Read one issue with title, state, author, labels, body and timestamps. Read-only. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, repository, number }, { signal }) => ({
						provider,
						repository,
						number,
						issue: await providers.issue(provider, repository, number, signal),
					}),
				),
				capability(
					"env_provider_discussions",
					"List provider discussions",
					"List at most 50 review comments or merge-request discussion notes for one change with author, body, timestamp and resolution when available. Read-only; no replies, resolutions or other writes. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, repository, number }, { signal }) => ({
						provider,
						repository,
						number,
						discussions: await providers.discussions(
							provider,
							repository,
							number,
							signal,
						),
					}),
				),
				capability(
					"env_provider_issue_comments",
					"List provider issue comments",
					"List at most 50 issue comments or notes for one issue with author, body, timestamp and resolution when available. Read-only. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, repository, number }, { signal }) => ({
						provider,
						repository,
						number,
						comments: await providers.issueComments(
							provider,
							repository,
							number,
							signal,
						),
					}),
				),
				capability(
					"env_provider_pipelines",
					"List provider pipelines",
					"List at most 30 recent CI pipelines or workflow runs for one repository on a configured provider. Read-only. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, repository }, { signal }) => ({
						provider,
						repository,
						pipelines: await providers.pipelines(provider, repository, signal),
					}),
				),
				capability(
					"env_provider_jobs",
					"List provider pipeline jobs",
					"List at most 30 jobs for one CI pipeline or workflow run on a configured provider. Read-only; use env_provider_job_logs for bounded logs; retries are not exposed. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						pipeline: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, repository, pipeline }, { signal }) => ({
						provider,
						repository,
						pipeline,
						jobs: await providers.jobs(provider, repository, pipeline, signal),
					}),
				),
				capability(
					"env_provider_comment_change",
					"Comment on provider change",
					"Preview or post one comment on a pull request or merge request. Omit or mismatch confirm to receive the exact intent digest without a write; repeat with that digest to post. Same requestId and digest replay the durable receipt; a different digest conflicts. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
						body: z.string().trim().min(1).max(16000),
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{ provider, repository, number, body, requestId, confirm },
						{ signal },
					) =>
						providers.write(
							{
								action: "comment-change",
								provider,
								repository,
								number,
								body,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_comment_issue",
					"Comment on provider issue",
					"Preview or post one comment on an issue. Omit or mismatch confirm to receive the exact intent digest without a write; repeat with that digest to post. Same requestId and digest replay the durable receipt; a different digest conflicts. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
						body: z.string().trim().min(1).max(16000),
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{ provider, repository, number, body, requestId, confirm },
						{ signal },
					) =>
						providers.write(
							{
								action: "comment-issue",
								provider,
								repository,
								number,
								body,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_approve_change",
					"Approve exact provider change",
					"Preview or approve one pull request or merge request at an exact 40-character head SHA. The provider head is re-read and must still match. Omit or mismatch confirm to receive the exact intent digest without a write; repeat with that digest to approve. Same requestId and digest replay the durable receipt; a different digest conflicts. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
						sha: z.string().regex(/^[a-f0-9]{40}$/),
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{ provider, repository, number, sha, requestId, confirm },
						{ signal },
					) =>
						providers.write(
							{
								action: "approve-change",
								provider,
								repository,
								number,
								sha,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_merge_change",
					"Merge provider change",
					"Preview or merge one pull request or merge request at an exact 40-character head SHA. The provider head is re-read and must still match. mergeMethod applies to GitHub. Omit or mismatch confirm to receive the intent digest without a write. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
						sha: z.string().regex(/^[a-f0-9]{40}$/),
						mergeMethod: z.enum(["merge", "squash", "rebase"]).default("merge"),
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: true,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{
							provider,
							repository,
							number,
							sha,
							mergeMethod,
							requestId,
							confirm,
						},
						{ signal },
					) =>
						providers.write(
							{
								action: "merge-change",
								provider,
								repository,
								number,
								sha,
								mergeMethod,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_set_issue_state",
					"Set provider issue state",
					"Preview or open/close one issue. Omit or mismatch confirm to receive the intent digest without a write. Same requestId and digest replay the durable receipt. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
						state: z.enum(["open", "closed"]),
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: true,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{ provider, repository, number, state, requestId, confirm },
						{ signal },
					) =>
						providers.write(
							{
								action: "set-issue-state",
								provider,
								repository,
								number,
								state,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_rebase_change",
					"Rebase provider change",
					"Preview or request a GitLab merge-request rebase. GitHub changes refuse. Omit or mismatch confirm to receive the intent digest without a write. Same requestId and digest replay the durable receipt. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{ provider, repository, number, requestId, confirm },
						{ signal },
					) =>
						providers.write(
							{
								action: "rebase-change",
								provider,
								repository,
								number,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_unapprove_change",
					"Unapprove provider change",
					"Preview or withdraw approval from one change at an exact 40-character head SHA. The provider head is re-read and must still match. GitHub dismisses the configured account's latest approval; GitLab calls unapprove. Omit or mismatch confirm to receive the intent digest without a write. Same requestId and digest replay the durable receipt. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
						sha: z.string().regex(/^[a-f0-9]{40}$/),
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: true,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{ provider, repository, number, sha, requestId, confirm },
						{ signal },
					) =>
						providers.write(
							{
								action: "unapprove-change",
								provider,
								repository,
								number,
								sha,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_reply_discussion",
					"Reply to provider discussion",
					"Preview or post a reply to one change discussion or issue comment thread. Change replies use GitHub review-comment threads and GitLab discussions; issue replies add an issue comment. Omit or mismatch confirm to receive the intent digest without a write. Same requestId and digest replay the durable receipt. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
						scope: providerScope,
						discussionId: providerDiscussionId,
						body: z.string().trim().min(1).max(16_000),
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{
							provider,
							repository,
							number,
							scope,
							discussionId,
							body,
							requestId,
							confirm,
						},
						{ signal },
					) =>
						providers.write(
							{
								action: "reply-discussion",
								provider,
								repository,
								number,
								scope,
								discussionId,
								body,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_set_discussion_resolved",
					"Resolve provider discussion",
					"Preview or resolve/unresolve one discussion. GitLab toggles the merge-request discussion; GitHub finds the review thread containing the selected comment through GraphQL and resolves or unresolves it. Omit or mismatch confirm to receive the intent digest without a write. Same requestId and digest replay the durable receipt. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
						discussionId: providerDiscussionId,
						resolved: z.boolean(),
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{
							provider,
							repository,
							number,
							discussionId,
							resolved,
							requestId,
							confirm,
						},
						{ signal },
					) =>
						providers.write(
							{
								action: "set-discussion-resolved",
								provider,
								repository,
								number,
								discussionId,
								resolved,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_add_labels",
					"Add provider labels",
					"Preview or add one or more labels to a change or issue. Labels are appended, not replaced. Omit or mismatch confirm to receive the intent digest without a write. Same requestId and digest replay the durable receipt. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
						scope: providerScope,
						labels: providerLabels,
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{ provider, repository, number, scope, labels, requestId, confirm },
						{ signal },
					) =>
						providers.write(
							{
								action: "add-labels",
								provider,
								repository,
								number,
								scope,
								labels,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_set_assignees",
					"Set provider assignees",
					"Preview or replace the assignees of a change or issue. GitHub usernames are sent directly; GitLab usernames are resolved to user ids first. Omit or mismatch confirm to receive the intent digest without a write. Same requestId and digest replay the durable receipt. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						number: providerNumber,
						scope: providerScope,
						assignees: providerAssignees,
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: true,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{
							provider,
							repository,
							number,
							scope,
							assignees,
							requestId,
							confirm,
						},
						{ signal },
					) =>
						providers.write(
							{
								action: "set-assignees",
								provider,
								repository,
								number,
								scope,
								assignees,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_retry_job",
					"Retry provider job",
					"Preview or retry one CI job. GitHub reruns the workflow job; GitLab retries the job. Omit or mismatch confirm to receive the exact intent digest without a write. Same requestId and digest replay the durable receipt; a different digest conflicts. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						job: providerNumber,
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{ provider, repository, job, requestId, confirm },
						{ signal },
					) =>
						providers.write(
							{
								action: "retry-job",
								provider,
								repository,
								job,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_retry_pipeline",
					"Retry provider pipeline",
					"Preview or retry one CI pipeline/workflow run. GitHub reruns the run; GitLab retries failed pipeline jobs. Omit or mismatch confirm to receive the exact intent digest without a write; repeat with that digest to retry. Same requestId and digest replay the durable receipt; a different digest conflicts. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						pipeline: providerNumber,
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{ provider, repository, pipeline, requestId, confirm },
						{ signal },
					) =>
						providers.write(
							{
								action: "retry-pipeline",
								provider,
								repository,
								pipeline,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_cancel_pipeline",
					"Cancel provider pipeline",
					"Preview or cancel one CI pipeline/workflow run. Omit or mismatch confirm to receive the exact intent digest without a write; repeat with that digest to cancel. Same requestId and digest replay the durable receipt; a different digest conflicts. External side effect.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						pipeline: providerNumber,
						requestId: providerRequestId,
						confirm: providerConfirm,
					}),
					{
						readOnlyHint: false,
						destructiveHint: true,
						idempotentHint: true,
						openWorldHint: true,
					},
					async (
						{ provider, repository, pipeline, requestId, confirm },
						{ signal },
					) =>
						providers.write(
							{
								action: "cancel-pipeline",
								provider,
								repository,
								pipeline,
								requestId,
								...(confirm ? { confirm } : {}),
							},
							signal,
						),
				),
				capability(
					"env_provider_writes",
					"List provider write receipts",
					"List up to 50 recent provider write receipts for one provider or all providers. Receipts contain the intent digest, target, state, bounded result or error code; token values are never returned.",
					z.strictObject({
						provider: providerName.optional(),
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
					async ({ provider }) => ({
						writes: providers.writes(provider),
					}),
				),
				capability(
					"env_provider_job_logs",
					"Read provider job log",
					"Read at most 64 KiB of one CI job or workflow-run job log. Read-only; logs are redacted and may be truncated. Token values are never returned.",
					z.strictObject({
						provider: providerName,
						repository: providerRepository,
						job: providerNumber,
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: true },
					async ({ provider, repository, job }, { signal }) => ({
						provider,
						repository,
						job,
						...(await providers.jobLogs(provider, repository, job, signal)),
					}),
				),
			]
		: [];
	const kubernetes = deps.kubernetes;
	const kubernetesCapabilities: Capability[] = kubernetes
		? [
				capability(
					"env_clusters",
					"List Kubernetes clusters",
					"List read-only Kubernetes clusters explicitly authorized for this client's repositories, with cluster id, context and repository scope. Kubeconfig paths and environment values are never returned.",
					z.strictObject({}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
					async () => ({ clusters: kubernetes.list(deps.repositories) }),
				),
				capability(
					"env_cluster_resources",
					"Inspect Kubernetes namespace",
					"Read a bounded wide table of deployments, statefulsets, pods and services in one explicit non-system namespace of an authorized cluster. Read-only; no apply, edit, delete, exec, logs or arbitrary kubectl arguments.",
					z.strictObject({
						cluster: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
						namespace: z
							.string()
							.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
							.max(63),
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
					async ({ cluster, namespace }, { signal }) => ({
						...(await kubernetes.resources(
							deps.repositories,
							cluster,
							namespace,
							signal,
						)),
					}),
				),
				capability(
					"env_cluster_namespaces",
					"List Kubernetes namespaces",
					"List at most 200 non-system namespace names in an authorized cluster. Read-only; no apply, edit, delete, exec or arbitrary kubectl arguments.",
					z.strictObject({
						cluster: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
					async ({ cluster }, { signal }) => ({
						...(await kubernetes.namespaces(
							deps.repositories,
							cluster,
							signal,
						)),
					}),
				),
				capability(
					"env_cluster_events",
					"List Kubernetes namespace events",
					"Read at most 100 recent events in one explicit non-system namespace of an authorized cluster, sorted by last timestamp. Read-only; no apply, edit, delete, exec, logs or arbitrary kubectl arguments.",
					z.strictObject({
						cluster: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
						namespace: z
							.string()
							.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
							.max(63),
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
					async ({ cluster, namespace }, { signal }) => ({
						...(await kubernetes.events(
							deps.repositories,
							cluster,
							namespace,
							signal,
						)),
					}),
				),
				capability(
					"env_cluster_describe",
					"Describe Kubernetes resource",
					"Read a bounded kubectl describe for one named namespaced resource in an authorized cluster. Kind is limited to deployment, statefulset, pod, service, daemonset, replicaset, job or cronjob. Read-only; no apply, edit, delete, exec or arbitrary kubectl arguments.",
					z.strictObject({
						cluster: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
						namespace: z
							.string()
							.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
							.max(63),
						kind: z.enum([
							"deployment",
							"statefulset",
							"pod",
							"service",
							"daemonset",
							"replicaset",
							"job",
							"cronjob",
						]),
						name: z
							.string()
							.regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
							.max(253),
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
					async ({ cluster, namespace, kind, name }, { signal }) => ({
						...(await kubernetes.describe(
							deps.repositories,
							cluster,
							namespace,
							kind,
							name,
							signal,
						)),
					}),
				),
				capability(
					"env_pod_logs",
					"Read Kubernetes pod logs",
					"Read bounded tail logs for one pod in an explicit non-system namespace of an authorized cluster. Optional container selects one container; previous reads the prior container instance. Read-only; no exec, attach, apply, edit or delete.",
					z.strictObject({
						cluster: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
						namespace: z
							.string()
							.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
							.max(63),
						pod: z
							.string()
							.regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
							.max(253),
						container: z
							.string()
							.regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
							.max(63)
							.optional(),
						tail: z.number().int().min(1).max(1000).default(200),
						previous: z.boolean().default(false),
					}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
					async (
						{ cluster, namespace, pod, container, tail, previous },
						{ signal },
					) => ({
						...(await kubernetes.podLogs(
							deps.repositories,
							cluster,
							namespace,
							pod,
							container,
							tail,
							previous,
							signal,
						)),
					}),
				),
			]
		: [];
	const config = deps.config;
	const configDigest = z.string().regex(/^[a-f0-9]{64}$/);
	const configDefaults = z.strictObject({
		build: identifier.optional(),
		test: identifier.optional(),
		run: identifier.optional(),
	});
	const configProfile = z.string().trim().min(1).max(64);
	const configText = z.string().min(1).max(65536);
	const configStrings = z.record(z.string(), z.string().max(16000));
	const guardConfigWrite = () => {
		if (
			deps.execution?.isBusy() ||
			(deps.execution?.status().owned.length ?? 0) > 0
		)
			throw new OperationRefusal("configuration-busy");
	};
	const configMutation = async (
		mutation: ConfigurationMutation,
		expectedDigest: string | undefined,
		confirm: string | undefined,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> => {
		signal.throwIfAborted();
		if (!config) throw new OperationRefusal("config-write-unavailable");
		if (!expectedDigest || !confirm) return config.preview(mutation);
		guardConfigWrite();
		const result: ConfigurationMutationResult = await config.apply(
			mutation,
			expectedDigest,
			confirm,
		);
		return result;
	};
	const configCapabilities: Capability[] = config
		? [
				capability(
					"env_config_revision",
					"Show configuration revision",
					"Read the current environments.json digest and application/target counts. Use this digest as expectedDigest for a configuration write preview.",
					z.strictObject({}),
					{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
					async () => config.revision(),
				),
				capability(
					"env_app_create",
					"Create application",
					"Preview or create an application in the v2 environment configuration. Omit or mismatch confirm to receive the exact intent digest and next revision without a write. The repository must already be authorized. Profiles are target labels, not separate entities.",
					z.strictObject({
						id: identifier,
						kind: z.enum(["app", "library", "infrastructure"]).default("app"),
						repository: z.string().min(1).max(4096),
						defaults: configDefaults.optional(),
						expectedDigest: configDigest.optional(),
						confirm: configDigest.optional(),
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: false,
					},
					async (
						{ id, kind, repository, defaults, expectedDigest, confirm },
						{ signal },
					) =>
						configMutation(
							{
								operation: "app-create",
								app: {
									id,
									kind,
									repository,
									...(defaults ? { defaults } : {}),
								},
							},
							expectedDigest,
							confirm,
							signal,
						),
				),
				capability(
					"env_app_update",
					"Update application",
					"Preview or update an application's kind, repository or defaults. Repository changes are refused while the application has targets. Omit or mismatch confirm to receive the intent digest without a write.",
					z.strictObject({
						id: identifier,
						kind: z.enum(["app", "library", "infrastructure"]).optional(),
						repository: z.string().min(1).max(4096).optional(),
						defaults: configDefaults.optional(),
						expectedDigest: configDigest.optional(),
						confirm: configDigest.optional(),
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: false,
					},
					async (
						{ id, kind, repository, defaults, expectedDigest, confirm },
						{ signal },
					) =>
						configMutation(
							{
								operation: "app-update",
								id,
								...(kind ? { kind } : {}),
								...(repository ? { repository } : {}),
								...(defaults ? { defaults } : {}),
							},
							expectedDigest,
							confirm,
							signal,
						),
				),
				capability(
					"env_app_delete",
					"Delete application",
					"Preview or delete an application. Refuses while targets exist unless deleteTargets is true; external prerequisite references are always refused. Omit or mismatch confirm to receive the intent digest without a write.",
					z.strictObject({
						id: identifier,
						deleteTargets: z.boolean().default(false),
						expectedDigest: configDigest.optional(),
						confirm: configDigest.optional(),
					}),
					{
						readOnlyHint: false,
						destructiveHint: true,
						idempotentHint: true,
						openWorldHint: false,
					},
					async ({ id, deleteTargets, expectedDigest, confirm }, { signal }) =>
						configMutation(
							{ operation: "app-delete", id, deleteTargets },
							expectedDigest,
							confirm,
							signal,
						),
				),
				capability(
					"env_target_create",
					"Create target",
					"Preview or create a target. Duplicate mode clones an existing target and only changes identity/profile; shell mode creates a shell build/test/run target. Profiles are optional labels. Omit or mismatch confirm to receive the intent digest without a write.",
					z.discriminatedUnion("mode", [
						z.strictObject({
							mode: z.literal("duplicate"),
							app: identifier,
							sourceApp: identifier,
							sourceTarget: identifier,
							id: identifier,
							profile: configProfile.optional(),
							expectedDigest: configDigest.optional(),
							confirm: configDigest.optional(),
						}),
						z.strictObject({
							mode: z.literal("shell"),
							app: identifier,
							id: identifier,
							action: z.enum(["build", "test", "run"]),
							profile: configProfile.optional(),
							command: configText,
							timeoutSec: z.number().int().min(1).max(7200).optional(),
							environment: configStrings.optional(),
							secretRefs: configStrings.optional(),
							readyText: z.string().min(1).max(4096).optional(),
							expectedDigest: configDigest.optional(),
							confirm: configDigest.optional(),
						}),
					]),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: false,
					},
					async (input, { signal }) => {
						const { expectedDigest, confirm, ...mutation } = input;
						return configMutation(
							{
								operation: "target-create",
								...mutation,
							} as ConfigurationMutation,
							expectedDigest,
							confirm,
							signal,
						);
					},
				),
				capability(
					"env_target_update",
					"Update target",
					"Preview or update target metadata: profile, action, shell command, timeout, shell environment and secret references, ready text, dependencies, prerequisites, endpoints and endpoint services. Unsupported runtime-specific descriptor changes are left to file/skill edits. Omit or mismatch confirm to receive the intent digest without a write.",
					z.strictObject({
						app: identifier,
						id: identifier,
						profile: configProfile.nullable().optional(),
						action: z.enum(["build", "test", "run"]).optional(),
						command: configText.optional(),
						timeoutSec: z.number().int().min(1).max(7200).optional(),
						environment: configStrings.optional(),
						secretRefs: configStrings.optional(),
						readyText: z.string().min(1).max(4096).nullable().optional(),
						dependsOn: z
							.array(z.record(z.string(), z.unknown()))
							.max(16)
							.optional(),
						prerequisites: z
							.array(z.strictObject({ app: identifier, target: identifier }))
							.max(16)
							.optional(),
						endpoints: z.record(z.string(), z.string().max(4096)).optional(),
						endpointServices: z.record(z.string(), identifier).optional(),
						expectedDigest: configDigest.optional(),
						confirm: configDigest.optional(),
					}),
					{
						readOnlyHint: false,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: false,
					},
					async ({ expectedDigest, confirm, ...mutation }, { signal }) =>
						configMutation(
							{
								operation: "target-update",
								...mutation,
							} as ConfigurationMutation,
							expectedDigest,
							confirm,
							signal,
						),
				),
				capability(
					"env_target_delete",
					"Delete target",
					"Preview or delete a target. Refuses a default target or one referenced by another target's prerequisites. Omit or mismatch confirm to receive the intent digest without a write.",
					z.strictObject({
						app: identifier,
						id: identifier,
						expectedDigest: configDigest.optional(),
						confirm: configDigest.optional(),
					}),
					{
						readOnlyHint: false,
						destructiveHint: true,
						idempotentHint: true,
						openWorldHint: false,
					},
					async ({ app, id, expectedDigest, confirm }, { signal }) =>
						configMutation(
							{ operation: "target-delete", app, id },
							expectedDigest,
							confirm,
							signal,
						),
				),
			]
		: [];
	const capabilities: Capability[] = [
		...providerCapabilities,
		...kubernetesCapabilities,
		...configCapabilities,
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
			"List bounded changed paths and their staged/worktree status for one authorized repository. Read-only: no diff contents, fetch, checkout, stage or commit. Pass session: true for the current working-directory repository.",
			z.strictObject({
				repository: z.string().min(1).max(4096),
				session: z.boolean().default(false),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repository, session }, { signal }) => {
				if (!session && !deps.repositories.includes(repository))
					throw new OperationRefusal("repository-unauthorized");
				return deps.git.changes(repository, signal);
			},
		),
		capability(
			"env_git_diff",
			"Read repository diff",
			"Read one bounded unified diff for a path reported by env_git_changes. `side` selects all (HEAD vs working tree), staged (HEAD vs index) or worktree (index vs working tree). Untracked regular files are diffed against /dev/null; binaries and symlinks are refused. Read-only: no fetch, checkout, stage or commit. Pass session: true for the current working-directory repository.",
			z.strictObject({
				repository: z.string().min(1).max(4096),
				path: z.string().min(1).max(4096),
				side: z.enum(["all", "staged", "worktree"]).default("all"),
				session: z.boolean().default(false),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repository, path, side, session }, { signal }) => {
				if (!session && !deps.repositories.includes(repository))
					throw new OperationRefusal("repository-unauthorized");
				return deps.git.diff(repository, path, signal, side);
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
		capability(
			"env_git_branches",
			"List repository branches",
			"List bounded local branches with the current marker, upstream and ahead/behind counts for one authorized repository. Read-only. Pass session: true for the current working-directory repository, which is not restricted to the configured allowlist.",
			z.strictObject({
				repository: z.string().min(1).max(4096),
				session: z.boolean().default(false),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repository, session }, { signal }) => {
				if (!session && !deps.repositories.includes(repository))
					throw new OperationRefusal("repository-unauthorized");
				return deps.gitActions.branches(repository, signal);
			},
		),
		capability(
			"env_git_worktrees",
			"List repository worktrees",
			"List bounded linked worktrees with branch, HEAD, current/locked/prunable state for one authorized repository. Read-only. Pass session: true for the current working-directory repository, which is not restricted to the configured allowlist.",
			z.strictObject({
				repository: z.string().min(1).max(4096),
				session: z.boolean().default(false),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repository, session }, { signal }) => {
				if (!session && !deps.repositories.includes(repository))
					throw new OperationRefusal("repository-unauthorized");
				return deps.gitActions.worktrees(repository, signal);
			},
		),
		capability(
			"env_git_remotes",
			"List repository remotes",
			"List bounded configured remotes with sanitized fetch/push URLs for one authorized repository. Read-only. Pass session: true for the current working-directory repository.",
			z.strictObject({
				repository: z.string().min(1).max(4096),
				session: z.boolean().default(false),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repository, session }, { signal }) => {
				if (!session && !deps.repositories.includes(repository))
					throw new OperationRefusal("repository-unauthorized");
				return deps.gitActions.remotes(repository, signal);
			},
		),
		capability(
			"env_git_log",
			"List repository commits",
			"List at most 50 commits from the current HEAD history with full/short SHA, subject, author, date and ref names for one authorized repository. Read-only. Pass session: true for the current working-directory repository.",
			z.strictObject({
				repository: z.string().min(1).max(4096),
				session: z.boolean().default(false),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repository, session }, { signal }) => {
				if (!session && !deps.repositories.includes(repository))
					throw new OperationRefusal("repository-unauthorized");
				return deps.gitActions.log(repository, signal);
			},
		),
		capability(
			"env_git_commit",
			"Read repository commit",
			"Read one commit by full SHA with author, email, date, parents, full message, up to 200 changed-file stats and a bounded 48 KiB unified diff for one authorized repository. Read-only. Pass session: true for the current working-directory repository.",
			z.strictObject({
				repository: z.string().min(1).max(4096),
				session: z.boolean().default(false),
				sha: z.string().regex(/^[a-f0-9]{40,64}$/),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repository, session, sha }, { signal }) => {
				if (!session && !deps.repositories.includes(repository))
					throw new OperationRefusal("repository-unauthorized");
				return deps.gitActions.commit(repository, sha, signal);
			},
		),
		capability(
			"env_git_tags",
			"List repository tags",
			"List at most 200 tags with name, object SHA, annotated state, date and subject for one authorized repository. Read-only. Pass session: true for the current working-directory repository.",
			z.strictObject({
				repository: z.string().min(1).max(4096),
				session: z.boolean().default(false),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repository, session }, { signal }) => {
				if (!session && !deps.repositories.includes(repository))
					throw new OperationRefusal("repository-unauthorized");
				return deps.gitActions.tags(repository, signal);
			},
		),
		capability(
			"env_git_stashes",
			"List repository stashes",
			"List at most 100 stashes with index, ref, branch, message and date for one authorized repository. Read-only. Pass session: true for the current working-directory repository.",
			z.strictObject({
				repository: z.string().min(1).max(4096),
				session: z.boolean().default(false),
			}),
			{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			async ({ repository, session }, { signal }) => {
				if (!session && !deps.repositories.includes(repository))
					throw new OperationRefusal("repository-unauthorized");
				return deps.gitActions.stashes(repository, signal);
			},
		),
	];
	if (deps.execution)
		capabilities.push(
			capability(
				"env_git_action",
				"Run repository git action",
				"Run one bounded git action for an authorized repository: fetch, fast-forward-only pull, switch or safely delete a branch, add/remove a linked worktree, add/remove a remote, or stage/unstage one path or all changes. Mutating actions refuse a dirty worktree, the current worktree, branches in use, existing paths and paths inside the repository. Refuses while an operation is in progress. Direct execution; no fetch/pull approval step.",
				z.discriminatedUnion("action", [
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("fetch"),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("pull"),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("checkout"),
						branch: z.string().min(1).max(255),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("branch-delete"),
						branch: z.string().min(1).max(255),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("remote-add"),
						name: z.string().min(1).max(255),
						url: z.string().min(1).max(4096),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("remote-remove"),
						name: z.string().min(1).max(255),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("stage"),
						path: z.string().min(1).max(4096),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("unstage"),
						path: z.string().min(1).max(4096),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("stage-all"),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("unstage-all"),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("worktree-add"),
						path: z.string().min(1).max(4096),
						branch: z.string().min(1).max(255),
						create: z.boolean().default(false),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						action: z.literal("worktree-remove"),
						path: z.string().min(1).max(4096),
					}),
				]),
				{
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: false,
					openWorldHint: true,
				},
				async (input, { signal }) => {
					if (!input.session && !deps.repositories.includes(input.repository))
						throw new OperationRefusal("repository-unauthorized");
					if (input.action !== "fetch" && deps.execution?.isBusy())
						return {
							repository: input.repository,
							action: input.action,
							status: "refused",
							output: "",
							truncated: false,
							reason: "operation-in-progress",
						};
					const { repository, session: _session, ...request } = input;
					return deps.gitActions.run(repository, request, signal);
				},
			),
			capability(
				"env_git_write",
				"Run guarded git write",
				"Preview and confirm one Git write for an authorized repository: push a branch, force-push with an exact lease, create a lightweight or annotated tag, delete a tag, rename a branch, update a remote URL, commit staged changes or all changes, stash, pop/apply/drop a stash, merge, rebase, or abort a rebase. The first call returns the exact intent digest without running git; repeat with that digest to execute. Force push requires an existing upstream and local remote-tracking ref. Merge/rebase require a clean worktree. Replayed confirmations are cached per process. Direct execution after confirmation.",
				z.discriminatedUnion("action", [
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("push"),
						branch: z.string().min(1).max(255),
						remote: z.string().min(1).max(255),
						setUpstream: z.boolean().default(false),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("push-force"),
						branch: z.string().min(1).max(255),
						remote: z.string().min(1).max(255),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("tag"),
						name: z.string().min(1).max(255),
						message: z.string().trim().max(5000).optional(),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("tag-delete"),
						name: z.string().min(1).max(255),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("stash-pop"),
						index: z.number().int().min(0).max(999),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("stash-apply"),
						index: z.number().int().min(0).max(999),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("stash-drop"),
						index: z.number().int().min(0).max(999),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("branch-rename"),
						branch: z.string().min(1).max(255),
						name: z.string().min(1).max(255),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("remote-set-url"),
						name: z.string().min(1).max(255),
						url: z.string().min(1).max(4096),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("commit"),
						message: z.string().trim().min(1).max(5000),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("commit-all"),
						message: z.string().trim().min(1).max(5000),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("stash"),
						message: z.string().trim().max(500).optional(),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("merge"),
						branch: z.string().min(1).max(255),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("rebase"),
						branch: z.string().min(1).max(255),
					}),
					z.strictObject({
						repository: z.string().min(1).max(4096),
						session: z.boolean().default(false),
						requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
						confirm: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						action: z.literal("rebase-abort"),
					}),
				]),
				{
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: false,
					openWorldHint: true,
				},
				async (input, { signal }) => {
					if (!input.session && !deps.repositories.includes(input.repository))
						throw new OperationRefusal("repository-unauthorized");
					if (deps.execution?.isBusy())
						throw new OperationRefusal("operation-in-progress");
					const {
						repository,
						session: _session,
						requestId,
						confirm,
						...request
					} = input;
					return deps.gitActions.write(
						repository,
						request,
						requestId,
						confirm,
						signal,
					);
				},
			),
		);
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
				"Execute one configured build, test or run target. Admission and dispatch are one step; missing declared secret references refuse before dispatch. Nonzero exits are failures. Borrowed dependencies are revalidated before dispatch and never enter cleanup. Pass worktree to run shell/process commands, Docker builds, Compose, container-run or Helm targets from a linked worktree; Compose files and Helm charts must be repository-local, and network-only targets refuse. Use env_wait for a bounded observation of the settled receipt.",
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
				"env_container_stats",
				"Show container stats",
				"Read bounded CPU, memory, network and PID stats for containers currently owned by this scope or registered as shared services across the client's repositories. Other host containers are never enumerated. Read-only; engine failures count as unavailable.",
				z.strictObject({}),
				{ readOnlyHint: true, idempotentHint: true, openWorldHint: false },
				async (_input, { signal }) => execution.containerStats(signal),
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
