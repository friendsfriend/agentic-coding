import { describe, expect, test } from "bun:test";
import {
	mergeBuildOutput,
	parseBuildOutput,
} from "../src/environments/build.ts";

const output = `#1 [internal] load build definition from Dockerfile
#1 transferring dockerfile: 81B done
#1 DONE 0.0s

#4 [1/2] FROM docker.io/library/nginx:alpine@sha256:abc
#4 CACHED

#5 [2/2] RUN echo hello
#5 0.086 hello
#5 DONE 0.1s

#6 exporting to image
#6 exporting layers 0.0s done
#6 DONE 0.1s
`;

describe("build output", () => {
	test("parses steps, cached state, duration and logs", () => {
		const parsed = parseBuildOutput(output);
		expect(parsed.steps.map((step) => step.id)).toEqual(["1", "4", "5", "6"]);
		expect(parsed.steps[0]).toMatchObject({
			title: "[internal] load build definition from Dockerfile",
			status: "done",
			duration: "0.0s",
		});
		expect(parsed.steps[1]).toMatchObject({
			title: "[1/2] FROM docker.io/library/nginx:alpine@sha256:abc",
			status: "cached",
		});
		expect(parsed.steps[2]?.logs).toContain("hello");
		expect(parsed.steps[3]?.title).toBe("exporting to image");
	});

	test("keeps an error block with the failing step", () => {
		const failed = parseBuildOutput(`#5 [2/2] RUN false
#5 0.062 before
#5 ERROR: process did not complete successfully: exit code: 1
------
 > [2/2] RUN false:
0.062 before
------
ERROR: failed to build
`);
		expect(failed.steps[0]).toMatchObject({
			id: "5",
			status: "error",
		});
		expect(failed.steps[0]?.logs.join("\n")).toContain("exit code: 1");
		expect(failed.steps[0]?.logs.join("\n")).toContain("0.062 before");
		expect(failed.global).toContain("ERROR: failed to build");
	});

	test("merges retained live steps with a settled tail", () => {
		const live = parseBuildOutput(
			"#1 [1/2] FROM base\n#1 DONE 0.0s\n#9 [2/2] RUN build\n#9 1.0 line\n",
		);
		const settled = parseBuildOutput(
			"#9 1.1 more\n#9 1.2 even more\n#9 DONE 5.0s\n",
		);
		const merged = mergeBuildOutput(live, settled);
		expect(merged?.steps.map((step) => step.id)).toEqual(["1", "9"]);
		expect(merged?.steps[1]).toMatchObject({
			status: "done",
			duration: "5.0s",
		});
		expect(merged?.steps[1]?.logs).toContain("even more");
	});
});
