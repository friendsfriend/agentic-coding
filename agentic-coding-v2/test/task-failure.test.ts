import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { safeFailureMessage, taskFailure } from "../src/task-failure.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const profile = { id: "reviewer", provider: "example", modelId: "model" };

test("failure diagnostics preserve budget and availability reasons without echoed credentials", () => {
	const budget = taskFailure(
		{
			reason: "model_error",
			detail:
				'429 {"error":{"message":"Budget has been exceeded! Key=synthetic-account (sk-synthetic-secret) Current cost: 181, Max budget: 180","type":"budget_exceeded"}}',
		},
		profile,
	);
	expect(budget.detail).toMatchObject({
		kind: "budget_exceeded",
		profile: "reviewer",
		provider: "example",
		model: "model",
	});
	expect(budget.message).toContain("Max budget: 180");
	expect(budget.message).not.toContain("synthetic-account");
	expect(budget.message).not.toContain("sk-synthetic-secret");
	expect(
		taskFailure(
			{
				detail:
					'github-copilot API error (400): {"message":"The requested model is not available for integrator vscode-chat","code":"model_not_available_for_integrator"}',
			},
			profile,
		).detail.kind,
	).toBe("model_unavailable");
	expect(
		taskFailure({ detail: "HTTP 429 rate limited" }, profile).detail.kind,
	).toBe("rate_limited");
	expect(
		safeFailureMessage(
			'https://user:secret@example.test {"token":"private-token"} Authorization: Bearer private-bearer',
		),
	).not.toMatch(/user:secret|private-token|private-bearer/);
});

test("a failed model's real reason reaches its parent's durable join", async () => {
	const { app, fake, invocation } = await fixture(false, (config) => {
		config.profiles.push({
			...config.profiles[0],
			id: "verifier",
			modelId: "replacement",
		});
	});
	let rounds = 0;
	let parentContext = "";
	const replies: FauxResponseFactory = (input, _options, _state, model) => {
		if (model.id === "replacement")
			return fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage:
					'API error (400): {"code":"model_not_available_for_integrator","message":"The requested model is not available for integrator vscode-chat. Key=synthetic-account (sk-synthetic-secret)"}',
			});
		rounds++;
		if (rounds === 1)
			return fauxAssistantMessage(
				fauxToolCall("start_task", {
					...invocation,
					workspace: "shared",
					profile: "verifier",
					requestId: "failed-verifier",
				}),
				{ stopReason: "toolUse" },
			);
		parentContext = JSON.stringify(input);
		return fauxAssistantMessage(fauxText("Observed child provider failure"));
	};
	fake.setResponses(Array.from({ length: 8 }, () => replies));
	const id = await app.startTask(invocation);
	const parent = await app.harness.waitForTask(id as never, context);
	expect(parent.state.outcome.status).toBe("completed");
	const child = (await app.snapshot()).tasks.find((task) => task.parent === id);
	if (!child) throw new Error("Missing child task");
	const result = await app.taskResult(child.id);
	expect(result?.state.outcome).toMatchObject({
		status: "failed",
		error: {
			message: expect.stringContaining("model_not_available_for_integrator"),
			detail: {
				kind: "model_unavailable",
				profile: "verifier",
				model: "replacement",
			},
		},
	});
	expect(parentContext).toContain("model_not_available_for_integrator");
	expect(parentContext).toContain("model_unavailable");
	expect(parentContext).not.toContain("synthetic-account");
	expect(parentContext).not.toContain("sk-synthetic-secret");
});
