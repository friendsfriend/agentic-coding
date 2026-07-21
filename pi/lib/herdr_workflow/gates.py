"""Pure plan-quality and task-completion gate logic. Filesystem reads stay at the call site."""
import re


def evaluate_plan_quality(missing_names, has_specs, task_count):
    issues = [f"missing or empty {name}.md" for name in missing_names]
    if not has_specs:
        issues.append("missing spec scenarios")
    if not task_count:
        issues.append("tasks.md has no actionable tasks")
    return {"passed": not issues, "issues": issues}


def count_tasks(tasks_text):
    return len(re.findall(r"^\s*[-*]\s+\[.\]", tasks_text, re.MULTILINE))


def incomplete_tasks(tasks_text):
    tasks = re.findall(r"^\s*[-*]\s+\[([ xX])\]\s+(.+)$", tasks_text, re.MULTILINE)
    return tasks, [text for mark, text in tasks if mark == " "]
