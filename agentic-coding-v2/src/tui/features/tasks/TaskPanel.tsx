/** @jsxImportSource @opentui/solid */
import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { For, onCleanup, Show } from "solid-js";
import type { Data, TaskDetails } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";

/** Read-only native detail presentation. Action headers prepare an unsent command only. */
export function TaskPanel(props: {
	rows: Data[];
	selectedId: number | null;
	select: (id: number) => void;
	details: TaskDetails | null;
	error: string | null;
	connected: boolean;
	reviews: Data[];
	expanded: string[];
	toggle: (id: string) => void;
	prepare: (command: string) => void;
	openSession: (() => void) | null;
}) {
	const syntax = SyntaxStyle.fromStyles(
		{
			default: { fg: color("text") },
			"markup.heading": { fg: color("primary"), bold: true },
			"markup.strong": { fg: color("text"), bold: true },
			"markup.raw": { fg: color("accent") },
		},
		useRenderer().nativeScene,
	);
	onCleanup(() => syntax.destroy());
	const open = (id: string) => props.expanded.includes(id);
	const fold = (id: string, label: string) => (
		<ActionHeader onActivate={() => props.toggle(id)}>
			<text fg={color("accent")}>
				{open(id) ? "▾" : "▸"} {label}
			</text>
		</ActionHeader>
	);
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Native tasks · {props.rows.length} matching
			</text>
			<For each={props.rows}>
				{(row) => (
					<ActionHeader onActivate={() => props.select(Number(row.id))}>
						<text
							fg={
								Number(row.id) === props.selectedId
									? color("accent")
									: color("textMuted")
							}
						>
							{Number(row.id) === props.selectedId ? "›" : "·"} #
							{String(row.id)} · {String(row.skill)} · {String(row.detail)}
						</text>
					</ActionHeader>
				)}
			</For>
			<Show
				when={
					props.reviews.filter(
						(review) =>
							review.state === "pending" && review.taskId !== props.selectedId,
					).length
				}
			>
				<text fg={color("warning")}>
					Other pending native reviews (select owner to inspect)
				</text>
				<For
					each={props.reviews.filter(
						(review) =>
							review.state === "pending" && review.taskId !== props.selectedId,
					)}
				>
					{(review) => (
						<ActionHeader
							onActivate={() => props.select(Number(review.taskId))}
						>
							<text fg={color("warning")}>
								#{String(review.taskId)} · {String(review.title)} ·{" "}
								{String(review.id)}@{String(review.revision)}
							</text>
						</ActionHeader>
					)}
				</For>
			</Show>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<Show when={props.details}>
				{(details) => (
					<box
						flexDirection="column"
						gap={1}
						border={["top"]}
						borderColor={color("border")}
						paddingTop={1}
					>
						<text fg={color("primary")}>
							Task #{details().id} ·{" "}
							{props.connected
								? "last observed native detail (non-atomic)"
								: "cached detail; current activity unknown"}
						</text>
						<text fg={color("textMuted")}>
							Native status: {details().native?.status ?? "missing"} · abort
							requested: {String(details().native?.abortRequested ?? "unknown")}
						</text>
						<text wrapMode="word">
							Skill {String(details().metadata.skill)} · profile{" "}
							{String(details().metadata.profile)} · policy{" "}
							{String(details().metadata.policy)}
						</text>
						<text wrapMode="word">
							Topic {String(details().metadata.topicId)} · related task{" "}
							{String(details().metadata.relatedTo ?? "none")} · base{" "}
							{String(details().metadata.baseCommit ?? "not retained")}
						</text>
						<text wrapMode="word">
							Repository: {String(details().metadata.repository)}
							{"\n"}Workspace:{" "}
							{String(details().metadata.workspace || "not prepared")}
						</text>
						<Show when={props.openSession}>
							<ActionHeader onActivate={() => props.openSession?.()}>
								<text fg={color("accent")}>
									Open recorded native child transcript
								</text>
							</ActionHeader>
						</Show>
						<Show
							when={
								props.connected &&
								!props.error &&
								details().native &&
								details().native?.status !== "terminal"
							}
						>
							<ActionHeader
								onActivate={() => props.prepare(`/cancel ${details().id}`)}
							>
								<text fg={color("warning")}>
									Prepare cancellation command (does not submit)
								</text>
							</ActionHeader>
						</Show>
						<Show when={details().native?.outcome}>
							{(outcome) => (
								<>
									<text fg={color("primary")}>
										Recorded terminal outcome · {String(outcome().status)}
									</text>
									<Show when={typeof outcome().result === "string"}>
										<markdown
											content={String(outcome().result)}
											syntaxStyle={syntax}
											conceal={true}
										/>
									</Show>
									{fold(
										`task:${details().id}:outcome`,
										"Complete native outcome",
									)}
									<Show when={open(`task:${details().id}:outcome`)}>
										<code
											content={JSON.stringify(outcome(), null, 2)}
											filetype="json"
											syntaxStyle={syntax}
											drawUnstyledText={true}
											wrapMode="word"
										/>
									</Show>
								</>
							)}
						</Show>
						<text fg={color("primary")}>
							Reviews · {details().reviews.length}
						</text>
						<For each={details().reviews}>
							{(review) => {
								const key = `task:${details().id}:review:${String(review.id)}`;
								return (
									<box
										flexDirection="column"
										border={true}
										borderColor={
											review.state === "pending"
												? color("warning")
												: color("border")
										}
										padding={1}
										gap={1}
									>
										<text fg={color("primary")}>
											{String(review.title)} · {String(review.state)}
										</text>
										<text wrapMode="word">
											{String(review.id)}@{String(review.revision)} · path{" "}
											{String(review.path)}
											{"\n"}Immutable snapshot digest: {String(review.digest)}
										</text>
										{fold(
											`${key}:snapshot`,
											"Inspect exact immutable review snapshot",
										)}
										<Show when={open(`${key}:snapshot`)}>
											<code
												content={String(review.snapshot)}
												filetype="diff"
												syntaxStyle={syntax}
												drawUnstyledText={true}
												wrapMode="word"
											/>
										</Show>
										<Show when={Boolean(review.comments)}>
											<text wrapMode="word">
												Recorded decision comments: {String(review.comments)}
											</text>
										</Show>
										<Show
											when={
												props.connected &&
												!props.error &&
												review.state === "pending" &&
												details().native &&
												details().native?.status !== "terminal" &&
												!details().native?.abortRequested
											}
										>
											<text fg={color("textMuted")}>
												Prepare only; edit comments in the prompt, then
												explicitly submit. The backend rechecks revision and
												ownership.
											</text>
											<For each={["approve", "changes", "reject"]}>
												{(decision) => (
													<ActionHeader
														onActivate={() =>
															props.prepare(
																`/${decision} ${String(review.id)}@${String(review.revision)} `,
															)
														}
													>
														<text fg={color("accent")}>
															Prepare {decision} command
														</text>
													</ActionHeader>
												)}
											</For>
										</Show>
									</box>
								);
							}}
						</For>
						<text fg={color("primary")}>
							Retained image evidence · {details().attachments.length}
						</text>
						<For each={details().attachments}>
							{(item) => (
								<box flexDirection="column" paddingLeft={1}>
									<text wrapMode="word">
										{item.caption} · {item.mediaType} · owner #{item.taskId}
									</text>
									<text fg={color("textMuted")} wrapMode="word">
										Content identity: {item.id}
										{"\n"}Image pixels are not rendered by this terminal client;
										metadata is not visual proof. No arbitrary file or external
										URL is opened.
									</text>
								</box>
							)}
						</For>
						{fold(
							`task:${details().id}:metadata`,
							"Complete retained task metadata",
						)}
						<Show when={open(`task:${details().id}:metadata`)}>
							<code
								content={JSON.stringify(details().metadata, null, 2)}
								filetype="json"
								syntaxStyle={syntax}
								drawUnstyledText={true}
								wrapMode="word"
							/>
						</Show>
					</box>
				)}
			</Show>
		</box>
	);
}
