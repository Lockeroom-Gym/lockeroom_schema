# Member Auth, RLS & Staff RBAC — Combined Planning Document

> **What this is.** A single implementation-oriented plan for Locker Room Gym’s Supabase project (`dvrhazdtbsttzduaedzu`): **Phase 0 backups**, the **staff RBAC / RLS** track (canonical detail in [`RLS-AND-HIERARCHY.md`](./RLS-AND-HIERARCHY.md)), and a **separate member-facing login** architecture (read-only v1) that shares the same `auth.users` but uses a distinct member identity layer and RLS.
>
> **Status.** Proposal — this file is documentation only. No migrations or app code are applied by committing this doc.
>
> **Member identity table names (production).** Use **`rls_member_accounts`** and **`rls_member_login_bindings`**. The second table is **member login bindings** (which gym `member_database` row(s) a login may use). Older drafts used `member_accounts` / `member_account_members`; if Supabase still has **`rls_member_account_members`**, rename it to **`rls_member_login_bindings`** in a migration and update policies, views, and functions that reference the old name.
>
> **Companion docs.**
> - [`RLS-AND-HIERARCHY.md`](./RLS-AND-HIERARCHY.md) — full staff audit, 25-permission taxonomy, biomap lockdown SQL, Coach OS frontend map, `usePermission` / `RequirePermission` examples.
> - [`architecture.md`](./architecture.md) — schema neural map.
> - `coach_os/coachOS/docs/RLS-migration.md` — earlier narrow RLS rollout note.

---

## Table of contents

1. [Phase 0 — Backup and rollback (do this first)](#1-phase-0--backup-and-rollback-do-this-first)
2. [How this doc relates to staff RBAC](#2-how-this-doc-relates-to-staff-rbac)
3. [Scaling audit — what the staff-only plan did not yet cover](#3-scaling-audit--what-the-staff-only-plan-did-not-yet-cover)
4. [Confirmed product decisions (member portal)](#4-confirmed-product-decisions-member-portal)
5. [Part A — Staff RBAC track (summary + pointer)](#5-part-a--staff-rbac-track-summary--pointer)
6. [Part B — Member auth & RLS (read-only v1)](#6-part-b--member-auth--rls-read-only-v1)
7. [SQL skeletons — member identity and portal RLS](#7-sql-skeletons--member-identity-and-portal-rls)
8. [Onboarding: invite-first + guarded self-signup](#8-onboarding-invite-first--guarded-self-signup)
9. [Member app (separate codebase) — non-goals and checklist](#9-member-app-separate-codebase--non-goals-and-checklist)
10. [Combined rollout order (staff + member)](#10-combined-rollout-order-staff--member)
11. [Verification checklist](#11-verification-checklist)
12. [References](#12-references)

---

## 1. Phase 0 — Backup and rollback (do this first)

RBAC, RLS tightening, and member logins all touch **authentication**, **policies**, and **views**. Mistakes can lock out staff, leak PII, or require restore with downtime. Treat backups as mandatory **before** any production migration window.

### 1.1 Supabase-native backups

1. **Confirm what your Supabase plan includes** for the production project (`dvrhazdtbsttzduaedzu`): daily physical backups, retention, and whether **Point-in-Time Recovery (PITR)** is available and enabled.
2. **Enable PITR before the risky window** if you want timestamp-level recovery. PITR must already be on *before* the incident you are trying to rewind.
3. **Dashboard:** verify backup status and last successful backup in the Supabase project settings (Database → Backups).
4. **Management API** (automation / audit trail): list backups and initiate PITR restore using a personal access token and project ref. See [Supabase backups guide](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/platform/backups.mdx) (also published on [supabase.com/docs](https://supabase.com/docs/guides/platform/backups)).

Example (from Supabase docs — replace tokens and project ref):

```bash
export SUPABASE_ACCESS_TOKEN="your-access-token"
export PROJECT_REF="dvrhazdtbsttzduaedzu"

curl -sS -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$PROJECT_REF/database/backups"
```

**Important:** PITR restore causes **downtime** and rewrites the database to a past time — coordinate a maintenance window and understand data loss for transactions after the recovery timestamp.

**Restore to a new project** (paid plans, physical backups) can be safer for rehearsal than mutating production — see Supabase [clone / restore to new project](https://supabase.com/docs/guides/platform/clone-project) documentation.

### 1.2 Independent logical backup (`pg_dump`)

Supabase backups are necessary but **not sufficient** for every failure mode (e.g. you want a portable dump, schema diff, or offline review). Before each production migration:

1. Run **`pg_dump`** against production with a **timestamped** filename.
2. Store artifacts in a **private, encrypted** location (not in git).
3. Prefer **two dumps**:
   - **Custom format** full dump (data + schema) for restore testing.
   - **Schema-only** dump for quick diff and policy review.

Example (connection string from Supabase dashboard; use SSL):

```bash
ts=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump "$DATABASE_URL" -Fc -f "lockeroom-prod-$ts.dump"
pg_dump "$DATABASE_URL" -s -f "lockeroom-prod-$ts.schema.sql"
```

### 1.3 Restore rehearsal (staging / branch)

1. Restore the latest dump or Supabase backup into a **branch database** or **staging project**.
2. Apply the **full migration sequence** (staff RBAC, biomap lockdown, member identity) in staging.
3. Run the **verification checklist** (§11) for staff app, service-role tools, and member app.
4. Only after staging is green, schedule production.

### 1.4 Rollback strategy by change type

| Change type | Rollback approach |
|-------------|-------------------|
| Additive (new tables, new functions, new views) | Ship a **revert migration** that drops objects in reverse dependency order. |
| RLS policy tightening on existing tables | **Pre-write** `DROP POLICY` / restore old policy SQL **before** deploy; keep in the same PR as the forward migration. |
| Catastrophic mistake / unknown state | **PITR** or **restore from backup** to a known timestamp; accept downtime and possible loss of post-recovery-point writes. |
| Need to test recovery without touching prod | **Restore to a new project** or use a database branch. |

### 1.5 Migration window hygiene

1. Pick a **low-traffic** window (state times in **UTC** and **Australia/Sydney**).
2. Record **`migration_start_utc`** immediately before applying changes (for PITR target discipline).
3. **Freeze** risky writers during the window: batch jobs (`tools/`), imports, Retool admins, and manual data fixes — or accept that recovery may lose those writes.
4. Post a short **internal comms** line: who is on call, how to detect failure, and when rollback triggers.

### 1.6 Pre-flight checklist (copy for runbooks)

- [ ] Supabase backup status confirmed; PITR enabled if required.
- [ ] Latest backups listed via dashboard or Management API.
- [ ] `pg_dump` full + schema-only taken; stored encrypted off-repo.
- [ ] Staging/branch restore successful from that dump or backup.
- [ ] All migrations applied on staging; §11 verification passed.
- [ ] Revert SQL prepared for every **policy** change on existing tables.
- [ ] Maintenance window + `migration_start_utc` recorded.
- [ ] Rollback owner named (who executes PITR vs revert migration).

---

## 2. How this doc relates to staff RBAC

| Track | Purpose | Canonical detail |
|-------|---------|------------------|
| **Staff RBAC** | Coaches/admins; permissions from `staff_roles` + `user_has_permission()` | [`RLS-AND-HIERARCHY.md`](./RLS-AND-HIERARCHY.md) |
| **Member portal** | Members; row access scoped to **their** `member_database.id` via **member login bindings** (`rls_member_login_bindings`) | This file, §6–§9 |

Both tracks can share one Supabase project and one `auth.users` table. They **must not** share the same authorization helper: staff uses `staff_database.auth_id` + RBAC tables; members use **`rls_member_accounts`** + **`rls_member_login_bindings`** + member RLS.

---

## 3. Scaling audit — what the staff-only plan did not yet cover

The staff RBAC document correctly focuses on **Coach OS** and **`staff_database.auth_id`**. Adding a **member product** surfaces additional requirements:

### 3.1 No member principal today

- Operational data is keyed by **`member_id`** on many tables, but **`member_database` has no `auth_id` column** in the inspected schema — there is nothing to anchor RLS to `auth.uid()` for members without a new link layer.

### 3.2 `authenticated` is not “staff”

- Coach OS `ProtectedRoute` only checks **any** Supabase session. A member JWT would also pass a naive client guard — **authorization must be enforced in Postgres (RLS)** and in app bootstrap (member app must require a linked member account).

### 3.3 Staff-centric OAuth sync must not run for members

- Coach OS `auth.tsx` syncs sign-in to **`staff_database`** and may insert staff rows. The **member app must not reuse that logic** or members could be mis-provisioned as staff.

### 3.4 Views and RLS foot-guns

- In PostgreSQL 15+, prefer **`CREATE VIEW … WITH (security_invoker = true)`** for member-facing views so the view does not accidentally bypass RLS. Staff-only operational views (`v_calls_v2_*`, churn, 360) should remain **inaccessible** to member sessions.

### 3.5 Breadth of member-linked tables

- Many `member_*` tables and analytics views exist; most are **RLS-off** or **wide** today. A member app must use **narrow portal projections** plus explicit policies — not “SELECT * FROM member_database”.

### 3.6 Dual identity: staff who are also members

- The same `auth.uid()` may need **both** `staff_database` and **`rls_member_login_bindings`** rows. Apps choose context (Coach OS vs member portal). RLS must allow staff policies and member policies to coexist without widening member access to coach data.

### 3.7 Service role remains bypass

- Railway, `tools/`, and automation must continue using **service role** where appropriate. Member RLS must assume **publishable key + member JWT** is hostile.

---

## 4. Confirmed product decisions (member portal)

| Decision | Choice |
|----------|--------|
| App surface | **Separate member-facing app** (not routes inside Coach OS) |
| Identity | Same Supabase project, same **`auth.users`** |
| Staff + member | **Same login** allowed when both links exist |
| Member v1 | **Read-only** |
| Data scope | **Only rows for linked member(s)** |
| Financials v1 | **Membership summary only** (no invoices/payment detail in v1) |
| Member directory | **Deferred**; design later as opt-in / public-profile layer |
| Staff-only denial | Coach/programming notes, churn/RPI/AI risk, call accountability, internal finance, staff directory details — **must not** be exposed to member sessions |

---

## 5. Part A — Staff RBAC track (summary + pointer)

**Full content** (audit tables, 25 permissions, role × permission matrix, biomap lockdown SQL, `user_has_permission`, `get_my_permissions`, Coach OS file map, example React helpers) lives in **[`RLS-AND-HIERARCHY.md`](./RLS-AND-HIERARCHY.md)**.

### 5.1 Outcomes of Part A

- Four tables: `roles`, `permissions`, `role_permissions`, `staff_roles`.
- One helper: `user_has_permission(text)` with **service-role bypass** where `auth.uid() IS NULL` (preserves import/sync behavior).
- Frontend: `get_my_permissions` RPC + `usePermission` / `RequirePermission` (examples in sibling doc).
- **Biomap:** coarse read gate `biomap_access` + table-level RLS (see §7 of sibling doc).

### 5.2 Implementation note: migration order

When creating RLS policies on `staff_roles`, ensure **`user_has_permission()` exists before** policies that call it (the sibling doc’s `rbac_read_own` policy references `user_has_permission` — order migrations accordingly or use a staged policy).

### 5.3 Coach OS codebase

Implementation tasks remain in **`coach_os/coachOS`** (frontend + `supabase/migrations`). This repository (`lockeroom_schema`) holds **planning and schema reference** only unless you choose to duplicate migration files elsewhere.

---

## 6. Part B — Member auth & RLS (read-only v1)

### 6.1 Design principles

1. **Default deny** for all member-linked data.
2. **No trust in the client** — RLS is the source of truth.
3. **Narrow reads** — expose portal views with explicit column lists.
4. **Never** use `auth.jwt() ->> 'user_metadata'` for authorization (user-editable in Supabase). Prefer **tables** or **`raw_app_meta_data`** if you must use JWT claims — see Supabase security guidance.
5. **Staff-only tables** stay without `SELECT` for member-like policies (or revoke direct grants if needed).

### 6.2 Identity model

**Tables (production names in Supabase):**

| Table | Purpose |
|-------|---------|
| `rls_member_accounts` | One row per Supabase Auth user that is allowed to use the member portal (`auth_user_id uuid PRIMARY KEY` referencing `auth.users(id)`). |
| `rls_member_login_bindings` | **Member login bindings:** which `member_database.id` row(s) this login may access (`auth_user_id`, `member_id`, `is_primary`, `created_at`, `verified_at`). |

v1 can enforce **at most one** `member_id` per `auth_user_id` via a partial unique index; keep the M:N shape for **guardian / family** later.

### 6.3 Helper functions (SQL concepts)

| Function | Purpose |
|----------|---------|
| `current_member_ids()` | Returns set of `member_id` values linked to `auth.uid()`. |
| `is_member_portal_user()` | True if a `rls_member_accounts` row exists for `auth.uid()`. |
| `user_linked_to_member(mid uuid)` | True if `mid` is in `current_member_ids()`. |

Implement as `STABLE` SQL or `SECURITY DEFINER` with **fixed `search_path`** and minimal grants. Prefer `SECURITY INVOKER` policies that inline `member_id IN (SELECT … FROM rls_member_login_bindings WHERE auth_user_id = auth.uid())` if you want to avoid extra functions.

### 6.4 Member capability slugs (v1 read + reserved writes)

**v1 (grant read via RLS + optional `member_permissions` table later):**

| Slug | v1 |
|------|-----|
| `view_own_profile` | Read allowed fields from `member_database` / portal view |
| `view_own_membership` | Membership summary only |
| `view_own_programs` | Program payloads safe for member |
| `view_own_schedule` | Sessions relevant to member |
| `view_own_attendance` | Attendance summaries |
| `view_own_biomap` | BioMap results safe for member (subset of `member_biomap_*`) |
| `view_own_health_metrics` | InBody / health metrics as appropriate |
| `view_own_assessments` | Physicals / assessments as appropriate |

**Reserved for later (do not enable in v1 UI):**

- `update_own_profile`, `submit_own_checkin`, `submit_own_biomap_response`, `request_session_booking`, `manage_own_billing`.

### 6.5 Portal views (recommended)

Create **`member_portal_*` views** with explicit columns. Example names:

- `member_portal_profile`
- `member_portal_memberships_summary`
- `member_portal_programs`
- `member_portal_schedule`
- `member_portal_attendance`
- `member_portal_biomap_results`

Use **`security_invoker = true`** (Postgres 15+) so RLS on base tables applies correctly.

### 6.6 Staff-only: never expose via member session

Block or omit entirely:

- `member_coach_notes`, `member_programming_notes`, internal churn tables, `member_churn_risk*`, call accountability views, financial reporting tables, full `staff_database`, HubSpot sync tables, etc.

---

## 7. SQL skeletons — member identity and portal RLS

> **Proposed** — validate names, constraints, and indexes against your final ERD. Apply only after §1 backups and staging rehearsal.

### 7.1 Member account tables

```sql
-- Link Supabase Auth users to the member portal identity.
-- Production names: rls_member_accounts, rls_member_login_bindings.
-- Skip CREATE if tables already exist; use migrations to rename legacy rls_member_account_members → rls_member_login_bindings if needed.

CREATE TABLE public.rls_member_accounts (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.rls_member_login_bindings (
  auth_user_id uuid NOT NULL REFERENCES public.rls_member_accounts (auth_user_id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.member_database (id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  PRIMARY KEY (auth_user_id, member_id)
);

CREATE INDEX idx_rls_member_login_bindings_member ON public.rls_member_login_bindings (member_id);

-- v1: optional — enforce single-member links per login
CREATE UNIQUE INDEX uq_rls_member_login_bindings_one_member_v1
  ON public.rls_member_login_bindings (auth_user_id)
  WHERE true; -- drop this index later if you allow multiple members per login
```

### 7.2 Helper: current member ids

```sql
CREATE OR REPLACE FUNCTION public.current_member_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT mlb.member_id
  FROM public.rls_member_login_bindings mlb
  JOIN public.rls_member_accounts ma ON ma.auth_user_id = mlb.auth_user_id
  WHERE mlb.auth_user_id = auth.uid()
    AND ma.status = 'active'
    AND mlb.verified_at IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.current_member_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_member_ids() TO authenticated;
```

### 7.3 Example portal view (shape only)

```sql
CREATE OR REPLACE VIEW public.member_portal_profile
WITH (security_invoker = true) AS
SELECT
  md.id AS member_id,
  md.email,
  md.phone,
  md.current_status
  -- add only columns safe for members; omit internal fields
FROM public.member_database md
WHERE md.test_account = false;

-- RLS on member_database must still restrict which rows are visible;
-- the view does not magically fix missing policies.
```

### 7.4 Example RLS on `member_portal_profile` / base table

Prefer **RLS on `member_database`** (or only expose via view + RLS on view if your Postgres/Supabase pattern supports it cleanly). Example policy pattern on `member_database`:

```sql
ALTER TABLE public.member_database ENABLE ROW LEVEL SECURITY;

CREATE POLICY member_read_own_row ON public.member_database
  FOR SELECT
  TO authenticated
  USING (
    id IN (SELECT public.current_member_ids())
    AND test_account = false
  );
```

**Writes:** omit in v1 (`FOR INSERT/UPDATE/DELETE` — none for members).

Repeat the same `USING (member_id IN (SELECT current_member_ids()))` pattern for child tables **or** only allow `SELECT` on portal views that join to `member_database` with the same predicate.

### 7.5 Biomap for members

- Do **not** point the member app at staff-only `biomap_leads` or coach touchpoint logs.
- Expose a **subset** (e.g. latest results, interpreted markers) via `member_portal_biomap_results` backed by `member_biomap_results` with strict RLS.

---

## 8. Onboarding: invite-first + guarded self-signup

**Preferred flow (your choice): hybrid**

1. **Invite-first:** staff sends magic link / invite from a **server-side** path (Edge Function or backend) that creates `auth.users` and `rls_member_accounts` + `rls_member_login_bindings` with `verified_at` set when appropriate.
2. **Guarded self-signup:** allow sign-up only when **`auth.users.email` matches `member_database.email`** (normalized) for exactly one active member, then create link rows in a **SECURITY DEFINER** RPC after email verification.
3. **Audit:** log every link creation (table `member_account_link_audit` optional) — who, when, which `member_id`.

Never auto-link on fuzzy name match.

---

## 9. Member app (separate codebase) — non-goals and checklist

### 9.1 Non-goals for v1

- No Coach OS `auth.tsx` staff provisioning.
- No reuse of `get_my_permissions` staff RPC unless you **rename / split** — members should call **`get_my_member_capabilities`** (future) or rely purely on RLS.
- No churn, accountability, or internal dashboards.

### 9.2 Environment

- Same `SUPABASE_URL` and **anon** key for the member app; **never** ship service role to the browser.
- Distinct OAuth redirect URLs and app origin from Coach OS.

### 9.3 Bootstrap checks

After `signIn`:

1. Session exists.
2. Row exists in `rls_member_accounts`.
3. At least one `rls_member_login_bindings` row.
4. If user is staff-only, show “no member access” — do not crash.

---

## 10. Combined rollout order (staff + member)

1. **Phase 0** — Backups, PITR, `pg_dump`, staging restore rehearsal (§1).
2. **Staff RBAC** — Tables, seed, `user_has_permission`, migrate Coach OS to `usePermission` per [`RLS-AND-HIERARCHY.md`](./RLS-AND-HIERARCHY.md).
3. **Biomap lockdown** — As per sibling doc §7 (after staff can still operate in staging).
4. **Member identity tables** — `rls_member_accounts`, `rls_member_login_bindings`, helpers.
5. **Portal views + RLS** — Read-only SELECT policies; `security_invoker` views.
6. **Member app v1** — Read-only UI against portal views only.
7. **Production cutover** — Limited invite cohort; monitor logs for RLS errors.

---

## 11. Verification checklist

### 11.1 Staff regression

- [ ] Coach OS routes still work for representative roles (admin, coach, casual).
- [ ] Service-role scripts (`tools/`, Railway) still succeed where expected.
- [ ] `user_has_permission` bypass still works for `auth.uid() IS NULL` paths used by automation.

### 11.2 Member isolation

- [ ] Member A session **cannot** `SELECT` member B rows (attempt explicit `member_id` in query string / REST filter).
- [ ] Member session **cannot** read `staff_database`, churn, or coach notes tables.
- [ ] Member app never receives service role key in bundle.

### 11.3 Views

- [ ] Member portal views use **`security_invoker = true`** (PG15+) or equivalent protection.
- [ ] Underlying tables have RLS; verify `EXPLAIN` / test queries as member JWT.

### 11.4 Operational

- [ ] Backup listing immediately before and after migration.
- [ ] Rollback owner and revert SQL location documented in runbook.

---

## 12. References

- Staff RBAC + biomap plan: [`RLS-AND-HIERARCHY.md`](./RLS-AND-HIERARCHY.md)
- Supabase backups & PITR (Management API examples): [backups.mdx in Supabase docs source](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/platform/backups.mdx)
- Supabase security product notes: [Product security](https://supabase.com/docs/guides/security/product-security)

---

*Last updated: 2026-04-28.*
