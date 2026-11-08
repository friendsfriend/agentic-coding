/** @jsxImportSource @opentui/solid */
import { For, type JSX, Show } from "solid-js";
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

/** Local original dialogue row/detail presentation, not a response editor.
 * Pairing, source projection, native status and scoped disclosure state remain
 * with the owning card. No new layout wrapper or global event listener is added. */
export function ToolDialogue(props: {
	questions: readonly SuppliedDialogueQuestion[];
	phase: "Partial generated" | "Live slot" | "Requested";
	open: (suffix: string) => boolean;
	fold: (suffix: string, label: string) => JSX.Element;
}) {
	return (
		<For each={props.questions}>
			{(question) => (
				<>
					{props.fold(
						`:question:${question.index}`,
						`${props.phase} question ${question.index + 1}`,
					)}
					<Show when={props.open(`:question:${question.index}`)}>
						<text fg={color("textMuted")} wrapMode="word">
							Supplied question bytes — not an active clarification, answer or
							approval control.
						</text>
						<text fg={color("text")} wrapMode="word">
							{question.ident === null ? "" : `[${question.ident}] `}
							{question.text ?? "Question text not supplied."}
						</text>
						<Show when={question.context !== null}>
							<text fg={color("textMuted")}>Supplied question context</text>
							<text wrapMode="word">{question.context ?? ""}</text>
						</Show>
						<Show when={question.options.length > 0}>
							<text fg={color("textMuted")} wrapMode="word">
								Supplied options — stars are recorded recommendations, not
								selected answers.
							</text>
							<For each={question.options}>
								{(option) => (
									<box flexDirection="column" flexShrink={0}>
										<text
											fg={
												option.recommended
													? color("accent")
													: color("textMuted")
											}
											wrapMode="word"
										>
											○{option.recommended ? " ★" : "  "} {option.label}
										</text>
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
													<text fg={color("textMuted")} wrapMode="word">
														{option.description ?? ""}
													</text>
												</Show>
											</box>
										</Show>
									</box>
								)}
							</For>
						</Show>
					</Show>
				</>
			)}
		</For>
	);
}
