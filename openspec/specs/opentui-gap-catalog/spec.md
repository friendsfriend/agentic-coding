# opentui-gap-catalog Specification

## Purpose
TBD - created by archiving change otel-gap-analysis. Update Purpose after archive.
## Requirements
### Requirement: Gap inventory
The catalog SHALL enumerate action domains that currently emit no OpenTelemetry traces.

#### Scenario: Reader reviews domain inventory
- **WHEN** developer opens the gap catalog
- **THEN** catalog SHALL list all untraced domains with unique identifier, name, description, and affected component tag

#### Scenario: Domains listed
- **WHEN** developer views the catalog
- **THEN** these domains SHALL be present with at least one concrete untraced action each:
  | Domain | ID | Untraced actions | Tier | Effort |
  |--------|-----|-----------------|------|--------|
  | Pi runtime | pi-runtime | Extension load/unload, config file change detection, file watcher events, SIGUSR1/SIGHUP reload | P0 | M |
  | Agent-dash UI | agent-dash-ui | Panel switch, modal open/close, theme change, keymap layer switch, clipboard copy | P1 | M |
  | Git operations | git-ops | `herdr-workflow` git commit, branch create/switch, merge, push, stash | P1 | S |
  | Notification system | notifications | `herdr notification show`, notification click/dismiss, toast lifecycle | P2 | S |
  | Error recovery | error-recovery | Retry loop iteration, backoff delay, circuit breaker open/close, recovery agent invocation | P0 | L |
  | OpenSpec operations | openspec | Spec validation result, proposal generation, artifact write, archive | P1 | M |
  | Workflow admin | workflow-admin | Workflow create, approve, reject, archive, state override, phase transition | P0 | S |
  | Performance | performance | Memory/CPU samples, render frame timing, GC pause duration, tool execution queue depth | P2 | XL |

### Requirement: Prioritisation
The catalog SHALL assign an observability value tier (P0/P1/P2) and effort estimate (S/M/L/XL) to each instrumentation candidate.

#### Scenario: Candidate ranked
- **WHEN** developer reads a catalog entry
- **THEN** entry SHALL show:
  - Tier: P0 (high value, trace would debug frequent failures), P1 (medium value, trace aids troubleshooting), P2 (nice-to-have)
  - Effort: S (<1 day), M (1-3 days), L (1 week), XL (>1 week)
  - Dependency: any prerequisite instrumentation or spec change needed first

#### Scenario: P0 candidates identified
- **WHEN** developer filters the catalog by tier
- **THEN** P0 candidates SHALL include at minimum:
  - Extension load failure — P0, M effort, no dependencies
  - Workflow create/approve/reject — P0, S effort, depends on herdr-workflow CLI span
  - Error recovery cycle — P0, L effort, needs herdr-agent-telemetry retry hooks

### Requirement: Recipe cards
Each candidate SHALL have an instrumentation recipe card showing what code to touch, what span attributes to emit, and what parent trace to attach to.

#### Scenario: Developer reads recipe
- **WHEN** developer opens a catalog entry's recipe card
- **THEN** recipe SHALL show:
  - Span name template (e.g. `extension.load`, `workflow.approve`)
  - Parent span strategy (continue current trace, start new trace, attach to active agent-operation)
  - Required attributes (component, outcome, duration, error reason)
  - File paths and function names to instrument
  - Sample instrumentation code in TypeScript

#### Scenario: P0 recipe cards
- **WHEN** developer reads P0 candidate recipe
- **THEN** recipe SHALL include span name template, parent strategy, required attributes, file paths, and sample instrumentation code.

#### Scenario: Recipe for extension load failure (pi-runtime)
- **WHEN** developer reads extension load recipe
- **THEN** recipe SHALL include:
  - Span name: `pi.extension.load`
  - Parent: continue current agent-operation or start new trace
  - Attributes: `pi.extension.name`, `pi.extension.path`, `pi.extension.outcome`, `pi.extension.error`
  - Files: `pi/src/extension.ts` (`loadExtension` function)
  - Sample:
```typescript
import { trace } from '@opentelemetry/api';
const tracer = trace.getTracer('pi-extension');
async function loadExtension(name: string, path: string) {
  return tracer.startActiveSpan('pi.extension.load', async (span) => {
    span.setAttribute('pi.extension.name', name);
    span.setAttribute('pi.extension.path', path);
    try {
      const result = await actualLoad(name, path);
      span.setAttribute('pi.extension.outcome', 'success');
      return result;
    } catch (e) {
      span.setAttribute('pi.extension.outcome', 'failure');
      span.setAttribute('pi.extension.error', String(e));
      span.setStatus({ code: 2, message: String(e) });
      throw e;
    } finally { span.end(); }
  });
}
```

#### Scenario: Recipe for workflow create/approve/reject (workflow-admin)
- **WHEN** developer reads workflow admin recipe
- **THEN** recipe SHALL include:
  - Span name: `herdr.workflow.create`, `herdr.workflow.approve`, `herdr.workflow.reject`
  - Parent: continue current user action trace
  - Attributes: `herdr.workflow.id`, `herdr.workflow.action`, `herdr.workflow.outcome`, `herdr.workflow.actor`
  - Files: `pi/bin/herdr-workflow` (`createWorkflow`, `approveWorkflow`, `rejectWorkflow` functions)
  - Sample:
```typescript
const tracer = trace.getTracer('herdr-workflow');
async function approveWorkflow(id: string, actor: string) {
  return tracer.startActiveSpan('herdr.workflow.approve', async (span) => {
    span.setAttribute('herdr.workflow.id', id);
    span.setAttribute('herdr.workflow.action', 'approve');
    span.setAttribute('herdr.workflow.actor', actor);
    try {
      const result = await actualApprove(id);
      span.setAttribute('herdr.workflow.outcome', 'success');
      return result;
    } catch (e) {
      span.setAttribute('herdr.workflow.outcome', 'failure');
      span.setStatus({ code: 2, message: String(e) });
      throw e;
    } finally { span.end(); }
  });
}
```

#### Scenario: Recipe for error recovery cycle (error-recovery)
- **WHEN** developer reads error recovery recipe
- **THEN** recipe SHALL include:
  - Span name: `herdr.recovery.cycle`
  - Parent: continue current workflow action trace
  - Attributes: `herdr.recovery.round`, `herdr.recovery.max_retries`, `herdr.recovery.backoff_ms`, `herdr.recovery.outcome`
  - Files: `pi/bin/herdr-workflow` (retry loop), `pi/bin/recovery-agent` (invocation)
  - Sample:
```typescript
const tracer = trace.getTracer('herdr-recovery');
async function recoveryCycle(action: () => Promise<void>, maxRetries: number) {
  for (let round = 1; round <= maxRetries; round++) {
    await tracer.startActiveSpan('herdr.recovery.cycle', async (span) => {
      span.setAttribute('herdr.recovery.round', round);
      span.setAttribute('herdr.recovery.max_retries', maxRetries);
      span.setAttribute('herdr.recovery.backoff_ms', backoff(round));
      try {
        await action();
        span.setAttribute('herdr.recovery.outcome', 'success');
        return;
      } catch (e) {
        span.setAttribute('herdr.recovery.outcome', 'retry');
        if (round === maxRetries) {
          span.setAttribute('herdr.recovery.outcome', 'exhausted');
          span.setStatus({ code: 2, message: String(e) });
        }
        throw e;
      } finally { span.end(); }
    });
  }
}
```

### Requirement: Instrumentation status tracking
The catalog SHALL track instrumentation status for each domain with current completion state and change reference.

#### Scenario: Developer checks instrumentation status
- **WHEN** developer views the instrumentation status table
- **THEN** the catalog SHALL display a table with Domain ID, Instrumented status, Change ID, and Date columns
- **AND** SHALL show ❌ for uninstrumented domains and ✅ for completed ones

| Domain ID | Instrumented | Change ID | Date |
|-----------|-------------|-----------|------|
| pi-runtime | ❌ | — | — |
| agent-dash-ui | ❌ | — | — |
| git-ops | ❌ | — | — |
| notifications | ❌ | — | — |
| error-recovery | ❌ | — | — |
| openspec | ❌ | — | — |
| workflow-admin | ❌ | — | — |
| performance | ❌ | — | — |

### Requirement: Living document format
The catalog SHALL be a spec scenario document under `openspec/changes/otel-gap-analysis/specs/opentui-gap-catalog/spec.md` and be updated as new domains are instrumented.

#### Scenario: New domain discovered
- **WHEN** developer identifies an untraced action not in the catalog
- **THEN** developer SHALL add a new domain entry with all required fields
- **AND** SHALL re-index the priority table

#### Scenario: Domain instrumented
- **WHEN** instrumentation for a catalog entry is completed
- **THEN** developer SHALL mark the entry as `instrumented: true`
- **AND** SHALL add a reference to the change ID that implemented it

