/** @jsxImportSource @opentui/solid */
import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, onCleanup, Show } from "solid-js";
import type { Data, SkillDocument } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { DetailsFold } from "../../ui/DetailsFold.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";
import { SuppliedCode } from "../sessions/SuppliedCode.tsx";
export function SkillPanel(props: {
	rows: Data[];
	catalog: Data[];
	selected: (row: Data, index: number) => boolean;
	select: (row: Data, index: number) => void;
	document: SkillDocument | null;
	error: string | null;
	connected: boolean;
	fresh: boolean;
	prepare: (command: string) => void;
	discuss: (id: string, revision: string) => void;
}) {
	const syntax = SyntaxStyle.fromStyles(
		{ default: { fg: color("text") } },
		useRenderer().nativeScene,
	);
	let disposed = false;
	onCleanup(() => {
		disposed = true;
		syntax.destroy();
	});
	const source = createMemo(() => ({
		rows: props.rows,
		catalog: props.catalog,
		document: props.document,
		connected: props.connected,
		fresh: props.fresh,
		error: props.error,
	}));
	const member = (row: Data) =>
		!disposed &&
		props.rows.some((entry) => entry === row) &&
		props.catalog.filter((entry) => entry.id === row.id).length === 1 &&
		props.catalog.some(
			(entry) => entry.id === row.id && entry.revision === row.revision,
		);
	const safe = (row: Data) =>
		member(row) &&
		typeof row.id === "string" &&
		row.id.length > 0 &&
		row.id.length <= 128 &&
		!/\s/.test(row.id) &&
		Array.from(row.id).every(
			(char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
		) &&
		typeof row.revision === "string" &&
		/^[a-f0-9]{64}$/.test(row.revision);
	const ready = (row: Data) =>
		safe(row) && props.connected && props.fresh && !props.error;
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>Skills · {props.rows.length}</text>
			<text wrapMode="word" fg={color("textMuted")}>
				Instructions the running host loaded · read-only
			</text>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<Show when={!props.connected || !props.fresh}>
				<text fg={color("warning")}>Disconnected · showing the last read</text>
			</Show>
			<Show when={!props.rows.length && !props.error}>
				<text fg={color("textMuted")}>No skills match the filter.</text>
			</Show>
			<SuppliedRecordWindow
				rows={props.rows}
				scope={source()}
				label="loaded skill observations"
				title={(row) =>
					`${String(row.id)} · ${String(row.origin)} · ${String(row.description)}`
				}
				search={(row) => JSON.stringify(row)}
				selected={props.selected}
				pick={(row, index) => {
					if (!member(row)) return false;
					props.select(row, index);
					return true;
				}}
			>
				{(row, index) => {
					const document = createMemo(() =>
						member(row) &&
						props.document?.id === row.id &&
						props.document?.revision === row.revision
							? props.document
							: null,
					);
					return (
						<box
							flexDirection="column"
							backgroundColor={
								props.selected(row, index())
									? color("backgroundPanel")
									: color("background")
							}
						>
							<ActionHeader
								scope={source()}
								interactive={member(row)}
								onActivate={() => {
									if (member(row)) props.select(row, index());
								}}
							>
								<text fg={color("primary")}>
									{props.selected(row, index()) ? "▾" : "▸"} {String(row.id)} ·{" "}
									{String(row.origin)}
								</text>
							</ActionHeader>
							<Show when={props.selected(row, index())}>
								<text wrapMode="word">{String(row.description)}</text>
								<text wrapMode="word" fg={color("textMuted")}>
									{String(row.revision)}
									{row.readOnly === true ? " · read-only tasks" : ""}
								</text>
								<Show when={!safe(row)}>
									<text fg={color("warning")}>
										Identity or revision is missing or ambiguous · unavailable
									</text>
								</Show>
								<Show when={ready(row)}>
									<ActionHeader
										scope={source()}
										interactive={ready(row)}
										onActivate={() => {
											if (ready(row))
												props.prepare(
													`/skill ${String(row.id)}@${String(row.revision)}`,
												);
										}}
									>
										<text fg={color("accent")}>Read instructions</text>
									</ActionHeader>
									<ActionHeader
										scope={source()}
										interactive={ready(row)}
										onActivate={() => {
											if (ready(row))
												props.discuss(String(row.id), String(row.revision));
										}}
									>
										<text fg={color("accent")}>Discuss in orchestrator</text>
									</ActionHeader>
								</Show>
								<Show when={document()} keyed>
									{(saved) => (
										<box flexDirection="column" gap={1}>
											<text fg={color("textMuted")}>
												Loaded instructions · untrusted text, nothing executes
											</text>
											<SuppliedCode
												content={saved.content}
												identity={`loaded-skill:${saved.id}:${saved.revision}`}
												filetype="markdown"
												syntax={syntax}
											/>
										</box>
									)}
								</Show>
								<DetailsFold
									label="Descriptor"
									summary="supplied fields"
									scope={source()}
								>
									<SuppliedObservation
										value={row}
										scope={source()}
										label="Skill descriptor"
									/>
								</DetailsFold>
							</Show>
						</box>
					);
				}}
			</SuppliedRecordWindow>
		</box>
	);
}
