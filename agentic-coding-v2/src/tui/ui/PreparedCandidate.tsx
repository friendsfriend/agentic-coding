/** @jsxImportSource @opentui/solid */
import { createMemo, onCleanup, Show } from "solid-js";
import { ActionHeader } from "./ActionHeader.tsx";
import { SuppliedObservation } from "./SuppliedObservation.tsx";
import { color } from "./theme/index.ts";
/** Read-only sealed source and an UNSENT placeholder. No approval value is
 * generated, no native operation is called, and UI validity is not authority. */
export function PreparedCandidate(props: {
	candidate: {
		id: string;
		snapshot: string;
		digest: string;
		expiresAt: number;
	} | null;
	scope: unknown;
	ready: boolean;
	label: string;
	metadata?: unknown;
	prepare: (id: string) => void;
}) {
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const source = createMemo(() => ({
		candidate: props.candidate,
		scope: props.scope,
		ready: props.ready,
	}));
	return (
		<Show when={props.candidate} keyed>
			{(saved) => {
				const valid = () =>
					!disposed &&
					props.ready &&
					props.candidate === saved &&
					typeof saved.id === "string" &&
					/^[a-zA-Z0-9-]{1,128}$/.test(saved.id) &&
					/^[a-f0-9]{64}$/.test(saved.digest) &&
					Number.isSafeInteger(saved.expiresAt) &&
					saved.expiresAt > Date.now();
				return (
					<box flexDirection="column" gap={1}>
						<text fg={color("primary")}>
							{props.label} · immutable candidate {saved.id}
						</text>
						<text wrapMode="word">
							Native snapshot digest {saved.digest} · expires {saved.expiresAt}{" "}
							(epoch ms)
						</text>
						<Show when={props.metadata !== undefined}>
							<SuppliedObservation
								value={props.metadata}
								scope={source()}
								label="Supplied candidate metadata; not current authority"
							/>
						</Show>
						<SuppliedObservation
							value={saved.snapshot}
							scope={source()}
							filetype="json"
							label="Exact supplied sealed snapshot"
						/>
						<text fg={color("warning")}>
							Inspect the immutable snapshot and manually type approve:DIGEST.
							Preparation supplies a placeholder only, never approval.
							Editing/navigation/refresh/disconnect withdraw confirmation;
							native ownership, revision, expiry and exact approval checks
							remain final. No automatic dispatch or retry.
						</text>
						<Show when={valid()}>
							<ActionHeader
								scope={source()}
								interactive={valid()}
								onActivate={() => {
									if (valid()) props.prepare(saved.id);
								}}
							>
								<text fg={color("accent")}>
									Prepare apply command with manual confirmation placeholder
									only
								</text>
							</ActionHeader>
						</Show>
					</box>
				);
			}}
		</Show>
	);
}
