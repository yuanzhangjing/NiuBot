# Workspace Rules

User-editable workspace notes. NiuBot creates this file when missing and does not overwrite user edits.

## Project

Describe what this workspace is and where the main code lives. For example: `repos/<repo>/`.

## Workspace Layout

- `persona.md`: bot role and response style.
- `instructions.md`: bot-level long-term instructions.
- `repos/`: code repositories.
- `tasks/`: formal tasks managed by `nbt task`.
- `tmp/`: temporary files, drafts, command outputs, and one-off analysis.

Do not write ad hoc files into the workspace root. Put temporary files under `tmp/`.
