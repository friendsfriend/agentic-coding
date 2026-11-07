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
	ProviderQuery,
	ProviderSummary,
	SettingsCandidate,
	SettingsDefinition,
	SettingsDocument,
	TaskDetails,
} from "../../protocol/index.ts";
import { type ClientConnection, dataList } from "../client/connection.ts";
import { ObservabilityPanel } from "../features/observability/ObservabilityPanel.tsx";
import { ProviderPanel } from "../features/providers/ProviderPanel.tsx";
import { ResourcePanel } from "../features/resources/ResourcePanel.tsx";
import { Transcript } from "../features/sessions/Transcript.tsx";
import { SettingsPanel } from "../features/settings/SettingsPanel.tsx";
import { TaskPanel } from "../features/tasks/TaskPanel.tsx";
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
	"/task TASK_ID · /refresh (read-only refresh)",
	"/cancel TASK_ID",
	"/approve REVIEW_ID@REVISION [comments]",
	"/reject REVIEW_ID@REVISION comments",
	"/changes REVIEW_ID@REVISION comments",
	"/delete-schedule SCHEDULE_ID@REVISION",
	"/run|build|test APP [target] (native task + review)",
	"/logs APP · /filter TEXT · /sort newest|default",
	"/provider NAME repos QUERY | branches|labels|collaborators REPO",
	"/provider NAME changes|issues REPO [open|closed|all]",
	"/provider NAME change|issue|files|versions|discussions REPO NUMBER",
	"/provider NAME jobs REPO [RUN_ID] (required for GitHub)",
	"/view settings · /settings-preview · /settings-reset",
	"/settings-apply CANDIDATE_ID approve:DIGEST (explicit file save; restart required)",
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
		[providerData, setProviderData] = createSignal<ProviderSummary[]>([]),
		[providerError, setProviderError] = createSignal<string | null>(null),
		[taskDetails, setTaskDetails] = createSignal<TaskDetails | null>(null),
		[taskError, setTaskError] = createSignal<string | null>(null),
		[refreshRevision, setRefreshRevision] = createSignal(0),
		[settingsDocument, setSettingsDocument] =
			createSignal<SettingsDocument | null>(null),
		[settingsError, setSettingsError] = createSignal<string | null>(null),
		[settingsDraft, setSettingsDraft] = createSignal(""),
		[settingsCandidate, setSettingsCandidate] =
			createSignal<SettingsCandidate | null>(null),
		[settingsEditing, setSettingsEditing] = createSignal(false),
		[helpOpen, setHelpOpen] = createSignal(false),
		[busy, setBusy] = createSignal(false);
	let prompt: TextareaRenderable | undefined,
		scroll: ScrollBoxRenderable | undefined;
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
		setSettingsCandidate(null);
		setSettingsEditing(false);
		if (navigation.current.page === "settings")
			setRefreshRevision((value) => value + 1);
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
	const watchedSession = createMemo(() => (available() ? sessionId() : null));
	createEffect(() => client.selectSession(watchedSession()));
	onCleanup(() => client.selectSession(null));
	const transcript = () => {
		revision();
		return client.transcript?.id === sessionId() ? client.transcript : null;
	};
	const observation = () => {
		revision();
		return client.observation;
	};
	const observationError = () => {
		revision();
		return client.observationError;
	};
	let settingsEpoch = 0;
	createEffect(() => {
		const selectedPage = page(),
			connected = status() === "connected";
		refreshRevision();
		const epoch = ++settingsEpoch;
		onCleanup(() => {
			settingsEpoch++;
		});
		setSettingsCandidate(null);
		if (selectedPage !== "settings") {
			setSettingsEditing(false);
			return;
		}
		if (!connected) {
			setSettingsEditing(false);
			setSettingsError(
				"Disconnected; document is cached and confirmations were discarded",
			);
			return;
		}
		setSettingsError("Reading native writable settings…");
		void client
			.call("settings.read", {})
			.then((document) => {
				if (epoch !== settingsEpoch || status() !== "connected") return;
				setSettingsDocument(document);
				if (!settingsDraft())
					setSettingsDraft(JSON.stringify(document.settings, null, 2));
				setSettingsError(null);
			})
			.catch((error: Error) => {
				if (epoch === settingsEpoch) setSettingsError(error.message);
			});
	});
	createEffect(() => {
		if (current().focus !== "content" || helpOpen()) setSettingsEditing(false);
	});
	let providerEpoch = 0;
	createEffect(() => {
		const selectedPage = page(),
			connected = status() === "connected";
		refreshRevision();
		const epoch = ++providerEpoch;
		onCleanup(() => {
			providerEpoch++;
		});
		if (selectedPage !== "providers") return;
		if (!connected) {
			setProviderError("Disconnected; provider registry is cached");
			return;
		}
		setProviderError("Refreshing local native provider registry…");
		void client
			.call("providers.read", {})
			.then((providers) => {
				if (epoch !== providerEpoch || status() !== "connected") return;
				setProviderData(providers);
				setProviderError(null);
			})
			.catch((error: Error) => {
				if (epoch === providerEpoch) setProviderError(error.message);
			});
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
						: selected.page === "providers"
							? providerData().map((provider) => ({
									...provider,
									id: provider.name,
								}))
							: selected.page === "observability"
								? (
										[
											["http", snapshot?.environments.httpOperations],
											["query", snapshot?.environments.queryOperations],
											["wait", snapshot?.environments.waits],
											["reference", snapshot?.environments.referenceGraphs],
										] as const
									).flatMap(([journal, records]) =>
										dataList(records).map((row, index) => {
											const nativeIdentity = String(
												row.id ?? row.batch ?? `unidentified:${index}`,
											);
											return {
												...row,
												journal,
												nativeIdentity,
												id: `${journal}:${nativeIdentity}`,
											};
										}),
									)
								: selected.page === "pi-durable"
									? (snapshot?.sessions ?? []).map((session) => ({
											...session,
										}))
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
	const selectedTaskId = createMemo(() => {
		if (page() !== "tasks") return null;
		const row = rows().find(rowSelected);
		return row && Number.isSafeInteger(row.id) ? Number(row.id) : null;
	});
	const taskReadKey = createMemo(() =>
		JSON.stringify([
			selectedTaskId(),
			status(),
			refreshRevision(),
			state()?.tasks.find((task) => task.id === selectedTaskId()),
			state()?.reviews.filter((review) => review.taskId === selectedTaskId()),
		]),
	);
	let detailEpoch = 0;
	createEffect(() => {
		taskReadKey();
		const id = selectedTaskId(),
			epoch = ++detailEpoch;
		onCleanup(() => {
			detailEpoch++;
		});
		if (id === null) {
			setTaskDetails(null);
			setTaskError(null);
			return;
		}
		if (status() !== "connected") {
			setTaskError(
				"Disconnected; task details are cached and current activity is unknown",
			);
			return;
		}
		setTaskError("Refreshing native task detail…");
		void client
			.call("task.read", { id })
			.then((details) => {
				if (
					epoch !== detailEpoch ||
					status() !== "connected" ||
					selectedTaskId() !== id
				)
					return;
				if (details.id !== id)
					throw new Error("Wrong native task detail identity");
				setTaskDetails(details);
				setTaskError(null);
			})
			.catch((error: Error) => {
				if (epoch === detailEpoch) setTaskError(error.message);
			});
	});
	const toggleDetail = (id: string) => {
		navigation.current.expanded = current().expanded.includes(id)
			? current().expanded.filter((key) => key !== id)
			: [...current().expanded, id];
		update();
	};
	const prepareCommand = (command: string) => {
		remember();
		if (navigation.current.draft.trim()) {
			setNotice(
				"An unsent draft already exists; it was not replaced. Clear or save it before preparing another command.",
			);
			return;
		}
		navigation.current.draft = command;
		prompt?.setText(command);
		setNotice(
			"Command prepared only. Inspect the native snapshot, add comments, and submit explicitly; no action has run.",
		);
		update();
	};
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
					setSettingsEditing(false);
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
					if (
						navigation.current === origin &&
						prompt &&
						prompt.plainText !== content
					) {
						origin.draft = prompt.plainText;
						return;
					}
					if (origin.draft !== content) return;
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
				} else if (command === "task") {
					const id = numbered();
					if (!state()?.tasks.some((task) => task.id === id))
						throw new Error("Native task is unavailable");
					clear();
					go("tasks", String(id));
				} else if (command === "refresh") {
					await client.call("state.read", {}).then((snapshot) => {
						client.state = snapshot;
						update();
					});
					setRefreshRevision((value) => value + 1);
					clear();
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
				} else if (command === "settings-reset") {
					if (
						origin.page !== "settings" ||
						args ||
						!settingsDocument() ||
						settingsError()
					)
						throw new Error(
							"Open settings and refresh its native document before reset",
						);
					setSettingsCandidate(null);
					setSettingsDraft(
						JSON.stringify(settingsDocument()?.settings, null, 2),
					);
					clear();
				} else if (command === "settings-preview") {
					const document = settingsDocument(),
						draft = settingsDraft(),
						epoch = settingsEpoch;
					if (
						origin.page !== "settings" ||
						args ||
						!document ||
						settingsError()
					)
						throw new Error(
							"Open settings and refresh its native document before preview",
						);
					let settings: SettingsDefinition;
					try {
						settings = JSON.parse(draft) as SettingsDefinition;
					} catch {
						throw new Error("Settings editor must contain a JSON object");
					}
					setSettingsCandidate(null);
					const candidate = await client.call("settings.preview", {
						baseRevision: document.revision,
						settings,
					});
					if (
						navigation.current !== origin ||
						epoch !== settingsEpoch ||
						settingsDraft() !== draft ||
						status() !== "connected"
					)
						throw new Error(
							"Preview selection/draft changed; create a fresh candidate",
						);
					if (candidate.baseRevision !== document.revision)
						throw new Error("Wrong settings candidate revision");
					setSettingsCandidate(candidate);
					clear();
					setNotice(
						"Native candidate prepared only. Inspect its exact immutable snapshot; no file has been written.",
					);
				} else if (command === "settings-apply") {
					const candidate = settingsCandidate();
					if (
						origin.page !== "settings" ||
						words.length !== 2 ||
						!candidate ||
						identity !== candidate.id ||
						comments !== `approve:${candidate.digest}` ||
						candidate.expiresAt <= Date.now() ||
						settingsError()
					)
						throw new Error(
							"A fresh displayed settings candidate and manually typed exact approve:DIGEST are required",
						);
					setSettingsCandidate(null);
					const result = await client.call("settings.apply", {
						id: candidate.id,
						approval: comments,
					});
					clear();
					setRefreshRevision((value) => value + 1);
					setNotice(
						`Configuration saved at revision ${result.revision}. Running host is unchanged; a separately authorized restart is required. Edited JSON is retained until explicit reset.`,
					);
				} else if (command === "provider") {
					const [provider, operation, repo, argument] = words;
					if (!provider || !operation)
						throw new Error(
							"Use /provider NAME OPERATION ...; /help lists read-only operations",
						);
					const positive = (value: string | undefined) => {
						if (
							!value ||
							!/^\d+$/.test(value) ||
							!Number.isSafeInteger(Number(value)) ||
							Number(value) < 1
						)
							throw new Error("Supply a positive native provider number");
						return Number(value);
					};
					let input: ProviderQuery;
					if (operation === "repos") {
						if (!repo) throw new Error("Supply a repository search query");
						input = { provider, operation, query: words.slice(2).join(" ") };
					} else {
						if (!repo || words.length > 4)
							throw new Error(
								"Supply a repository and only the operation's allowed arguments",
							);
						if (operation === "changes" || operation === "issues") {
							if (argument && !["open", "closed", "all"].includes(argument))
								throw new Error("State accepts open, closed or all");
							input = {
								provider,
								operation,
								repo,
								state: (argument ?? "open") as "open" | "closed" | "all",
							};
						} else if (
							["change", "issue", "files", "versions", "discussions"].includes(
								operation,
							)
						)
							input = {
								provider,
								operation: operation as
									| "change"
									| "issue"
									| "files"
									| "versions"
									| "discussions",
								repo,
								number: positive(argument),
							};
						else if (operation === "jobs")
							input = {
								provider,
								operation,
								repo,
								...(argument ? { run: positive(argument) } : {}),
							};
						else if (
							operation === "branches" ||
							operation === "labels" ||
							operation === "collaborators"
						) {
							if (argument)
								throw new Error("This read accepts only a repository");
							input = { provider, operation, repo };
						} else
							throw new Error(
								"Unsupported provider operation; no write or arbitrary route is forwarded",
							);
					}
					const inspection = await client.call("providers.inspect", input);
					if (
						inspection.provider !== provider ||
						inspection.operation !== operation
					)
						throw new Error("Wrong provider inspection identity");
					const retained = { ...inspection, input, receivedAt: Date.now() };
					origin.detail = { ...origin.detail, providerInspection: retained };
					clear();
					if (navigation.current === origin) {
						if (origin.page !== "providers") go("providers", provider);
						navigation.current.resource = provider;
						navigation.current.detail = {
							...navigation.current.detail,
							providerInspection: retained,
						};
					}
					update();
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
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Command refused";
			setNotice(
				/^\/settings-apply(?:\s|$)/.test(content)
					? `${message}. If apply was sent, the file may already have changed; refresh its revision before creating a new confirmation. No automatic retry.`
					: message,
			);
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
												observation={observation()}
												observationError={observationError()}
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
									<Show
										when={
											rows().length &&
											![
												"tasks",
												"environments",
												"schedules",
												"providers",
												"observability",
											].includes(current().page)
										}
									>
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
										<TaskPanel
											rows={rows()}
											selectedId={selectedTaskId()}
											select={(id) => go("tasks", String(id))}
											details={
												taskDetails()?.id === selectedTaskId()
													? taskDetails()
													: null
											}
											error={taskError()}
											connected={status() === "connected"}
											reviews={state()?.reviews ?? []}
											expanded={current().expanded}
											toggle={toggleDetail}
											prepare={prepareCommand}
											openSession={
												state()?.sessions.find(
													(session) => session.task === selectedTaskId(),
												)
													? () => {
															const session = state()?.sessions.find(
																(session) => session.task === selectedTaskId(),
															);
															if (session) go("session", String(session.id));
														}
													: null
											}
										/>
									</Show>
									<Show
										when={
											current().page === "environments" ||
											current().page === "schedules"
										}
									>
										<ResourcePanel
											kind={
												current().page === "schedules"
													? "schedules"
													: "environments"
											}
											rows={rows()}
											selected={rowSelected}
											select={(row, index) => {
												navigation.current.selection = index;
												navigation.current.resource = String(row.id);
												update();
											}}
											environments={state()?.environments}
											connected={status() === "connected"}
											expanded={current().expanded}
											toggle={toggleDetail}
											prepare={prepareCommand}
											openTask={(id) => {
												if (state()?.tasks.some((task) => task.id === id))
													go("tasks", String(id));
												else
													setNotice(
														"Owner task is not in the native catalog; no arbitrary native task is adopted.",
													);
											}}
										/>
									</Show>
									<Show when={current().page === "providers"}>
										<ProviderPanel
											rows={rows()}
											selected={rowSelected}
											select={(row, index) => {
												navigation.current.selection = index;
												navigation.current.resource = String(row.id);
												update();
											}}
											connected={status() === "connected"}
											error={providerError()}
											inspection={
												current().detail.providerInspection &&
												typeof current().detail.providerInspection ===
													"object" &&
												!Array.isArray(current().detail.providerInspection)
													? (current().detail.providerInspection as Data)
													: null
											}
											expanded={current().expanded}
											toggle={toggleDetail}
											prepare={prepareCommand}
										/>
									</Show>
									<Show when={current().page === "observability"}>
										<ObservabilityPanel
											rows={rows()}
											selected={rowSelected}
											select={(row, index) => {
												navigation.current.selection = index;
												navigation.current.resource = String(row.id);
												update();
											}}
											environments={state()?.environments}
											connected={status() === "connected"}
											expanded={current().expanded}
											toggle={toggleDetail}
											openTask={(id) => {
												if (state()?.tasks.some((task) => task.id === id))
													go("tasks", String(id));
												else
													setNotice(
														"Owner task is not in the native catalog; no arbitrary task is adopted.",
													);
											}}
										/>
									</Show>
									<Show when={current().page === "settings"}>
										<SettingsPanel
											document={settingsDocument()}
											error={settingsError()}
											draft={settingsDraft()}
											change={(value) => {
												if (value !== settingsDraft()) {
													setSettingsDraft(value);
													setSettingsCandidate(null);
												}
											}}
											editing={settingsEditing()}
											edit={(value) => {
												navigation.current.focus = "content";
												setSettingsEditing(value);
												update();
											}}
											candidate={settingsCandidate()}
											connected={status() === "connected"}
											prepare={prepareCommand}
										/>
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
									<Show
										when={
											Object.keys(current().detail).length &&
											current().page !== "providers"
										}
									>
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
							focused={current().focus === "content" && !settingsEditing()}
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
