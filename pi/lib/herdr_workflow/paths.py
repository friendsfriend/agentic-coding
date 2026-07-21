"""Static path constants. Module-level attributes so tests/tools can override them."""
import os
from pathlib import Path

AGENT_DIR = Path.home() / ".pi" / "agent"
# pi/lib/herdr_workflow/paths.py -> herdr_workflow -> lib -> pi -> repo root
AGENT_DEF_DIR = Path(__file__).resolve().parents[3] / "agent-definitions"
CONFIG = Path(os.environ.get("HERDR_WORKFLOW_CONFIG", AGENT_DIR / "herdr-workflow.toml"))
SKILLS = AGENT_DEF_DIR / "skills"
