// Authenticated clarification boundary. Caller IDs select data, never grant
// custody, human origin or source authority. Host location is operator-owned.
import fs from "node:fs";
import path from "node:path";
import { HostClient } from "../agent-host/client.ts";
import { hostLayout } from "../agent-host/layout.ts";
import { orchestratorRuntimeDir } from "../agent-host/orchestrator-session.ts";
import {
	type ClarificationAttach,
	type ClarificationMutation,
	clarificationAttachSchema,
	clarificationMutationSchema,
} from "../contracts/clarification.ts";
import { decodeContract } from "../contracts/decode.ts";
import type {
	ClarificationAuthority,
	WorkflowView,
} from "../contracts/workflow.ts";
import {
	assertClarificationConfirmation,
	assertClarificationResponses,
} from "../workflow/runtime/clarification.ts";
import {
	clarificationDigest,
	renderClarificationProposal,
} from "../workflow/runtime/clarification-actions.ts";
import {
	AuthorizationError,
	type OrchestratorConversationIdentity,
	type Principal,
} from "./auth.ts";

export function clarificationSources(view: WorkflowView): Array<
	ClarificationAuthority["sources"][number] & {
		content: string;
		eligible: boolean;
	}
> {
	const sources: Array<
		ClarificationAuthority["sources"][number] & {
			content: string;
			eligible: boolean;
		}
	> = [];
	const add = (
		kind: "task" | "design" | "developer-decision",
		id: string,
		content: string,
		eligible = true,
	) => {
		if (content && Buffer.byteLength(content) <= 128 * 1024)
			sources.push({
				kind,
				id,
				digest: clarificationDigest(content),
				content,
				eligible,
			});
	};
	if (view.task) add("task", "task", view.task);
	const approved = view.approvedDesign;
	if (approved && clarificationDigest(approved.content) === approved.digest)
		add("design", `approved-design:${approved.revision}`, approved.content);
	if (view.worktree && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(view.changeId)) {
		const file = path.join(
			view.worktree,
			"openspec",
			"changes",
			view.changeId,
			"design.md",
		);
		try {
			const root = fs.realpathSync(view.worktree);
			const resolved = fs.realpathSync(file);
			const relative = path.relative(root, resolved);
			if (
				relative &&
				relative !== ".." &&
				!relative.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relative)
			) {
				const fd = fs.openSync(
					resolved,
					fs.constants.O_RDONLY |
						fs.constants.O_NOFOLLOW |
						fs.constants.O_NONBLOCK,
				);
				try {
					if (fs.fstatSync(fd).isFile()) {
						const bytes = Buffer.alloc(128 * 1024 + 1);
						const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
						const content = bytes.subarray(0, count).toString("utf8");
						// Bounded even if the live file grows between stat and read.
						// These bytes inform discussion, never manufacture approval.
						if (
							count <= 128 * 1024 &&
							Buffer.from(content).equals(bytes.subarray(0, count))
						)
							add("design", "design.md", content, false);
					}
				} finally {
					fs.closeSync(fd);
				}
			}
		} catch (error) {
			if (
				!["ENOENT", "ELOOP"].includes(
					(error as NodeJS.ErrnoException).code ?? "",
				)
			)
				throw error;
		}
	}
	for (const question of view.developerDialogue ?? []) {
		if (
			question.kind === "login-handoff" ||
			question.status !== "answered" ||
			!question.answer ||
			question.answer.kind === "cancel"
		)
			continue;
		// Absence of a legacy target is not authenticated human provenance.
		if (question.clarification?.resolution?.origin !== "confirmed-developer")
			continue;
		add(
			"developer-decision",
			question.id,
			JSON.stringify({
				question: question.description,
				answer: question.answer,
			}),
		);
	}
	return sources;
}
export function clarificationProposalPreview(
	view: WorkflowView,
	raw: unknown,
): { version: number; text: string } | undefined {
	const input = decodeContract<ClarificationMutation>(
		"server.clarification.preview",
		clarificationMutationSchema,
		raw,
	);
	if (!input.responses) return undefined;
	const question = view.developerDialogue?.find(
		(item) => item.id === input.questionId,
	);
	if (!question) throw new AuthorizationError(403, "Clarification not found");
	const questions = question.groupId
		? (view.developerDialogue ?? []).filter(
				(item) => item.groupId === question.groupId,
			)
		: [question];
	assertClarificationResponses(questions, input.responses);
	const version = (question.clarification?.candidate?.version ?? 0) + 1;
	const text = renderClarificationProposal(questions, input.responses, version);
	if (Buffer.byteLength(text) > 8192)
		throw new AuthorizationError(
			413,
			"Proposed answer exceeds the native transcript reference bound",
		);
	return { version, text };
}

export async function resolveClarificationAuthority(options: {
	actionId: string;
	input: unknown;
	view: WorkflowView;
	principal: Principal;
	identity?: OrchestratorConversationIdentity;
	configDir?: string;
}): Promise<ClarificationAuthority> {
	const { view } = options;
	let hostId: string;
	let conversationId: string;
	let homeRunId: string;
	let epoch = view.clarificationAttachment?.epoch ?? 0;
	let messageIds: string[] | undefined;
	let requestedSources: ClarificationMutation["sources"];
	if (options.actionId === "clarification.attach") {
		if (options.principal !== "operator")
			throw new AuthorizationError(
				403,
				"Only the developer may attach clarification custody",
			);
		const input = decodeContract<ClarificationAttach>(
			"server.clarification.attach",
			clarificationAttachSchema,
			options.input,
		);
		({ hostId, conversationId, homeRunId } = input);
		epoch += 1;
	} else {
		const input = decodeContract<ClarificationMutation>(
			"server.clarification.mutation",
			clarificationMutationSchema,
			options.input,
		);
		const identity = options.identity;
		const attachment = view.clarificationAttachment;
		if (
			options.principal !== "orchestrator" ||
			!identity ||
			!attachment ||
			identity.hostId !== attachment.hostId ||
			identity.conversationId !== attachment.conversationId ||
			input.epoch !== attachment.epoch
		)
			throw new AuthorizationError(
				403,
				"Clarification belongs to another or unattached Home conversation",
			);
		({ hostId, conversationId } = identity);
		homeRunId = input.homeRunId;
		requestedSources = input.sources;
		const candidate = view.developerDialogue?.find(
			(question) => question.id === input.questionId,
		)?.clarification?.candidate;
		const ids =
			options.actionId === "clarification.confirm"
				? [candidate?.proposal.messageId, input.confirmationMessageId]
				: options.actionId === "clarification.stage"
					? [input.proposalMessageId]
					: options.actionId === "clarification.context"
						? [input.proposalMessageId, input.confirmationMessageId]
						: [];
		messageIds = [
			...new Set(ids.filter((id): id is string => id !== undefined)),
		];
		if (!messageIds.length) messageIds = undefined;
	}
	const client = new HostClient(
		hostLayout(orchestratorRuntimeDir(options.configDir)).socketPath,
	);
	const transcript = await client.clarificationTranscript({
		hostId,
		conversationId,
		runId: homeRunId,
		...(messageIds ? { messageIds } : {}),
	});
	if (options.actionId === "clarification.confirm") {
		const input = decodeContract<ClarificationMutation>(
			"server.clarification.confirm",
			clarificationMutationSchema,
			options.input,
		);
		const question = view.developerDialogue?.find(
			(item) => item.id === input.questionId,
		);
		const state = question?.clarification;
		const candidate = state?.candidate;
		const proposal = transcript.messages.find(
			(message) => message.messageId === candidate?.proposal.messageId,
		);
		const confirmation = transcript.messages.find(
			(message) => message.messageId === input.confirmationMessageId,
		);
		if (
			!question ||
			!state ||
			!candidate ||
			!proposal ||
			!confirmation ||
			!input.version
		)
			throw new AuthorizationError(
				403,
				"Current proposal and native developer confirmation are required",
			);
		assertClarificationConfirmation(
			state,
			input.version,
			proposal,
			confirmation,
		);
		const questions = question.groupId
			? (view.developerDialogue ?? []).filter(
					(item) => item.groupId === question.groupId,
				)
			: [question];
		if (
			!proposal.text.includes(
				renderClarificationProposal(
					questions,
					candidate.responses,
					candidate.version,
				),
			)
		)
			throw new AuthorizationError(403, "Native proposal content mismatch");
		await client.claimClarification({
			hostId,
			conversationId,
			runId: homeRunId,
			confirmationMessageId: confirmation.messageId,
			binding: clarificationDigest([
				view.repository,
				view.workflowId,
				state.attachment,
				question.groupId ?? question.id,
				candidate.digest,
				candidate.proposal,
			]),
		});
	}
	return {
		attachment: { hostId, conversationId, epoch },
		// The host's recent-history read allows 32 entries; canonical command
		// authority is deliberately capped at 16. Grounded/ack operations must
		// still work after a long ordinary conversation, not fail decoding.
		messages: transcript.messages.slice(-16),
		sources: clarificationSources(view)
			.filter(
				(source) =>
					source.eligible &&
					requestedSources?.some(
						(requested) =>
							source.kind === requested.kind &&
							source.id === requested.id &&
							source.digest === requested.digest,
					),
			)
			.map(({ kind, id, digest }) => ({ kind, id, digest })),
	};
}
