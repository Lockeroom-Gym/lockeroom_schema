# Locker Room Schema — Neural Map

Interactive visualization of the Locker Room Gym Supabase database schema.
Auto-updated daily via GitHub Actions.

## How It Works

`update-schema.js` queries the Supabase Management API for all tables, columns,
and foreign key relationships, then injects the data into `schema-neural-map.html`.

Tables are auto-classified into domains (Members, Staff, Scheduling, Finance,
Health, CRM, Programming, Coach Ops, PM, System) and rendered as an interactive
force-directed graph.

## Automated Updates

A GitHub Action runs daily at 06:00 UTC (4pm AEST). It:
1. Runs `npm run update-schema` against the live Supabase database
2. Commits and pushes only if the schema has changed
3. Can also be triggered manually from the Actions tab

### Required Secrets

Set these in the repo's Settings > Secrets and variables > Actions:

| Secret | Description |
|--------|-------------|
| `SUPABASE_PROJECT_REF` | Supabase project reference (e.g. `dvrhazdtbsttzduaedzu`) |
| `SUPABASE_ACCESS_TOKEN` | Supabase **Personal Access Token** — get from [dashboard](https://supabase.com/dashboard/account/tokens) |

### Manual Trigger

From the Actions tab, select "Update Schema Map" and click "Run workflow".

Or from the command line:

```bash
gh workflow run update-schema.yml
```

## Local Development

```bash
cp .env.example .env
# Fill in SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN
npm install
npm run update-schema
open schema-neural-map.html
```
