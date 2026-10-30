import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type {
	ClarificationState,
	DeveloperDialogueRecord,
} from "../src/contracts/workflow.ts";
import {
	assertClarificationConfirmation,
	assertClarificationCustody,
	assertClarificationResponses,
	type TrustedClarificationMessage,
} from "../src/workflow/runtime/clarification.ts";
import { ClarificationStateSchema } from "../src/workflow/schema.ts";

const attachment = { hostId: "host", conversationId: "conversation", epoch: 1 };
const state: ClarificationState = {
	attachment,
	delivery: { id: "stable-delivery", status: "pending" },
	candidate: {
		version: 1,
		responses: [{ questionId: "q", kind: "custom", value: "line 1\nline 2" }],
		digest: "digest",
		proposal: { messageId: "proposal", sequence: 10 },
	},
};
const proposal: TrustedClarificationMessage = {
	...attachment,
	messageId: "proposal",
	sequence: 10,
	role: "assistant",
};
const confirmation: TrustedClarificationMessage = {
	...attachment,
	messageId: "confirmation",
	sequence: 11,
	role: "developer",
};
const question: DeveloperDialogueRecord = {
	id: "q",
	workflowId: "workflow",
	runId: "run",
	stepId: "step",
	role: "worker",
	description: "Choose",
	options: [{ title: "A", value: "a", recommended: false, description: "A" }],
	status: "pending",
	createdAt: "now",
	expiresAt: "later",
};

describe("clarification additive contracts and protocol guards", () => {
	test("round trips exact custom content and stable delivery identity", () => {
		expect(Schema.decodeUnknownSync(ClarificationStateSchema)(state)).toEqual(
			state,
		);
	});
	test("bounds attachment, versions, sources and response sets", () => {
		for (const invalid of [
			{ ...state, attachment: { ...attachment, epoch: 0 } },
			{
				...state,
				attachment: { ...attachment, conversationId: "x".repeat(257) },
			},
			{ ...state, candidate: { ...state.candidate, version: 0 } },
			{ ...state, candidate: { ...state.candidate, responses: [] } },
			{
				...state,
				resolution: {
					origin: "grounded-orchestrator",
					rationale: "because",
					sources: [],
					receipt: "receipt",
				},
			},
		])
			expect(() =>
				Schema.decodeUnknownSync(ClarificationStateSchema)(invalid),
			).toThrow();
	});
	test("rejects inconsistent receipts and confirmation provenance", () => {
		const candidate = state.candidate;
		if (!candidate) throw new Error("fixture candidate missing");
		for (const invalid of [
			{ ...state, delivery: { id: "stable", status: "accepted" } },
			{
				...state,
				delivery: { id: "stable", status: "pending", acceptedAt: "now" },
			},
			{
				...state,
				candidate: {
					...candidate,
					responses: [...candidate.responses, ...candidate.responses],
				},
			},
			{
				...state,
				candidate: {
					...candidate,
					responses: [
						{ questionId: "q", kind: "custom", value: "x".repeat(8193) },
					],
				},
			},
			{ ...state, attachment: { ...attachment, hostId: "😀".repeat(65) } },
			{
				...state,
				candidate: {
					...candidate,
					responses: Array.from({ length: 101 }, (_, index) => ({
						questionId: `q${index}`,
						kind: "custom",
						value: "answer",
					})),
				},
			},
			{
				...state,
				resolution: {
					origin: "confirmed-developer",
					candidateVersion: 2,
					confirmation: { messageId: "confirmation", sequence: 11 },
					receipt: "receipt",
				},
			},
			{
				...state,
				resolution: {
					origin: "confirmed-developer",
					candidateVersion: 1,
					confirmation: { messageId: "confirmation", sequence: 9 },
					receipt: "receipt",
				},
			},
		])
			expect(() =>
				Schema.decodeUnknownSync(ClarificationStateSchema)(invalid),
			).toThrow();
	});
	test("legacy absence never grants custody", () => {
		expect(() => assertClarificationCustody(undefined, attachment)).toThrow();
		assertClarificationCustody(attachment, attachment);
		for (const caller of [
			{ ...attachment, epoch: 2 },
			{ ...attachment, conversationId: "other" },
			{ ...attachment, hostId: "other" },
		])
			expect(() => assertClarificationCustody(attachment, caller)).toThrow();
	});
	test("confirmation binds exact candidate and subsequent developer transcript", () => {
		assertClarificationConfirmation(state, 1, proposal, confirmation);
		for (const message of [
			{ ...confirmation, role: "tool" as const },
			{ ...confirmation, role: "system" as const },
			{ ...confirmation, role: "assistant" as const },
			{ ...confirmation, sequence: 9 },
			{ ...confirmation, conversationId: "other" },
			{ ...confirmation, hostId: "other" },
		])
			expect(() =>
				assertClarificationConfirmation(state, 1, proposal, message),
			).toThrow();
		expect(() =>
			assertClarificationConfirmation(state, 2, proposal, confirmation),
		).toThrow();
		expect(() =>
			assertClarificationConfirmation(
				state,
				1,
				{ ...proposal, messageId: "forged" },
				confirmation,
			),
		).toThrow();
	});
	test("single/options/custom and complete ordered groups remain distinct", () => {
		assertClarificationResponses(
			[question],
			[{ questionId: "q", kind: "option", value: "a" }],
		);
		assertClarificationResponses(
			[question],
			[{ questionId: "q", kind: "custom", value: "line 1\nline 2" }],
		);
		expect(() =>
			assertClarificationResponses(
				[question],
				[{ questionId: "q", kind: "option", value: "missing" }],
			),
		).toThrow();
		const group = [
			{ ...question, groupId: "g", itemIndex: 0 },
			{ ...question, id: "q2", groupId: "g", itemIndex: 1 },
		];
		const responses = [
			{ questionId: "q", kind: "custom" as const, value: "one" },
			{ questionId: "q2", kind: "custom" as const, value: "two" },
		];
		assertClarificationResponses(group, responses);
		expect(() =>
			assertClarificationResponses(group, responses.slice(0, 1)),
		).toThrow();
		expect(() =>
			assertClarificationResponses(group, [...responses].reverse()),
		).toThrow();
		for (const changed of [
			{ ...question, status: "expired" as const },
			{ ...question, kind: "login-handoff" as const },
			{ ...question, targetRole: "planner" },
		])
			expect(() =>
				assertClarificationResponses([changed], responses.slice(0, 1)),
			).toThrow();
	});
});
