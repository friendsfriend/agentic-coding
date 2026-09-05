## ADDED Requirements

### Requirement: Prepared evidence retains transactional authorization
Expensive external evidence collection SHALL occur outside the canonical writer transaction where equivalent integrity can be maintained. Prepared evidence SHALL be bound to the workflow, exact run generation or developer revision, relevant source baseline, and validated artifact content. The command transaction SHALL reload current state and reauthorize authority, legality, and evidence bindings before acceptance. Necessary final integrity checks SHALL not be removed merely to shorten the transaction.

#### Scenario: Slow evidence collection is in progress
- **WHEN** a handoff is waiting for an external evidence collector before transaction application
- **THEN** it SHALL not hold the canonical SQLite writer lock during that collection
- **AND** an independent valid workflow command SHALL be able to commit

#### Scenario: Artifact changes after preparation
- **WHEN** submitted evidence is replaced, moved outside its assigned path, oversized, or changed after its initial preparation
- **THEN** acceptance SHALL reject or reprepare it using the existing path, size, schema, and digest guarantees
- **AND** rejected evidence SHALL not consume the run capability

#### Scenario: Source isolation changes during preparation
- **WHEN** guarded repository content changes after evidence collection but before handoff acceptance
- **THEN** the engine SHALL detect the invalid binding or perform the required final integrity validation
- **AND** it SHALL not accept a stale fingerprint as proof that live source remained unchanged

#### Scenario: Sibling handoff commits first
- **WHEN** a distinct active parallel run commits while evidence is being prepared
- **THEN** the engine SHALL validate the submitting run against the latest snapshot and reprepare dependent evidence if necessary
- **AND** an unrelated revision alone SHALL not invalidate an otherwise authorized active-run handoff

#### Scenario: Run is expired during preparation
- **WHEN** repair, cancellation, or another accepted outcome expires the submitting run before application
- **THEN** transactional reauthorization SHALL reject the prepared completion
- **AND** no successor runs, effects, or capability consumption SHALL be committed for it
