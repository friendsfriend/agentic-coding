/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, SyntaxStyle } from "@opentui/core";
import { createMemo, For, Show } from "solid-js";
import type { Data, ToolProgress } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { useHover } from "../../presentation/components/mouse/useHover.ts";
import { useTap } from "../../presentation/components/mouse/useTap.ts";
import { ToolCallHeader } from "../../presentation/components/ToolCallHeader.tsx";
import { uiColors } from "../../presentation/theme/colors.ts";
import { ImageView } from "../../ui/ImageView.tsx";
import { StructuredData } from "../../ui/StructuredData.tsx";
import { color } from "../../ui/theme/index.ts";
import { FileContent, ToolSurfaceHoverContext } from "./FileContent.tsx";
import { TranscriptHeader } from "./TranscriptHeader.tsx";
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
	const hover = useHover();
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
		codemode: "{}",
		developer_question: "?",
		agent_ask: "?",
	};
	const args = () => object(props.call.arguments);
	const name = () => string(props.call.name) || "Unnamed native tool";
	const detailsValue = () =>
		props.result ? props.result.details : props.progress?.details;
	const details = () => object(props.result?.details);
	const output = () =>
		dataList(props.result?.content)
			.filter((part) => part.type === "text")
			.map((part) => string(part.text))
			.join("\n");
	const diagnostics = () =>
		props.result
			? dataList(props.result.nativeDiagnostics)
			: (props.progress?.diagnostics ?? []);
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
		const line = typeof args().offset === "number" ? Number(args().offset) : 1;
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
	const summary = () =>
		["read", "edit", "write"].includes(name())
			? path()
			: name() === "bash" || name() === "shell"
				? string(args().command)
				: string(args().app) || string(args().title) || string(args().query);
	const headerLabel = () => {
		if (!browserActions.has(name())) return summary() || name();
		const verb = name().slice("browser_".length).replaceAll("_", " ");
		const target =
			["ref", "selector", "url", "text", "key"]
				.map((key) => string(args()[key]))
				.find((value) => value.length > 0) || summary();
		return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}${target ? ` ${target}` : ""}`;
	};
	const requestedSource = createMemo(() => {
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
	const structured = createMemo(() => {
		const text = dataList(props.result?.content).find(
			(part) => part.type === "text",
		)?.text;
		if (typeof text !== "string") return null;
		try {
			const parsed: unknown = JSON.parse(text);
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	});
	const browserResult = createMemo(() => {
		const value = structured();
		return browserActions.has(name()) && value && !Array.isArray(value)
			? object(value)
			: null;
	});
	const browserSections = createMemo(() => {
		const value = browserResult();
		if (!value) return [];
		return ["observation", "matches"].flatMap((key) =>
			Object.hasOwn(value, key) && value[key] !== null
				? [{ key, value: value[key] }]
				: [],
		);
	});
	const specialized = () =>
		Boolean(
			path() &&
				(name() === "read" ||
					name() === "write" ||
					(name() === "edit" && patch())),
		) || name() === "bash";
	const fold = (suffix: string, label: string) => (
		<box
			{...useTap(
				() => {
					props.select(props.identity);
					props.toggle(`${props.identity}${suffix}`);
				},
				{ stopPropagation: true },
			)}
		>
			<text fg={color("accent")}>
				{open(suffix) ? "▾" : "▸"} {label}
			</text>
		</box>
	);
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
					identity={props.identity}
					select={props.select}
					toggle={props.toggle}
					anchor={props.anchor}
				>
					<ToolCallHeader
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
						onToggle={() => {
							props.select(props.identity);
							props.toggle(props.identity);
						}}
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
						name() === "bash" &&
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
							<Show
								when={props.result?.isError !== true}
								fallback={
									<text fg={color("error")} wrapMode="word">
										{output()}
									</text>
								}
							>
								<Show when={readProjection().file !== null}>
									<FileContent
										path={path()}
										content={readProjection().file ?? ""}
										syntax={props.syntax}
										startLine={
											typeof args().offset === "number"
												? Number(args().offset)
												: 1
										}
										label="Retained read output — not a live file snapshot"
									/>
								</Show>
								<Show when={readProjection().notice !== null}>
									<text fg={color("textMuted")} wrapMode="word">
										{readProjection().file === null
											? "Retained read text · file-line provenance unavailable; possible SDK annotation kept verbatim"
											: "Retained SDK-style read annotation · metadata-matched, not a file line"}
									</text>
									<text fg={color("text")} wrapMode="word">
										{readProjection().notice ?? ""}
									</text>
								</Show>
							</Show>
						</Show>
						<Show when={name() === "write" && path()}>
							<FileContent
								path={path()}
								content={string(args().content)}
								syntax={props.syntax}
								label={
									props.partial
										? "Partial requested write bytes — call still being generated"
										: "Requested write bytes — not a live file snapshot"
								}
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
						<Show
							when={name() === "bash" && props.call.arguments !== undefined}
						>
							<text fg={color("textMuted")}>
								Requested shell command ·{" "}
								{args().timeout === undefined
									? "default timeout"
									: `timeout ${String(args().timeout)}`}
							</text>
							<code
								content={string(args().command)}
								filetype="bash"
								syntaxStyle={props.syntax}
								drawUnstyledText={true}
								wrapMode="word"
							/>
						</Show>
						<Show when={requestedSource()}>
							{(source) => (
								<>
									{fold(
										":source",
										props.partial
											? source().label.replace("Requested", "Partial")
											: props.liveOnly
												? source().label.replace("Requested", "Live slot")
												: source().label,
									)}
									<Show when={open(":source")}>
										<text fg={color("textMuted")} wrapMode="word">
											{props.partial
												? "Partial generated source — not an execution observation."
												: props.liveOnly
													? "Supplied current-round source — no retained intent linked; not proof of completion."
													: "Retained requested source — not proof of execution or completion."}
										</text>
										<code
											content={source().content}
											filetype={source().filetype}
											syntaxStyle={props.syntax}
											drawUnstyledText={true}
											wrapMode="word"
										/>
									</Show>
								</>
							)}
						</Show>
						<For each={browserSections()}>
							{(section) => (
								<>
									{fold(
										`:${section.key}`,
										section.key === "matches" ? "Matches" : "Observation",
									)}
									<Show when={open(`:${section.key}`)}>
										<text fg={color("textMuted")} wrapMode="word">
											Retained browser {section.key} — refs belong to the
											recorded snapshot; this display does not resolve or
											activate them.
										</text>
										<Show
											when={typeof section.value === "string"}
											fallback={
												<StructuredData
													value={section.value}
													label={`Retained ${section.key}`}
												/>
											}
										>
											<text wrapMode="word">{string(section.value)}</text>
										</Show>
									</Show>
								</>
							)}
						</For>
						<Show when={!specialized() && props.result}>
							<Show
								when={structured() !== null}
								fallback={
									<text wrapMode="word">
										{output() || "No text output retained."}
									</text>
								}
							>
								<text fg={color("textMuted")}>
									Native structured output — status/authority fields are
									observations, not UI permissions.
								</text>
								<StructuredData
									value={structured()}
									label={`${name()} · retained native result`}
								/>
							</Show>
						</Show>
						<For each={diagnostics()}>
							{(item) => (
								<text
									wrapMode="word"
									fg={
										item.severity === "error"
											? color("error")
											: item.severity === "warn"
												? color("warning")
												: color("textMuted")
									}
								>
									Native {String(item.severity ?? "diagnostic")} ·{" "}
									{string(item.message)}
								</text>
							)}
						</For>
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
								<code
									content={JSON.stringify(props.call.arguments, null, 2)}
									filetype="json"
									syntaxStyle={props.syntax}
									drawUnstyledText={true}
									wrapMode="word"
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
								when={name() === "bash"}
								fallback={
									<Show when={open(":output")}>
										<text wrapMode="word">{props.progress?.output}</text>
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
										<text wrapMode="word">
											{output() || "No text output retained."}
										</text>
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
							<For
								each={dataList(props.result?.content).filter(
									(part) => part.type !== "text",
								)}
							>
								{(part) => (
									<Show
										when={part.type === "image"}
										fallback={
											<text fg={color("textMuted")}>
												Retained {String(part.type ?? "non-text")} content ·{" "}
												{JSON.stringify(part)}
											</text>
										}
									>
										<ImageView
											content={part.data}
											mediaType={part.mimeType}
											caption="Retained native tool image"
										/>
									</Show>
								)}
							</For>
						</Show>
						<Show when={detailsValue() !== undefined}>
							{fold(
								":details",
								props.result
									? "Native retained details"
									: "Native live details",
							)}
							<Show when={open(":details")}>
								<code
									content={JSON.stringify(detailsValue(), null, 2)}
									filetype="json"
									syntaxStyle={props.syntax}
									drawUnstyledText={true}
									wrapMode="word"
								/>
							</Show>
						</Show>
						<Show when={props.progress?.summary !== undefined && !props.result}>
							<text fg={color("textMuted")}>
								Native nested completion summary:{" "}
								{JSON.stringify(props.progress?.summary)}
							</text>
						</Show>
					</box>
				</Show>
			</ToolSurfaceHoverContext.Provider>
		</box>
	);
}
