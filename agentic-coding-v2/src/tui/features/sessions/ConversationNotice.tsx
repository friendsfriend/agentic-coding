/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { Data, Session } from "../../../protocol/index.ts";
import type { Review } from "../../../state.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";
import { HumanInteractionCard } from "./HumanInteractionCard.tsx";

/** Navigation only. Human authority stays in the exact snapshot-bound submit. */
export function ConversationNotice(props: {
	session: Session | undefined;
	owner: Session | undefined;
	reviews: Data[];
	fresh: boolean;
	openSession: (id: number) => void;
	jump: (review: Data) => void;
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
					<box flexDirection="column">
						<ActionHeader
							scope={`${review.id}:${review.revision}`}
							onActivate={() => props.jump(review)}
						>
							<text fg={color("warning")} wrapMode="word">
								{props.fresh ? "Awaiting you" : "Last observed input needed"} ·{" "}
								{String(review.title)} · jump to requesting transcript/card
							</text>
						</ActionHeader>
						<Show
							when={
								!review.callId &&
								(review.conversationId === props.session?.id ||
									review.taskId === props.session?.task)
							}
						>
							<text fg={color("textMuted")}>
								Legacy request · exact call location was not retained. Recovered
								human controls; no review kind inferred.
							</text>
							<HumanInteractionCard request={review as Review} />
						</Show>
					</box>
				)}
			</For>
		</box>
	);
}
