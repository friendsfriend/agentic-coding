import type { KeyboardEvent } from "./types";

export const isDownKey = (event: KeyboardEvent) =>
	!event.shift &&
	(event.name === "j" ||
		event.sequence === "j" ||
		event.name === "down" ||
		event.name === "Down");

export const isUpKey = (event: KeyboardEvent) =>
	!event.shift &&
	(event.name === "k" ||
		event.sequence === "k" ||
		event.name === "up" ||
		event.name === "Up");

export const isLeftKey = (event: KeyboardEvent) =>
	!event.shift &&
	(event.name === "h" ||
		event.sequence === "h" ||
		event.name === "left" ||
		event.name === "Left");

export const isRightKey = (event: KeyboardEvent) =>
	!event.shift &&
	(event.name === "l" ||
		event.sequence === "l" ||
		event.name === "right" ||
		event.name === "Right");

export const isEnterKey = (event: KeyboardEvent) =>
	event.name === "return" ||
	event.name === "Return" ||
	event.name === "enter" ||
	event.name === "Enter" ||
	event.sequence === "\r" ||
	event.sequence === "\n" ||
	event.raw === "\r" ||
	event.raw === "\n";
