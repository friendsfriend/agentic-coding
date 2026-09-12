import { describe, expect, test } from "bun:test";
import {
	statusAnimationIntentForOperation,
	statusAnimationIntentForText,
	statusAnimationModel,
} from "./AnimatedStatusText";

describe("operation status animation model", () => {
	test("uses semantic action tones across application, library, and infrastructure operations", () => {
		expect(
			statusAnimationModel(statusAnimationIntentForOperation("start")).tone,
		).toBe("positive");
		expect(
			statusAnimationModel(statusAnimationIntentForOperation("run")).tone,
		).toBe("positive");
		expect(
			statusAnimationModel(statusAnimationIntentForOperation("stop")).tone,
		).toBe("negative");
		expect(
			statusAnimationModel(statusAnimationIntentForOperation("build")).tone,
		).toBe("warning");
		expect(
			statusAnimationModel(statusAnimationIntentForOperation("test")).tone,
		).toBe("warning");
		expect(
			statusAnimationModel(statusAnimationIntentForOperation("checkout")).tone,
		).toBe("highlight2");
		expect(
			statusAnimationModel(statusAnimationIntentForOperation("script")).tone,
		).toBe("warning");
		expect(statusAnimationIntentForText("Stopping infrastructure")).toBe(
			"stop",
		);
		expect(statusAnimationIntentForText("Running tests")).toBe("test");
		expect(statusAnimationIntentForText("Building library")).toBe("build");
	});
});
