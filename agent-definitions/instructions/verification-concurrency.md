# Concurrency verification

Review changed shared mutable state for introduced races, unguarded ordering assumptions, and unsafe reentrancy: concurrent step transitions and projections, duplicate or late run completion, outbox retry ordering and idempotency, and interleaving between engine transactions and boundary adapters. Report concrete evidence only.
