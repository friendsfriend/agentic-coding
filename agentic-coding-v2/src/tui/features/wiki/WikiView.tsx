/** @jsxImportSource @opentui/solid */
// v1's Wiki view (src/tui/otel/views/WikiView.tsx), copied and adapted onto the
// native wiki: the same tree list, note reader and line-anchored review
// comments. v2 has no checkout wiki, so reads/saves use the authenticated
// gateway (wiki.list/read/save/comment) and nothing imports workflow sources.
import type { KeyEvent } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { Data, Methods } from "../../../protocol/index.ts";
import type { ClientConnection } from "../../client/connection.ts";
import { MarkdownViewer } from "../../presentation/components/MarkdownViewer.tsx";
import { Selectable } from "../../presentation/components/Selectable.tsx";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import {
	Form,
	type FormField,
	type FormPane,
	type FormValues,
	type KeybindSection,
	ScrollableList,
	uiColors,
	useKeyDispatch,
} from "../../ui/index.ts";
import { editorKeybinds, textareaBindings } from "../../ui/keybinds.ts";
import { wikiTree } from "./tree.ts";

type Draft =
	| {
			kind: "page";
			creating: boolean;
			id: string;
			title: string;
			content: string;
	  }
	| {
			kind: "comment";
			comment: string;
			profile: string;
			repository: string;
			baseRef: string;
	  };

const NOTES = new Set(["index.md", "log.md"]);

export function WikiView(props: {
	client: ClientConnection;
	/** Route-owned open note; null shows the tree (v1 route identity). */
	resource: string | null;
	tasks: Data[];
	repositories: string[];
	orchestratorProfile: string;
	connected: boolean;
	active: () => boolean;
	open: (id: string) => void;
	close: () => void;
	changed: () => void;
	notify: (message: string, error?: boolean) => void;
	catalog: (catalog: KeybindSection[]) => void;
	openTask: (id: number) => void;
}) {
	const dispatch = useKeyDispatch();
	const [pages, setPages] = createSignal<Data[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string>();
	const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
	const [selected, setSelected] = createSignal(0);
	const [document, setDocument] = createSignal<{
		page: Data;
		comments: Data[];
	}>();
	const [draft, setDraft] = createSignal<Draft>();
	const [fieldIndex, setFieldIndex] = createSignal(0);
	const [pane, setPane] = createSignal<FormPane>("field");
	const [choice, setChoice] = createSignal(0);
	const [busy, setBusy] = createSignal(false);
	// v1 v1-style inline entry: a textarea owns the caret while the value pane
	// is in entry mode; Escape/Tab leave it and the draft stays.
	const [editing, setEditing] = createSignal(false);
	let disposed = false,
		generation = 0;
	let area: { plainText?: string } | null = null;
	const ready = () => !disposed && props.connected && !busy() && !error();
	const report = (value: unknown) =>
		props.notify(value instanceof Error ? value.message : String(value), true);
	const rows = createMemo(() => {
		const tree = wikiTree(pages().map((page) => String(page.id)));
		return tree.flatten(expanded());
	});
	const note = createMemo(() => {
		const saved = document();
		return saved && props.resource && saved.page.id === props.resource
			? saved
			: undefined;
	});
	const ids = () => pages().map((page) => String(page.id));
	const load = async (id: string | null) => {
		const request = ++generation;
		if (!props.connected) {
			setError("Disconnected; the wiki is cached");
			return;
		}
		setLoading(true);
		try {
			const list = await props.client.call("wiki.list", {});
			if (disposed || generation !== request) return;
			setPages(list);
			setError(undefined);
			if (id) {
				if (!list.some((page) => page.id === id))
					throw new Error("Wiki page is unavailable; the draft remains unsent");
				const read = await props.client.call("wiki.read", { id });
				if (disposed || generation !== request) return;
				if (read.page.id !== id) throw new Error("Wrong native wiki identity");
				setDocument(read);
			} else setDocument(undefined);
		} catch (cause) {
			if (disposed || generation !== request) return;
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!disposed && generation === request) setLoading(false);
		}
	};
	createEffect(() => {
		const id = props.resource;
		props.connected;
		void load(id);
	});
	const openRow = (row: ReturnType<typeof rows>[number] | undefined) => {
		if (!row) return;
		if (row.kind === "directory")
			setExpanded((value) => {
				const next = new Set(value);
				if (next.has(row.id)) next.delete(row.id);
				else next.add(row.id);
				return next;
			});
		else props.open(row.id);
	};
	const navigate = (direction: 1 | -1) => {
		const all = ids();
		if (!all.length) return;
		const at = all.indexOf(props.resource ?? "");
		props.open(all[(at + direction + all.length) % all.length] ?? all[0] ?? "");
	};

	// ---- drafts ----
	const newPage = () => {
		if (!ready()) return;
		setFieldIndex(0);
		setPane("field");
		setEditing(false);
		setDraft({
			kind: "page",
			creating: true,
			id: "new-page",
			title: "New page",
			content: "",
		});
	};
	const editPage = () => {
		const saved = note();
		if (!ready() || !saved || typeof saved.page.content !== "string") return;
		setFieldIndex(0);
		setPane("field");
		setEditing(false);
		setDraft({
			kind: "page",
			creating: false,
			id: String(saved.page.id),
			title: String(saved.page.title),
			content: String(saved.page.content),
		});
	};
	const comment = () => {
		const saved = note();
		if (!ready() || !saved) return;
		setFieldIndex(0);
		setPane("field");
		setEditing(false);
		setDraft({
			kind: "comment",
			comment: "",
			profile: props.orchestratorProfile,
			repository: props.repositories[0] ?? "",
			baseRef: "HEAD",
		});
	};
	const fields = (): FormField[] => {
		const current = draft();
		if (!current) return [];
		if (current.kind === "comment")
			return [
				{ key: "comment", label: "Comment", kind: "text" },
				{
					key: "profile",
					label: "Review profile",
					kind: "select",
					options: props.orchestratorProfile ? [props.orchestratorProfile] : [],
				},
				{
					key: "repository",
					label: "Repository",
					kind: "select",
					options: props.repositories,
				},
				{
					key: "baseRef",
					label: "Git base",
					kind: "text",
					hint: "Pinned to a commit on admission",
				},
			];
		return [
			{
				key: "id",
				label: "Page identity",
				kind: "text",
				hint: current.creating
					? "Lowercase words joined by dashes"
					: "Identities cannot be renamed here",
			},
			{ key: "title", label: "Title", kind: "text" },
			{ key: "content", label: "Content (markdown)", kind: "text" },
		];
	};
	const values = (): FormValues => {
		const current = draft();
		if (!current) return {};
		return current.kind === "page"
			? { id: current.id, title: current.title, content: current.content }
			: {
					comment: current.comment,
					profile: current.profile,
					repository: current.repository,
					baseRef: current.baseRef,
				};
	};
	const field = createMemo(() => fields()[fieldIndex()]);
	const optionIndex = () => {
		const active = field();
		const options = active?.options ?? [];
		return choice() < options.length ? choice() : 0;
	};
	const setValue = (key: string, value: string) => {
		const current = draft();
		if (!current) return;
		const maximum = key === "content" ? 32000 : key === "comment" ? 4000 : 4096;
		if (value.length > maximum) return;
		setDraft({ ...current, [key]: value } as Draft);
	};
	const closeDraft = () => {
		setDraft(undefined);
		setChoice(0);
		setEditing(false);
	};
	const savePage = async (current: Extract<Draft, { kind: "page" }>) => {
		const saved = note();
		const body: Methods["wiki.save"]["input"] = {
			id: current.id.trim(),
			title: current.title.trim(),
			content: current.content,
			baseRevision:
				!current.creating && saved?.page.id === current.id
					? Number(saved.page.revision)
					: 0,
		};
		setBusy(true);
		try {
			const page = await props.client.call("wiki.save", body);
			closeDraft();
			props.changed();
			props.notify(`Wiki page ${String(page.id)} saved`);
			if (disposed) return;
			props.open(String(page.id));
			await load(String(page.id));
		} catch (cause) {
			if (!disposed) report(cause);
		} finally {
			if (!disposed) setBusy(false);
		}
	};
	const submitComment = async (
		current: Extract<Draft, { kind: "comment" }>,
	) => {
		const saved = note();
		if (!saved) return;
		setBusy(true);
		try {
			const result = await props.client.call("wiki.comment", {
				pageId: String(saved.page.id),
				pageRevision: Number(saved.page.revision),
				comment: current.comment.trim(),
				profile: current.profile,
				repository: current.repository,
				baseRef: current.baseRef.trim() || "HEAD",
				// Stable identity for one attempt; no automatic retry reuses it.
				requestId: `wiki-comment:${crypto.randomUUID()}`,
			});
			closeDraft();
			props.changed();
			props.notify(
				`Read-only review task #${result.taskId} admitted; admission is not completion or page modification.`,
			);
			await load(props.resource);
		} catch (cause) {
			if (!disposed) report(cause);
		} finally {
			if (!disposed) setBusy(false);
		}
	};
	const submit = () => {
		const current = draft();
		if (!current || !ready()) return;
		const current_values = values();
		if (current.kind === "comment") {
			if (!current_values.comment?.trim())
				return props.notify("A comment body is required", true);
			if (!current_values.profile || !current_values.repository)
				return props.notify("Choose a profile and repository", true);
			void submitComment(current);
			return;
		}
		const id = (current_values.id ?? "").trim();
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
			return props.notify(
				"Page identity must be lowercase words joined by dashes",
				true,
			);
		if (NOTES.has(`${id}.md`) && current.creating)
			return props.notify("index and log are reserved wiki files", true);
		if (!(current_values.title ?? "").trim())
			return props.notify("A page title is required", true);
		void savePage(current);
	};

	// ---- keys ----
	const moveField = (delta: number) => {
		setFieldIndex((index) =>
			Math.max(0, Math.min(fields().length - 1, index + delta)),
		);
	};
	const handleDraft = (event: KeyEvent, key: string): boolean => {
		const active = field();
		if (!active) return false;
		if (event.ctrl && key === "s") {
			submit();
			return true;
		}
		if (editing()) {
			// The textarea owns printable input; only leaving it is ours.
			if (key === "escape" || key === "tab") {
				setEditing(false);
				if (key === "tab") {
					moveField(event.shift ? -1 : 1);
					setPane("value");
				}
				return true;
			}
			return false;
		}
		if (key === "escape") {
			if (pane() === "value" && active.kind === "text") setPane("field");
			else closeDraft();
		} else if (key === "tab") {
			moveField(event.shift ? -1 : 1);
			setPane("value");
		} else if (key === "enter" || key === "return") submit();
		else if (pane() === "field") {
			if (key === "j" || key === "down") moveField(1);
			else if (key === "k" || key === "up") moveField(-1);
			else if (key === "l" || key === "right") setPane("value");
			else if (key !== "h" && key !== "left") return false;
		} else if (key === "h" || key === "left") setPane("field");
		else if (active.kind !== "select") {
			// v1's text entry: `e` (or Enter on the value pane) opens the field.
			if (key === "e" || key === "enter" || key === "return") {
				setEditing(true);
				return true;
			}
			if (key === "backspace" || key === "delete")
				setValue(active.key, (values()[active.key] ?? "").slice(0, -1));
			else if (event.sequence?.length === 1 && event.sequence >= " ")
				setValue(active.key, (values()[active.key] ?? "") + event.sequence);
			else return false;
		} else {
			const options = active.options ?? [];
			if (key === "j" || key === "down")
				setChoice(Math.min(options.length - 1, optionIndex() + 1));
			else if (key === "k" || key === "up")
				setChoice(Math.max(0, optionIndex() - 1));
			else if (key === "space")
				setValue(active.key, options[optionIndex()] ?? "");
			else return false;
		}
		return true;
	};
	const handle = (event: KeyEvent): boolean => {
		const key = event.name.toLowerCase();
		if (draft() && event.ctrl && key === "s") return handleDraft(event, key);
		if (event.ctrl || event.meta || event.option) return false;
		if (busy()) return true;
		if (draft()) return handleDraft(event, key);
		const saved = note();
		if (key === "?") return false;
		if (saved) {
			if (key === "escape") {
				props.close();
				return true;
			}
			if (key === "e" && typeof saved.page.content === "string") {
				editPage();
				return true;
			}
			if (key === "c") {
				comment();
				return true;
			}
			if (key === "n") {
				navigate(event.shift ? -1 : 1);
				return true;
			}
			if (key === "r") {
				void load(props.resource);
				return true;
			}
			return true;
		}
		if (key === "escape") return false;
		if (key === "w") {
			newPage();
			return true;
		}
		if (key === "r") {
			void load(null);
			return true;
		}
		if (key === "j" || key === "down") {
			setSelected((index) =>
				Math.min(Math.max(0, rows().length - 1), index + 1),
			);
			return true;
		}
		if (key === "k" || key === "up") {
			setSelected((index) => Math.max(0, index - 1));
			return true;
		}
		if (key === "enter" || key === "return") {
			openRow(rows()[selected()]);
			return true;
		}
		return false;
	};
	const keys = [
		"escape",
		"return",
		"enter",
		"tab",
		"shift+tab",
		"space",
		"up",
		"down",
		"left",
		"right",
		"home",
		"end",
	];
	const unregister = useKeymap().registerLayer({
		id: "v2.wiki",
		priority: 80,
		enabled: () => props.active(),
		commands: [{ name: "wiki.handle", run: ({ event }) => handle(event) }],
		bindings: [
			...keys,
			"j",
			"k",
			"h",
			"l",
			"e",
			"c",
			"n",
			"N",
			"r",
			"w",
			"backspace",
			"delete",
			..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_[]{};:\\|,.<>`~!@#$%^&*() /'\"="
				.split("")
				.map((key) => (key === " " ? "space" : key)),
		]
			.filter((key, index, all) => all.indexOf(key) === index)
			.map((key) => ({
				key,
				cmd: "wiki.handle",
			})),
	});
	createEffect(() => {
		const current = draft();
		props.catalog([
			{
				title: current
					? current.kind === "comment"
						? "Wiki review comment"
						: "Wiki page"
					: note()
						? "Wiki note"
						: "Wiki",
				keybinds: current
					? [
							{ key: "h/l", action: "focus fields/value", standard: true },
							{
								key: "j/k or ↑/↓",
								action: "move fields/choices",
								standard: true,
							},
							{
								key: "Space",
								action: "select highlighted choice",
								short: "select",
							},
							{ key: "Tab", action: "next field", standard: true },
							{ key: "Enter", action: "validate and save", short: "save" },
							{ key: "Esc", action: "cancel", short: "cancel", standard: true },
						]
					: note()
						? [
								{ key: "j/k or ↑/↓", action: "scroll", standard: true },
								{ key: "e", action: "edit page", short: "edit" },
								{ key: "c", action: "add review comment", short: "comment" },
								{ key: "n", action: "next note", short: "next" },
								{ key: "N", action: "previous note", short: "prev" },
								{ key: "r", action: "reload", short: "reload" },
								{ key: "Esc", action: "back to the wiki", standard: true },
							]
						: [
								{ key: "j/k or ↑/↓", action: "select entry", standard: true },
								{ key: "Enter", action: "open note", short: "open" },
								{ key: "w", action: "new wiki page", short: "new" },
								{ key: "r", action: "reload", short: "reload" },
								{ key: "Esc", action: "parent page", standard: true },
							],
			},
		]);
	});
	onCleanup(() => {
		disposed = true;
		unregister();
		props.catalog([]);
	});
	onMount(() => {
		void load(props.resource);
	});

	const taskMember = (comment: Data) =>
		Number.isSafeInteger(comment.taskId) &&
		props.tasks.filter((task) => task.id === comment.taskId).length === 1;
	const renderRow = (
		row: Accessor<ReturnType<typeof rows>[number]>,
		selectedRow: Accessor<boolean>,
		index: Accessor<number>,
	) => (
		<Selectable
			height={1}
			selected={selectedRow()}
			onMouseUp={() => setSelected(index())}
			onActivate={() => dispatch("Enter")}
		>
			<box height={1}>
				<text fg={uiColors.textPrimary}>
					{"  ".repeat(row().depth)}
					{row().kind === "directory"
						? expanded().has(row().id)
							? "▾ "
							: "▸ "
						: "• "}
					{row().label}
				</text>
			</box>
		</Selectable>
	);

	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
		>
			<Show when={loading()}>
				<text fg={uiColors.textMuted}>Reading native wiki…</text>
			</Show>
			<Show when={!props.connected}>
				<text fg={uiColors.warning}>
					Disconnected · reads and saves withheld
				</text>
			</Show>
			<Show when={error()}>
				<text fg={uiColors.warning}>{error()}</text>
			</Show>
			<Show when={busy()}>
				<text fg={uiColors.textMuted}>Saving…</text>
			</Show>
			<Show when={draft()} keyed>
				{(current) => (
					<box flexDirection="column" gap={1}>
						<text fg={uiColors.primary}>
							{current.kind === "comment"
								? "Review comment · proposes changes, never applies them"
								: current.creating
									? "New wiki page"
									: `Edit ${current.id}`}
						</text>
						<Form
							fields={fields()}
							values={values()}
							activeIndex={fieldIndex()}
							focusedPane={pane()}
							choiceCursorIndex={optionIndex()}
							editing={false}
							header={current.kind === "comment" ? "Comment" : "Page"}
						/>
						<Show when={editing() && field()}>
							{(active) => (
								<box flexDirection="column">
									<text fg={uiColors.textMuted}>
										{active().label} · Enter adds a line · Ctrl+S saves · Esc
										leaves the text
									</text>
									<textarea
										ref={(value) => {
											area = value as unknown as {
												plainText?: string;
											} | null;
										}}
										initialValue={values()[active().key] ?? ""}
										focused={true}
										height={12}
										width="100%"
										keyBindings={textareaBindings(editorKeybinds)}
										onContentChange={() => {
											const value = area?.plainText;
											if (
												typeof value === "string" &&
												value !== values()[active().key]
											)
												setValue(active().key, value);
										}}
									/>
								</box>
							)}
						</Show>
					</box>
				)}
			</Show>
			<Show when={!draft()}>
				<Show
					when={note()}
					fallback={
						<Show when={!loading() && !error()}>
							<text fg={uiColors.primary}>Wiki · {pages().length} pages</text>
							<text wrapMode="word" fg={uiColors.textMuted}>
								Comments are proposals: submitting one admits a read-only review
								task
							</text>
							<Show
								when={rows().length}
								fallback={
									<text fg={uiColors.textMuted}>
										No native wiki pages yet · w creates one
									</text>
								}
							>
								<ScrollableList
									items={rows()}
									itemKey={(row) => `${row.kind}:${row.id}`}
									selectedIndex={selected()}
									onSelect={setSelected}
									availableLines={12}
									estimatedItemHeight={1}
									showScrollIndicator={false}
									renderItem={(row, selectedRow, index) =>
										renderRow(
											() => row,
											selectedRow,
											() => index,
										)
									}
									renderReactiveItem={renderRow}
								/>
							</Show>
						</Show>
					}
				>
					{(saved) => (
						<box flexDirection="column" gap={1}>
							<text wrapMode="word">
								{String(saved().page.title)} · {String(saved().page.id)}@
								{String(saved().page.revision)} · digest{" "}
								{String(saved().page.digest)}
							</text>
							<Show
								when={typeof saved().page.content === "string"}
								fallback={
									<text fg={uiColors.warning}>
										Page content was not supplied (distinct from an empty page).
									</text>
								}
							>
								<MarkdownViewer content={String(saved().page.content)} />
							</Show>
							<Show when={saved().comments.length}>
								<text fg={uiColors.primary}>Review comments</text>
								<For each={saved().comments}>
									{(comment, index) => (
										<box flexDirection="column">
											<text wrapMode="word" fg={uiColors.textSecondary}>
												{index() + 1}. {String(comment.comment)} · revision{" "}
												{String(comment.pageRevision)}
											</text>
											<Show
												when={taskMember(comment)}
												fallback={
													<text fg={uiColors.warning}>
														Review task {String(comment.taskId)} is not in the
														observed catalog
													</text>
												}
											>
												<ActionHeader
													scope={[saved(), props.tasks]}
													interactive={true}
													onActivate={() =>
														props.openTask(Number(comment.taskId))
													}
												>
													<text fg={uiColors.accent}>
														Open review task #{String(comment.taskId)}
													</text>
												</ActionHeader>
											</Show>
										</box>
									)}
								</For>
							</Show>
							<Show when={typeof saved().page.content === "string"}>
								<ActionHeader
									scope={[saved(), ready()]}
									interactive={ready()}
									onActivate={() => {
										if (ready()) editPage();
									}}
								>
									<text fg={uiColors.accent}>e Edit page</text>
								</ActionHeader>
							</Show>
							<ActionHeader
								scope={[saved(), ready()]}
								interactive={ready()}
								onActivate={() => {
									if (ready()) comment();
								}}
							>
								<text fg={uiColors.warning}>c Submit review comment</text>
							</ActionHeader>
						</box>
					)}
				</Show>
			</Show>
			<Show when={!draft() && note()}>
				<ActionHeader
					scope={[note(), ready()]}
					interactive={ready()}
					onActivate={() => {
						if (ready()) newPage();
					}}
				>
					<text fg={uiColors.accent}>w New wiki page</text>
				</ActionHeader>
			</Show>
		</box>
	);
}
