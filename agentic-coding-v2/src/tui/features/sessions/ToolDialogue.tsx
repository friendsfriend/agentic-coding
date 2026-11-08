/** @jsxImportSource @opentui/solid */
import { type JSX, Show } from "solid-js";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";

/** Narrow UI-only supplied bytes. No native question/result/authority identity. */
export type SuppliedDialogueQuestion = {
	readonly index: number;
	readonly ident: string | null;
	readonly text: string | null;
	readonly context: string | null;
	readonly options: readonly {
		readonly index: number;
		readonly label: string;
		readonly recommended: boolean;
		readonly description: string | null;
	}[];
};

/** Original passive question/option folds, with bounded local record and source
 * windows. Native arguments remain the complete, unprojected observation. */
export function ToolDialogue(props: {
	questions: readonly SuppliedDialogueQuestion[];
	scope: unknown;
	interactive?: boolean;
	phase: "Partial generated" | "Live slot" | "Requested";
	open: (suffix: string) => boolean;
	fold: (suffix: string, label: string) => JSX.Element;
}) {
	return (
		<Show when={props.questions.length > 0}>
			<SuppliedRecordWindow
				interactive={props.interactive}
				rows={props.questions}
				scope={props.scope}
				label="supplied dialogue questions"
				title={(question) =>
					`${props.phase} question ${question.index + 1} · ${question.text ?? "no textual question projected"}`
				}
				search={(question) => JSON.stringify(question)}
			>
				{(question) => (
					<>
						{props.fold(
							`:question:${question.index}`,
							`${props.phase} question ${question.index + 1}`,
						)}
						<Show when={props.open(`:question:${question.index}`)}>
							<text fg={color("textMuted")} wrapMode="word">
								Supplied question bytes — not an active clarification, answer or
								approval control. Projection is not original schema; complete
								native arguments remain separately inspectable.
							</text>
							<Show when={question.ident !== null}>
								<SuppliedObservation
									interactive={props.interactive}
									value={question.ident}
									scope={props.scope}
									label="Supplied question identifier text; never a routed clarification target"
								/>
							</Show>
							<Show
								when={question.text !== null}
								fallback={
									<text fg={color("textMuted")}>
										No textual question projected; inspect complete arguments.
									</text>
								}
							>
								<SuppliedObservation
									interactive={props.interactive}
									value={question.text}
									scope={props.scope}
									label="Exact supplied question text (empty remains empty)"
								/>
							</Show>
							<Show when={question.context !== null}>
								<SuppliedObservation
									interactive={props.interactive}
									value={question.context}
									scope={props.scope}
									label="Exact supplied question context"
								/>
							</Show>
							<Show when={question.options.length > 0}>
								<text fg={color("textMuted")} wrapMode="word">
									Supplied options — stars are recorded recommendations, never
									selected answers. Ordinals are local display carriers only.
								</text>
								<SuppliedRecordWindow
									interactive={props.interactive}
									rows={question.options}
									scope={props.scope}
									label="supplied dialogue options"
									title={(option) => `${option.index + 1}. ${option.label}`}
									search={(option) => JSON.stringify(option)}
								>
									{(option) => (
										<box flexDirection="column" flexShrink={0}>
											<text
												fg={
													option.recommended
														? color("accent")
														: color("textMuted")
												}
											>
												○{option.recommended ? " ★" : "  "}{" "}
												{Array.from(option.label.replace(/\s+/g, " "))
													.slice(0, 200)
													.join("")}
												{Array.from(option.label.replace(/\s+/g, " ")).length >
												200
													? "…"
													: ""}
											</text>
											<SuppliedObservation
												interactive={props.interactive}
												value={option.label}
												scope={props.scope}
												label="Exact supplied option label"
											/>
											<Show when={option.description !== null}>
												<box
													paddingLeft={2}
													flexShrink={0}
													flexDirection="column"
												>
													{props.fold(
														`:question:${question.index}:option:${option.index}`,
														"Option description",
													)}
													<Show
														when={props.open(
															`:question:${question.index}:option:${option.index}`,
														)}
													>
														<SuppliedObservation
															interactive={props.interactive}
															value={option.description}
															scope={props.scope}
															label="Exact supplied option description"
														/>
													</Show>
												</box>
											</Show>
										</box>
									)}
								</SuppliedRecordWindow>
							</Show>
						</Show>
					</>
				)}
			</SuppliedRecordWindow>
		</Show>
	);
}
