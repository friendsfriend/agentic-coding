/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { notify } from "../../src/tui/otel/app/notifications";
import { NotificationOverlay } from "../../src/tui/otel/components/Notification";

// Regression test: NotificationOverlay previously read activeNotification()
// directly in the component body instead of through a reactive primitive
// (e.g. <Show>). Solid components run once, so that pattern only ever
// reflected whatever notification was active at first mount and silently
// never updated again for any later notify() call, including the
// copy-succeeded/copy-failed toasts this change adds.
test("shows no toast before any notification, then updates on each notify() call", async () => {
	const t = await testRender(() => <NotificationOverlay />, {
		width: 40,
		height: 10,
	});
	await t.renderOnce();
	expect(t.captureCharFrame()).not.toContain("message");

	notify("First message", "success");
	const firstFrame = await t.waitForFrame((frame) =>
		frame.includes("First message"),
	);
	expect(firstFrame).toContain("✓ First message");

	notify("Second message", "error");
	const secondFrame = await t.waitForFrame((frame) =>
		frame.includes("Second message"),
	);
	expect(secondFrame).not.toContain("First message");
	expect(secondFrame).toContain("✗ Second message");

	t.renderer.destroy();
});
