/**
 * Wire-contract layer: the shapes the server, the dashboard gateway and the
 * TUI exchange. Pure structural types and Effect Schemas — importing this
 * module must never pull in TUI, server, workflow-runtime, database,
 * filesystem, process or network code.
 *
 * - `workflow.ts`   workflow views, actions, questions, commands, reviews
 * - `telemetry.ts`  OTEL metric/log/span/trace records and telemetry requests
 * - `actions.ts`    action, agent and review request schemas
 * - `environment.ts` observations, event envelopes, connection state, errors
 * - `integration.ts` Git, wiki and Herdr observations
 * - `credential.ts` credential interaction responses
 * - `gateway.ts`    the `DashboardGateway` port both transports implement
 * - `decode.ts`     `ContractFailure` and the Effect-Schema decode boundary
 */

export * from "./actions.ts";
export * from "./credential.ts";
export * from "./decode.ts";
export * from "./environment.ts";
export * from "./gateway.ts";
export * from "./integration.ts";
export * from "./telemetry.ts";
export * from "./workflow.ts";
