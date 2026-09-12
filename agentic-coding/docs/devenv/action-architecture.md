# Backend action architecture

Operational actions are configuration-derived immutable definitions compiled into versioned registry snapshots. Stable IDs use resource, action, runtime, and profile identity; never labels, array positions, or checkout paths. Registry publication is atomic. Active and historical runs retain compact definition snapshots.

Definitions separate semantic tree identity (`StepDefinitionID`) from deduplicated work identity (`ExecutionKey`). Duplicate dependency relationships remain visible, while one canonical node owns execution and command output. References mirror result metadata. `already-running` is successful outcome distinct from skipped work.

Step handlers execute capabilities. Sequential composites enforce failure conditions and always-run cleanup. Named typed values connect producers and consumers; positional previous-step output is forbidden. Values declare action/composite/step scope and public/internal/secret/ephemeral visibility. Secret and ephemeral values never enter persisted snapshots.

Every executed process command owns one leaf step, stdout, stderr, exit result, and error. Composite and SDK operation steps remain commandless. Process startup completes only after explicit readiness. Existing script configuration defaults to one-second process or tmux-pane survival stabilization.

Clients query backend definitions and start actions by stable ID. Frontends must not infer workflows, parse configuration filenames, or synthesize infrastructure runners. Legacy operation endpoints remain compatibility adapters only until provider cutover.
