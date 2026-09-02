import type { StepBehavior } from "./types.ts";

export const researchBehavior: StepBehavior = {
	roles: () => ["researcher"],
	candidateRoles: () => ["researcher"],
	developerActions: () => [
		{
			id: "research-follow-up",
			label: "Ask researcher follow-up",
			confirmation: "reason",
			input: { schemaId: "core.research-follow-up", schemaVersion: 1 },
		},
		{ id: "close-research", label: "Close research", confirmation: "confirm" },
	],
	assignmentInputs: ({ snapshot }) => ({
		taskLine: snapshot.metadata.task
			? `Research task: ${snapshot.metadata.task}`
			: undefined,
		introLines: [
			`Repository context: ${snapshot.metadata.repository || "none (standalone research)"}`,
			"Research is a persistent interactive session; answer follow-ups in this same session and remain active until close-research.",
		],
		objective:
			"Research the user's task, answer follow-ups, and remain available until a wiki request or developer closure.",
		interaction: "developer-dialogue",
		permissions: [
			"use only tools exposed by the selected runtime",
			...(snapshot.metadata.repository
				? ["read supplied repository as evidence only"]
				: []),
			"dispatch the research-handoff command yourself after an explicit user request; do not wait for a developer dashboard action",
		],
		checks: ["source citations and source-isolation checks"],
	}),
	handoffNote: [
		"Do not hand off `complete` for a research answer or follow-up. Remain in the persistent session until the user explicitly requests a wiki entry, then dispatch `agentic-coding workflow research-handoff` yourself with the structured directives and narrative — it records the handoff and transitions to wiki drafting in one authenticated step. Use `blocked` or `failed` only for bounded handoffs.",
	],
};
