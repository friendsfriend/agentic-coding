"""Pure verification-tiering logic. Git diff text is passed in, never fetched here."""
import re
from pathlib import Path

VERIFIER_ROLES = ("security-verifier", "agents-verifier", "quality-verifier", "performance-verifier", "openspec-verifier")
TEST_VERIFIER = "test-verifier"


def review_tier(diff_numstat, paths):
    lines = sum(sum(map(int, row.split("\t")[:2])) for row in diff_numstat.splitlines() if row and "-" not in row)
    sensitive = any(re.search(r"(^|/)(auth|security|crypto|secret|permission|migration)(/|$)", path, re.I) for path in paths)
    docs_only = bool(paths) and all(re.search(r"(^|/)(README|AGENTS|CLAUDE|docs?/)|\.md$", path, re.I) for path in paths)
    if sensitive or len(paths) > 50 or lines > 100:
        return "full", VERIFIER_ROLES
    if docs_only and lines <= 10:
        return "trivial", ("quality-verifier", "openspec-verifier")
    return "lite", ("security-verifier", "agents-verifier", "quality-verifier", "openspec-verifier")


def eligible_verifier_roles(files):
    joined = "\n".join(files)
    eligible = set()
    if any(not path.endswith(".md") for path in files):
        eligible.add("quality-verifier")
    if re.search(r"(^|/)(auth|security|crypto|secret|permission|migration)(/|$)", joined, re.I):
        eligible.add("security-verifier")
    if any(Path(path).name in {"AGENTS.md", "CLAUDE.md"} for path in files):
        eligible.add("agents-verifier")
    if any(path.startswith("openspec/") or path.endswith(("openapi.yaml", "openapi.yml")) for path in files):
        eligible.add("openspec-verifier")
    if re.search(r"(performance|benchmark|cache|stream|batch|query|algorithm)", joined, re.I):
        eligible.add("performance-verifier")
    return sorted(eligible)


def file_manifest(diff_numstat, diff_text, files):
    stats = {row.split("\t", 2)[2]: {"added": row.split("\t", 2)[0], "removed": row.split("\t", 2)[1]} for row in diff_numstat.splitlines() if row and "\t" in row}
    hunks, current = {}, None
    for line in diff_text.splitlines():
        if line.startswith("+++ b/"):
            current = line[6:]
        elif current and line.startswith("@@"):
            hunks.setdefault(current, []).append(line)
    return [{"path": path, **stats.get(path, {"added": "?", "removed": "?"}), "hunks": [{"id": index + 1, "header": header} for index, header in enumerate(hunks.get(path, [])[:8])]} for path in files]


def applicable_instructions(root, files):
    """Local AGENTS.md/CLAUDE.md discovery — plain filesystem walk, no git involved."""
    found = set()
    for file in files:
        directory = (root / file).parent
        while directory >= root:
            for name in ("AGENTS.md", "CLAUDE.md"):
                candidate = directory / name
                if candidate.is_file():
                    found.add(str(candidate.relative_to(root)))
            if directory == root:
                break
            directory = directory.parent
    return sorted(found)
