import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { clarificationSources } from "../src/server/clarification.ts";
import { createClarificationReconciler } from "../src/server/clarification-delivery.ts";
import { runAction } from "../src/server/handlers.ts";
import { nativeClarificationFixture } from "./support/native-clarification.ts";

test("real action adapter propagates a post-verification stale relay refusal to HTTP and receipt reconciliation", async () => {
	const f = await nativeClarificationFixture();
	try {
		f.ask();
		const before = f.view();
		const question = before.developerDialogue?.[0];
		const task = clarificationSources(before).find(
			(source) => source.kind === "task",
		);
		if (!question || !task) throw new Error("missing question/source");
		// Simulate another writer advancing between the server's preflight/native
		// context read and dispatch. Exercise the real adapter, not fixture dispatch.
		f.setActionAdapter((request, options) =>
			runAction({ ...request, revision: request.revision - 1 }, options),
		);
		const response = await f.post("clarification.grounded", {
			epoch: 1,
			questionId: question.id,
			askingRunId: f.run.id,
			homeRunId: f.home.runId,
			responses: [{ questionId: question.id, kind: "option", value: "a" }],
			rationale: "The agreed task specifies A.",
			receipt: "refused-relay",
			sources: [{ kind: task.kind, id: task.id, digest: task.digest }],
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: { code: "revision-conflict" },
		});
		expect(f.view().revision).toBe(before.revision);
		expect(f.view().developerDialogue?.[0]?.status).toBe("pending");
		f.faux.setResponses([
			fauxAssistantMessage([
				fauxText("Clarification received, decision still pending."),
			]),
		]);
		const reconcile = createClarificationReconciler(f.operations, f.root);
		await expect(reconcile(f.repo, f.run.workflowId, true)).rejects.toThrow();
		await f.settle(0);
		expect(f.view().revision).toBe(before.revision);
		expect(
			f.view().developerDialogue?.[0]?.clarification?.delivery.status,
		).toBe("pending");
	} finally {
		await f.cleanup();
	}
}, 30_000);
