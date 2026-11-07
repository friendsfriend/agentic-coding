import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { digest, text } from "./config.ts";
import { type Data, record } from "./protocol/index.ts";
import type {
	ProviderActionCandidate,
	ProviderActionIntent,
	ProviderActionReceipt,
} from "./protocol/provider-actions.ts";
import { redact } from "./providers/clients.ts";
import {
	findProvider,
	type ProviderConfig,
	providerToken,
} from "./providers/config.ts";
import { ProviderApis } from "./providers/providers.ts";
import type { Runtime } from "./runtime.ts";

const methods = {
	"comment-change": "commentOnChange",
	"approve-exact-change": "approveExactChange",
	"unapprove-change": "unapproveChange",
	"comment-issue": "commentOnIssue",
	"close-issue": "closeIssue",
	"retry-job": "retryJob",
	"cancel-job": "cancelJob",
	"rebase-change": "rebaseChange",
	"reply-discussion": "replyDiscussion",
	"resolve-discussion": "resolveDiscussion",
	"set-issue-labels": "setIssueLabels",
	"set-issue-assignees": "setIssueAssignees",
} as const;
const Attempts = defineDoc<{ attempts: Record<string, string> }>({
	kind: "v2.provider-action-attempts",
	version: 1,
	scope: "session",
	initial: () => ({ attempts: {} }),
	checkpointWhen: () => true,
});
type Candidate = ProviderActionCandidate & {
	providerConfig: ProviderConfig;
	intent: ProviderActionIntent;
	target: string;
	key: string;
};
/** Exact immutable operator intentions; intent is durable before outbound dispatch. */
export class ProviderActions {
	private readonly candidates = new Map<string, Candidate>();
	constructor(private readonly app: Runtime) {}
	private definition(provider: ProviderConfig) {
		return JSON.stringify({
			name: provider.name,
			type: provider.type,
			baseUrl: provider.baseUrl,
			username: provider.username,
			tokenRef: provider.tokenRef,
		});
	}
	async list(providerName: string): Promise<ProviderActionReceipt[]> {
		findProvider(this.app.config.providers, providerName);
		const doc = await this.app.harness.snapshot(Attempts, context);
		return Object.values(doc?.attempts ?? {})
			.map((raw) => JSON.parse(raw) as ProviderActionReceipt)
			.filter((item) => item.provider === providerName)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((item) => ({
				...item,
				result:
					item.result && Buffer.byteLength(JSON.stringify(item.result)) > 1024
						? {
								receiptClipped: true,
								requestId: item.id,
								message:
									"Read this exact native receipt for full retained data; no remote call",
							}
						: item.result,
			}));
	}
	async receipt(
		provider: string,
		requestId: string,
	): Promise<ProviderActionReceipt> {
		findProvider(this.app.config.providers, provider);
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
			throw new Error("Invalid request identity");
		const value = (await this.app.harness.snapshot(Attempts, context))
			?.attempts[digest(JSON.stringify([provider, requestId]))];
		if (!value)
			throw new Error("Native receipt unavailable for this provider/request");
		return JSON.parse(value) as ProviderActionReceipt;
	}
	async preview(raw: Data): Promise<ProviderActionCandidate> {
		if (
			Object.keys(raw).some(
				(key) =>
					![
						"provider",
						"operation",
						"repo",
						"number",
						"thread",
						"payload",
						"requestId",
					].includes(key),
			)
		)
			throw new Error("Unsupported provider intention field");
		const provider = structuredClone(
				findProvider(
					this.app.config.providers,
					text(raw.provider, "provider", 64),
				),
			),
			operation = text(raw.operation, "provider operation", 32);
		if (!Object.hasOwn(methods, operation))
			throw new Error("Unsupported native provider operation");
		if (
			["rebase-change", "resolve-discussion"].includes(operation) &&
			provider.type !== "gitlab"
		)
			throw new Error("Operation requires GitLab");
		if (
			operation === "unapprove-change" &&
			provider.type === "github" &&
			!provider.username
		)
			throw new Error(
				"GitHub unapproval requires a matching configured/authenticated username",
			);
		if (!providerToken(provider))
			throw new Error("Provider credential reference is unavailable");
		const repo = text(raw.repo, "repository", 256),
			number = Number(raw.number),
			requestId = text(raw.requestId, "stable request ID", 128),
			payload = record(raw.payload);
		if (
			typeof raw.number !== "number" ||
			!Number.isSafeInteger(number) ||
			number < 1 ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
			!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(repo) ||
			repo.split("/").some((part) => [".", ".."].includes(part)) ||
			(provider.type === "github" && repo.split("/").length !== 2)
		)
			throw new Error("Invalid fixed repository/number/request identity");
		const commenting = [
				"comment-change",
				"comment-issue",
				"reply-discussion",
			].includes(operation),
			allowed = commenting
				? ["body"]
				: operation === "approve-exact-change"
					? ["sha"]
					: operation === "resolve-discussion"
						? ["resolved"]
						: operation === "set-issue-labels"
							? ["labels"]
							: operation === "set-issue-assignees"
								? ["assignees"]
								: [];
		if (
			Object.keys(payload).some((key) => !allowed.includes(key)) ||
			allowed.some((key) => !Object.hasOwn(payload, key))
		)
			throw new Error("Unsupported/absent provider payload field");
		if (commenting) text(payload.body, "comment body", 16000);
		if (
			operation === "approve-exact-change" &&
			(typeof payload.sha !== "string" || !/^[a-f0-9]{40}$/.test(payload.sha))
		)
			throw new Error("Full reviewed head SHA required");
		if (
			operation === "resolve-discussion" &&
			typeof payload.resolved !== "boolean"
		)
			throw new Error("Explicit discussion resolution required");
		if (
			operation === "set-issue-labels" &&
			(!Array.isArray(payload.labels) ||
				payload.labels.length > 32 ||
				!payload.labels.every(
					(item) =>
						typeof item === "string" && item.length > 0 && item.length <= 64,
				))
		)
			throw new Error("Invalid bounded issue labels");
		if (
			operation === "set-issue-assignees" &&
			(!Array.isArray(payload.assignees) ||
				payload.assignees.length > 16 ||
				!payload.assignees.every((item) =>
					provider.type === "github"
						? typeof item === "string" && /^[A-Za-z0-9-]{1,128}$/.test(item)
						: Number.isSafeInteger(item) && Number(item) > 0,
				))
		)
			throw new Error("Invalid provider-specific assignees");
		let thread: string | undefined;
		if (["reply-discussion", "resolve-discussion"].includes(operation)) {
			thread = text(raw.thread, "discussion identity", 128);
			if (
				!(provider.type === "github"
					? /^[1-9][0-9]{0,15}$/.test(thread)
					: /^[A-Za-z0-9_-]{1,128}$/.test(thread))
			)
				throw new Error("Invalid discussion identity");
		} else if (raw.thread !== undefined)
			throw new Error("Unexpected discussion identity");
		const intent: ProviderActionIntent = {
				provider: provider.name,
				operation: operation as keyof typeof methods,
				repo,
				number,
				...(thread ? { thread } : {}),
				payload: structuredClone(payload),
				requestId,
			},
			target = `${repo}#${number}${thread ? `#${thread}` : ""}`,
			key = digest(JSON.stringify([provider.name, requestId]));
		text(target, "fixed provider target", 256);
		if ((await this.app.harness.snapshot(Attempts, context))?.attempts[key])
			throw new Error(
				"Request has a retained attempt; inspect its receipt and remote state, never retry implicitly",
			);
		if (Buffer.byteLength(this.definition(provider)) > 1024)
			throw new Error(
				"Provider destination metadata exceeds bounded UTF-8 size",
			);
		const snapshot = JSON.stringify(
			{ ...intent, destination: JSON.parse(this.definition(provider)) },
			null,
			2,
		);
		if (Buffer.byteLength(snapshot) > 32000)
			throw new Error("Provider snapshot exceeds bounded UTF-8 size");
		for (const configured of this.app.config.providers) {
			const token = providerToken(configured);
			if (token && snapshot.includes(token))
				throw new Error(
					"Provider credential values cannot enter approval snapshots",
				);
		}
		for (const [id, candidate] of this.candidates)
			if (candidate.expiresAt <= Date.now()) this.candidates.delete(id);
		if (this.candidates.size >= 16)
			throw new Error("Provider candidate capacity reached");
		const candidate: Candidate = {
			id: crypto.randomUUID(),
			provider: provider.name,
			snapshot,
			digest: digest(snapshot),
			expiresAt: Date.now() + 600000,
			providerConfig: provider,
			intent,
			target,
			key,
		};
		this.candidates.set(candidate.id, candidate);
		return this.publicCandidate(candidate);
	}
	private publicCandidate(candidate: Candidate): ProviderActionCandidate {
		const { id, provider, snapshot, digest, expiresAt } = candidate;
		return { id, provider, snapshot, digest, expiresAt };
	}
	async apply(id: string, approval: string): Promise<ProviderActionReceipt> {
		const candidate = this.candidates.get(id);
		if (
			!candidate ||
			candidate.expiresAt <= Date.now() ||
			approval !== `approve:${candidate.digest}` ||
			this.definition(
				findProvider(this.app.config.providers, candidate.provider),
			) !== this.definition(candidate.providerConfig)
		)
			throw new Error("Provider confirmation is missing, expired or changed");
		const receipt: ProviderActionReceipt = {
			id: candidate.intent.requestId,
			provider: candidate.provider,
			operation: candidate.intent.operation,
			target: candidate.target,
			digest: candidate.digest,
			destination: this.definition(candidate.providerConfig),
			status: "uncertain",
			result: null,
			updatedAt: Date.now(),
		};
		await this.app.harness.commit(async (tx) => {
			const doc = await tx.doc(Attempts);
			if (
				this.candidates.get(id) !== candidate ||
				candidate.expiresAt <= Date.now() ||
				Object.hasOwn(doc.attempts, candidate.key) ||
				Object.keys(doc.attempts).length >= 256
			)
				throw new Error(
					"Provider attempt unavailable/already allocated or journal full",
				);
			doc.attempts[candidate.key] = JSON.stringify(receipt);
		}, context);
		this.candidates.delete(id);
		// A crash, rejection, preflight failure or lost acknowledgement remains conservatively uncertain.
		// No candidate/request is redispatched on retry, startup, reconnect or receipt read.
		try {
			const api = new ProviderApis(
					{ ...this.app.config, providers: [candidate.providerConfig] },
					() => this.app.harness,
				),
				payload = candidate.intent.payload;
			const result = await api[methods[candidate.intent.operation]](
				candidate.provider,
				{
					requestId: candidate.intent.requestId,
					target: candidate.target,
					payload,
					op: candidate.intent.operation,
					approve: digest(
						JSON.stringify({
							op: candidate.intent.operation,
							target: candidate.target,
							payload,
						}),
					),
				},
			);
			const serialized = redact(
				JSON.stringify(result),
				candidate.providerConfig,
			);
			if (Buffer.byteLength(serialized) > 32000)
				throw new Error("Provider receipt exceeds bounded size");
			const complete: ProviderActionReceipt = {
				...receipt,
				status: "acknowledged",
				result: record(JSON.parse(serialized)),
				updatedAt: Date.now(),
			};
			await this.app.harness.commit(async (tx) => {
				const doc = await tx.doc(Attempts);
				const current = JSON.parse(
					doc.attempts[candidate.key],
				) as ProviderActionReceipt;
				if (
					current.digest !== candidate.digest ||
					current.status !== "uncertain"
				)
					throw new Error("Provider journal changed");
				doc.attempts[candidate.key] = JSON.stringify(complete);
			}, context);
			return complete;
		} catch {
			return receipt;
		}
	}
}
