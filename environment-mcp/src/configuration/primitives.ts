import * as z from "zod/v4";

export const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const runtime = z.enum([
	"shell",
	"systemshell",
	"docker",
	"podman",
	"compose",
	"kubernetes",
]);
export const action = z.enum(["build", "test", "run"]);
