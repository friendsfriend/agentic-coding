/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show } from "solid-js";
import type { UiActionDescriptor } from "../../../src/ui/capability-api.ts";
import { actionBadges, fieldChoices, previewFields } from "../catalog.ts";
import type { Theme } from "../opencode-types.ts";
import { Badge } from "./Badge.tsx";

export function ActionDetail(props: {
	theme: Theme;
	action: UiActionDescriptor;
}) {
	const fields = createMemo(() => {
		const preview = previewFields(props.action);
		return "fields" in preview ? preview.fields : undefined;
	});
	const error = createMemo(() => {
		const preview = previewFields(props.action);
		return "error" in preview ? preview.error : undefined;
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none" truncate flexGrow={1}>
					<b>{props.action.label}</b>
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
					{props.action.name}
				</text>
			</box>
			<box flexDirection="row" gap={1} flexWrap="wrap">
				<For each={actionBadges(props.action)}>
					{(badge) => (
						<Badge theme={props.theme} label={badge.label} tone={badge.tone} />
					)}
				</For>
			</box>
			<text fg={props.theme.text.muted} wrapMode="word">
				{props.action.description}
			</text>
			<box flexDirection="column" paddingTop={1} gap={1}>
				<text fg={props.theme.text.feedback.info.base}>
					<b>Inputs</b>
				</text>
				<Show
					when={fields()}
					fallback={
						<Show
							when={error()}
							fallback={
								<text fg={props.theme.text.muted}>
									None. Enter runs this capability immediately.
								</text>
							}
						>
							{(message) => (
								<text fg={props.theme.text.feedback.error.base} wrapMode="word">
									{message()}
								</text>
							)}
						</Show>
					}
				>
					{(values) => (
						<Show
							when={values().length > 0}
							fallback={
								<text fg={props.theme.text.muted}>
									None. Enter runs this capability immediately.
								</text>
							}
						>
							<For each={values()}>
								{(field) => {
									const choices = () => fieldChoices(field);
									return (
										<box flexDirection="column" gap={0}>
											<box flexDirection="row" gap={1} flexWrap="wrap">
												<text fg={props.theme.text.base} wrapMode="none">
													<b>{field.name}</b>
												</text>
												<text fg={props.theme.text.muted} wrapMode="none">
													{field.kind}
													{field.required ? " *" : ""}
												</text>
												<Show when={field.defaultValue !== undefined}>
													<text fg={props.theme.text.muted} wrapMode="none">
														default {field.defaultValue}
													</text>
												</Show>
											</box>
											<Show when={field.description}>
												<text fg={props.theme.text.muted} wrapMode="word">
													{field.description}
												</text>
											</Show>
											<Show when={choices()}>
												{(options) => (
													<text fg={props.theme.text.muted} wrapMode="word">
														one of: {options().join(", ")}
													</text>
												)}
											</Show>
										</box>
									);
								}}
							</For>
						</Show>
					)}
				</Show>
			</box>
			<box flexGrow={1} />
			<text fg={props.theme.text.muted}>
				{error()
					? "Enter opens the form; this schema is not editable."
					: fields()?.length
						? "Enter opens the form."
						: "Enter runs this capability."}
			</text>
		</box>
	);
}
