/** @jsxImportSource @opentui/solid */
import { createHash } from "node:crypto";
import { createMemo, For, onCleanup, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";
export function ProviderPanel(props: {
	rows: Data[];
	catalog: Data[];
	selected: (row: Data, index: number) => boolean;
	select: (row: Data, index: number) => void;
	connected: boolean;
	fresh: boolean;
	error: string | null;
	inspection: Data | null;
	expanded: string[];
	toggle: (key: string) => void;
	prepare: (command: string) => void;
}) {
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const registry = createMemo(() => ({
		rows: props.rows,
		catalog: props.catalog,
		connected: props.connected,
		fresh: props.fresh,
		error: props.error,
	}));
	const member = (provider: Data) =>
		!disposed &&
		props.rows.some((row) => row === provider) &&
		props.catalog.filter((row) => row.name === provider.name).length === 1;
	const safe = (provider: Data) =>
		member(provider) &&
		typeof provider.name === "string" &&
		provider.name.length > 0 &&
		provider.name.length <= 64 &&
		!/\s/.test(provider.name) &&
		Array.from(provider.name).every(
			(char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
		);
	const ready = (provider: Data) =>
		safe(provider) &&
		props.connected &&
		props.fresh &&
		!props.error &&
		provider.has_token === true;
	const selectedName = () => {
		const matches = props.rows.filter(props.selected);
		return matches.length === 1 && matches[0] && member(matches[0])
			? matches[0].name
			: null;
	};
	const summary = (value: unknown, maximum = 200) => {
		const units = Array.from(String(value).replace(/\s+/g, " "));
		return `${units.slice(0, maximum).join("")}${units.length > maximum ? "…" : ""}`;
	};
	const title = (item: Data) =>
		summary(
			item.title ??
				item.full_name ??
				item.path_with_namespace ??
				item.path ??
				item.name ??
				item.id ??
				item.sha ??
				"Record",
		);
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Configured native providers · {props.rows.length} matching
			</text>
			<text fg={color("textMuted")}>
				Registry is local configuration/token presence, not authentication or
				reachability proof. No outbound request on navigation, reconnect, local
				range search or viewpoint restoration.
			</text>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<Show when={!props.connected || !props.fresh}>
				<text fg={color("warning")}>
					Cached/disconnected registry and inspection; no read-command
					preparation. Local observations do not establish current upstream
					state.
				</text>
			</Show>
			<SuppliedRecordWindow
				rows={props.rows}
				scope={registry()}
				label="configured provider records"
				title={(provider) =>
					`${String(provider.name)} · ${String(provider.type)} · ${String(provider.baseUrl)}`
				}
				search={(provider) => JSON.stringify(provider)}
				selected={props.selected}
				pick={(provider, index) => {
					if (!member(provider)) return false;
					props.select(provider, index);
					return true;
				}}
			>
				{(provider, index) => (
					<box
						flexDirection="column"
						border={true}
						borderColor={
							props.selected(provider, index())
								? color("accent")
								: color("border")
						}
						padding={1}
						gap={1}
					>
						<ActionHeader
							scope={registry()}
							interactive={member(provider)}
							onActivate={() => {
								if (member(provider)) props.select(provider, index());
							}}
						>
							<text fg={color("primary")}>
								{props.selected(provider, index()) ? "▾" : "▸"}{" "}
								{String(provider.name)} · {String(provider.type)} · token{" "}
								{provider.has_token === true ? "present" : "missing"}
							</text>
						</ActionHeader>
						<Show when={props.selected(provider, index())}>
							<text wrapMode="word">
								Configured origin {String(provider.baseUrl)} · username{" "}
								{String(provider.username || "not configured")}
							</text>
							<text fg={color("textMuted")}>
								Tokens are never displayed/persisted in viewpoints. Writes need
								a separate sealed operator intention and manual digest
								confirmation. Inspections never approve or dispatch writes.
							</text>
							<Show when={!safe(provider)}>
								<text fg={color("warning")}>
									Missing/ambiguous/unsafe provider identity; command generation
									withheld.
								</text>
							</Show>
							<Show when={ready(provider)}>
								<text fg={color("textMuted")}>
									Prepare a read command, edit placeholders and explicitly
									submit:
								</text>
								<For
									each={[
										"repos QUERY",
										"branches REPO",
										"changes REPO open",
										"change REPO NUMBER",
										"files REPO NUMBER",
										"versions REPO NUMBER",
										"discussions REPO NUMBER",
										"issues REPO open",
										"issue REPO NUMBER",
										"jobs REPO RUN_ID",
										"labels REPO",
										"collaborators REPO",
									]}
								>
									{(query) => (
										<ActionHeader
											scope={registry()}
											interactive={ready(provider)}
											onActivate={() => {
												if (ready(provider))
													props.prepare(
														`/provider ${String(provider.name)} ${query}`,
													);
											}}
										>
											<text fg={color("accent")}>{query}</text>
										</ActionHeader>
									)}
								</For>
							</Show>
						</Show>
					</box>
				)}
			</SuppliedRecordWindow>
			<Show when={props.inspection} keyed>
				{(saved) => {
					const current = () => !disposed && props.inspection === saved;
					const source = createMemo(() => [saved, registry(), props.expanded]);
					const records = Array.isArray(saved.value)
						? dataList(saved.value)
						: saved.value && typeof saved.value === "object"
							? [saved.value as Data]
							: [];
					const fingerprint = createHash("sha256")
						.update(JSON.stringify(saved))
						.digest("hex");
					const recordKey = (index: number) =>
						`provider-inspection:${fingerprint}:row:${index}`;
					return (
						<box flexDirection="column" gap={1}>
							<text fg={color("primary")}>
								Retained explicit inspection · {String(saved.provider)} ·{" "}
								{String(saved.operation)}
							</text>
							<text fg={color("textMuted")}>
								Cached response, never refreshed/replayed automatically. Lists
								may reflect upstream page limits; absent/empty patches never
								prove no changes. URLs remain inert.
							</text>
							<Show when={saved.provider !== selectedName()}>
								<text fg={color("warning")}>
									Retained response belongs to another/missing provider
									selection, never substituted for the selected registry owner.
								</text>
							</Show>
							<text wrapMode="word">
								Received locally {String(saved.receivedAt ?? "not recorded")}{" "}
								(epoch ms, not upstream revision).
							</text>
							<SuppliedObservation
								value={saved.input}
								scope={saved}
								label="Supplied explicit read arguments"
							/>
							<ActionHeader
								scope={source()}
								interactive={current()}
								onActivate={() => {
									if (current())
										props.toggle(`provider-inspection:${fingerprint}:value`);
								}}
							>
								<text fg={color("accent")}>
									{props.expanded.includes(
										`provider-inspection:${fingerprint}:value`,
									)
										? "▾"
										: "▸"}{" "}
									Inspect complete returned value separately from record
									summaries
								</text>
							</ActionHeader>
							<Show
								when={props.expanded.includes(
									`provider-inspection:${fingerprint}:value`,
								)}
							>
								<SuppliedObservation
									value={saved.value}
									scope={saved}
									label="Complete supplied returned value; serialized fields, not original upstream bytes"
								/>
							</Show>
							<SuppliedRecordWindow
								rows={records}
								scope={saved}
								label="provider response records"
								title={title}
								search={(item) => JSON.stringify(item)}
								pick={(_item, index) => {
									if (!current()) return false;
									const key = recordKey(index);
									if (!props.expanded.includes(key)) props.toggle(key);
									return true;
								}}
							>
								{(item, index) => (
									<box flexDirection="column" gap={1} paddingLeft={1}>
										<ActionHeader
											scope={source()}
											interactive={current()}
											onActivate={() => {
												if (current()) props.toggle(recordKey(index()));
											}}
										>
											<text fg={color("primary")}>
												{props.expanded.includes(recordKey(index()))
													? "▾"
													: "▸"}{" "}
												{title(item)} ·{" "}
												{summary(item.state ?? item.status ?? "", 80)}
											</text>
										</ActionHeader>
										<Show when={props.expanded.includes(recordKey(index()))}>
											<Show when={typeof item.patch === "string"}>
												<Show
													when={item.patch !== ""}
													fallback={
														<text fg={color("textMuted")}>
															Native empty patch; not proof of upstream omission
															or lack of changes.
														</text>
													}
												>
													<SuppliedObservation
														value={item.patch}
														filetype="diff"
														scope={saved}
														label="Exact supplied native patch (token-masked); window-local syntax only"
													/>
												</Show>
											</Show>
											<SuppliedObservation
												value={item}
												scope={saved}
												label="Complete supplied response record; serialized fields, not original bytes"
											/>
										</Show>
									</box>
								)}
							</SuppliedRecordWindow>
							<Show when={!records.length}>
								<SuppliedObservation
									value={saved.value}
									scope={saved}
									label="Supplied non-record/empty response; missing, null, scalar and empty remain distinct"
								/>
							</Show>
						</box>
					);
				}}
			</Show>
		</box>
	);
}
