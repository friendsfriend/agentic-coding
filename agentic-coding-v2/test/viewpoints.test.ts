import { expect, test } from "bun:test";
import { Navigation, view } from "../src/tui/shell/navigation.ts";
import { Viewpoints } from "../src/tui/shell/viewpoints.ts";

test("saved viewpoints restore nested state and unsent input; navigation never executes a command", () => {
	const navigation = new Navigation(),
		viewpoints = new Viewpoints();
	navigation.current = {
		...view("session", "17"),
		draft: "unsent follow-up",
		selection: 3,
		scroll: 28,
		filter: "error",
		expanded: ["tool:9"],
		detail: { tab: "transcript" },
	};
	const saved = viewpoints.save("Investigation", navigation.current);
	navigation.go(view("environments", "api"));
	const reloaded = new Viewpoints();
	reloaded.load(viewpoints.export());
	reloaded.restore(saved.id, navigation);
	expect(navigation.current).toEqual(saved.view);
	navigation.current.draft = "changed";
	expect(reloaded.items[0]?.view.draft).toBe("unsent follow-up");
	navigation.back();
	expect(navigation.current.page).toBe("environments");
	reloaded.remove(saved.id);
	expect(() => reloaded.restore(saved.id, navigation)).toThrow();
});
