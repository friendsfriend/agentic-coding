/** Phase status badges (establish-opencode-boundaries, task 6.1): the workflow
 * phase plus an explicit BLOCKED marker. Props-in and pure — the derivation
 * lives in `projections.ts`. */
import { Badge } from "@ui";
import { createMemo, Show } from "solid-js";
import { type PhaseStatusState, phaseStatus } from "../projections.ts";

export function PhaseStatus(props: { state: PhaseStatusState }) {
	const status = createMemo(() => phaseStatus(props.state));
	return (
		<box flexDirection="row" gap={1}>
			<Badge
				text={status().text}
				appearance="badge"
				highlight={status().working ? "highlight2" : "secondary"}
				animation={status().working ? "aurora" : "static"}
			/>
			<Show when={status().blocked}>
				<Badge text="BLOCKED" appearance="badge" highlight="warning" />
			</Show>
		</box>
	);
}
