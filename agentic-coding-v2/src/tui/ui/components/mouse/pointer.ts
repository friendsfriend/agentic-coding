import type { MouseEvent } from "@opentui/core";

/** True while the event cell lies inside the renderable that received it. */
export function pointerInside(event: MouseEvent): boolean {
	const target = event.currentTarget;
	if (!target) return false;
	return (
		event.x >= target.screenX &&
		event.x < target.screenX + target.width &&
		event.y >= target.screenY &&
		event.y < target.screenY + target.height
	);
}
