/** @jsxImportSource @opentui/solid */
import { createHash } from "node:crypto";
import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
	useContext,
} from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { LocalChoiceContext } from "../../ui/LocalChoice.ts";
import { color } from "../../ui/theme/index.ts";
import { SuppliedCode } from "../sessions/SuppliedCode.tsx";

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
	const choices = useContext(LocalChoiceContext);
	const [start, setStart] = createSignal(0);
	const inspection = createMemo(() => props.inspection);
	const values = createMemo(() => {
		const value = inspection()?.value;
		return Array.isArray(value)
			? dataList(value)
			: value && typeof value === "object"
				? [value as Data]
				: [];
	});
	let generation = 0;
	const source = createMemo(() => {
		inspection();
		return ++generation;
	});
	createEffect(() => {
		source();
		setStart(0);
	});
	const visible = createMemo(() => values().slice(start(), start() + 20));
	const title = (item: Data) =>
		String(
			item.title ??
				item.full_name ??
				item.path_with_namespace ??
				item.path ??
				item.name ??
				item.id ??
				item.sha ??
				"Record",
		);
	// UI fold identity only, never an approval digest or native/provider identity.
	const responseKey = createMemo(() =>
		createHash("sha256").update(JSON.stringify(inspection())).digest("hex"),
	);
	const recordKey = (index: number) =>
		`provider-inspection:${responseKey()}:row:${index}`;
	const chooseRecord = () => {
		if (!choices?.interactive()) return;
		const saved = inspection();
		const owner = choices.scope();
		const version = source();
		const records = values();
		choices.choose({
			title: "Search supplied provider response records",
			rows: records.map((item, index) => ({
				key: String(index),
				label: `${index + 1}. ${Array.from(title(item).replace(/\s+/g, " ")).slice(0, 240).join("")}`,
				detail: `${String(item.state ?? item.status ?? "")} · supplied response only`,
				search: JSON.stringify(item),
			})),
			note: "Local cached response only; choosing mounts and expands the supplied record, never inspects upstream, opens a URL or prepares an approval.",
			valid: () =>
				inspection() === saved &&
				source() === version &&
				choices.scope() === owner,
			choose: (key) => {
				const index = Number(key);
				if (
					inspection() !== saved ||
					source() !== version ||
					choices.scope() !== owner ||
					!/^\d+$/.test(key) ||
					!Number.isSafeInteger(index) ||
					!records[index]
				)
					return false;
				setStart(Math.floor(index / 20) * 20);
				if (!open(recordKey(index))) props.toggle(recordKey(index));
				return true;
			},
		});
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
				<Show when={values().length > 0}>
					<text fg={color("textMuted")}>
						Supplied records {start() + 1}–
						{Math.min(start() + 20, values().length)} of {values().length}; no
						upstream pagination runs here.
					</text>
					<ActionHeader scope={source()} onActivate={chooseRecord}>
						<text fg={color("accent")}>Search supplied records</text>
					</ActionHeader>
					<Show when={start() > 0}>
						<ActionHeader
							scope={`${source()}:${start()}`}
							onActivate={() => setStart(Math.max(0, start() - 20))}
						>
							<text fg={color("accent")}>Previous supplied records</text>
						</ActionHeader>
					</Show>
					<Show when={start() + 20 < values().length}>
						<ActionHeader
							scope={`${source()}:${start()}`}
							onActivate={() => setStart(start() + 20)}
						>
							<text fg={color("accent")}>Next supplied records</text>
						</ActionHeader>
					</Show>
				</Show>
				<For each={visible()}>
					{(item, index) => {
						const key = () => recordKey(start() + index());
						return (
							<box flexDirection="column" gap={1} paddingLeft={1}>
								<ActionHeader
									scope={`${source()}:${key()}`}
									onActivate={() => props.toggle(key())}
								>
									<text fg={color("primary")}>
										{open(key()) ? "▾" : "▸"}{" "}
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
								<Show when={open(key())}>
									<Show when={typeof item.patch === "string"}>
										<Show
											when={String(item.patch).length > 0}
											fallback={
												<text fg={color("textMuted")}>
													Upstream supplied an empty patch string; this is not
													proof of no changes.
												</text>
											}
										>
											<code
												content={String(item.patch)}
												filetype="diff"
												syntaxStyle={syntax}
												drawUnstyledText={true}
												wrapMode="word"
											/>
										</Show>
									</Show>
									<SuppliedCode
										content={JSON.stringify(item, null, 2)}
										identity={key()}
										filetype="json"
										syntax={syntax}
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
