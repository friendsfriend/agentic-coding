/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/solid";
import {
	CredentialsModal,
	credentialPromptBridge,
	pendingCredentialRequest,
} from "../../src/tui/dash/ui/CredentialsModal.tsx";
import { NewWorkflowModal } from "../../src/tui/dash/ui/NewWorkflowModal.tsx";

function key(
	name: string,
	extra: { meta?: boolean; shift?: boolean; sequence?: string } = {},
): KeyEvent {
	return new KeyEvent({
		name,
		ctrl: false,
		meta: extra.meta ?? false,
		shift: extra.shift ?? false,
		option: false,
		sequence: extra.sequence ?? name,
		number: false,
		raw: extra.sequence ?? name,
		eventType: "press",
		source: "raw",
	});
}

test("credentials modal masks the passphrase input", async () => {
	const t = await testRender(
		() => (
			<CredentialsModal
				prompt="Enter passphrase for key '~/.ssh/id_ed25519':"
				mask
				value="hunter2"
			/>
		),
		{ width: 90, height: 24 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("SSH credential required");
	expect(frame).toContain("Enter passphrase for key '~/.ssh/id_ed25519':");
	expect(frame).toContain("*******");
	expect(frame).not.toContain("hunter2");
	t.renderer.destroy();
});

test("credentials modal shows username prompts unmasked", async () => {
	const t = await testRender(
		() => (
			<CredentialsModal
				prompt="Username for 'https://github.com':"
				mask={false}
				value="octocat"
			/>
		),
		{ width: 90, height: 24 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("octocat");
	expect(frame).not.toContain("********");
	t.renderer.destroy();
});

test("credentialPromptBridge resolves with the submitted answer and clears the pending request", async () => {
	const bridge = credentialPromptBridge();
	const promise = bridge(
		"Enter passphrase for key '/home/me/.ssh/id_ed25519':",
	);
	const request = pendingCredentialRequest();
	expect(request).toBeTruthy();
	expect(request?.prompt).toBe(
		"Enter passphrase for key '/home/me/.ssh/id_ed25519':",
	);
	expect(request?.mask).toBe(true);
	request?.resolve("s3cret");
	await expect(promise).resolves.toBe("s3cret");
	expect(pendingCredentialRequest()).toBeUndefined();
});

test("credentialPromptBridge abort clears only its own pending request", async () => {
	const bridge = credentialPromptBridge();
	const controller = new AbortController();
	const abandoned = bridge(
		"Enter passphrase for key 'old':",
		controller.signal,
	);
	const old = pendingCredentialRequest();
	controller.abort();
	await expect(abandoned).resolves.toBe("");
	expect(pendingCredentialRequest()).toBeUndefined();

	const next = bridge("Username for 'https://example.test':");
	const request = pendingCredentialRequest();
	expect(request?.id).not.toBe(old?.id);
	// A stale callback cannot remove the newer request.
	old?.resolve("old-secret");
	expect(pendingCredentialRequest()?.id).toBe(request?.id);
	request?.resolve("octocat");
	await expect(next).resolves.toBe("octocat");
});

test("new workflow confirm summary has no Agent routing row", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={{ kind: "independent" }}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		{ width: 110, height: 30 },
	);
	await t.flush();
	// Drive through workflow type -> agent preset -> ticket -> change -> task.
	handler?.(key("enter")); // workflow type: research
	handler?.(key("enter")); // agent preset: (config defaults)
	handler?.(key("enter")); // agent preset: (config defaults)
	t.mockInput.pressEnter(); // ticket: optional, advance
	t.mockInput.pressEnter(); // change: advance
	t.mockInput.pressEnter({ meta: true }); // task: Alt+Enter advances to confirm
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Confirm workflow");
	expect(frame).toContain("Workflow type");
	expect(frame).not.toContain("Agent routing");
	t.renderer.destroy();
});
