/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { useTerminalDimensions } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import type {
	Data,
	Transcript as TranscriptData,
} from "../../protocol/index.ts";
import { type ClientConnection, dataList } from "../client/connection.ts";
import { Transcript } from "../features/sessions/Transcript.tsx";
import { color } from "../ui/theme/index.ts";
import { Navigation, type Page, view } from "./navigation.ts";
import { Viewpoints } from "./viewpoints.ts";

const pages: [Page, string][] = [
	["tasks", "Tasks & reviews"],
	["environments", "Environments"],
	["providers", "Providers"],
	["observability", "Observability"],
	["schedules", "Schedules"],
	["wiki", "Wiki"],
	["settings", "Settings"],
];
const help = [
	"Plain input: send to the selected native conversation",
	"/help · /view tasks|environments|providers|schedules",
	"/session ID · /back · /forward · /reconnect",
	"/model PROFILE · /abort · /compact [instructions]",
	"/cancel TASK_ID",
	"/approve REVIEW_ID@REVISION [comments]",
	"/reject REVIEW_ID@REVISION comments",
	"/changes REVIEW_ID@REVISION comments",
	"/delete-schedule SCHEDULE_ID@REVISION",
	"/run|build|test APP [target] (native task + review)",
	"/logs APP · /filter TEXT · /sort newest|default",
	"/bookmark NAME · /jump NAME_OR_ID · /forget ID",
	"Alt+1..4: session modes · Alt+Left/Right: history",
	"Ctrl+B: sessions focus · Ctrl+V: viewpoints focus",
	"Ctrl+P: save viewpoint · Escape: content focus",
	"Enter: submit · Shift+Enter: newline · Ctrl+Q: quit",
	"Unknown commands refuse locally. // sends a literal slash.",
];

export function App(props: { client: ClientConnection; quit: () => void }) {
	const client = props.client,
		dimensions = useTerminalDimensions();
	const navigation = new Navigation(),
		viewpoints = new Viewpoints();
	const [revision, setRevision] = createSignal(0),
		[notice, setNotice] = createSignal<string | null>(null),
		[transcript, setTranscript] = createSignal<TranscriptData | null>(null),
		[providerData, setProviderData] = createSignal<unknown>(null),
		[helpOpen, setHelpOpen] = createSignal(false),
		[busy, setBusy] = createSignal(false);
	let prompt: TextareaRenderable | undefined,
		scroll: ScrollBoxRenderable | undefined,
		lastSession: number | null = null,
		reading = false;
	const update = () => setRevision((value) => value + 1);
	const removeListener = client.onChange(update);
	onCleanup(removeListener);
	const current = () => {
		revision();
		return navigation.current;
	};
	const state = () => {
		revision();
		return client.state;
	};
	const page = createMemo(() => current().page);
	const status = createMemo(() => {
		revision();
		return client.status;
	});
	const bookmarks = () => {
		revision();
		return viewpoints.items;
	};
	const connectionError = () => {
		revision();
		return client.error;
	};
	const isTranscript = () =>
		current().page === "orchestrator" || current().page === "session";
	const sessionId = () =>
		current().page === "orchestrator"
			? (state()?.sessions.find((session) => session.parent === null)?.id ??
				null)
			: current().page === "session"
				? Number(current().resource)
				: null;
	const available = () => {
		const id = sessionId();
		return (
			id === null || state()?.sessions.some((session) => session.id === id)
		);
	};
	const remember = () => {
		if (prompt) navigation.current.draft = prompt.plainText;
		if (scroll)
			navigation.current.scroll = Math.max(0, Math.round(scroll.scrollTop));
	};
	const restore = () => {
		prompt?.setText(navigation.current.draft);
		scroll?.scrollTo(navigation.current.scroll);
		update();
	};
	const go = (page: Page, resource: string | null = null) => {
		remember();
		navigation.go(view(page, resource));
		setNotice(null);
		restore();
	};
	async function refreshTranscript() {
		const id = sessionId();
		if (id === null || client.status !== "connected" || reading || !available())
			return;
		reading = true;
		try {
			const value = await client.call("session.read", { id });
			if (sessionId() === id) setTranscript(value);
		} catch (error) {
			if (sessionId() === id)
				setNotice(
					error instanceof Error ? error.message : "Transcript unavailable",
				);
		} finally {
			reading = false;
		}
	}
	const timer = setInterval(() => void refreshTranscript(), 1000);
	onCleanup(() => clearInterval(timer));
	createEffect(() => {
		const id = sessionId();
		if (id !== lastSession) {
			lastSession = id;
			setTranscript(null);
			void refreshTranscript();
		}
	});
	createEffect(() => {
		if (page() === "providers" && status() === "connected")
			void client
				.call("providers.read", {})
				.then(setProviderData)
				.catch((error: Error) => setNotice(error.message));
	});
	const rows = createMemo(() => {
		const snapshot = state(),
			selected = current();
		let rows: Data[] =
			selected.page === "tasks"
				? (snapshot?.tasks ?? [])
				: selected.page === "schedules"
					? (snapshot?.schedules ?? [])
					: selected.page === "environments"
						? dataList(snapshot?.environments.projects)
						: selected.page === "pi-durable"
							? (snapshot?.sessions ?? []).map((session) => ({ ...session }))
							: [];
		if (selected.filter)
			rows = rows.filter((row) =>
				JSON.stringify(row)
					.toLowerCase()
					.includes(selected.filter.toLowerCase()),
			);
		if (selected.sort === "newest") rows = [...rows].reverse();
		return rows;
	});
	const rowSelected = (row: Data, index: number) =>
		current().resource === null
			? index === current().selection
			: String(row.id) === current().resource;
	const missingResource = () =>
		current().resource !== null &&
		!isTranscript() &&
		!rows().some((row) => String(row.id) === current().resource);
	const keymap = useKeymap();
	const unregister = keymap.registerLayer({
		id: "v2.shell",
		priority: 10,
		commands: [
			{ id: "shell.quit", name: "Quit", run: () => props.quit() },
			{
				id: "shell.back",
				name: "Back",
				run: () => {
					remember();
					navigation.back();
					restore();
				},
			},
			{
				id: "shell.forward",
				name: "Forward",
				run: () => {
					remember();
					navigation.forward();
					restore();
				},
			},
			{
				id: "shell.sessions",
				name: "Focus sessions",
				run: () => {
					navigation.current.focus = "sessions";
					update();
				},
			},
			{
				id: "shell.viewpoints",
				name: "Focus viewpoints",
				run: () => {
					remember();
					navigation.current.focus = "viewpoints";
					update();
				},
			},
			{
				id: "shell.content",
				name: "Focus content",
				run: () => {
					navigation.current.focus = "content";
					setHelpOpen(false);
					update();
				},
			},
			{
				id: "shell.bookmark",
				name: "Save viewpoint",
				run: () => {
					remember();
					try {
						viewpoints.save(
							`${current().page} ${current().resource ?? ""}`.trim(),
							current(),
						);
						setNotice(
							"Saved viewpoint in this client session (including unsent draft)",
						);
						update();
					} catch (error) {
						setNotice(
							error instanceof Error ? error.message : "Bookmark refused",
						);
					}
				},
			},
			...["opencode", "pi", "pi-durable", "orchestrator"].map((page) => ({
				id: `shell.${page}`,
				name: page,
				run: () => go(page as Page),
			})),
		],
		bindings: [
			{ key: "ctrl+q", cmd: "shell.quit" },
			{ key: "alt+left", cmd: "shell.back" },
			{ key: "alt+right", cmd: "shell.forward" },
			{ key: "ctrl+b", cmd: "shell.sessions" },
			{ key: "ctrl+v", cmd: "shell.viewpoints" },
			{ key: "escape", cmd: "shell.content" },
			{ key: "ctrl+p", cmd: "shell.bookmark" },
			...["opencode", "pi", "pi-durable", "orchestrator"].map(
				(page, index) => ({ key: `alt+${index + 1}`, cmd: `shell.${page}` }),
			),
		],
	});
	onCleanup(unregister);
	async function submit() {
		if (busy()) return;
		remember();
		const origin = navigation.current;
		const content = origin.draft;
		if (!content.trim()) return;
		setBusy(true);
		setNotice(null);
		try {
			if (content.startsWith("/") && !content.startsWith("//")) {
				const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content),
					command = match?.[1] ?? "",
					args = match?.[2]?.trim() ?? "";
				const clear = () => {
					origin.draft = "";
					if (navigation.current === origin) prompt?.setText("");
				};
				const words = args.split(/\s+/),
					identity = words[0] ?? "",
					comments = words.slice(1).join(" ");
				const numbered = () => {
					const id = Number(identity);
					if (!/^\d+$/.test(identity) || !Number.isSafeInteger(id))
						throw new Error("Supply a native numeric identity");
					return id;
				};
				const revisioned = () => {
					const match = /^(.+)@(\d+)$/.exec(identity);
					if (!match?.[1] || !match[2])
						throw new Error("Use ID@REVISION from current server state");
					return { id: match[1], revision: Number(match[2]) };
				};
				if (command === "help") {
					setHelpOpen(true);
					clear();
				} else if (command === "view") {
					const page = pages.find(([page]) => page === args)?.[0];
					if (!page) throw new Error("Unknown feature view");
					clear();
					go(page);
				} else if (command === "session") {
					const id = numbered();
					if (!state()?.sessions.some((session) => session.id === id))
						throw new Error("Native session is unavailable");
					clear();
					go("session", String(id));
				} else if (command === "back" || command === "forward") {
					clear();
					if (command === "back") navigation.back();
					else navigation.forward();
					restore();
				} else if (command === "bookmark") {
					clear();
					remember();
					viewpoints.save(args, current());
					update();
				} else if (command === "jump") {
					const saved = viewpoints.items.find(
						(item) => item.id === args || item.name === args,
					);
					if (!saved) throw new Error("Unknown saved viewpoint");
					clear();
					viewpoints.restore(saved.id, navigation);
					restore();
				} else if (command === "forget") {
					viewpoints.remove(args);
					clear();
					update();
				} else if (command === "filter" || command === "sort") {
					if (command === "filter") navigation.current.filter = args;
					else {
						if (!["default", "newest"].includes(args))
							throw new Error("Sort accepts default or newest");
						navigation.current.sort = args;
					}
					navigation.current.selection = 0;
					clear();
					update();
				} else if (command === "quit") {
					props.quit();
				} else if (command === "reconnect") {
					client.reconnectNow();
					clear();
				} else if (command === "cancel") {
					await client.call("task.cancel", { id: numbered() });
					clear();
				} else if (["approve", "reject", "changes"].includes(command)) {
					await client.call("review.decide", {
						...revisioned(),
						decision:
							command === "approve"
								? "approved"
								: command === "reject"
									? "rejected"
									: "changes-requested",
						comments,
					});
					clear();
				} else if (command === "delete-schedule") {
					await client.call("schedule.delete", revisioned());
					clear();
				} else if (["run", "build", "test"].includes(command)) {
					const result = await client.call("environment.action", {
						apps: [identity],
						action: command as "run" | "build" | "test",
						...(words[1] ? { target: words[1] } : {}),
						requestId: crypto.randomUUID(),
					});
					clear();
					setNotice(
						`Native environment task #${result.taskId}; inspect its review before execution.`,
					);
				} else if (command === "logs") {
					const logs = await client.call("environment.logs", { app: args });
					origin.detail = { logs };
					clear();
					update();
				} else if (["model", "abort", "compact"].includes(command)) {
					const id = sessionId();
					if (id === null)
						throw new Error("Select a native conversation first");
					if (command === "model")
						await client.call("session.configure", { id, profile: args });
					else if (command === "abort")
						await client.call("session.abort", { id });
					else
						await client.call("session.compact", {
							id,
							...(args ? { instructions: args } : {}),
						});
					clear();
					await refreshTranscript();
				} else
					throw new Error(
						"Unsupported prompt command; /help lists available commands",
					);
			} else {
				const id = sessionId();
				if (id === null || !available())
					throw new Error("Select a current native conversation to send input");
				const result = await client.call("session.send", {
					id,
					content: content.startsWith("//") ? content.slice(1) : content,
					requestId: crypto.randomUUID(),
				});
				if (navigation.current === origin && current().draft === content) {
					navigation.current.draft = "";
					prompt?.setText("");
				}
				setNotice(`Admitted submission #${result.submissionId}`);
				await refreshTranscript();
			}
		} catch (error) {
			setNotice(error instanceof Error ? error.message : "Command refused");
		} finally {
			setBusy(false);
			update();
		}
	}
	const sidebarOptions = () => [
		...["OpenCode", "Pi", "Pi Durable", "Orchestrator"].map((name, index) => ({
			name,
			description: index < 2 ? "Native adapter not implemented" : "Native",
			value: `mode:${index}`,
		})),
		{
			name: `${current().expanded.includes("sidebar:children") ? "▾" : "▸"} Native children`,
			description: "",
			value: "tree:children",
		},
		...(current().expanded.includes("sidebar:children")
			? (state()
					?.sessions.filter((session) => session.parent !== null)
					.map((session) => ({
						name: `  ${session.writable ? "▸" : "·"} ${session.title}`,
						description: `Session ${session.id}`,
						value: `session:${session.id}`,
					})) ?? [])
			: []),
		...pages.map(([page, title]) => ({
			name: title,
			description: "",
			value: page,
		})),
	];
	return (
		<box
			width="100%"
			height="100%"
			flexDirection="column"
			backgroundColor={color("background")}
		>
			<box
				height={1}
				flexDirection="row"
				justifyContent="space-between"
				backgroundColor={color("backgroundPanel")}
			>
				<text fg={color("primary")}> agentic-coding v2 · {current().page}</text>
				<text
					fg={status() === "connected" ? color("success") : color("warning")}
				>
					{status()} {busy() ? "· pending" : ""}{" "}
				</text>
			</box>
			<box flexDirection="row" flexGrow={1} minHeight={0}>
				<box
					width={dimensions().width < 100 ? 22 : 30}
					flexDirection="column"
					border={["right"]}
					borderColor={color("border")}
				>
					<text fg={color("textMuted")}> SESSIONS & FEATURES</text>
					<select
						flexGrow={1}
						focused={current().focus === "sessions"}
						options={sidebarOptions()}
						showDescription={false}
						textColor={color("text")}
						selectedBackgroundColor={color("backgroundElement")}
						onSelect={(_index, option) => {
							const value = option?.value;
							if (typeof value !== "string") return;
							if (value === "tree:children") {
								navigation.current.expanded = current().expanded.includes(
									"sidebar:children",
								)
									? current().expanded.filter(
											(key) => key !== "sidebar:children",
										)
									: [...current().expanded, "sidebar:children"];
								update();
							} else if (value.startsWith("mode:"))
								go(
									(["opencode", "pi", "pi-durable", "orchestrator"] as Page[])[
										Number(value.slice(5))
									] ?? "orchestrator",
								);
							else if (value.startsWith("session:"))
								go("session", value.slice(8));
							else go(value as Page);
						}}
					/>
				</box>
				<box flexGrow={1} minWidth={0} flexDirection="column">
					<scrollbox
						ref={(value) => {
							scroll = value;
						}}
						flexGrow={1}
						minHeight={0}
						padding={1}
						scrollY={true}
						focused={current().focus === "content" && !isTranscript()}
					>
						<Show
							when={helpOpen()}
							fallback={
								<>
									<Show when={isTranscript()}>
										<Show
											when={available()}
											fallback={
												<text fg={color("warning")}>
													Saved conversation is unavailable. Its draft remains
													unsent; select another session explicitly.
												</text>
											}
										>
											<text fg={color("textMuted")}>
												{transcript()?.model ?? "Native conversation"} ·
												thinking {transcript()?.thinking ?? "—"}
											</text>
											<Show when={transcript()}>
												<text fg={color("textMuted")}>
													History window · input{" "}
													{transcript()?.usage.input ?? 0} · output{" "}
													{transcript()?.usage.output ?? 0} · cached{" "}
													{transcript()?.usage.cacheRead ?? 0} · reported $
													{(transcript()?.usage.cost ?? 0).toFixed(4)}
												</text>
											</Show>
											<Transcript
												value={transcript()}
												enabled={current().focus === "content"}
												selected={
													typeof current().detail.transcriptSelection ===
													"string"
														? String(current().detail.transcriptSelection)
														: null
												}
												select={(id) => {
													navigation.current.detail = {
														...current().detail,
														transcriptSelection: id,
													};
													update();
												}}
												reveal={(node) => {
													if (!scroll || !Number.isFinite(node.y)) return;
													const top =
														node.y - scroll.viewport.y + scroll.scrollTop;
													if (top < scroll.scrollTop)
														scroll.scrollTo(Math.max(0, top));
													else if (
														top + node.height >
														scroll.scrollTop + scroll.viewport.height
													)
														scroll.scrollTo(
															Math.max(
																0,
																top + node.height - scroll.viewport.height,
															),
														);
												}}
												expanded={current().expanded}
												toggle={(id) => {
													navigation.current.expanded =
														current().expanded.includes(id)
															? current().expanded.filter((key) => key !== id)
															: [...current().expanded, id];
													update();
												}}
											/>
										</Show>
									</Show>
									<Show
										when={
											current().page === "opencode" || current().page === "pi"
										}
									>
										<text fg={color("warning")}>
											The v2 native adapter for this session mode is not
											implemented yet. Legacy launch/delegation is not used.
										</text>
									</Show>
									<Show when={missingResource()}>
										<text fg={color("warning")}>
											Saved resource is unavailable in the current filtered
											inventory. Its draft remains unsent.
										</text>
									</Show>
									<Show when={rows().length}>
										<box flexDirection="column" gap={1}>
											<For each={rows()}>
												{(row, index) => (
													<box
														flexDirection="column"
														backgroundColor={
															rowSelected(row, index())
																? color("backgroundPanel")
																: color("background")
														}
														onMouseDown={() => {
															navigation.current.selection = index();
															navigation.current.resource = String(row.id);
															update();
														}}
													>
														<text fg={color("primary")}>
															{rowSelected(row, index()) ? "▾ " : "▸ "}
															{String(row.id)}{" "}
															{String(
																row.status ??
																	row.state ??
																	row.kind ??
																	row.title ??
																	"",
															)}{" "}
															{String(row.skill ?? "")}
														</text>
														<Show when={rowSelected(row, index())}>
															<text wrapMode="word">
																{JSON.stringify(row, null, 2)}
															</text>
														</Show>
													</box>
												)}
											</For>
										</box>
									</Show>
									<Show when={current().page === "tasks"}>
										<box flexDirection="column" gap={1}>
											<For each={state()?.reviews ?? []}>
												{(review) => (
													<box
														border={true}
														borderColor={color("warning")}
														flexDirection="column"
														padding={1}
													>
														<text fg={color("warning")}>
															Review {String(review.id)}@
															{String(review.revision)} · {String(review.state)}
														</text>
														<text wrapMode="word">
															{JSON.stringify(review, null, 2)}
														</text>
													</box>
												)}
											</For>
										</box>
									</Show>
									<Show when={current().page === "providers"}>
										<text wrapMode="word">
											{providerData() === null
												? "Provider inventory unavailable"
												: JSON.stringify(providerData(), null, 2)}
										</text>
									</Show>
									<Show when={current().page === "observability"}>
										<text wrapMode="word">
											{JSON.stringify(
												{
													http: state()?.environments.httpOperations ?? [],
													database: state()?.environments.queryOperations ?? [],
													referenceGraphs:
														state()?.environments.referenceGraphs ?? [],
												},
												null,
												2,
											)}
										</text>
									</Show>
									<Show when={current().page === "settings"}>
										<text fg={color("textMuted")}>
											Writable configuration editing has no native v2
											candidate/apply contract yet. No read-only settings
											inventory is presented.
										</text>
									</Show>
									<Show when={current().page === "wiki"}>
										<text fg={color("textMuted")}>
											Wiki storage and native comment-skill binding are not yet
											implemented in v2.
										</text>
									</Show>
									<Show
										when={
											![
												"orchestrator",
												"session",
												"opencode",
												"pi",
												"wiki",
												"settings",
												"providers",
												"observability",
											].includes(current().page) && !rows().length
										}
									>
										<text fg={color("textMuted")}>
											No matching resources. Viewpoints do not create or revive
											resources.
										</text>
									</Show>
									<Show when={Object.keys(current().detail).length}>
										<text wrapMode="word">
											{JSON.stringify(current().detail, null, 2)}
										</text>
									</Show>
								</>
							}
						>
							<For each={help}>{(line) => <text>{line}</text>}</For>
						</Show>
					</scrollbox>
					<box
						height={5}
						flexShrink={0}
						border={["top"]}
						borderColor={color("border")}
					>
						<textarea
							ref={(value) => {
								prompt = value;
							}}
							focused={current().focus === "content"}
							initialValue={current().draft}
							placeholder={
								isTranscript()
									? "Send a message or /help…"
									: "Prompt command (/help)…"
							}
							keyBindings={[
								{ name: "return", action: "submit" },
								{ name: "return", shift: true, action: "newline" },
							]}
							onContentChange={(value) => {
								navigation.current.draft =
									typeof value === "string" ? value : (prompt?.plainText ?? "");
							}}
							onSubmit={() => void submit()}
							width="100%"
							height="100%"
							textColor={color("text")}
							backgroundColor={color("backgroundPanel")}
						/>
					</box>
				</box>
				<box
					width={dimensions().width < 100 ? 20 : 27}
					flexDirection="column"
					border={["left"]}
					borderColor={color("border")}
				>
					<text fg={color("textMuted")}> VIEWPOINTS</text>
					<text fg={color("textMuted")}> Ctrl+P saves current state</text>
					<select
						flexGrow={1}
						focused={current().focus === "viewpoints"}
						options={bookmarks().map((item) => ({
							name: item.name,
							description: `${item.view.page} ${item.view.resource ?? ""}`,
							value: item.id,
						}))}
						textColor={color("text")}
						selectedBackgroundColor={color("backgroundElement")}
						onSelect={(_index, option) => {
							if (typeof option?.value !== "string") return;
							remember();
							viewpoints.restore(option.value, navigation);
							restore();
						}}
					/>
					<text fg={color("textMuted")}> Memory-only · drafts retained</text>
				</box>
			</box>
			<text
				height={1}
				fg={
					notice() || connectionError() ? color("warning") : color("textMuted")
				}
			>
				{" "}
				{notice() ??
					connectionError() ??
					"Ctrl+B sessions · Ctrl+V viewpoints · /help · Ctrl+Q quit"}
			</text>
		</box>
	);
}
