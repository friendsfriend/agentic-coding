import { expect, test } from "bun:test";
import type { SlotRow } from "../stores/slot-store.ts";
import { releaseConfirmationMessage } from "./slot-actions.ts";

// The force-release confirmation (show-environment-instances, task 2.2): the
// text names the holder, the next waiter and that the holder's run stops. The
// route the confirmed action calls is covered by the core client test
// (`releaseApp`).

function row(overrides: Partial<SlotRow>): SlotRow {
	return {
		app: "customer-mw",
		holder: "workflow:a",
		status: "running",
		endpoints: {},
		holderSince: null,
		idleMs: null,
		idleTtlMs: null,
		waiting: [],
		...overrides,
	};
}

test("names the holder and the next waiter", () => {
	expect(
		releaseConfirmationMessage(
			row({
				waiting: [{ owner: "workflow:b", since: "", position: 1 }],
			}),
		),
	).toBe(
		"This stops the run held by a. The app is then granted to b, the next waiter.",
	);
});

test("names a human holder as you and omits the waiter sentence when none waits", () => {
	expect(releaseConfirmationMessage(row({ holder: "user" }))).toBe(
		"This stops the run held by you.",
	);
});
