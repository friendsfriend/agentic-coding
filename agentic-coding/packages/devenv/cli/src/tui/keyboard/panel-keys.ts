import type { KeyboardEvent } from "./types";

export const isNextPanelKey = (event: KeyboardEvent) =>
	event.sequence === "J" || (event.name === "j" && event.shift);

export const isPrevPanelKey = (event: KeyboardEvent) =>
	event.sequence === "K" || (event.name === "k" && event.shift);

export const isReverseTabKey = (event: KeyboardEvent) =>
	(event.name === "tab" || event.name === "Tab") && !!event.shift;

export const NO_PANEL_FOCUS = -1;

export const nextPanelIndex = (current: number, panelCount: number) =>
	current < 0 ? 0 : (current + 1) % panelCount;

export const prevPanelIndex = (current: number, panelCount: number) =>
	current < 0 ? panelCount - 1 : (current - 1 + panelCount) % panelCount;
