import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	activeCredentialPromptProvider,
	createQueuedCredentialPrompt,
	dashboardApplication,
	disposeExecutionCoordinator,
	executionCoordinator,
	setCredentialPromptProvider,
} from "../../src/workflow/execution-coordinator";

// The composition-unified shell must keep repository execution coordination
// alive across feature hide/show and only release it when the root disposes it
// (compose-unified-feature-shell task 1.2/1.3). These tests pin the registry
// identity semantics that make that true, plus the request lifecycle.
describe("root-owned execution coordinator (compose-unified-feature-shell)", () => {
	test("a repository keeps the same coordinator across repeated show/hide lookups", () => {
		const repo = "/tmp/herdr-coordinator-showhide";
		try {
			const first = executionCoordinator(repo);
			const second = executionCoordinator(repo);
			expect(second).toBe(first);
		} finally {
			disposeExecutionCoordinator(repo);
		}
	});

	test("distinct repositories get distinct coordinators", () => {
		const a = "/tmp/herdr-coordinator-a";
		const b = "/tmp/herdr-coordinator-b";
		try {
			expect(executionCoordinator(a)).not.toBe(executionCoordinator(b));
		} finally {
			disposeExecutionCoordinator(a);
			disposeExecutionCoordinator(b);
		}
	});

	test("root disposal releases the coordinator so a later lookup is a fresh owner", () => {
		const repo = "/tmp/herdr-coordinator-dispose";
		const first = executionCoordinator(repo);
		disposeExecutionCoordinator(repo);
		const second = executionCoordinator(repo);
		try {
			expect(second).not.toBe(first);
		} finally {
			disposeExecutionCoordinator(repo);
		}
	});

	test("the dashboard application runtime is a single shared owner", () => {
		expect(typeof dashboardApplication.dispose).toBe("function");
		expect(typeof dashboardApplication.runSync).toBe("function");
	});

	test("a request made while a drain is in flight is coalesced and settles both workflows", async () => {
		const repo = mkdtempSync(join(tmpdir(), "herdr-coordinator-"));
		const coordinator = executionCoordinator(repo);
		const settled: string[] = [];
		const errors: string[] = [];
		const unsubscribeSettled = coordinator.onSettled((id) => settled.push(id));
		const unsubscribeError = coordinator.onError((id) => errors.push(id));
		try {
			coordinator.request("wf-first");
			// Queue two ids while the first drain is in flight. Every coalesced id
			// must settle after the follow-up drain actually processes it.
			coordinator.request("wf-second");
			coordinator.request("wf-third");
			const deadline = Date.now() + 3000;
			while (
				(!settled.includes("wf-second") || !settled.includes("wf-third")) &&
				Date.now() < deadline
			) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect(settled).toContain("wf-second");
			expect(settled).toContain("wf-third");
			expect(settled.includes("wf-first") || errors.includes("wf-first")).toBe(
				true,
			);
		} finally {
			unsubscribeSettled();
			unsubscribeError();
			disposeExecutionCoordinator(repo);
		}
	});

	test("root disposal drops a queued follow-up", async () => {
		const repo = mkdtempSync(join(tmpdir(), "herdr-coordinator-dispose-"));
		const coordinator = executionCoordinator(repo);
		const settled: string[] = [];
		const unsubscribe = coordinator.onSettled((id) => settled.push(id));
		try {
			coordinator.request("wf-first");
			coordinator.request("wf-second");
			coordinator.dispose();
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(settled).not.toContain("wf-second");
		} finally {
			unsubscribe();
			disposeExecutionCoordinator(repo);
		}
	});

	test("an aborted queued prompt releases the next prompt", async () => {
		const calls: string[] = [];
		let resolveSecond: ((value: string) => void) | undefined;
		const dispose = setCredentialPromptProvider(
			() => (prompt, signal) =>
				new Promise<string>((resolve) => {
					calls.push(prompt);
					signal?.addEventListener("abort", () => resolve(""), { once: true });
					if (prompt === "second") resolveSecond = resolve;
				}),
		);
		try {
			const prompt = createQueuedCredentialPrompt();
			const firstController = new AbortController();
			const first = prompt("first", firstController.signal);
			const second = prompt("second");
			const deadline = Date.now() + 500;
			while (!calls.includes("first") && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 5));
			firstController.abort();
			await expect(first).resolves.toBe("");
			while (!resolveSecond && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 5));
			expect(calls).toEqual(["first", "second"]);
			resolveSecond?.("done");
			await expect(second).resolves.toBe("done");
		} finally {
			dispose();
		}
	});

	test("registering a credential prompt provider is reversible", () => {
		const dispose = setCredentialPromptProvider(() => async () => "secret");
		expect(typeof dispose).toBe("function");
		// Disposing restores the previous (headless) provider without throwing.
		dispose();
	});

	test("non-LIFO disposal never resurrects a released provider", async () => {
		const disposeA = setCredentialPromptProvider(() => async () => "a");
		const disposeB = setCredentialPromptProvider(() => async () => "b");
		// A is superseded before its own disposer runs; B then releases and must
		// not restore the already-disposed A.
		disposeA();
		disposeB();
		const active = activeCredentialPromptProvider();
		expect(await active()("password")).toBe("");
		// Disposers are idempotent.
		disposeA();
		disposeB();
	});

	test("a re-registered provider survives disposal of a temporary override", async () => {
		const disposeOld = setCredentialPromptProvider(() => async () => "old");
		disposeOld();
		const disposeLive = setCredentialPromptProvider(() => async () => "live");
		const disposeTemporary = setCredentialPromptProvider(
			() => async () => "temp",
		);
		try {
			disposeTemporary();
			expect(await activeCredentialPromptProvider()()("password")).toBe("live");
		} finally {
			disposeLive();
		}
	});
});
