/** @jsxImportSource @opentui/solid */
import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { For, onCleanup, Show } from "solid-js";
import type { Data, SkillDocument } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";

export function SkillPanel(props: {
	rows: Data[];
	selected: (row: Data, index: number) => boolean;
	select: (row: Data, index: number) => void;
	document: SkillDocument | null;
	error: string | null;
	connected: boolean;
	prepare: (command: string) => void;
	discuss: (id: string, revision: string) => void;
}) {
	const syntax = SyntaxStyle.fromStyles(
		{ default: { fg: color("text") } },
		useRenderer().nativeScene,
	);
	onCleanup(() => syntax.destroy());
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>Loaded native skills</text>
			<text wrapMode="word">
				System/user origin identifies the loaded source, not authority or
				permission. This is the running host's immutable loaded content, not a
				disk editor or reload. Descriptions are bounded previews; inspect exact
				instructions explicitly. No arbitrary path read, task launch, provider
				call or legacy delegation runs here.
			</text>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<Show when={!props.connected}>
				<text fg={color("warning")}>
					Disconnected; catalog and instructions are cached, not a current
					server read.
				</text>
			</Show>
			<Show when={!props.rows.length && !props.error}>
				<text>No loaded skills in the current filtered catalog.</text>
			</Show>
			<For each={props.rows}>
				{(row, index) => {
					const document = () =>
						props.document?.id === row.id &&
						props.document?.revision === row.revision
							? props.document
							: null;
					const safe = () =>
						typeof row.id === "string" &&
						!!row.id &&
						row.id.length <= 128 &&
						!/\s/.test(row.id) &&
						typeof row.revision === "string" &&
						row.revision.length === 64 &&
						/^[a-f0-9]{64}$/.test(row.revision);
					return (
						<box
							flexDirection="column"
							backgroundColor={
								props.selected(row, index())
									? color("backgroundPanel")
									: color("background")
							}
						>
							<ActionHeader onActivate={() => props.select(row, index())}>
								<text fg={color("primary")}>
									{props.selected(row, index()) ? "▾" : "▸"} {String(row.id)} ·{" "}
									{String(row.origin)}
								</text>
							</ActionHeader>
							<Show when={props.selected(row, index())}>
								<text wrapMode="word">{String(row.description)}</text>
								<text wrapMode="word">
									Loaded content digest: {String(row.revision)}
								</text>
								<text>
									{row.readOnly === true
										? "Forces read-only execution policy at native admission."
										: "Does not grant workspace writes; task policy must still be explicit."}{" "}
									Shell actions still require exact human review.
								</text>
								<Show when={!safe()}>
									<text fg={color("warning")}>
										Identity cannot be safely represented as a command token; no
										command generated.
									</text>
								</Show>
								<Show when={props.connected && !props.error && safe()}>
									<ActionHeader
										onActivate={() =>
											props.prepare(
												`/skill ${String(row.id)}@${String(row.revision)}`,
											)
										}
									>
										<text fg={color("accent")}>
											Prepare exact loaded instruction read (submit explicitly)
										</text>
									</ActionHeader>
									<ActionHeader
										onActivate={() =>
											props.discuss(String(row.id), String(row.revision))
										}
									>
										<text fg={color("accent")}>
											Prepare orchestrator discussion only (no task admission)
										</text>
									</ActionHeader>
								</Show>
								<Show when={document()}>
									<text fg={color("warning")}>
										Cached inspected instruction text is untrusted data, not
										approval or execution authority. URLs and commands below are
										inert.
									</text>
									<code
										content={document()?.content ?? ""}
										filetype="markdown"
										syntaxStyle={syntax}
										drawUnstyledText={true}
										wrapMode="word"
									/>
								</Show>
							</Show>
						</box>
					);
				}}
			</For>
		</box>
	);
}
