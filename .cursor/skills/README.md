# Cursor agent skills in this repo

Skills are directories under `.cursor/skills/<skill-name>/`, each containing a `SKILL.md` (required) plus optional supporting files such as `reference.md`.

## How Cursor loads them

- **Project skills:** When you open **this repo as the Cursor workspace folder**, Cursor can discover skills in `.cursor/skills/`. Anyone who clones the repo and opens it gets the same skills.
- **Personal skills:** A copy under `~/.cursor/skills/<skill-name>/` (Windows: `%USERPROFILE%\.cursor\skills\<skill-name>\`) applies **across all projects** on **that machine** only.

Skills in GitHub do **not** automatically appear on your other laptops or desktops until you `git pull` this repo there (or copy the folder into your personal `~/.cursor/skills/`).

## Suggested setups

| Goal | What to do |
|------|------------|
| Same skills for everyone on the Lockeroom schema repo | Keep skills here under `.cursor/skills/` and commit them. Open this repo when working on schema or session balance docs. |
| Same skills everywhere you use Cursor | Copy or symlink `.cursor/skills/<name>/` into `~/.cursor/skills/<name>/` on each machine after `git pull`, or duplicate only the ones you want globally. |
| Single source of truth | Treat this repo as canonical; mirror to personal folder when you want global triggers without opening the repo. |

## Adding more Lockeroom skills here

Create `.cursor/skills/<short-kebab-name>/SKILL.md` with YAML frontmatter (`name`, `description`) and body instructions. Optionally add `reference.md` for longer SQL templates and workflows.