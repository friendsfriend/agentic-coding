"""Seams: the only place that touches `herdr`, git, subprocess, time, network, and config I/O."""
import copy
import json
import shlex
import subprocess
import threading
import time
import tomllib
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import paths


def run(*args, cwd=None, capture=True):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=capture, check=False)
    if result.returncode:
        detail = (result.stderr or result.stdout or "command failed").strip()
        raise SystemExit(f"{' '.join(map(shlex.quote, args))}: {detail}")
    return result.stdout.strip() if capture else ""


class Herdr:
    """Wraps the `herdr` CLI, parsing its JSON `result` envelope."""

    def call(self, *args):
        output = run("herdr", *args)
        return json.loads(output).get("result", {}) if output else {}


class Git:
    """Wraps git subprocess calls scoped to a working directory."""

    def run(self, *args, cwd):
        return run("git", *args, cwd=cwd)


class Clock:
    def now(self):
        return datetime.now(timezone.utc)

    def monotonic(self):
        return time.monotonic()

    def time(self):
        return time.time()

    def time_ns(self):
        return time.time_ns()

    def sleep(self, seconds):
        time.sleep(seconds)


def trace_endpoint():
    import os
    return os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or (os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"].rstrip("/") + "/v1/traces" if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") else "http://127.0.0.1:4318/v1/traces")


class TraceExporter:
    """Best-effort OTLP HTTP exporter; fire-and-forget background thread, never raises."""

    def export(self, record):
        def send():
            try:
                attributes = [{"key": key, "value": {"stringValue": str(value)}} for key, value in record["attributes"].items()]
                payload = {"resourceSpans": [{"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "herdr-workflow"}}]}, "scopeSpans": [{"scope": {"name": "herdr-workflow"}, "spans": [{"traceId": record["traceId"], "spanId": record["spanId"], "parentSpanId": record.get("parentSpanId"), "name": record["name"], "startTimeUnixNano": record["startTimeUnixNano"], "endTimeUnixNano": record["endTimeUnixNano"], "attributes": attributes, "status": {"code": 2 if record.get("status") == "ERROR" else 1}}]}]}]}
                request = urllib.request.Request(trace_endpoint(), data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
                urllib.request.urlopen(request, timeout=0.75).read()
            except Exception:
                pass
        threading.Thread(target=send, daemon=True).start()


def _deep_merge(base, overlay):
    merged = copy.deepcopy(base)
    for key, value in overlay.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config():
    with paths.CONFIG.open("rb") as file:
        cfg = tomllib.load(file)
    project_config = Path.cwd() / ".pi" / "herdr-workflow.toml"
    if project_config.exists():
        with project_config.open("rb") as file:
            project_cfg = tomllib.load(file)
        cfg = _deep_merge(cfg, project_cfg)
    return cfg


@dataclass
class Context:
    """Threaded through commands.py so orchestration runs against fakes in tests."""

    config: dict
    herdr: Herdr
    git: Git
    clock: Clock
    exporter: TraceExporter
