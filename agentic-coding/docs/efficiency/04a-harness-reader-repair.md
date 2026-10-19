# Addendum — the harness reader repair and the empty-source build alarm

Backlog item 23 (`04-backlog.md`, "Fix the harness reader, and make a source that
parsed nothing fail the build"). It is an additive record: it does **not** revise
the figures in `00`…`04`. The short version is in the last section: every turn
and call number those documents quote is a **lower bound** against the old
denominator, because a ninth of the snapshot's transcripts was invisible to
them.

## What was wrong

`harness.*` is the only source with a real transcript: per-turn stop reasons,
thinking-token counts, argument digests, result sizes and truncation. Nine
stores in the pinned snapshot (`backend`, `orchestrator`, `wiki-workflows`,
`main-store/harness-stale-oct12.sqlite`, five worktree stores) reported
`records = 0`, `parsed = 0` with the note
`unreadable: unable to open database file`, and the build recorded that as a
note — so a whole source disappeared from the dataset without failing anything.

Cause, verified against the snapshot rather than inferred: a harness store is a
SQLite database in **WAL mode** (bytes 18/19 of every one of the nine files read
`02 02`), and the evidence snapshot copies the store **without its `-shm` and
`-wal` companions**. SQLite cannot open a WAL database read-only without the
shared-memory index, so it refuses the file — with `SQLITE_CANTOPEN`, "unable to
open database file". Two details matter and are easy to get wrong:

- The failure surfaces on the **first statement**, not at `new Database(...)`:
  the open is lazy, so the error appears inside the first scan.
- A failed read-only attempt leaves nothing behind (no `-shm` is created in the
  snapshot directory); the test asserts that too, because writing into a read-only
  evidence tree would be a worse bug than the one being fixed.

## The repair

`scripts/efficiency/lib/harness.ts` opens a store in two steps:

1. a plain `new Database(path, { readonly: true })`, probed with
   `select count(*) from sqlite_master` so a lazy failure is raised at the open;
2. only if that fails, the same file through SQLite's URI form with
   `immutable=1` (`file:<escaped path>?immutable=1`, also `readonly`).

The plain open comes first so a store that *does* carry its WAL is still read
exactly as the runtime left it. `immutable=1` says the file cannot change and
needs no recovery, which is what lets SQLite read a frozen file with no
shared-memory index. **`immutable=1` ignores a live `-wal`**: the pages in the
main file are then the whole database. For a snapshot copy that is the intended
semantics — the companions were never copied, so there is no newer state to
honour — and it is why this is the fallback and not the default. The source file
row now says which path was taken, e.g.
`1 conversation(s); opened immutable=1: the snapshot copy has no -shm/-wal companion, so a live -wal would be ignored`.

Scope: this is the harness reader only. `herdr.*` and `traces.*` read fine in
this snapshot and were left alone; if a future snapshot loses them the same way,
the alarm below fails the build instead of quieting down.

## A source that parsed nothing now fails the build

`scripts/efficiency/build-dataset.ts` refuses to write a dataset when a source
file parses into zero rows. It exits non-zero, names every offending file with
its counts and note, points at the `source-gaps` query, and writes no
`dataset.sqlite` (the previous behaviour, a note in `source_files`, is how nine
stores stayed invisible for weeks: every workflow count still looked plausible).

The allow-list mechanism is `EMPTY_SOURCE_ALLOWLIST` in
`scripts/efficiency/lib/empty-sources.ts`: a short, documented list of
`{ path, source?, reason }` entries whose `path` is a `*`/`**` glob over the
snapshot-relative path (`*` inside one segment, `**` across segments) and whose
`source` narrows the entry when one pattern would otherwise cover several
sources. Every entry needs a reason. A build can add patterns for one run with
`--allow-empty "<pattern>[,<pattern>]"`, which is what the test uses to prove
that a matching pattern clears the file and an unrelated one does not. The
committed list is **empty**: after this repair all 184 source files in the pinned
snapshot parse at least one row, and an entry should only be added once an empty
file has been looked at and found legitimately empty.

`analyze.ts source-gaps` is unchanged and stays the query that shows the gaps in
a dataset built before this check existed (or with `--allow-empty`).

## The pinned snapshot, rebuilt

Command (output to a temporary directory; the evidence tree is opened read-only
and never written to, and no transcript text is read out of it):

```bash
bun run scripts/efficiency/build-dataset.ts \
  --evidence ~/agentic-coding-efficiency-evidence/latest --out "$(mktemp -d)"
```

| metric (`analyze.ts summary`, `coverage`, `source-gaps`, build summary) | before | after |
| --- | ---: | ---: |
| `source-gaps` rows (`source_files.parsed = 0`) | **9** | **0** |
| harness stores that parsed | 0 of 9 | **9 of 9** |
| `turns` rows (build summary) | 33,537 | **35,800** (+2,263) |
| `tool_calls` rows (build summary) | 25,504 | **28,308** (+2,804) |
| `runs` rows | 1,238 | 1,259 (+21) |
| preferred `turns` / `tool_calls` (what the analysis queries read) | 33,137 / 25,024 | **34,711 / 26,847** |
| preferred cost units (`SUM(cost)`) | 391.0161 | **441.9321** |
| preferred turns carrying a `stop_reason` | 0 | **2,263** |
| preferred turns carrying `thinking_tokens` | 0 | **2,253** |
| preferred calls carrying `args_hash` | 1,297 | **3,120** |
| preferred calls carrying `result_bytes` / `duration_ms` | 6,789 | **9,592** |
| runs with harness turns | 0 | **25** |
| workflows with a harness source, `has_transcript = 1` | 0 of 5 | **5 of 5** |

So the expected repair is exactly what the backlog predicted: ≈35,800 turns and
≈28,308 calls, `source-gaps` → 0 rows, and `coverage.has_transcript = 1` for
every workflow whose `sources` name a harness store. The 2,263 turns and 2,804
calls the nine stores hold are the only place in the snapshot with stop reasons,
thinking tokens, per-call result sizes and argument digests — which is why item 1
of the backlog (the runtime recording those fields) and `source-recording` could
not be verified before this repair.

## What this does to the earlier documents

The pinned figures in `03-synthesis.md` / `04-backlog.md` (391.0161 units,
33,137 turns, 25,024 calls, 1,238 runs) were computed with the broken reader and
are a **lower bound**: the corrected denominators are 441.9321 units, 34,711
preferred turns (+4.7 %), 26,847 preferred calls (+7.3 %) and 1,259 runs. Every
share, ratio and "x % of the corpus" in those documents is therefore biased
*upward* unless re-expressed — a doc that says "17 % of the corpus" is 17 % of
the old 391.0161, i.e. ≈15 % of the repaired whole. Those documents are not
rewritten here; this addendum is the correction. The CSV and number formats the
tooling emits are unchanged, the dataset schema stays at version 2, and no store
schema is touched.

## Tests

`test/efficiency/efficiency-harness-reader.test.ts` (fixtures built in temporary
directories, no committed binary blobs):

- a harness store built from the committed `sql/orchestrator-harness.sql`
  fixture, checkpointed and then stripped of `-wal`/`-shm`, so its header is a
  WAL header and plain SQLite refuses it read-only — the fixture asserts both of
  those, that the failed attempt leaves the directory untouched, and that
  `readHarness` and `extractTables` then produce the expected 2 turns, 1 tool
  call and 5 parsed records with an `immutable=1` note;
- a build whose only source is an empty telemetry file exits non-zero, names the
  file, prints the `--allow-empty` hint and writes no dataset;
- the same build passes with `--allow-empty` matching that file (and keeps the
  empty file as a recorded `parsed = 0` row), while an unrelated pattern still
  fails;
- the allow-list matcher (`*`, `**`, source narrowing) and the fact that the
  committed list is empty.
