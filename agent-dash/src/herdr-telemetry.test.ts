import { expect, test } from "bun:test";
import { telemetryTest } from "../../agent-definitions/extensions/herdr-telemetry";

test("verifiers persist after settling", () => {
  expect(telemetryTest.isOneShot("quality-verifier")).toBe(false);
  expect(telemetryTest.isOneShot("archive")).toBe(true);
});
