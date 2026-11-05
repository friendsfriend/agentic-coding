import { button, element } from "./dom.js";

/** Explicit operator inspection only; no automatic recovery or execution. */
export function promotionAttemptControls(request, busy, status, clearRetry) {
	const selector = element("select"),
		report = element("pre", "No promotion attempts loaded.");
	selector.setAttribute("aria-label", "Promotion attempts");
	report.setAttribute("aria-label", "Historical promotion attempts");
	let listed = [],
		pendingAcknowledgement = null;
	const list = button("Inspect promotion attempts", () =>
		busy(async () => {
			listed = await request("/api/environments/drafts/promotion-attempts");
			selector.replaceChildren(
				...listed
					.filter((entry) => entry.status === "pending")
					.map((entry) => {
						const option = element("option", `${entry.id} · ${entry.digest}`);
						option.value = entry.id;
						return option;
					}),
			);
			report.textContent = JSON.stringify(listed, null, 2);
			status.textContent =
				"Attempt history loaded. Pending means in progress OR uncertain, not proof of failure. Inspect the live file and ensure no writer remains before acknowledgement.";
		}),
	);
	const acknowledge = button(
		"Acknowledge selected uncertain attempt (no write)",
		() =>
			busy(async () => {
				const attempt = listed.find(
					(entry) => entry.id === selector.value && entry.status === "pending",
				);
				if (!attempt)
					throw Error("Inspect and select a pending promotion attempt first");
				if (
					!confirm(
						`Acknowledge ${attempt.id}? Verify live configuration and ensure no writer remains first. This only clears the native blocker: no rollback, file lock removal, validation, retry or approval occurs.`,
					)
				)
					return;
				if (pendingAcknowledgement?.id !== attempt.id)
					pendingAcknowledgement = {
						id: attempt.id,
						requestId: crypto.randomUUID(),
						acknowledge: true,
					};
				const result = await request(
					"/api/environments/drafts/promotion-attempts/acknowledge",
					pendingAcknowledgement,
				);
				pendingAcknowledgement = null;
				listed = [];
				selector.replaceChildren();
				report.textContent = JSON.stringify(result, null, 2);
				status.textContent =
					"Uncertainty acknowledged only. No file write, rollback, filesystem lock removal, runtime check or new approval. Inspect attempts again; a new promotion needs its own exact confirmation.";
			}),
	);
	const clear = button("Start a new local promotion request (no write)", () => {
		if (
			!confirm(
				"Discard the local retry ID? Inspect prior attempts first; this does not resolve an uncertain attempt, remove locks, write files or approve another promotion.",
			)
		)
			return;
		clearRetry();
		status.textContent =
			"Local promotion retry ID cleared only. Unresolved native attempts still block writes; a new promotion requires a separate exact-digest confirmation.";
	});
	return [list, selector, acknowledge, clear, report];
}
