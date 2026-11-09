/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js";
import type { Progress } from "../../../protocol/index.ts";
import { Stamp } from "../../presentation/components/Stamp.tsx";
import { DetailsFold } from "../../ui/DetailsFold.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";

/** Already supplied progress only. The page shows what is happening; the
 * supplied records behind each line stay folded until asked for. */
export function NativeProgress(props: {
	value: Progress;
	scope: unknown;
	interactive: boolean;
}) {
	const source = createMemo(() => ({ scope: props.scope, value: props.value }));
	// Nothing to report is reported as nothing: an idle session keeps no
	// progress chrome in the transcript.
	const present = () =>
		props.value.run != null ||
		props.value.generation != null ||
		(props.value.compactions?.length ?? 0) > 0 ||
		(props.value.inbox?.length ?? 0) > 0 ||
		props.value.compactionFailure != null;
	return (
		<Show when={present()}>
			<box flexDirection="column">
				<text fg={color("textMuted")} wrapMode="word">
					{props.value.run
						? `Run #${props.value.run.taskId} · ${props.value.run.inputs.length} inputs`
						: "No run recorded"}{" "}
					· {props.value.inbox.length} queued
				</text>
				<Show when={props.value.run}>
					{(run) => (
						<DetailsFold
							interactive={props.interactive}
							scope={source()}
							label="Run details"
							summary={`${run().inputs.length} input IDs`}
						>
							<SuppliedObservation
								interactive={props.interactive}
								scope={source()}
								label="Supplied native run and input identities; not child targets or completion evidence"
								value={run()}
							/>
						</DetailsFold>
					)}
				</Show>
				<Show when={props.value.generation}>
					{(generation) => (
						<>
							<text fg={color("textMuted")}>
								Attempt {generation().attempt} · committed partials only
							</text>
							<Show when={generation().retry}>
								{(retry) => (
									<box flexDirection="row">
										<box flexGrow={1} minWidth={0}>
											<DetailsFold
												interactive={props.interactive}
												scope={source()}
												label="Retry scheduled"
												summary="supplied scheduling fields"
											>
												<SuppliedObservation
													interactive={props.interactive}
													scope={source()}
													label="Complete supplied retry/error fields; recorded epoch milliseconds, no inferred elapsed time"
													value={retry()}
												/>
											</DetailsFold>
										</box>
										<Stamp
											timestamp={retry().at}
											clockLabel="retry scheduled"
										/>
									</box>
								)}
							</Show>
							<Show when={generation().deferred}>
								{(deferred) => (
									<box flexDirection="row">
										<box flexGrow={1} minWidth={0}>
											<DetailsFold
												interactive={props.interactive}
												scope={source()}
												label="Poll deferred"
												summary="supplied poll fields"
											>
												<SuppliedObservation
													interactive={props.interactive}
													scope={source()}
													label="Complete supplied deferred scheduling fields; no UI polling or inferred completion"
													value={deferred()}
												/>
											</DetailsFold>
										</box>
										<Stamp
											timestamp={deferred().pollAt}
											clockLabel="poll scheduled"
										/>
									</box>
								)}
							</Show>
						</>
					)}
				</Show>
				<Show when={props.value.compactions.length > 0}>
					<DetailsFold
						interactive={props.interactive}
						scope={source()}
						label="Compactions"
						summary={`${props.value.compactions.length} recorded`}
					>
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
										Compaction #{String(item.taskId)} · {String(item.reason)} ·
										attempt {String(item.attempt)}
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
					</DetailsFold>
				</Show>
				<Show when={props.value.compactionFailure}>
					{(failure) => (
						<box flexDirection="column">
							<text fg={color("warning")}>Compaction failed</text>
							<DetailsFold
								interactive={props.interactive}
								scope={source()}
								label="Failure details"
								summary="supplied fields"
							>
								<SuppliedObservation
									interactive={props.interactive}
									scope={source()}
									label="Native compaction failure observation; supplied fields, not a recovery command"
									value={failure()}
								/>
							</DetailsFold>
						</box>
					)}
				</Show>
				<Show when={props.value.inbox.length > 0}>
					<DetailsFold
						interactive={props.interactive}
						scope={source()}
						label="Queued inputs"
						summary={`${props.value.inbox.length} waiting`}
					>
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
					</DetailsFold>
				</Show>
			</box>
		</Show>
	);
}
