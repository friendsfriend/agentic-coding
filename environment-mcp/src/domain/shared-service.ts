import * as z from "zod/v4";
import { identifier } from "../configuration/primitives.ts";

const lease = z.strictObject({
	scope: z.uuid(),
	app: identifier,
	target: identifier,
	acquiredAt: z.number().int(),
});
export const sharedServiceSchema = z.strictObject({
	service: identifier,
	state: z.enum(["starting", "ready", "stopping", "uncertain", "released"]),
	operation: z.uuid(),
	scope: z.uuid(),
	containers: z.array(z.string().regex(/^[a-f0-9]{12,64}$/)).max(32),
	socket: z.string().min(1).max(4096),
	provider: z.enum(["docker", "podman"]),
	startedAt: z.number().int(),
	leases: z.array(lease).max(256).default([]),
});
export type SharedService = z.output<typeof sharedServiceSchema>;
