/** @jsxImportSource @opentui/solid */

import {
	Card,
	Form,
	type FormErrors,
	type FormValues,
	firstErrorField,
	formStepOption,
	type KeybindSection,
	ScrollableContent,
	ScrollableList,
	setActiveKeybindCatalog,
	uiColors,
	useTerminalDimensions,
} from "@agentic-coding/ui";
import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { useKeyboard } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import {
	type Job,
	type Occurrence,
	type Schedule,
	SchedulingError,
} from "../../contracts/scheduling.ts";
import type {
	SchedulingRequest,
	SchedulingResponse,
} from "../../contracts/scheduling-api.ts";
import { instant } from "../../scheduling/recurrence.ts";
import {
	type BackendClient,
	BackendClientError,
	backendClient,
} from "../../server/client.ts";
import { estimateTextRows } from "../dash/ui/transcript-viewport.tsx";
import {
	type EditorBasis,
	type EditorMode,
	schedulingDraft,
	schedulingFields,
	schedulingSave,
} from "./editor.ts";
import {
	type SchedulingSurface,
	schedulingKeybindCatalog,
} from "./keybinds.ts";
import { ScheduleDetails } from "./ScheduleDetails.tsx";

type Summary = Extract<
	SchedulingResponse,
	{ kind: "schedules" }
>["summaries"][number];
interface Row {
	id: string;
	label: string;
	description: string;
}
function schedulingTextInput(event: KeyEvent): string {
	if (event.ctrl || event.meta) return "";
	if (event.sequence && isPlainText(event.sequence)) return event.sequence;
	const value =
		event.name === "space"
			? " "
			: event.shift
				? event.name.toUpperCase()
				: event.name;
	return Array.from(value).length === 1 && isPlainText(value) ? value : "";
}
const schedulingInputKeys = [
	"f2",
	"escape",
	"return",
	"enter",
	"tab",
	"shift+tab",
	"backspace",
	"delete",
	"up",
	"down",
	"left",
	"right",
	"pageup",
	"pagedown",
	"ctrl+return",
	"ctrl+enter",
	"ctrl+r",
	"ctrl+u",
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=+[]{};:\\|,.<>`~!@#$%^&*()/?'\" "
		.split("")
		.map((key) => (key === " " ? "space" : key)),
];
interface Pending {
	request: SchedulingRequest;
	owner: string;
	label: string;
	detail: string;
	returnTo: SchedulingSurface;
	attempted: boolean;
}
type ManualClient = Pick<BackendClient, "scheduling" | "baseUrl">;
/** Owned by the shell's route-state store, never by a second navigation stack. */
export interface SchedulingViewState {
	owner: string | undefined;
	surface: SchedulingSurface;
	tab: "schedules" | "jobs";
	index: number;
	filter: string;
	filterFrom?: "list" | "history";
	basis: EditorBasis | undefined;
	values: FormValues;
	fieldIndex: number;
	editing: boolean;
	pending: Pending | undefined;
	historyId: string | undefined;
	outputId: string | undefined;
	after: {
		jobs: string | undefined;
		schedules: string | undefined;
		history: string | undefined;
	};
	before: {
		jobs: (string | undefined)[];
		schedules: (string | undefined)[];
		history: (string | undefined)[];
	};
}
function isPlainText(value: string): boolean {
	return Array.from(value).every((character) => {
		const code = character.codePointAt(0) ?? 0;
		return (
			code === 9 || code === 10 || (code >= 32 && code < 127) || code >= 160
		);
	});
}
export interface SchedulesViewProps {
	readonly keymap: Keymap<Renderable, KeyEvent>;
	readonly active: () => boolean;
	readonly onBack: () => void;
	readonly additionalKeybinds?: readonly KeybindSection[];
	readonly initialState?: SchedulingViewState;
	readonly onStateChange?: (state: SchedulingViewState) => void;
	readonly client?: ManualClient;
	readonly onOpenWorkflow?: (target: {
		repository: string;
		workflowId: string;
	}) => void;
	readonly onOpenConversation?: (occurrence: Occurrence) => void;
}
export function SchedulesView(props: SchedulesViewProps) {
	const dimensions = useTerminalDimensions();
	const narrow = () => dimensions().width < 100;
	const detailWidth = () =>
		Math.max(
			1,
			surface() === "output" || narrow()
				? dimensions().width - 4
				: Math.floor(dimensions().width * 0.62) - 6,
		);
	const initial = props.initialState;
	const [storeId, setStoreId] = createSignal(initial?.owner);
	const [jobsAfter, setJobsAfter] = createSignal(initial?.after.jobs),
		[schedulesAfter, setSchedulesAfter] = createSignal(
			initial?.after.schedules,
		),
		[historyAfter, setHistoryAfter] = createSignal(initial?.after.history);
	const before = {
		jobs: [...(initial?.before.jobs ?? [])],
		schedules: [...(initial?.before.schedules ?? [])],
		history: [...(initial?.before.history ?? [])],
	};
	const [outputId, setOutputId] = createSignal(initial?.outputId);
	const [surface, setSurface] = createSignal<SchedulingSurface>(
			initial?.surface ?? "list",
		),
		[tab, setTab] = createSignal<"schedules" | "jobs">(
			initial?.tab ?? "schedules",
		),
		[index, setIndex] = createSignal(initial?.index ?? 0);
	const [jobs, setJobs] = createSignal<Job[]>([]),
		[schedules, setSchedules] = createSignal<Schedule[]>([]),
		[summaries, setSummaries] = createSignal<Summary[]>([]),
		[history, setHistory] = createSignal<Occurrence[]>([]);
	const [jobsCursor, setJobsCursor] = createSignal<string>(),
		[schedulesCursor, setSchedulesCursor] = createSignal<string>(),
		[historyCursor, setHistoryCursor] = createSignal<string>(),
		[historyId, setHistoryId] = createSignal<string | undefined>(
			initial?.historyId,
		);
	const [filter, setFilter] = createSignal(initial?.filter ?? ""),
		[banner, setBanner] = createSignal(""),
		[status, setStatus] = createSignal("Connecting to scheduling service…"),
		[detail, setDetail] = createSignal("Select an item."),
		[busy, setBusy] = createSignal(false);
	const [basis, setBasis] = createSignal<EditorBasis | undefined>(
			initial?.basis,
		),
		[values, setValues] = createSignal<FormValues>(initial?.values ?? {}),
		[fieldIndex, setFieldIndex] = createSignal(initial?.fieldIndex ?? 0),
		[editing, setEditing] = createSignal(initial?.editing ?? false),
		[pending, setPending] = createSignal<Pending | undefined>(initial?.pending);
	const [fieldErrors, setFieldErrors] = createSignal<FormErrors>({});
	const [filterFrom, setFilterFrom] = createSignal<"list" | "history">(
		initial?.filterFrom ?? "list",
	);
	const historyView = () =>
		surface() === "history" ||
		(surface() === "filter" && filterFrom() === "history");
	let disposed = false,
		detailGeneration = 0,
		lastDetailSelection = "",
		detailScroll: ScrollBoxRenderable | undefined;
	const lines = () => Math.max(6, dimensions().height - 11);
	const client = () => props.client ?? backendClient();
	const enteringText = () =>
		(surface() === "editor" && editing()) ||
		surface() === "filter" ||
		surface() === "postpone";
	// A command can open text entry during this same key dispatch (for example P).
	// Do not then insert that opening command as the first draft character.
	const commandEvents = new WeakSet<KeyEvent>();
	useKeyboard((event) => {
		if (commandEvents.has(event)) return;
		const text = schedulingTextInput(event);
		if (props.active() && enteringText() && text) handle(event);
	});
	let textEntryOwner = false;
	createEffect(() => {
		if (props.active()) {
			textEntryOwner = true;
			props.keymap.setData(
				"textEntry.active",
				(surface() === "editor" && editing()) ||
					surface() === "filter" ||
					surface() === "postpone",
			);
		} else if (textEntryOwner) {
			props.keymap.setData("textEntry.active", false);
			textEntryOwner = false;
		}
	});
	let verifiedClient: ManualClient | undefined;
	function verifyStatus(response: SchedulingResponse, current: ManualClient) {
		if (response.kind !== "status")
			throw new Error("Scheduling service identity is unavailable.");
		if (storeId() && storeId() !== response.status.storeId)
			throw new Error(
				"The scheduling store changed. Restore the original server before using this saved draft or acknowledgement.",
			);
		setStoreId(response.status.storeId);
		verifiedClient = current;
	}
	function snapshot(): SchedulingViewState {
		return {
			owner: storeId(),
			surface: surface(),
			tab: tab(),
			index: index(),
			filter: filter(),
			filterFrom: filterFrom(),
			basis: basis(),
			values: values(),
			fieldIndex: fieldIndex(),
			editing: editing(),
			pending: pending(),
			historyId: historyId(),
			outputId: outputId(),
			after: {
				jobs: jobsAfter(),
				schedules: schedulesAfter(),
				history: historyAfter(),
			},
			before: {
				jobs: [...before.jobs],
				schedules: [...before.schedules],
				history: [...before.history],
			},
		};
	}
	createEffect(() => {
		const state = snapshot();
		props.onStateChange?.(state);
	});
	async function call(request: SchedulingRequest) {
		const current = client();
		if (!current)
			throw new Error(
				"Scheduling requires an authenticated server connection.",
			);
		if (request.operation !== "status" && verifiedClient !== current)
			verifyStatus(await current.scheduling({ operation: "status" }), current);
		const response = await current.scheduling(
			request,
			undefined,
			request.operation === "status" ? undefined : storeId(),
		);
		if (request.operation === "status") verifyStatus(response, current);
		return response;
	}
	const failure = (error: unknown) =>
		error instanceof Error ? error.message : String(error);
	const rows = createMemo<Row[]>(() => {
		let result: Row[];
		if (historyView())
			result = history().map((value) => ({
				id: value.id,
				label: `${value.state} · ${new Date(value.nominalDue).toISOString()}`,
				description: `${value.reason ?? ""} ${value.receipt?.result ?? ""}`,
			}));
		else if (tab() === "jobs")
			result = jobs().map((job) => ({
				id: job.id,
				label: job.name,
				description: `${job.target.kind} · ${job.target.kind === "wake-up" ? "orchestrator" : job.target.repository} · revision ${job.revision}`,
			}));
		else
			result = schedules().map((schedule) => {
				const summary = summaries().find(
					(value) => value.scheduleId === schedule.id,
				);
				return {
					id: schedule.id,
					label: `${schedule.name} · ${schedule.state}`,
					description: `${summary?.targetKind ?? ""} · ${schedule.timing.kind} ${schedule.timing.timezone} · next ${schedule.nextDue === null ? "none" : new Date(schedule.nextDue).toISOString()} · last ${summary?.lastOutcome?.state ?? "none"} · ${summary?.activeStates.join(", ") ?? ""}${summary?.latenessMs ? ` · late ${Math.floor(summary.latenessMs / 1000)}s` : ""} · ${summary?.project ?? ""}`,
				};
			});
		const query = filter().toLowerCase();
		return query
			? result.filter((row) =>
					`${row.label} ${row.description} ${row.id}`
						.toLowerCase()
						.includes(query),
				)
			: result;
	});
	const selected = () => rows()[index()];
	const rowHeights = () => {
		const width = Math.max(
			1,
			(narrow()
				? dimensions().width - 2
				: Math.floor((dimensions().width - 2) * 0.38)) - 4,
		);
		return rows().map(
			(row) =>
				estimateTextRows(row.label, width) +
				estimateTextRows(row.description, width) +
				1,
		);
	};
	function captureInteraction() {
		const source = surface(),
			sourceTab = tab(),
			sourceBasis = basis(),
			draft = values();
		const tracksSelection = source === "list" || source === "history";
		const id = tracksSelection ? selected()?.id : undefined;
		return () =>
			!disposed &&
			props.active() &&
			!pending()?.attempted &&
			surface() === source &&
			tab() === sourceTab &&
			basis() === sourceBasis &&
			values() === draft &&
			(!tracksSelection || selected()?.id === id);
	}
	const fields = () => {
		const current = basis();
		return current ? schedulingFields(values(), current.mode, jobs()) : [];
	};
	createEffect(() => {
		const last = Math.max(0, fields().length - 1);
		if (fieldIndex() > last) setFieldIndex(last);
	});
	createEffect(() => {
		if (props.active())
			setActiveKeybindCatalog([
				...schedulingKeybindCatalog(
					surface(),
					tab() === "jobs",
					schedules().find((value) => value.id === selected()?.id)?.state ===
						"paused",
					editing(),
					history().find((value) => value.id === selected()?.id)?.state ===
						"waiting-review",
					pending()?.attempted ?? false,
				),
				...(props.additionalKeybinds ?? []),
			]);
	});
	async function loadDetail() {
		const ticket = ++detailGeneration;
		const row = selected();
		if (!row) {
			setDetail("No items match the loaded page.");
			return;
		}
		const selection = `${surface()}:${tab()}:${row.id}`;
		try {
			const request: SchedulingRequest = historyView()
				? { operation: "occurrences.get", id: row.id }
				: tab() === "jobs"
					? { operation: "jobs.get", id: row.id }
					: { operation: "schedules.get", id: row.id };
			const result = await call(request);
			if (disposed || ticket !== detailGeneration) return;
			const summary = summaries().find((value) => value.scheduleId === row.id);
			setDetail(
				JSON.stringify({ ...(summary ? { summary } : {}), ...result }, null, 2),
			);
			if (lastDetailSelection !== selection) {
				lastDetailSelection = selection;
				detailScroll?.scrollTo(0);
			}
		} catch (error) {
			if (!disposed && ticket === detailGeneration)
				setDetail(`Unavailable: ${failure(error)}`);
		}
	}
	function choose(next: number) {
		setIndex(Math.max(0, Math.min(rows().length - 1, next)));
		void loadDetail();
	}
	async function refresh(more = false) {
		if (busy()) return;
		let stableId: string | undefined;
		setBusy(true);
		try {
			const nextJobsAfter =
				more && tab() === "jobs" ? jobsCursor() : jobsAfter();
			const nextSchedulesAfter =
				more && tab() === "schedules" ? schedulesCursor() : schedulesAfter();
			const nextHistoryAfter = more ? historyCursor() : historyAfter();
			const health = await call({ operation: "status" });
			if (disposed) return;
			if (health.kind === "status")
				setStatus(
					`${health.status.available ? "Service running" : "Service unavailable"} · no machine wake · service must remain running · polling allowance ${health.status.pollingAllowanceMs}ms`,
				);
			if (surface() === "output") {
				const id = outputId();
				if (id) {
					const result = await call({ operation: "occurrences.get", id });
					if (
						!disposed &&
						surface() === "output" &&
						outputId() === id &&
						result.kind === "occurrence"
					)
						showOutput(result.occurrence);
				}
			} else if (historyView()) {
				const id = historyId();
				if (id) {
					const result = await call({
						operation: "history",
						scheduleId: id,
						limit: 100,
						...(nextHistoryAfter ? { after: nextHistoryAfter } : {}),
					});
					if (
						!disposed &&
						historyView() &&
						historyId() === id &&
						result.kind === "occurrences"
					) {
						stableId = selected()?.id;
						if (more) {
							before.history.push(historyAfter());
							if (before.history.length > 100) before.history.shift();
						}
						setHistoryAfter(nextHistoryAfter);
						setHistory([...result.items]);
						setHistoryCursor(result.nextCursor);
					}
				}
			} else {
				const [jobPage, schedulePage] = await Promise.all([
					call({
						operation: "jobs.list",
						limit: 100,
						...(nextJobsAfter ? { after: nextJobsAfter } : {}),
					}),
					call({
						operation: "schedules.list",
						limit: 100,
						...(nextSchedulesAfter ? { after: nextSchedulesAfter } : {}),
					}),
				]);
				if (disposed) return;
				stableId = selected()?.id;
				if (jobPage.kind === "jobs") {
					if (more && tab() === "jobs") {
						before.jobs.push(jobsAfter());
						if (before.jobs.length > 100) before.jobs.shift();
					}
					setJobsAfter(nextJobsAfter);
					setJobs([...jobPage.items]);
					setJobsCursor(jobPage.nextCursor);
				}
				if (schedulePage.kind === "schedules") {
					if (more && tab() === "schedules") {
						before.schedules.push(schedulesAfter());
						if (before.schedules.length > 100) before.schedules.shift();
					}
					setSchedulesAfter(nextSchedulesAfter);
					setSchedules([...schedulePage.items]);
					setSummaries([...schedulePage.summaries]);
					setSchedulesCursor(schedulePage.nextCursor);
				}
			}
			if (surface() === "list" || surface() === "filter" || historyView()) {
				const stableIndex = stableId
					? rows().findIndex((row) => row.id === stableId)
					: -1;
				setIndex(
					more
						? 0
						: stableIndex >= 0
							? stableIndex
							: Math.max(0, Math.min(index(), rows().length - 1)),
				);
				await loadDetail();
			}
		} catch (error) {
			setStatus(
				`Scheduling unavailable: ${failure(error)}. Existing details are retained.`,
			);
		} finally {
			if (!disposed) setBusy(false);
		}
	}
	async function openEditor(mode: EditorMode) {
		const unchanged = captureInteraction();
		setBanner("");
		try {
			let job: Job | undefined,
				schedule: Schedule | undefined,
				affectedSchedules: readonly string[] | undefined;
			const row = selected();
			if (mode === "schedule-edit") {
				if (!row) return;
				const response = await call({ operation: "schedules.get", id: row.id });
				if (response.kind !== "schedule") return;
				schedule = response.schedule;
				const responseJob = await call({
					operation: "jobs.get",
					id: schedule.jobId,
				});
				if (responseJob.kind !== "job") return;
				job = responseJob.job;
			}
			if (mode === "job-edit") {
				if (!row) return;
				const response = await call({ operation: "jobs.get", id: row.id });
				if (response.kind !== "job") return;
				job = response.job;
				affectedSchedules = response.affectedSchedules;
			}
			if (!unchanged()) return;
			if (job && !jobs().some((value) => value.id === job.id))
				setJobs([...jobs(), job]);
			const next: EditorBasis = {
				mode,
				requestId: crypto.randomUUID(),
				...(job ? { job } : {}),
				...(schedule ? { schedule } : {}),
				...(affectedSchedules ? { affectedSchedules } : {}),
			};
			setBasis(next);
			setValues(schedulingDraft(next, Date.now()));
			setFieldIndex(0);
			setEditing(false);
			setPending(undefined);
			setSurface("editor");
		} catch (error) {
			setBanner(failure(error));
		}
	}
	function review(
		request: SchedulingRequest,
		label: string,
		context: unknown,
		returnTo: SchedulingSurface = surface(),
	) {
		if (pending()?.attempted)
			throw new Error(
				"The original acknowledgement is unknown. Retry the pinned request before preparing another change.",
			);
		const current = client();
		if (!current) throw new Error("Scheduling service is unavailable.");
		setPending({
			request,
			owner: storeId() ?? "",
			label,
			detail: JSON.stringify(
				{
					request,
					context,
					notice:
						"Changes apply to future unadmitted work. Already admitted or running work is preserved. No machine wake is provided.",
				},
				null,
				2,
			),
			returnTo,
			attempted: false,
		});
		setBanner("");
		setSurface("confirm");
		setEditing(false);
		detailScroll?.scrollTo(0);
	}
	async function prepareSave() {
		setFieldErrors({});
		const unchanged = captureInteraction(),
			draft = values();
		const current = basis();
		if (!current) return;
		try {
			await call({ operation: "status" });
			let request = schedulingSave(draft, current);
			let preview: unknown;
			if (
				request.operation === "create" ||
				request.operation === "schedules.create" ||
				request.operation === "schedules.update"
			) {
				const response = await call({
					operation: "preview",
					timing: request.schedule.timing,
				});
				if (response.kind !== "preview")
					throw new Error("Scheduling preview is unavailable.");
				preview = response.preview;
				// Commit exactly the previewed instant, never a new relative time on retry.
				const timing = response.preview.timing;
				switch (request.operation) {
					case "create":
						request = { ...request, schedule: { ...request.schedule, timing } };
						break;
					case "schedules.create":
						request = { ...request, schedule: { ...request.schedule, timing } };
						break;
					case "schedules.update":
						request = { ...request, schedule: { ...request.schedule, timing } };
						break;
				}
			}
			if (!unchanged()) return;
			review(
				request,
				"Save scheduling changes",
				{
					preview,
					affectedSchedules: current.affectedSchedules ?? [],
					reusedJob: jobs().find((job) => job.id === values().jobId),
				},
				"editor",
			);
		} catch (error) {
			if (
				error instanceof SchedulingError ||
				error instanceof BackendClientError
			) {
				const aliases: Record<string, string> = {
					"job.name": "jobName",
					"schedule.name": "scheduleName",
					"target.kind": "target",
					"timing.kind": "timing",
					"timing.delayMs": "delay",
					"timing.everyMs": "every",
					"latePolicy.graceMs": "grace",
					"latePolicy.kind": "late",
				};
				const errors: FormErrors = {};
				for (const issue of error.issues) {
					const source = issue.path.replace(/^\$\./, ""),
						short = source.replace(/^(job|schedule)\./, "");
					const key =
						aliases[source] ??
						aliases[short] ??
						short.replace(/^(target|timing)\./, "").replace(/\[.*$/, "");
					if (fields().some((field) => field.key === key))
						errors[key] = issue.message;
				}
				setFieldErrors(errors);
				if (Object.keys(errors).length) {
					setFieldIndex(firstErrorField(fields(), errors));
					setEditing(false);
				}
			}
			setBanner(`Draft retained: ${failure(error)}`);
		}
	}
	async function execute() {
		const current = pending();
		if (!current || busy()) return;
		if (storeId() !== current.owner) {
			setBanner(
				"The server connection changed. Restore the original server before retrying this request.",
			);
			return;
		}
		setBusy(true);
		setPending({ ...current, attempted: true });

		try {
			const result = await call(current.request);
			setPending(undefined);
			setBasis(undefined);
			setSurface("list");
			setBanner(
				`Saved · request ${"requestId" in current.request ? current.request.requestId : ""}`,
			);
			if (result.kind === "created") setTab("schedules");
			if (result.kind === "job") setTab("jobs");
		} catch (error) {
			if (
				!current.attempted &&
				error instanceof BackendClientError &&
				error.status >= 400 &&
				error.status < 500
			) {
				setPending({ ...current, attempted: false });
			}
			setBanner(
				`${failure(error)} · ${current.attempted ? "The original acknowledgement is still unknown. Retry the pinned request on its original store." : error instanceof BackendClientError && error.code !== "scheduling-store-changed" && error.status === 409 ? "Reload the saved version before applying edits. Draft retained." : "Retry retains the exact request identity and preview."}`,
			);
		} finally {
			setBusy(false);
		}
		if (!pending()) await refresh();
	}
	async function action(
		action: Extract<
			SchedulingRequest,
			{ operation: "schedules.action" }
		>["action"],
	) {
		const unchanged = captureInteraction();
		const row = selected();
		if (!row) return;
		try {
			const response = await call({ operation: "schedules.get", id: row.id });
			if (response.kind !== "schedule" || !unchanged()) return;
			const schedule = response.schedule;
			review(
				{
					operation: "schedules.action",
					requestId: crypto.randomUUID(),
					id: schedule.id,
					revision: schedule.revision,
					action,
				},
				`${action.slice(0, 1).toUpperCase()}${action.slice(1).replaceAll("-", " ")} · ${schedule.name}`,
				response,
			);
		} catch (error) {
			setBanner(failure(error));
		}
	}
	async function deleteJob() {
		const unchanged = captureInteraction();
		const row = selected();
		if (!row) return;
		try {
			const result = await call({ operation: "jobs.get", id: row.id });
			if (!unchanged()) return;
			if (result.kind === "job")
				review(
					{
						operation: "jobs.delete",
						requestId: crypto.randomUUID(),
						id: result.job.id,
						revision: result.job.revision,
					},
					"Delete reusable job",
					result,
				);
		} catch (error) {
			setBanner(failure(error));
		}
	}
	async function initializeDestination() {
		const unchanged = captureInteraction();
		const current = basis();
		if (!current) return;
		try {
			const result = await call({
				operation: "destination",
				requestId: `${current.requestId}-destination`,
			});
			if (!unchanged()) return;
			if (result.kind === "destination")
				setValues({
					...values(),
					hostId: result.target.hostId,
					hostSocket: result.target.hostSocket,
					conversationId: result.target.conversationId,
					runId: result.target.runId,
				});
		} catch (error) {
			setBanner(`Destination unavailable; draft retained: ${failure(error)}`);
		}
	}
	async function openHistory() {
		const row = selected();
		if (!row) return;
		setHistoryId(row.id);
		setHistoryAfter(undefined);
		before.history = [];
		setHistory([]);
		setHistoryCursor(undefined);
		setIndex(0);
		setFilter("");
		setSurface("history");
		await refresh();
	}
	async function approve() {
		const unchanged = captureInteraction();
		const row = selected();
		if (!row) return;
		try {
			const result = await call({ operation: "occurrences.get", id: row.id });
			if (result.kind !== "occurrence" || !unchanged()) return;
			const occurrence = result.occurrence;
			if (occurrence.state !== "waiting-review")
				throw new Error(
					"This occurrence is not awaiting writable-execution approval.",
				);
			review(
				{
					operation: "occurrences.approve",
					requestId: crypto.randomUUID(),
					id: occurrence.id,
					fence: occurrence.fence,
				},
				"Approve this writable standalone occurrence",
				occurrence,
			);
		} catch (error) {
			setBanner(failure(error));
		}
	}
	function showOutput(value: Occurrence) {
		const changed = surface() !== "output" || outputId() !== value.id;
		setOutputId(value.id);
		setSurface("output");
		setDetail(
			JSON.stringify(
				{
					occurrenceId: value.id,
					state: value.state,
					output:
						value.receipt?.result ??
						"No terminal assistant output has been captured. Native identity/evidence links below remain authoritative.",
					reason: value.reason,
					target: value.job.target,
					receipt: value.receipt
						? { ...value.receipt, result: undefined }
						: undefined,
				},
				null,
				2,
			),
		);
		if (changed) detailScroll?.scrollTo(0);
	}
	async function openTarget(id = selected()?.id) {
		const unchanged = captureInteraction();
		if (!id || busy()) return;
		const ticket = ++detailGeneration;
		setBusy(true);
		try {
			const result = await call({ operation: "occurrences.get", id });
			if (
				disposed ||
				ticket !== detailGeneration ||
				!unchanged() ||
				result.kind !== "occurrence"
			)
				return;
			const value = result.occurrence;
			if (
				value.admittedAt !== undefined &&
				value.receipt?.workflow &&
				props.onOpenWorkflow
			)
				props.onOpenWorkflow(value.receipt.workflow);
			else if (value.admittedAt !== undefined && props.onOpenConversation)
				props.onOpenConversation(value);
			else {
				showOutput(value);
				detailScroll?.scrollTo(0);
			}
		} catch (error) {
			setBanner(failure(error));
		} finally {
			if (!disposed) setBusy(false);
		}
	}
	function setField(key: string, value: string) {
		setValues({
			...values(),
			[key]: value,
			...(key === "policy"
				? { review: value === "default" ? "human" : "none" }
				: {}),
		});
	}
	function back() {
		if (surface() === "confirm") {
			if (pending()?.attempted) {
				setBanner(
					"Acknowledgement is uncertain. Retry this exact request, or inspect persisted state after reconnecting.",
				);
				return;
			}
			setSurface(pending()?.returnTo ?? "list");
			setPending(undefined);
			return;
		}
		if (surface() === "editor" || surface() === "postpone") {
			setEditing(false);
			setSurface("list");
			setBasis(undefined);
			setBanner("Unsaved draft discarded.");
			return;
		}
		if (surface() === "output") {
			setSurface("history");
			setIndex(0);
			void refresh();
			return;
		}
		if (surface() === "filter") {
			setSurface(filterFrom());
			setFilter("");
			choose(0);
			return;
		}
		if (surface() === "history") {
			setSurface("list");
			setFilter("");
			setIndex(0);
			void refresh();
			return;
		}
		props.onBack();
	}
	function handle(event: KeyEvent): boolean {
		if (!props.active()) return false;
		const name = event.name,
			key = event.shift && name.length === 1 ? name.toUpperCase() : name;
		if (name === "pageup" || name === "pagedown") {
			detailScroll?.scrollBy((name === "pageup" ? -1 : 1) * lines());
			return true;
		}
		if (surface() === "confirm") {
			if (name === "escape") back();
			else if (name === "return" || name === "enter") void execute();
			else return false;
			return true;
		}
		if (surface() === "output") {
			if (name === "escape") back();
			else if (key === "r") void refresh();
			else if (key === "o" || name === "return" || name === "enter")
				void openTarget(outputId());
			else if (name === "up" || name === "down" || key === "j" || key === "k")
				detailScroll?.scrollBy(name === "up" || key === "k" ? -1 : 1);
			else return false;
			return true;
		}
		if (surface() === "filter") {
			if (name === "escape" || name === "return" || name === "enter") {
				if (name === "escape") setFilter("");
				setSurface(filterFrom());
				choose(0);
				return true;
			}
			if (name === "backspace") {
				setFilter(Array.from(filter()).slice(0, -1).join(""));
				choose(0);
				return true;
			}
			const text = schedulingTextInput(event);
			if (text) {
				setFilter(filter() + text);
				choose(0);
				return true;
			}
			return false;
		}
		if (surface() === "postpone") {
			if (name === "escape") {
				back();
				return true;
			}
			if (name === "return" || name === "enter") {
				const schedule = basis()?.schedule;
				if (!schedule) return true;
				try {
					review(
						{
							operation: "schedules.action",
							requestId: basis()?.requestId ?? crypto.randomUUID(),
							id: schedule.id,
							revision: schedule.revision,
							action: "postpone",
							until: instant(values().until ?? ""),
						},
						"Postpone next run",
						{ schedule },
						"postpone",
					);
				} catch (error) {
					setBanner(failure(error));
				}
				return true;
			}
			if (name === "backspace") {
				setField(
					"until",
					Array.from(values().until ?? "")
						.slice(0, -1)
						.join(""),
				);
				return true;
			}
			const text = schedulingTextInput(event);
			if (text) {
				setField("until", (values().until ?? "") + text);
				return true;
			}
			return false;
		}
		if (surface() === "editor") {
			if (
				name === "f2" ||
				(event.ctrl && (name === "enter" || name === "return"))
			) {
				setEditing(false);
				void prepareSave();
				return true;
			}
			if (event.ctrl && name === "r") {
				const current = basis();
				if (current) void openEditor(current.mode);
				return true;
			}
			if (event.ctrl && name === "u" && editing()) {
				const field = fields()[fieldIndex()];
				if (field) setField(field.key, "");
				return true;
			}
			if (editing()) {
				const field = fields()[fieldIndex()];
				if (!field) return true;
				if (name === "escape") {
					setEditing(false);
					return true;
				}
				if (name === "return" || name === "enter") {
					if (["task", "originalInstruction", "references"].includes(field.key))
						setField(field.key, `${values()[field.key] ?? ""}\n`);
					else setEditing(false);
					return true;
				}
				if (name === "backspace") {
					setField(
						field.key,
						Array.from(values()[field.key] ?? "")
							.slice(0, -1)
							.join(""),
					);
					return true;
				}
				const text = schedulingTextInput(event);
				if (text) {
					setField(field.key, (values()[field.key] ?? "") + text);
					return true;
				}
				return false;
			}
			if (name === "escape") {
				back();
				return true;
			}
			if (name === "up" || key === "k") {
				setFieldIndex(Math.max(0, fieldIndex() - 1));
				return true;
			}
			if (name === "down" || key === "j" || name === "tab") {
				const size = Math.max(1, fields().length);
				setFieldIndex(
					(fieldIndex() + (name === "tab" && event.shift ? -1 : 1) + size) %
						size,
				);
				return true;
			}
			const field = fields()[fieldIndex()];
			if (!field) return true;
			if (name === "return" || name === "enter") {
				if (field.kind === "action") void initializeDestination();
				else if (field.kind === "text") setEditing(true);
				else
					setField(
						field.key,
						formStepOption(field, values()[field.key] ?? "", 1),
					);
				return true;
			}
			if ((name === "left" || name === "right") && field.kind === "select") {
				setField(
					field.key,
					formStepOption(
						field,
						values()[field.key] ?? "",
						name === "left" ? -1 : 1,
					),
				);
				return true;
			}
			return false;
		}
		if (event.ctrl || event.meta) return false;
		if (name === "escape") {
			back();
			return true;
		}
		if (name === "up" || key === "k") {
			choose(index() - 1);
			return true;
		}
		if (name === "down" || key === "j") {
			choose(index() + 1);
			return true;
		}
		if (key === "r") {
			void refresh();
			return true;
		}
		if (key === "b" || key === "g") {
			if (busy()) return true;
			const kind = surface() === "history" ? "history" : tab();
			if (key === "b" && !before[kind].length) {
				setBanner("No earlier page in this view.");
				return true;
			}
			const after = key === "b" ? before[kind].pop() : undefined;
			if (key === "g") before[kind] = [];
			if (kind === "history") setHistoryAfter(after);
			else if (kind === "jobs") setJobsAfter(after);
			else setSchedulesAfter(after);
			setIndex(0);
			void refresh();
			return true;
		}
		if (key === "m") {
			const cursor =
				surface() === "history"
					? historyCursor()
					: tab() === "jobs"
						? jobsCursor()
						: schedulesCursor();
			if (cursor) void refresh(true);
			else setBanner("All available items are loaded.");
			return true;
		}
		if (key === "f") {
			setFilterFrom(surface() === "history" ? "history" : "list");
			setSurface("filter");
			return true;
		}
		if (surface() === "history") {
			if (key === "a") void approve();
			else if (key === "o" || name === "return" || name === "enter")
				void openTarget();
			else return false;
			return true;
		}
		if (name === "tab") {
			if (busy()) return true;
			setTab(tab() === "jobs" ? "schedules" : "jobs");
			setIndex(0);
			setFilter("");
			void loadDetail();
			return true;
		}
		if (key === "n") {
			void openEditor("create");
			return true;
		}
		if (key === "N") {
			void openEditor("job-create");
			return true;
		}
		if (key === "e") {
			void openEditor(tab() === "jobs" ? "job-edit" : "schedule-edit");
			return true;
		}
		if (key === "x") {
			if (tab() === "jobs") void deleteJob();
			else void action("delete");
			return true;
		}
		if (tab() === "schedules") {
			if (key === "o") {
				const row = selected(),
					last = summaries().find(
						(value) => value.scheduleId === row?.id,
					)?.lastOutcome;
				if (row && last) {
					setHistoryId(row.id);
					setHistoryAfter(undefined);
					before.history = [];
					void openTarget(last.id);
				} else setBanner("No terminal occurrence output is recorded yet.");
				return true;
			}
			if (key === "h") {
				void openHistory();
				return true;
			}
			if (key === "R") {
				void action("run-now");
				return true;
			}
			if (key === "c") {
				void action("cancel");
				return true;
			}
			if (key === "p") {
				const schedule = schedules().find(
					(value) => value.id === selected()?.id,
				);
				if (schedule)
					void action(schedule.state === "paused" ? "resume" : "pause");
				return true;
			}
			if (key === "P") {
				const schedule = schedules().find(
					(value) => value.id === selected()?.id,
				);
				if (schedule) {
					setBasis({
						mode: "schedule-edit",
						requestId: crypto.randomUUID(),
						schedule,
					});
					setValues({ until: new Date(Date.now() + 3600000).toISOString() });
					setSurface("postpone");
				}
				return true;
			}
		}
		if (name === "return" || name === "enter") {
			void loadDetail();
			return true;
		}
		return false;
	}
	onMount(() => {
		void refresh();
		const timer = setInterval(() => {
			if (
				props.active() &&
				!busy() &&
				(surface() === "list" ||
					surface() === "history" ||
					surface() === "output")
			)
				void refresh();
		}, 5000);
		const remove = props.keymap.registerLayer({
			shellFeature: "schedules",
			priority: 200,
			appView: "home",
			activeModal: "none",
			commands: [
				{
					name: "schedules.handle",
					run: ({ event }) => {
						if (enteringText() && schedulingTextInput(event)) return false;
						const handled = handle(event);
						if (handled) commandEvents.add(event);
						return handled;
					},
				},
			],
			bindings: [
				...new Set(
					schedulingInputKeys.map((key) =>
						/^[A-Z]$/.test(key) ? `shift+${key.toLowerCase()}` : key,
					),
				),
			].map((key) => ({
				key,
				cmd: "schedules.handle",
				preventDefault: false,
			})),
		});
		onCleanup(() => {
			props.onStateChange?.(snapshot());
			if (textEntryOwner) props.keymap.setData("textEntry.active", false);
			disposed = true;
			detailGeneration++;
			clearInterval(timer);
			remove();
		});
	});
	return (
		<box
			flexDirection="column"
			flexGrow={1}
			minHeight={0}
			height="100%"
			width="100%"
			paddingLeft={1}
			paddingRight={1}
			backgroundColor={uiColors.bgBase}
		>
			<text fg={uiColors.textPrimary} flexShrink={0}>
				{surface() === "output"
					? "Scheduled execution output · read-only"
					: historyView()
						? "Occurrence history"
						: tab() === "jobs"
							? "Reusable jobs"
							: "Schedules"}
				{busy() ? " · loading" : ""}
			</text>
			<text fg={uiColors.textMuted} wrapMode="char" flexShrink={0}>
				{status()}
			</text>
			<Show when={banner()}>
				<text fg={uiColors.warning} wrapMode="word" flexShrink={0}>
					{banner()}
				</text>
			</Show>
			<box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
				<Show
					when={surface() === "editor"}
					fallback={
						<Show
							when={surface() === "postpone"}
							fallback={
								<Show
									when={surface() === "confirm"}
									fallback={
										<>
											<Show
												when={
													surface() !== "output" &&
													(filter() || surface() === "filter")
												}
											>
												<text
													fg={uiColors.textMuted}
												>{`Filter loaded items: ${filter()}`}</text>
											</Show>
											<box
												flexDirection={narrow() ? "column" : "row"}
												gap={1}
												flexGrow={1}
												minHeight={0}
											>
												<Show when={surface() !== "output"}>
													<box
														width={narrow() ? "100%" : "38%"}
														height={
															narrow()
																? Math.max(3, Math.floor(lines() * 0.35))
																: undefined
														}
														flexShrink={0}
														flexDirection="column"
														minHeight={0}
													>
														<ScrollableList
															items={rows()}
															selectedIndex={index()}
															onSelect={choose}
															availableLines={
																narrow()
																	? Math.max(3, Math.floor(lines() * 0.35))
																	: lines()
															}
															itemHeights={rowHeights()}
															renderItem={(row, selectedRow) => (
																<Card
																	title={row.label}
																	selected={selectedRow}
																	style={{ marginBottom: 1 }}
																	cells={[
																		<text
																			fg={uiColors.textMuted}
																			wrapMode="word"
																		>
																			{row.description}
																		</text>,
																	]}
																/>
															)}
														/>
													</box>
												</Show>
												<ScrollableContent
													onScrollBoxReady={(box) => {
														detailScroll = box;
													}}
												>
													<ScheduleDetails
														content={detail()}
														width={detailWidth()}
													/>
												</ScrollableContent>
											</box>
										</>
									}
								>
									<text fg={uiColors.warning} flexShrink={0}>
										{pending()?.label}
										{pending()?.attempted ? " · acknowledgement unknown" : ""}
									</text>
									<ScrollableContent
										onScrollBoxReady={(box) => {
											detailScroll = box;
										}}
									>
										<ScheduleDetails
											content={pending()?.detail ?? ""}
											width={dimensions().width - 4}
										/>
									</ScrollableContent>
								</Show>
							}
						>
							<Form
								fields={[
									{
										key: "until",
										label: "Postpone next run",
										kind: "text",
										hint: "ISO instant with UTC/offset. The server validates that it is in the future.",
									},
								]}
								values={values()}
								activeIndex={0}
								editing
								focusedPane="value"
								availableLines={lines()}
							/>
						</Show>
					}
				>
					<Form
						fields={fields()}
						errors={fieldErrors()}
						availableColumns={Math.floor((dimensions().width - 6) * 0.64)}
						values={values()}
						activeIndex={Math.min(
							fieldIndex(),
							Math.max(0, fields().length - 1),
						)}
						editing={editing()}
						focusedPane={editing() ? "value" : "field"}
						availableLines={lines()}
						header={basis()?.mode}
						actionContent={
							<text fg={uiColors.textMuted}>
								Pins the native orchestrator identity and conversation without
								submitting a model turn.
							</text>
						}
					/>
				</Show>
			</box>
		</box>
	);
}
