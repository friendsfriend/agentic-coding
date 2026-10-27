## MODIFIED Requirements

### Requirement: Compaction policy resolution

The system SHALL select the nonempty user-scope `agentHost.compaction` section over `agents.compaction` over defaults, then merge exact `modelOverrides["provider/modelId"]` entries field-wise over that selected section. Provider identity SHALL be significant and further slashes in model IDs SHALL be preserved. Each conversation's policy SHALL be resolved against its actual model window through native pi-durable modelOverrides rather than another conversation's window. Absolute and percentage semantics, defaults, floors, clamps and cost-ceiling tail caps SHALL remain unchanged. `ceilingTokens` SHALL remain absolute-only. The native policy SHALL carry enabled, reserveTokens, keepRecentTokens and backgroundTokens; the host SHALL retain its independent cost-ceiling policy and per-run/role guards.

The default reserve SHALL remain `max(32000, 30% of window)` capped at half a known window; backgroundTokens SHALL default to 32000 and keepRecentTokens to 20000. Unknown windows SHALL use each field's existing absolute fallback. Settings SHALL describe actual-model resolution and display no-window fallback values when it has no model context. Ordinary settings edits SHALL preserve handwritten overrides. Validation SHALL clearly name invalid exact-entry fields from the selected source.

#### Scenario: No configuration present

- **WHEN** neither source is configured and the conversation's model window is unknown
- **THEN** the policy SHALL use enabled true, reserve 32000, background 32000 and kept tail 20000

#### Scenario: Known model defaults

- **WHEN** an unconfigured conversation uses a 1000000-token model
- **THEN** its reserve SHALL be 300000 independently of other conversations

#### Scenario: Exact field precedence

- **WHEN** the selected global section sets reserveTokens and its exact model entry sets only backgroundTokens
- **THEN** the entry's background SHALL replace the global background while reserve SHALL inherit from that selected section

#### Scenario: Unknown identity fallback

- **WHEN** an exact identity has a percentage override but no known model window
- **THEN** that percentage SHALL use its existing absolute fallback and SHALL NOT borrow another run's window

#### Scenario: Invalid exact override

- **WHEN** a handwritten entry has an invalid token form, identity, nested table or inherited tail/ceiling conflict
- **THEN** Settings validation SHALL identify that entry and parsing SHALL retain existing tolerant fallback behavior

#### Scenario: Ordinary settings edit

- **WHEN** the developer edits a global field while handwritten modelOverrides are present
- **THEN** the stored entries SHALL be preserved

### Requirement: Reference window from tracked runs

Each conversation SHALL use its actual model's catalog window, independently of other tracked runs. Native threshold checks, overflow recovery and compaction selection SHALL resolve that exact identity. Host ceilings SHALL use the same effective exact configuration and that run's own window. A model switch or live configuration change SHALL affect subsequent resolutions without changing another conversation's policy. Unknown windows SHALL NOT fall back to another tracked run's window.

#### Scenario: Concurrent mixed windows

- **WHEN** conversations on a small-window model and a 1000000-token model run in one host
- **THEN** each SHALL use its own thresholds and the large-window conversation SHALL NOT inherit the small-window reserve

#### Scenario: Model switch

- **WHEN** a conversation switches to a smaller model
- **THEN** subsequent native preparations and host ceiling decisions SHALL use that model's policy without altering other conversations

#### Scenario: Live configuration

- **WHEN** the effective exact or global configuration changes
- **THEN** subsequent resolution SHALL reflect it without restarting the shared host

## ADDED Requirements

### Requirement: Conversation-scoped summarizer serialization

The host SHALL serialize native and host-triggered summarizer calls per conversation, including manual, background, blocking threshold, overflow and cost-ceiling tasks, while allowing independent progress across conversations. Waiting SHALL NOT depend on summary placement at a generation boundary. Failed or cancelled tasks and host reopen SHALL NOT leak a process-local admission guard. The narrow public-hook workaround MAY leave redundant native admissions and serialized summaries, retaining native stale-cut handling. Pre-upgrade duplicate tasks already checkpointed in summarize SHALL be drained before upgrade; no migration is introduced for them.

#### Scenario: Nonblocking summary before blocking generation

- **WHEN** a manual or background summarizer is pending and generation admits blocking compaction
- **THEN** the later summarizer SHALL wait for its predecessor's task completion/write admission, not write placement, and SHALL progress after release

#### Scenario: Native-first or concurrent manual requests

- **WHEN** manual requests race with an existing native task or with each other
- **THEN** active summarizer requests for that conversation SHALL never exceed one

#### Scenario: Cleanup and independent progress

- **WHEN** summarization fails, is cancelled, or the host closes and reopens
- **THEN** subsequent work SHALL progress without leaked guards and unrelated conversations SHALL remain runnable
