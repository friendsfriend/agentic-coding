import {
	Badge,
	type Highlight,
	statusAnimationIntentForText,
	statusAnimationModel,
} from "@devenv/ui";
import { For, Show } from "solid-js";
import type { ActionRunStore } from "../stores/action-run-store";

export function ActionsView(props: { store: ActionRunStore }) {
	const focused = () =>
		props.store
			.run()
			?.steps.find((step) => step.id === props.store.focusedStepId());
	const icon = (status: string) =>
		status === "completed"
			? "✓"
			: status === "failed"
				? "✗"
				: status === "active"
					? ""
					: "○";
	const statusHighlight = (status: string): Highlight =>
		status === "completed"
			? "positive"
			: status === "failed"
				? "negative"
				: status === "active"
					? "primary"
					: "secondary";
	const animation = (status: string, label: string) =>
		status === "active"
			? statusAnimationModel(statusAnimationIntentForText(label))
			: undefined;
	return (
		<box flexDirection="row" width="100%" height="100%">
			<box flexDirection="column" width="38%" borderStyle="single" padding={1}>
				<text>Steps</text>
				<For each={props.store.run()?.steps ?? []}>
					{(step) => (
						<box style={{ flexDirection: "row", height: 1 }}>
							<text>
								{step.id === props.store.focusedStepId() ? "› " : "  "}
							</text>
							<Badge
								text={`${icon(step.status) || " "} ${step.label}${step.error ? ` — ${step.error}` : ""}`}
								appearance="text"
								highlight={
									animation(step.status, step.label)?.tone ??
									animation(step.status, step.label)?.highlights?.[0] ??
									statusHighlight(step.status)
								}
								animatedTone={animation(step.status, step.label)?.tone}
								animatedHighlights={
									animation(step.status, step.label)?.highlights
								}
								attributes={0}
								transitionKey={`actions-view-step:${step.id}`}
							/>
						</box>
					)}
				</For>
			</box>
			<box flexDirection="column" width="62%" borderStyle="single" padding={1}>
				<text>{`Log: ${focused()?.label ?? "none"}`}</text>
				<For each={focused()?.commands ?? []}>
					{(command) => (
						<box flexDirection="column">
							<text>{`$ ${command.command}`}</text>
							<Show when={command.stdout}>
								<text>{command.stdout}</text>
							</Show>
							<Show when={command.stderr}>
								<text>{command.stderr}</text>
							</Show>
						</box>
					)}
				</For>
			</box>
		</box>
	);
}
