## ADDED Requirements

### Requirement: Effect lifecycle tests share controlled time
Focused lease, retry, polling, and question-deadline tests SHALL use Effect-controlled time shared with engine validation and fake services. They SHALL synchronize task readiness before advancing time rather than depend on arbitrary real sleeps. Real SQLite/process tests SHALL remain for behavior virtual time cannot establish.

#### Scenario: Renewal deadline advances
- **WHEN** a ready execution test advances controlled time through renewal and expiry boundaries
- **THEN** runner scheduling and store ownership validation SHALL agree without an independently advanced clock

#### Scenario: Virtual test passes but process leaks
- **WHEN** a virtual cancellation test succeeds but a real owned process or credential reader survives its cleanup deadline
- **THEN** the real boundary contract test SHALL fail and block release

### Requirement: Migrated handlers retain crash and ownership checks
The focused execution checks SHALL cover every registered handler's relevant observation, execution, typed failure, and cleanup behavior, including durable agent survival, successor ownership, renewal exceptions, and crash after external success. Registry additions SHALL not silently escape handler coverage.

#### Scenario: Process crashes after remote success
- **WHEN** execution exits after external success but before result commit
- **THEN** a real-store recovery check SHALL verify observation avoids duplicate external work or surfaces uncertainty safely

#### Scenario: Handler kind is added
- **WHEN** a new effect kind is registered without its required handler/contract coverage
- **THEN** the focused coverage check SHALL identify that kind and fail
