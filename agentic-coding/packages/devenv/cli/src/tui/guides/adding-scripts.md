# Adding a Task

DevEnv discovers runnable task files from `$DEVENV_HOME/scripts/` (default `~/devenv/scripts/`).

## 1. Task discovery

Any executable file under `~/devenv/scripts/` is automatically discovered:

```
~/devenv/scripts/
├── deploy.sh
├── greet.py                   # Python with shebang — works natively
├── weather.ts                 # TypeScript/Bun — works out of the box
├── database/
│   └── migrate.py
└── clean.sh
```

## 2. Declare task parameters

Use the `--devenv-metadata` convention in a comment block to declare parameters. Tasks appear with their metadata in the TUI Tasks tab.

```python
#!/usr/bin/env python3
# --devenv-metadata:
# {
#   "name": "Deploy Service",
#   "description": "Deploys a service to the specified environment",
#   "parameters": [
#     {
#       "name": "service",
#       "type": "enum",
#       "description": "Service to deploy",
#       "default": "api",
#       "choices": ["api", "web", "worker"]
#     },
#     {
#       "name": "version",
#       "type": "string",
#       "description": "Version to deploy"
#     },
#     {
#       "name": "rollback",
#       "type": "bool",
#       "description": "Rollback to previous version",
#       "default": "false"
#     }
#   ]
# }
# --devenv-metadata-end
```

### Supported parameter types

| Type | Description | Example |
|---|---|---|
| `string` | Free text input | Version tag, commit hash |
| `bool` | Toggle (true/false) | Rollback flag |
| `enum` | Fixed set of choices | Environment, service name |
| `int` | Integer input | Port number, count |
| `float` | Decimal input | Timeout in seconds |

## 3. Using tasks in the TUI

- Navigate to the **Tasks** tab (press `4` or Tab to cycle)
- Press `Enter` to expand/collapse folders or run a task
- Press `s` to run a task (with args if parameters exist)
- Press `S` to run with custom arguments
- Press `+` to add a new task
- Press `-` to delete a task or folder
- Press `e` to open the task file in your editor

## 4. Adding a task

Create the file, make it executable, and add metadata:

```bash
touch ~/devenv/scripts/my-script.sh
chmod +x ~/devenv/scripts/my-script.sh
```

Then press `r` in the Tasks tab to refresh the list.
