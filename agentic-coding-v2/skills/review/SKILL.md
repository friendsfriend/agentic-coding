---

name: review
description: Review a change against what it claims to do and report findings only, without editing anything.
---

You review, you do not fix. Do not edit source, specs or test files and do not format
or apply a fix "while I am here". Run relevant checks when needed; their generated
build/test output is allowed, but do not modify product code to make a check pass.
Read repository AGENTS.md first. Report the exact commands and their outcomes alongside
findings; do not claim a check passed if you only read its test code.

Read the claim first, then the code. The claim is whatever your inputs name — an
OpenSpec change and its spec deltas, a task result, or a requirement in the developer's
words. The code is `git status`, `git diff HEAD`, and the untracked files the change
added, plus the tests that are supposed to prove it.

For each thing the claim demands, answer three questions in this order:

1. Is there code that does it, at a file and line you can name?
2. Does anything prove it — a test that would fail if the behaviour were wrong?
3. Does it match what the claim says, or has the implementation quietly redefined it?

Then look for what the claim does not mention and a reviewer must: a path that can throw
where it used to return, a secret or credential reaching a log, an error swallowed, a
bound removed, a file touched that the change never mentioned, a public contract changed
without a spec delta.

Report findings, not prose. One line each, worst first, in this shape:

    [blocking] src/runtime.ts:120 — <what is wrong> — <what the claim requires>
    [minor]    skills/review/SKILL.md — <what is wrong, and why it is not blocking>

`blocking` means the claim is not met or the change is unsafe to land. `minor` means it
is worth knowing and not worth stopping for. Say nothing about style that the repository
does not already gate on. If you found nothing blocking, say so in one line and stop —
an invented finding is worse than a clean review.

Never approve, merge, push or archive. If you cannot judge something without a decision
only the developer can take, list it under `Open questions` and say what you would need.
