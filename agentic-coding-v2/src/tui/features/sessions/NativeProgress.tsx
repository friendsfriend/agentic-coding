/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js";
import type { Progress } from "../../../protocol/index.ts";
import { Stamp } from "../../presentation/components/Stamp.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";

const summary = (value: unknown) => {
	const points = Array.from(JSON.stringify(value) ?? "(not supplied)");
	return points.slice(0, 160).join("") + (points.length > 160 ? "…" : "");
};

/** Already supplied progress only. Native times are recorded scheduling fields,
 * never countdowns, execution evidence, child adoption or retry controls. */
export function NativeProgress(props: {
	value: Progress;
	scope: unknown;
	interactive: boolean;
}) {
	const source = createMemo(() => ({ scope: props.scope, value: props.value }));
	return (
		<box flexDirection="column">
			<text fg={color("textMuted")} wrapMode="word">
				{props.value.run
					? `Native run task #${props.value.run.taskId} · ${props.value.run.inputs.length} recorded input IDs`
					: "No native run recorded in this observation"}{" "}
				· queued inputs {props.value.inbox.length}
			</text>
			<Show when={props.value.run}>
				{(run) => (
					<SuppliedObservation
						interactive={props.interactive}
						scope={source()}
						label="Supplied native run and input identities; not child targets or completion evidence"
						value={run()}
					/>
				)}
			</Show>
			<Show when={props.value.generation}>
				{(generation) => (
					<>
						<text fg={color("textMuted")}>
							Native generation · attempt {generation().attempt} · committed
							partials only
						</text>
						<Show when={generation().retry}>
							{(retry) => (
								<box flexDirection="column">
									<box flexDirection="row">
										<text fg={color("textMuted")} flexGrow={1}>
											Native retry scheduling observation (not execution)
										</text>
										<Stamp
											timestamp={retry().at}
											clockLabel="retry scheduled"
										/>
									</box>
									<SuppliedObservation
										interactive={props.interactive}
										scope={source()}
										label="Complete supplied retry/error fields; recorded epoch milliseconds, no inferred elapsed time"
										value={retry()}
									/>
								</box>
							)}
						</Show>
						<Show when={generation().deferred}>
							{(deferred) => (
								<box flexDirection="column">
									<box flexDirection="row">
										<text fg={color("textMuted")} flexGrow={1}>
											Native deferred poll observation (not readiness)
										</text>
										<Stamp
											timestamp={deferred().pollAt}
											clockLabel="poll scheduled"
										/>
									</box>
									<SuppliedObservation
										interactive={props.interactive}
										scope={source()}
										label="Complete supplied deferred scheduling fields; no UI polling or inferred completion"
										value={deferred()}
									/>
								</box>
							)}
						</Show>
					</>
				)}
			</Show>
			<SuppliedRecordWindow
				rows={props.value.compactions}
				scope={source()}
				interactive={props.interactive}
				label="native compaction observations"
				title={(row) => `Compaction task #${String(row.taskId)}`}
				search={(row) => JSON.stringify(row)}
			>
				{(item) => (
					<box flexDirection="column">
						<text fg={color("textMuted")} wrapMode="word">
							Native compaction #{summary(item.taskId)} · {summary(item.reason)}{" "}
							· attempt {summary(item.attempt)}
						</text>
						<SuppliedObservation
							interactive={props.interactive}
							scope={source()}
							label="Complete native compaction observation; reason/retry data does not prove adoption or completion"
							value={item}
						/>
					</box>
				)}
			</SuppliedRecordWindow>
			<Show when={props.value.compactionFailure}>
				{(failure) => (
					<box flexDirection="column">
						<text fg={color("warning")}>
							Native compaction failure recorded
						</text>
						<SuppliedObservation
							interactive={props.interactive}
							scope={source()}
							label="Native compaction failure observation; supplied fields, not a recovery command"
							value={failure()}
						/>
					</box>
				)}
			</Show>
			<SuppliedRecordWindow
				rows={props.value.inbox}
				scope={source()}
				interactive={props.interactive}
				label="native queued input observations"
				title={(row) => `Submission #${row.id} · ${row.mode}`}
				search={(row) => JSON.stringify(row)}
			>
				{(item) => (
					<SuppliedObservation
						interactive={props.interactive}
						scope={source()}
						label="Native queued submission observation; not a conversation ID, restore command or placement acknowledgement"
						value={item}
					/>
				)}
			</SuppliedRecordWindow>
		</box>
	);
}
