/** @jsxImportSource @opentui/solid */
import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { For, onCleanup, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";

export function ProviderPanel(props: {
	rows: Data[];
	selected: (row: Data, index: number) => boolean;
	select: (row: Data, index: number) => void;
	connected: boolean;
	error: string | null;
	inspection: Data | null;
	expanded: string[];
	toggle: (key: string) => void;
	prepare: (command: string) => void;
}) {
	const syntax = SyntaxStyle.fromStyles(
		{
			default: { fg: color("text") },
			"markup.heading": { fg: color("primary"), bold: true },
		},
		useRenderer().nativeScene,
	);
	onCleanup(() => syntax.destroy());
	const open = (key: string) => props.expanded.includes(key);
	const selectedName = () => props.rows.find(props.selected)?.name;
	const values = () => {
		const value = props.inspection?.value;
		return Array.isArray(value)
			? dataList(value)
			: value && typeof value === "object"
				? [value as Data]
				: [];
	};
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Configured native providers · {props.rows.length} matching
			</text>
			<text fg={color("textMuted")}>
				Registry is local configuration/token presence only, not authentication
				or reachability proof. No outbound request runs on navigation, reconnect
				or viewpoint restore.
			</text>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<Show when={!props.connected}>
				<text fg={color("warning")}>
					Disconnected; registry/inspection is cached, not current upstream
					state.
				</text>
			</Show>
			<For each={props.rows}>
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
						<ActionHeader onActivate={() => props.select(provider, index())}>
							<text fg={color("primary")}>
								{props.selected(provider, index()) ? "▾" : "▸"}{" "}
								{String(provider.name)} · {String(provider.type)} · token{" "}
								{provider.has_token === true ? "present" : "missing"}
							</text>
						</ActionHeader>
						<Show when={props.selected(provider, index())}>
							<text wrapMode="word">
								Configured origin: {String(provider.baseUrl)} · username:{" "}
								{String(provider.username || "not configured")}
							</text>
							<text fg={color("textMuted")}>
								Provider tokens are never displayed or stored in viewpoints.
								Provider writes use a separate immutable operator intention
								preview and explicit digest confirmation below; inspections
								never approve or dispatch a write.
							</text>
							<Show
								when={
									props.connected && !props.error && provider.has_token === true
								}
							>
								<text fg={color("textMuted")}>
									Prepare a read-only command, edit placeholders, then submit
									explicitly:
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
											onActivate={() =>
												props.prepare(
													`/provider ${String(provider.name)} ${query}`,
												)
											}
										>
											<text fg={color("accent")}>{query}</text>
										</ActionHeader>
									)}
								</For>
							</Show>
						</Show>
					</box>
				)}
			</For>
			<Show when={props.inspection}>
				<text fg={color("primary")}>
					Retained explicit inspection · {String(props.inspection?.provider)} ·{" "}
					{String(props.inspection?.operation)}
				</text>
				<text fg={color("textMuted")}>
					Cached response, never automatically refreshed or replayed. Lists may
					reflect upstream page limits; empty or absent patches are not proof of
					no changes. URLs are inert text, not opened.
				</text>
				<Show when={props.inspection?.provider !== selectedName()}>
					<text fg={color("warning")}>
						This cached response belongs to another provider selection; it is
						not substituted for the selected provider.
					</text>
				</Show>
				<text wrapMode="word">
					Received locally:{" "}
					{String(props.inspection?.receivedAt ?? "not recorded")} (epoch ms,
					not upstream revision). Read arguments:{" "}
					{JSON.stringify(props.inspection?.input)}
				</text>
				<For each={values()}>
					{(item, index) => {
						const key = `provider:${String(props.inspection?.provider)}:${String(props.inspection?.operation)}:${JSON.stringify(props.inspection?.input)}:row:${String(item.id ?? item.number ?? item.path ?? item.name ?? index())}`;
						return (
							<box flexDirection="column" gap={1} paddingLeft={1}>
								<ActionHeader onActivate={() => props.toggle(key)}>
									<text fg={color("primary")}>
										{open(key) ? "▾" : "▸"}{" "}
										{String(
											item.title ??
												item.full_name ??
												item.path_with_namespace ??
												item.path ??
												item.name ??
												item.id ??
												item.sha ??
												"Record",
										)}{" "}
										· {String(item.state ?? item.status ?? "")}
									</text>
								</ActionHeader>
								<Show when={open(key)}>
									<Show when={typeof item.patch === "string"}>
										<code
											content={
												String(item.patch) ||
												"No patch bytes returned by upstream"
											}
											filetype="diff"
											syntaxStyle={syntax}
											drawUnstyledText={true}
											wrapMode="word"
										/>
									</Show>
									<code
										content={JSON.stringify(item, null, 2)}
										filetype="json"
										syntaxStyle={syntax}
										drawUnstyledText={true}
										wrapMode="word"
									/>
								</Show>
							</box>
						);
					}}
				</For>
				<Show when={!values().length}>
					<text fg={color("textMuted")}>
						The retained response contains no records.
					</text>
				</Show>
			</Show>
		</box>
	);
}
