import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { clarificationDeliveries } from "../src/agent-host/clarification-delivery.ts";
import { createClarificationReconciler } from "../src/server/clarification-delivery.ts";
import { nativeClarificationFixture } from "./support/native-clarification.ts";

const text = (value: string) => fauxAssistantMessage([fauxText(value)]);

test("busy Home retains an acknowledged queued clarification through graceful shutdown and processes it once after reopen", async () => {
	const f = await nativeClarificationFixture();
	try {
		let started = false;
		f.faux.setResponses([
			async (_context, options) => {
				const signal = options?.signal;
				if (!signal) throw new Error("missing native turn cancellation signal");
				started = true;
				// Hold the ordinary turn until lifecycle shutdown cancels it, rather
				// than depending on a timer staying ahead of queue admission/ACK.
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else
						signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return text("ordinary turn");
			},
		]);
		await f.client.submit(
			f.home.runId,
			"An ordinary in-flight turn.",
			"busy-turn",
			"followUp",
			"internal",
		);
		for (let i = 0; i < 100 && !started; i++) await Bun.sleep(10);
		expect(started).toBe(true);
		f.ask();
		f.block();
		const reconcile = createClarificationReconciler(f.operations, f.root);
		await reconcile(f.repo, f.run.workflowId, true);
		expect(
			f.view().developerDialogue?.[0]?.clarification?.delivery.status,
		).toBe("accepted");
		expect(await f.assistants()).toHaveLength(0);
		// These responses are for any resumed in-flight turn and then the queued
		// notification. No new delivery attempt is possible after the committed ACK.
		f.faux.setResponses([
			text("Resumed ordinary turn."),
			text("Clarification processed."),
		]);
		await f.reopenHost();
		f.reopenEngine();
		await f.settle(0);
		const entries = await f.host().entriesForTest(f.home.runId);
		const notifications = entries.filter(
			(entry) =>
				(entry as { kind?: string }).kind === "herdr.orchestrator.internal" &&
				JSON.stringify(entry).includes("Workflow clarification pending."),
		);
		expect(notifications).toHaveLength(1);
		const notificationId = Number(
			(notifications[0] as { id?: string } | undefined)?.id,
		);
		expect(
			(await f.assistants()).some(
				(message) => message.sequence > notificationId,
			),
		).toBe(true);
		expect(clarificationDeliveries(f.view())).toEqual([]);
		expect(f.view().developerDialogue?.[0]?.status).toBe("pending");
		const before = await f.assistants();
		await reconcile(f.repo, f.run.workflowId, true);
		await Bun.sleep(50);
		expect(await f.assistants()).toEqual(before);
	} finally {
		await f.cleanup();
	}
}, 30_000);
