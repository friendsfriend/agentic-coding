/** @jsxImportSource @opentui/solid */
import {
	type BoxRenderable,
	type OptimizedBuffer,
	RGBA,
	TextAttributes,
} from "@opentui/core";
import { createMemo, createSignal, For } from "solid-js";
import { uiColors } from "../colors";

export interface TimelineMetric {
	title: string;
	value: string;
	values: number[];
	color: string;
}

export interface ResourceTimelineChartsProps {
	cpu: TimelineMetric;
	memory: TimelineMetric;
	/** Fixed width reserved for labels on the left. Defaults to 16 columns. */
	labelWidth?: number;
	/** Gap between label column and chart. Defaults to 1 column. */
	labelGap?: number;
	/** Horizontal padding inside the component. Defaults to 1 column each side. */
	paddingX?: number;
	/** Scale chart to visible data range. Defaults to false; fixed 0–100 keeps values comparable. */
	autoScale?: boolean;
}

interface Size {
	width: number;
	height: number;
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

function padOrTrim(value: string, width: number): string {
	if (width <= 0) return "";
	if (value.length > width) return value.slice(0, width);
	return value.padEnd(width, " ");
}

function visibleValues(values: number[], cellWidth: number): number[] {
	const safeWidth = Math.max(1, cellWidth);
	const display = values.length > safeWidth ? values.slice(-safeWidth) : values;
	const pad = safeWidth - display.length;
	return [...Array.from({ length: pad }, () => NaN), ...display];
}

function valueRange(
	values: number[],
	autoScale: boolean,
): { min: number; max: number } {
	const realValues = values.filter((value) => Number.isFinite(value));
	if (!autoScale || realValues.length === 0) return { min: 0, max: 100 };

	let min = Math.min(...realValues);
	let max = Math.max(...realValues);
	const range = max - min;

	if (range < 0.1) {
		min -= 0.5;
		max += 0.5;
	} else {
		const pad = range * 0.08;
		min -= pad;
		max += pad;
	}

	return { min: clamp(min, 0, 100), max: clamp(max, 0, 100) };
}

function sampleValue(values: number[], subpixelX: number): number {
	if (values.length === 0) return NaN;
	const cellX = subpixelX / 2;
	const left = Math.floor(cellX);
	const right = Math.min(values.length - 1, left + 1);
	const t = cellX - left;
	const a = values[left];
	const b = values[right];
	if (!Number.isFinite(a)) return NaN;
	if (!Number.isFinite(b)) return a;
	return a + (b - a) * t;
}

const BRAILLE_DOTS = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];

function brailleChar(mask: number): string {
	return mask === 0 ? " " : String.fromCharCode(0x2800 + mask);
}

function makeBrailleRows(
	values: number[],
	cellWidth: number,
	cellHeight: number,
	autoScale: boolean,
): string[] {
	const safeCellWidth = Math.max(1, cellWidth);
	const safeCellHeight = Math.max(1, cellHeight);
	const subpixelWidth = safeCellWidth * 2;
	const subpixelHeight = safeCellHeight * 4;
	const masks = Array.from({ length: safeCellHeight }, () =>
		Array.from({ length: safeCellWidth }, () => 0),
	);
	const display = visibleValues(values, safeCellWidth);
	const range = valueRange(display, autoScale);
	const span = Math.max(0.1, range.max - range.min);

	for (let x = 0; x < subpixelWidth; x++) {
		const value = sampleValue(display, x);
		if (!Number.isFinite(value)) continue;

		const normalized = clamp((value - range.min) / span, 0, 1);
		const lineY = normalized * (subpixelHeight - 1);
		const yFromTop = subpixelHeight - 1 - Math.round(lineY);
		const cellX = Math.floor(x / 2);
		const cellY = Math.floor(yFromTop / 4);
		const dotX = x % 2;
		const dotY = yFromTop % 4;

		masks[cellY][cellX] |= BRAILLE_DOTS[dotY]?.[dotX] ?? 0;
	}

	return masks.map((row) => row.map(brailleChar).join(""));
}

function renderMetricBraille(metric: TimelineMetric, autoScale: boolean) {
	const fg = RGBA.fromHex(metric.color);
	const bg = RGBA.fromHex(uiColors.bgMantle);

	return function renderAfter(this: BoxRenderable, buffer: OptimizedBuffer) {
		const width = Math.max(1, this.width ?? 0);
		const height = Math.max(1, this.height ?? 0);
		const rows = makeBrailleRows(metric.values, width, height, autoScale);

		buffer.fillRect(this.screenX, this.screenY, width, height, bg);
		rows.forEach((row, index) => {
			buffer.drawText(row, this.screenX, this.screenY + index, fg, bg);
		});
	};
}

function labelFor(
	metric: TimelineMetric,
	row: number,
	rows: number,
	width: number,
): string {
	if (rows <= 1) return padOrTrim(metric.title, width);
	if (row === 0) return padOrTrim(metric.title, width);
	if (row === 1) return padOrTrim(metric.value, width);
	return " ".repeat(Math.max(0, width));
}

export function ResourceTimelineCharts(props: ResourceTimelineChartsProps) {
	let root: BoxRenderable | undefined;
	const [size, setSize] = createSignal<Size>({ width: 0, height: 0 });
	const labelWidth = () => props.labelWidth ?? 16;
	const labelGap = () => props.labelGap ?? 1;
	const paddingX = () => props.paddingX ?? 1;
	const autoScale = () => props.autoScale ?? false;

	const updateSize = () => {
		if (!root) return;
		const next = {
			width: Math.max(0, root.width ?? 0),
			height: Math.max(0, root.height ?? 0),
		};
		const current = size();
		if (next.width !== current.width || next.height !== current.height) {
			setSize(next);
		}
	};

	const metricRows = createMemo(() =>
		Math.max(1, Math.floor(Math.max(2, size().height) / 2)),
	);
	const graphWidth = createMemo(() =>
		Math.max(1, size().width - paddingX() * 2 - labelWidth() - labelGap()),
	);

	const renderMetric = (metric: TimelineMetric) => (
		<box
			style={{
				width: "100%",
				height: metricRows(),
				flexDirection: "row",
				paddingLeft: paddingX(),
				paddingRight: paddingX(),
				flexShrink: 0,
			}}
		>
			<box
				style={{
					width: labelWidth(),
					height: "100%",
					flexDirection: "column",
					flexShrink: 0,
				}}
			>
				<For each={Array.from({ length: metricRows() })}>
					{(_, index) => (
						<box style={{ width: "100%", height: 1, flexShrink: 0 }}>
							<text
								fg={index() === 0 ? uiColors.textMuted : uiColors.textSecondary}
								attributes={index() === 0 ? TextAttributes.BOLD : undefined}
							>
								{labelFor(metric, index(), metricRows(), labelWidth())}
							</text>
						</box>
					)}
				</For>
			</box>
			<box style={{ width: labelGap(), height: "100%", flexShrink: 0 }} />
			<box
				renderAfter={renderMetricBraille(metric, autoScale())}
				backgroundColor={uiColors.bgMantle}
				style={{
					width: graphWidth(),
					height: metricRows(),
					flexShrink: 0,
					overflow: "hidden",
				}}
			/>
		</box>
	);

	return (
		<box
			ref={(r: BoxRenderable) => {
				root = r;
				queueMicrotask(updateSize);
			}}
			onSizeChange={updateSize}
			style={{
				width: "100%",
				flexGrow: 1,
				minHeight: 0,
				flexDirection: "column",
				overflow: "hidden",
			}}
		>
			{renderMetric(props.cpu)}
			{renderMetric(props.memory)}
		</box>
	);
}
