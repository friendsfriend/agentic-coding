// The host asks the trusted server to derive authority from a committed claim.
// This is an instance-only control contract, never an agent/environment tool.
import { Schema } from "effect";
export const launchClaimSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	runId: Schema.String,
	effectId: Schema.String,
	lease: Schema.String,
	intent: Schema.optionalKey(Schema.Literals(["admit", "stop"])),
});
export type LaunchClaim = Schema.Schema.Type<typeof launchClaimSchema>;
export const launchPermitSchema = Schema.Struct({
	workflowId: Schema.String,
	runId: Schema.String,
	stepId: Schema.String,
	role: Schema.String,
	generation: Schema.Number,
	attempt: Schema.Number,
	revision: Schema.Number,
	claimAttempt: Schema.Number,
	requestId: Schema.String,
	leaseExpiresAt: Schema.String,
	name: Schema.String,
	cwd: Schema.String,
	runEnvPath: Schema.String,
	hostRoot: Schema.String,
	toolPolicy: Schema.Literals(["default", "read-only"]),
	model: Schema.optionalKey(Schema.String),
	thinking: Schema.optionalKey(Schema.String),
});
export type LaunchPermit = Schema.Schema.Type<typeof launchPermitSchema>;
export const launchObservationSchema = Schema.Struct({
	runId: Schema.String,
	state: Schema.Literals([
		"absent",
		"prepared",
		"admitted",
		"stopping",
		"stopped",
	]),
	activity: Schema.Literals([
		"absent",
		"idle",
		"working",
		"blocked",
		"unknown",
	]),
	requestId: Schema.optionalKey(Schema.String),
});
export type LaunchObservation = typeof launchObservationSchema.Type;

export const launchRecoveryDetailSchema = Schema.Struct({
	effectId: Schema.String,
	runId: Schema.String,
	claimState: Schema.Literals(["unclaimed", "live", "expired", "malformed"]),
	cancelRequested: Schema.optionalKey(Schema.Boolean),
	claimAttempt: Schema.Number,
	claimOwner: Schema.optionalKey(Schema.String),
	leaseExpiresAt: Schema.optionalKey(Schema.String),
	admission: Schema.optionalKey(launchObservationSchema),
});
export type LaunchRecoveryDetail = typeof launchRecoveryDetailSchema.Type;
export const LAUNCH_VERIFY_PATH = "/api/v1/workflow/verify-launch";
