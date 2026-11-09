/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, SyntaxStyle } from "@opentui/core";
import {
	createEffect,
	createMemo,
	onCleanup,
	Show,
	useContext,
} from "solid-js";
import type { Data, ToolProgress } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { useHover } from "../../presentation/components/mouse/useHover.ts";
import type { RowGestureState } from "../../presentation/components/mouse/useRowMouse.ts";
import { useTap } from "../../presentation/components/mouse/useTap.ts";
import { ToolCallHeader } from "../../presentation/components/ToolCallHeader.tsx";
import { uiColors } from "../../presentation/theme/colors.ts";
import { LocalChoiceContext } from "../../ui/LocalChoice.ts";
import { StructuredData } from "../../ui/StructuredData.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";
import { FileContent, ToolSurfaceHoverContext } from "./FileContent.tsx";
import {
	type SuppliedBrowserSection,
	ToolBrowserObservation,
} from "./ToolBrowserObservation.tsx";
import {
	ToolReadBody,
	ToolShellBody,
	ToolWriteBody,
} from "./ToolByteBodies.tsx";
import { ToolContentParts } from "./ToolContentParts.tsx";
import { ToolDialogue } from "./ToolDialogue.tsx";
import {
	type SuppliedEditReplacement,
	ToolEditRequest,
} from "./ToolEditRequest.tsx";
import { nativeFields, ToolNativeFields } from "./ToolNativeFields.tsx";
import {
	type SuppliedToolSource,
	ToolRequestedSource,
} from "./ToolRequestedSource.tsx";
import { TranscriptHeader } from "./TranscriptHeader.tsx";
import { TranscriptRowsContext } from "./TranscriptRows.ts";
import { TranscriptShellOutput } from "./TranscriptShellOutput.tsx";

const object = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const string = (value: unknown) => (typeof value === "string" ? value : "");

/** Adapted file/shell cards and independently folded arguments/output/details.
 * Status comes from a paired retained result or a scoped native live slot.
 * An in-flight model call is explicitly not an execution observation. */
export function ToolCard(props: {
	identity: string;
	scope?: unknown;
	interactive?: boolean;
	selected: boolean;
	select: (id: string) => void;
	anchor: (node: BoxRenderable | null) => void;
	call: Data;
	partial?: boolean;
	progress?: ToolProgress;
	liveOnly?: boolean;
	result: Data | null;
	pairing: "matched" | "missing" | "ambiguous";
	expanded: string[];
	toggle: (id: string) => void;
	syntax: SyntaxStyle;
}) {
	const hover = useHover(),
		choices = useContext(LocalChoiceContext),
		reading = useContext(TranscriptRowsContext);
	let disposed = false;
	const foldGestures = new Map<string, RowGestureState>();
	let observationGeneration = 0;
	// Captured supplied owner, independent of selection/fold state. This key is
	// UI-only: repeated native bytes must not alias a replacement observation.
	const observation = createMemo(() => ({
		identity: `${props.identity}:supplied:${++observationGeneration}`,
		scope: props.scope,
		call: props.call,
		result: props.result,
		progress: props.progress,
		partial: props.partial,
		liveOnly: props.liveOnly,
		pairing: props.pairing,
	}));
	const cardScope = createMemo(() => [
		props.identity,
		props.scope,
		props.interactive,
		props.call,
		props.progress,
		props.result,
		props.partial,
		props.expanded,
		choices?.scope(),
		choices?.interactive(),
	]);
	const active = () =>
		!disposed &&
		props.interactive !== false &&
		(choices?.interactive() ?? true) &&
		(reading?.selectable(props.identity) ?? true);
	const retire = () => {
		for (const gesture of foldGestures.values()) {
			gesture.down = undefined;
			gesture.lastTap = undefined;
		}
	};
	createEffect(() => {
		cardScope();
		retire();
	});
	onCleanup(() => {
		disposed = true;
		retire();
		foldGestures.clear();
	});
	const activate = (suffix = "") => {
		if (active()) {
			if (reading) reading.activate(props.identity, suffix);
			else {
				props.select(props.identity);
				props.toggle(`${props.identity}${suffix}`);
			}
		}
	};
	// Icon gutter from the original tool-call header; unknown tools keep its dot.
	const browserActions = new Set([
		"browser_open",
		"browser_close",
		"browser_click",
		"browser_fill",
		"browser_press",
		"browser_select",
		"browser_hover",
		"browser_wait",
		"browser_snapshot",
		"browser_find",
	]);
	const icons: Record<string, string> = {
		...Object.fromEntries([...browserActions].map((name) => [name, "→"])),
		browser_run_script: "λ",
		browser_eval: "λ",
		browser_console: "≋",
		browser_network: "≋",
		db_query: "!",
		browser_screenshot: "▧",
		browser_record_start: "▧",
		browser_record_stop: "▧",
		read: "→",
		write: "←",
		edit: "←",
		apply_patch: "←",
		patch: "←",
		glob: "✱",
		grep: "✱",
		find: "✱",
		bash: "$",
		shell: "$",
		execute: "▶",
		task: "✓",
		subagent: "✓",
		webfetch: "%",
		websearch: "◈",
		codemode: "λ",
		developer_question: "?",
		agent_ask: "?",
	};
	const args = () => object(props.call.arguments);
	const name = () => string(props.call.name) || "Unnamed native tool";
	// Original pending aliases share shell presentation, not terminal semantics.
	const shellSource = () =>
		name() === "bash" ||
		(!props.result && ["shell", "execute"].includes(name()));
	const detailsValue = () =>
		props.result ? props.result.details : props.progress?.details;
	const details = () => object(props.result?.details);
	const output = () =>
		dataList(props.result?.content)
			.filter((part) => part.type === "text")
			.map((part) => string(part.text))
			.join("\n");
	const contentParts = createMemo(() => dataList(props.result?.content));
	const diagnostics = createMemo(() =>
		props.result
			? dataList(props.result.nativeDiagnostics)
			: (props.progress?.diagnostics ?? []),
	);
	const readOutput = () => {
		const parts = dataList(props.result?.content);
		const footer = `<harness>\n${diagnostics()
			.map((item) => `[${String(item.severity)}] ${string(item.message)}`)
			.join("\n")}\n</harness>`;
		// Remove only the exact separately recorded native diagnostic footer;
		// literal file bytes that resemble harness markup remain untouched.
		const body =
			diagnostics().length && parts.at(-1)?.text === footer
				? parts.slice(0, -1)
				: parts;
		return body
			.filter((part) => part.type === "text")
			.map((part) => string(part.text))
			.join("\n");
	};
	const readProjection = createMemo(() => {
		if (name() !== "read") return { file: null, notice: null };
		const text = readOutput();
		const truncation = object(details().truncation);
		const supplied = truncation.content;
		const line = args().offset === undefined ? 1 : args().offset;
		// Only an omitted SDK-default offset or a supplied valid file position
		// can establish numbered read provenance. Never coerce invalid values.
		if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1)
			return { file: null, notice: text };
		// SDK metadata may prove a file-prefix/notice split. Never strip a
		// footer-shaped literal file line based on spelling alone.
		if (
			typeof supplied === "string" &&
			truncation.truncated === true &&
			truncation.firstLineExceedsLimit !== true &&
			Number.isSafeInteger(line) &&
			line >= 1 &&
			Number.isSafeInteger(truncation.outputLines) &&
			Number(truncation.outputLines) > 0 &&
			text.startsWith(`${supplied}\n\n`)
		) {
			const notice = text.slice(supplied.length + 2);
			const match =
				/^\[Showing lines (\d+)-(\d+) of (\d+)(?: \([^\n\r()]+ limit\))?\. Use offset=(\d+) to continue\.\]$/.exec(
					notice,
				);
			const end = line + Number(truncation.outputLines) - 1;
			if (
				match &&
				Number(match[1]) === line &&
				Number(match[2]) === end &&
				Number.isSafeInteger(end) &&
				Number.isSafeInteger(end + 1) &&
				Number.isSafeInteger(Number(match[3])) &&
				Number(match[3]) >= end &&
				Number(match[4]) === end + 1
			)
				return { file: supplied, notice };
		}
		const ambiguous =
			truncation.truncated === true ||
			truncation.firstLineExceedsLimit === true ||
			dataList(props.result?.content).some((part) => part.type === "image") ||
			/(?:^|\n)\[(?:Showing lines [^\n]*|\d+ more lines in file\.[^\n]*|Line \d+ is [^\n]*)\]$/.test(
				text,
			);
		return ambiguous
			? { file: null, notice: text }
			: { file: text, notice: null };
	});
	const path = () => string(args().path);
	const patch = () => string(details().patch) || string(details().diff);
	const open = (section = "") =>
		props.expanded.includes(`${props.identity}${section}`);
	const status = () =>
		props.partial
			? "Native in-flight call — still being generated, not execution status"
			: props.result
				? props.result.isError === true
					? "Native tool error"
					: "Result recorded"
				: props.progress
					? `Native slot ${props.progress.status}${props.progress.status === "running" ? " — may be waiting on owned work/review" : props.progress.status === "done" ? " — no terminal result linked" : ""}${props.progress.summary?.isError === true ? " · nested summary reports an error" : ""}`
					: props.pairing === "ambiguous"
						? "Ambiguous retained identity — output not paired"
						: "Result not in retained history — activity unknown";
	const scriptHeadline = createMemo(() => {
		if (name() !== "codemode" || typeof args().code !== "string") return "";
		const line =
			string(args().code)
				.split("\n")
				.map((entry) => entry.trim())
				.find((entry) => entry.length > 0 && !entry.startsWith("// @")) ??
			"script";
		const points = Array.from(line.replace(/\s+/g, " "));
		return points.length > 160
			? `${points.slice(0, 159).join("")}…`
			: points.join("");
	});
	const summary = () =>
		name() === "codemode"
			? scriptHeadline()
			: ["developer_question", "agent_ask"].includes(name())
				? dialogueHeadline()
				: ["read", "edit", "write"].includes(name())
					? path()
					: shellSource() || name() === "shell"
						? string(args().command)
						: string(args().app) ||
							string(args().title) ||
							string(args().query);
	const headerLabel = () => {
		if (!browserActions.has(name())) return summary() || name();
		const verb = name().slice("browser_".length).replaceAll("_", " ");
		const target =
			["ref", "selector", "url", "text", "key"]
				.map((key) => string(args()[key]))
				.find((value) => value.length > 0) || summary();
		return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}${target ? ` ${target}` : ""}`;
	};
	const requestedSource = createMemo<SuppliedToolSource | null>(() => {
		if (name() === "db_query" && typeof args().sql === "string")
			return {
				content: string(args().sql),
				filetype: "sql",
				label: "Requested SQL",
			};
		if (
			["browser_run_script", "browser_eval", "codemode"].includes(name()) &&
			typeof args().code === "string"
		)
			return {
				content: string(args().code),
				filetype: "javascript",
				label: "Requested JavaScript",
			};
		return null;
	});
	const fields = createMemo(() =>
		props.result
			? nativeFields(name(), props.call.arguments, structured())
			: null,
	);
	const structured = createMemo(() => {
		const textParts = dataList(props.result?.content).filter(
			(part) => part.type === "text",
		);
		// One JSON-shaped part cannot stand in for a multipart retained body.
		// Keep all supplied text visible through the existing plain-text fallback.
		if (textParts.length !== 1) return null;
		const text = textParts[0]?.text;
		if (typeof text !== "string") return null;
		try {
			const parsed: unknown = JSON.parse(text);
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	});
	const requestedEdits = createMemo<readonly SuppliedEditReplacement[]>(() => {
		if (name() !== "edit") return [];
		const value = args();
		const edits = value.edits;
		const supplied = Array.isArray(edits)
			? edits.map((entry: unknown, index: number) => ({
					key: String(index),
					label: `replacement ${index + 1}`,
					entry,
				}))
			: [{ key: "object", label: "single-object replacement", entry: edits }];
		supplied.push({
			key: "top-level",
			label: "top-level replacement",
			entry: value,
		});
		return supplied.flatMap(({ key, label, entry: item }) => {
			const entry = object(item);
			return typeof entry.oldText === "string" &&
				typeof entry.newText === "string"
				? [{ key, label, oldText: entry.oldText, newText: entry.newText }]
				: [];
		});
	});
	const requestedQuestions = createMemo(() => {
		if (!["developer_question", "agent_ask"].includes(name())) return [];
		const value = args();
		const items = Array.isArray(value.questions) ? value.questions : [value];
		return items.flatMap((item: unknown, index: number) => {
			const record = object(item);
			const text = [record.question, record.description].find(
				(value) => typeof value === "string",
			);
			const options = Array.isArray(record.options)
				? record.options.flatMap((item: unknown, index: number) => {
						const option = object(item);
						const label = [option.title, option.label, option.value].find(
							(value) => typeof value === "string",
						);
						if (typeof label !== "string") return [];
						return [
							{
								index,
								label,
								recommended: option.recommended === true,
								description:
									typeof option.description === "string"
										? option.description
										: null,
							},
						];
					})
				: [];
			const context =
				typeof record.context === "string" ? record.context : null;
			if (typeof text !== "string" && options.length === 0 && context === null)
				return [];
			return [
				{
					index,
					text: typeof text === "string" ? text : null,
					ident: typeof record.ident === "string" ? record.ident : null,
					context,
					options,
				},
			];
		});
	});
	const dialogueHeadline = createMemo(() => {
		const questions = requestedQuestions();
		if (questions.length === 0) return "";
		if (questions.length > 1) return `${questions.length} questions`;
		const points = Array.from(
			(questions[0]?.text ?? "question").replace(/\s+/g, " ").trim(),
		);
		return points.length > 160
			? `${points.slice(0, 159).join("")}…`
			: points.join("");
	});
	const scriptOutput = createMemo(() => {
		const value = details().output;
		return name() === "codemode" &&
			props.result &&
			props.pairing === "matched" &&
			!props.partial &&
			!props.liveOnly &&
			typeof value === "string"
			? { text: value }
			: null;
	});
	const browserResult = createMemo(() => {
		const value = structured();
		return browserActions.has(name()) && value && !Array.isArray(value)
			? object(value)
			: null;
	});
	const browserSections = createMemo<readonly SuppliedBrowserSection[]>(() => {
		const value = browserResult();
		if (!value) return [];
		return (["observation", "matches"] as const).flatMap((key) =>
			Object.hasOwn(value, key) ? [{ key, value: value[key] }] : [],
		);
	});
	const specialized = () =>
		Boolean(
			path() &&
				(name() === "read" ||
					name() === "write" ||
					(name() === "edit" && patch())),
		) || shellSource();
	const fold = (suffix: string, label: string) => {
		const gesture = foldGestures.get(suffix) ?? {};
		foldGestures.set(suffix, gesture);
		return (
			<box
				{...useTap(() => activate(suffix), {
					gesture,
					enabled: active,
					stopPropagation: true,
				})}
			>
				<text fg={color("accent")}>
					{open(suffix) ? "▾" : "▸"} {label}
				</text>
			</box>
		);
	};
	return (
		<box
			flexDirection="column"
			paddingTop={1}
			paddingBottom={1}
			paddingLeft={2}
			paddingRight={1}
			flexShrink={0}
			border={["left"]}
			borderStyle="heavy"
			borderColor={
				props.result?.isError === true
					? color("error")
					: props.selected
						? color("primary")
						: props.result
							? color("success")
							: color("textMuted")
			}
			backgroundColor={hover.hovered() ? uiColors.bgHover : uiColors.bgMantle}
			{...hover}
		>
			<ToolSurfaceHoverContext.Provider value={hover.hovered}>
				<TranscriptHeader
					scope={cardScope()}
					interactive={props.interactive}
					identity={props.identity}
					select={props.select}
					toggle={props.toggle}
					anchor={props.anchor}
				>
					<ToolCallHeader
						scope={cardScope()}
						interactive={props.interactive}
						failed={props.result?.isError === true}
						pending={
							!props.partial &&
							!props.result &&
							props.progress?.status === "running"
						}
						browser={name().startsWith("browser_")}
						icon={Object.hasOwn(icons, name()) ? (icons[name()] ?? "•") : "•"}
						label={headerLabel()}
						hint={headerLabel() !== name() ? name() : undefined}
						timestamp={props.result?.timestamp}
						durationMs={props.result?.durationMs}
						onToggle={() => activate()}
					/>
					<text
						fg={
							props.result?.isError === true
								? color("error")
								: color("textMuted")
						}
						wrapMode="word"
					>
						{status()}
					</text>
					<Show when={props.liveOnly}>
						<text fg={color("textMuted")}>
							{props.progress?.parentTaskId === undefined
								? "Unassociated current-round native slot; retained intent not linked"
								: `Native nested slot · parent task #${props.progress.parentTaskId} · parent call ${props.progress.parentCallId}`}{" "}
							{props.progress?.taskId === undefined
								? ""
								: `· task #${props.progress.taskId}`}
						</text>
					</Show>
				</TranscriptHeader>
				<Show
					when={
						shellSource() &&
						!open() &&
						!props.partial &&
						(props.result
							? output().length > 0
							: props.progress?.output !== undefined)
					}
				>
					<Show when={!props.result}>
						<text fg={color("textMuted")} wrapMode="word">
							Native bounded observed output — not a terminal result
							{props.progress?.droppedBytes === undefined
								? ""
								: ` · native dropped bytes: ${props.progress.droppedBytes}`}
							{props.progress?.droppedLines === undefined
								? ""
								: ` · native dropped lines: ${props.progress.droppedLines}`}
						</text>
					</Show>
					<TranscriptShellOutput
						command={string(args().command)}
						output={props.result ? output() : string(props.progress?.output)}
						expanded={false}
						failed={props.result?.isError === true}
					/>
				</Show>
				<Show when={open()}>
					<box flexDirection="column" gap={1} paddingTop={1}>
						<Show when={name() === "read" && path() && props.result}>
							<ToolReadBody
								path={path()}
								file={readProjection().file}
								notice={readProjection().notice}
								startLine={
									typeof args().offset === "number" ? Number(args().offset) : 1
								}
								failed={props.result?.isError === true}
								output={output()}
								syntax={props.syntax}
							/>
						</Show>
						<Show when={name() === "write" && path()}>
							<ToolWriteBody
								path={path()}
								content={args().content}
								partial={props.partial}
								liveOnly={props.liveOnly}
								syntax={props.syntax}
							/>
						</Show>
						<Show when={name() === "edit" && path() && patch()}>
							<FileContent
								path={path()}
								content={patch()}
								syntax={props.syntax}
								diff={true}
								label="Native retained edit diff"
							/>
						</Show>
						<Show when={name() === "edit" && !patch()}>
							<text fg={color("warning")}>
								No native diff retained. Requested replacements are available
								under Arguments; no applied diff is inferred.
							</text>
						</Show>
						<Show when={name() === "edit" && !patch()}>
							<ToolEditRequest
								interactive={active()}
								scope={observation()}
								identity={observation().identity}
								replacements={requestedEdits()}
								phase={
									props.partial
										? "Partial generated"
										: props.liveOnly
											? "Live slot"
											: "Requested"
								}
								syntax={props.syntax}
								open={open}
								fold={fold}
							/>
						</Show>
						<Show when={shellSource()}>
							<ToolShellBody
								command={args().command}
								timeout={args().timeout}
								partial={props.partial}
								liveOnly={props.liveOnly}
								syntax={props.syntax}
							/>
						</Show>
						<ToolRequestedSource
							interactive={active()}
							identity={observation().identity}
							source={requestedSource()}
							phase={
								props.partial
									? "Partial generated"
									: props.liveOnly
										? "Live slot"
										: "Requested"
							}
							syntax={props.syntax}
							open={open}
							fold={fold}
						/>
						<ToolDialogue
							interactive={active()}
							scope={observation()}
							questions={requestedQuestions()}
							phase={
								props.partial
									? "Partial generated"
									: props.liveOnly
										? "Live slot"
										: "Requested"
							}
							open={open}
							fold={fold}
						/>
						<Show when={scriptOutput()}>
							{(script) => (
								<>
									{fold(":script-output", "Retained script output")}
									<Show when={open(":script-output")}>
										<text fg={color("textMuted")} wrapMode="word">
											Explicit native script-output field — not a completion or
											nested-call observation.
										</text>
										<SuppliedObservation
											interactive={active()}
											value={script().text}
											scope={observation()}
											label="Exact supplied native script-output field; empty remains empty"
										/>
									</Show>
								</>
							)}
						</Show>
						<ToolBrowserObservation
							interactive={active()}
							scope={observation()}
							sections={browserSections()}
							open={open}
							fold={fold}
						/>
						<Show when={!specialized() && props.result}>
							<Show
								when={structured() !== null}
								fallback={
									<SuppliedObservation
										interactive={active()}
										value={output()}
										scope={observation()}
										label="Joined retained text preview; exact native part boundaries remain under Output"
									/>
								}
							>
								<text fg={color("textMuted")}>
									Native structured output — status/authority fields are
									observations, not UI permissions.
								</text>
								<StructuredData
									interactive={active()}
									scope={observation()}
									value={structured()}
									label={`${name()} · bounded retained result summary; complete source under Output`}
								/>
							</Show>
						</Show>
						<Show when={diagnostics().length > 0}>
							<SuppliedRecordWindow
								interactive={active()}
								rows={diagnostics()}
								scope={observation()}
								label="supplied native diagnostics"
								title={(item, index) =>
									`Diagnostic ${index + 1} · ${String(item.severity ?? "severity not supplied")}`
								}
								search={(item) => JSON.stringify(item)}
							>
								{(item, index) => (
									<>
										<text
											fg={
												item.severity === "error"
													? color("error")
													: item.severity === "warn"
														? color("warning")
														: color("textMuted")
											}
										>
											Native diagnostic {index() + 1} · observation, not a
											completion signal
										</text>
										<SuppliedObservation
											interactive={active()}
											value={item}
											scope={observation()}
											label="Complete supplied diagnostic fields"
										/>
									</>
								)}
							</SuppliedRecordWindow>
						</Show>
						{fold(
							":arguments",
							props.partial
								? "Partial arguments"
								: props.liveOnly
									? "Live slot arguments"
									: "Requested arguments",
						)}
						<Show when={open(":arguments")}>
							<Show
								when={props.call.arguments !== undefined}
								fallback={
									<text fg={color("textMuted")}>
										Arguments not present in this native live slot; inspect a
										retained request if available.
									</text>
								}
							>
								<SuppliedObservation
									interactive={active()}
									value={props.call.arguments}
									scope={observation()}
									label="Complete supplied arguments; serialized JSON, not execution or approval"
								/>
							</Show>
						</Show>
						<Show when={!props.result && props.progress?.output !== undefined}>
							{fold(
								":output",
								"Native bounded observed output — not a terminal result",
							)}
							<text fg={color("textMuted")}>
								{props.progress?.droppedBytes === undefined
									? ""
									: `Native dropped bytes: ${props.progress.droppedBytes}`}
								{props.progress?.droppedLines === undefined
									? ""
									: ` · native dropped lines: ${props.progress.droppedLines}`}
							</text>
							<Show
								when={shellSource()}
								fallback={
									<Show when={open(":output")}>
										<SuppliedObservation
											interactive={active()}
											value={props.progress?.output}
											scope={observation()}
											label="Exact supplied live output; native dropped counters remain separate"
										/>
									</Show>
								}
							>
								<TranscriptShellOutput
									command={string(args().command)}
									output={string(props.progress?.output)}
									expanded={open(":output")}
									failed={false}
								/>
							</Show>
						</Show>
						<Show when={props.result}>
							{fold(":output", "Complete retained output")}
							<Show
								when={name() === "bash" && output().length > 0}
								fallback={
									<Show when={open(":output")}>
										<ToolContentParts
											interactive={active()}
											parts={contentParts()}
											scope={observation()}
										/>
										<Show when={contentParts().length === 0}>
											<SuppliedObservation
												interactive={active()}
												value={props.result?.content}
												scope={observation()}
												label="Supplied empty/non-list content field; absent, null and empty remain distinct, with no inferred completion"
											/>
										</Show>
									</Show>
								}
							>
								<TranscriptShellOutput
									command={string(args().command)}
									output={output()}
									expanded={open(":output")}
									failed={props.result?.isError === true}
								/>
							</Show>
							<Show
								when={
									name() === "bash" && output().length > 0 && open(":output")
								}
							>
								<ToolContentParts
									interactive={active()}
									parts={contentParts()}
									scope={observation()}
								/>
							</Show>
							<ToolContentParts
								interactive={active()}
								parts={contentParts()}
								scope={observation()}
								imagesOnly
							/>
						</Show>
						<Show when={fields()}>
							{(rows) => (
								<>
									{fold(
										":fields",
										"Named native fields — supplied observation only",
									)}
									<Show when={open(":fields")}>
										<ToolNativeFields rows={rows()} />
									</Show>
								</>
							)}
						</Show>
						<Show when={detailsValue() !== undefined}>
							{fold(
								":details",
								props.result
									? "Native retained details"
									: "Native live details",
							)}
							<Show when={open(":details")}>
								<SuppliedObservation
									interactive={active()}
									value={detailsValue()}
									scope={observation()}
									label="Complete supplied details; not an inferred task or conversation relationship"
								/>
							</Show>
						</Show>
						<Show when={props.progress?.summary !== undefined && !props.result}>
							{fold(
								":summary",
								"Native nested completion summary — supplied observation only",
							)}
							<Show when={open(":summary")}>
								<text fg={color("textMuted")} wrapMode="word">
									Recorded summary only; not a linked child transcript, current
									child status or permission to execute, resume, answer or
									approve.
								</text>
								<SuppliedObservation
									interactive={active()}
									value={props.progress?.summary}
									scope={observation()}
									label="Complete supplied nested summary fields"
								/>
							</Show>
						</Show>
					</box>
				</Show>
			</ToolSurfaceHoverContext.Provider>
		</box>
	);
}
