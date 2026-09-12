import type { ScrollBoxRenderable } from "@opentui/core";
import type { KeyboardEvent } from "./types";

function isHorizontalScrollLeftKey(event: KeyboardEvent): boolean {
	return (
		!event.shift &&
		(event.name === "h" ||
			event.sequence === "h" ||
			event.name === "left" ||
			event.name === "Left")
	);
}

function isHorizontalScrollRightKey(event: KeyboardEvent): boolean {
	return (
		!event.shift &&
		(event.name === "l" ||
			event.sequence === "l" ||
			event.name === "right" ||
			event.name === "Right")
	);
}

export function handleHorizontalScrollKey(
	event: KeyboardEvent,
	scrollBox: ScrollBoxRenderable | undefined,
	amount = 8,
): boolean {
	if (isHorizontalScrollLeftKey(event)) {
		scrollBox?.scrollBy({ x: -amount, y: 0 });
		return true;
	}
	if (isHorizontalScrollRightKey(event)) {
		scrollBox?.scrollBy({ x: amount, y: 0 });
		return true;
	}
	return false;
}

export function isPreviousRelatedKey(event: KeyboardEvent): boolean {
	return (
		event.sequence === "[" ||
		event.name === "[" ||
		event.name === "K" ||
		event.sequence === "K" ||
		(event.name === "k" && !!event.shift)
	);
}

export function isNextRelatedKey(event: KeyboardEvent): boolean {
	return (
		event.sequence === "]" ||
		event.name === "]" ||
		event.name === "J" ||
		event.sequence === "J" ||
		(event.name === "j" && !!event.shift)
	);
}
