/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { Data, Session } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";

/** Observed state, not permission: navigation opens the exact owner/review and
 * native admission/decision checks remain authoritative. Never submits a draft. */
export function ConversationNotice(props: {
	session: Session | undefined;
	owner: Session | undefined;
	reviews: Data[];
	fresh: boolean;
	openSession: (id: number) => void;
	openTask: (id: number) => void;
}) {
	return (
		<box flexDirection="column">
			<Show when={props.session && !props.session.writable}>
				<text fg={color("warning")} wrapMode="word">
					Read-only task transcript. Its task ended or was cancelled; follow up
					in its owning conversation. Your draft stays here unsent.
				</text>
				<Show when={props.owner}>
					{(owner) => (
						<ActionHeader
							scope={`${props.session?.id}:${owner().id}`}
							interactive={props.fresh}
							onActivate={() => props.openSession(owner().id)}
						>
							<text fg={color("accent")}>
								Open owning conversation #{owner().id} to follow up
							</text>
						</ActionHeader>
					)}
				</Show>
			</Show>
			<For each={props.reviews}>
				{(review) => (
					<box
						flexDirection="column"
						border={["left"]}
						borderColor={color("warning")}
						paddingLeft={1}
					>
						<text fg={color("warning")} wrapMode="word">
							Last observed: human review pending · request_review waits for
							your decision, not a model response.
						</text>
						<ActionHeader
							scope={`${props.session?.id}:${review.id}:${review.revision}`}
							interactive={props.fresh}
							onActivate={() => {
								const task = props.session?.task;
								if (typeof task === "number" && task === review.taskId)
									props.openTask(task);
							}}
						>
							<text fg={color("accent")}>
								Inspect {String(review.id)} · task #{String(review.taskId)} ·
								then approve, reject or request changes
							</text>
						</ActionHeader>
					</box>
				)}
			</For>
		</box>
	);
}
