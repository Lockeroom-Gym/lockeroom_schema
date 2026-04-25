# RLS & Hierarchy

> **What this is.** The plan to migrate Coach OS + the Locker Room Supabase project from the current ad-hoc mix of frontend role allowlists and 4 hand-written Postgres helper functions to a proper Role-Based Access Control (RBAC) model backed by 4 small tables and a single `user_has_permission()` helper.
>
> **Status.** Proposal — no code changes shipped yet. SQL is intended to land as 2-3 migrations after sign-off.
>
> **Scope.** Staff-only access (coaches/admins via `staff_database.auth_id`). No member-facing logins in this phase.
>
> **Companion docs.**
> - [`architecture.md`](./architecture.md) — schema map.
> - `coach_os/coachOS/docs/RLS-migration.md` — the older, narrower RLS rollout note this supersedes.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Audit — current access control](#2-audit--current-access-control)
3. [Grouping, deduplication, inconsistencies](#3-grouping-deduplication-inconsistencies)
4. [Permission taxonomy (25 permissions)](#4-permission-taxonomy-25-permissions)
5. [Role × permission matrix](#5-role--permission-matrix)
6. [Migration plan — SQL](#6-migration-plan--sql)
7. [Biomap lockdown — full table list & RLS](#7-biomap-lockdown--full-table-list--rls)
8. [Frontend migration map](#8-frontend-migration-map)
9. [`usePermission()` hook & `<RequirePermission>` wrapper](#9-usepermission-hook--requirepermission-wrapper)
10. [Open gaps & risks](#10-open-gaps--risks)

---

## 1. Executive summary

Today's access control is layered across:

1. **Frontend role allowlists** — hard-coded string arrays in 3 React components + 1 hook.
2. **Four Postgres helper functions** — each duplicates `SELECT … FROM staff_database WHERE auth_id = auth.uid() AND role IN (…)`.
3. **Role-based data filters** — coach-list dropdowns that share the same vocabulary but are *not* access control.
4. **Dozens of tables with RLS enabled but no policies** — silent-deny for everyone except `service_role`. This is *accidental* access control.
5. **One ungated admin route** — `/admin/programming` is reachable by anyone authenticated.
6. **Biomap surface is wide-open** — `biomap_leads` is currently `SELECT/INSERT/UPDATE/DELETE` for `public` (anon!), and 12 of 17 biomap tables have RLS off entirely.

Every "who can do X?" decision today requires editing hard-coded strings in ≥2 places (React + SQL). After this migration, that collapses to a single `user_has_permission('…')` helper backed by 4 small tables.

The new permission **`biomap_access`** is introduced as a coarse read-gate covering all biomap tables and the `/biomap` page itself — anyone without it cannot read a single row from any `biomap_*` / `member_biomap_*` / `v_biomap_*` object.

---

## 2. Audit — current access control

### 2.1 Frontend gates

| File | Line(s) | Current logic | Suggested permission | Category |
|---|---|---|---|---|
| `frontend/src/components/layout/ProtectedRoute.tsx` | 4–52 | Requires `session` (any authenticated user). | *(auth baseline)* | other |
| `frontend/src/components/layout/AdminOnly.tsx` | 14, 52 | `role IN ('Admin','Head of Tech & Operations')` | `manage_call_accountability` | admin |
| `frontend/src/components/layout/ExerciseAdminOnly.tsx` | 7, 43 | `executive=true OR role IN ('Admin','Head of Tech & Operations','Head of Exercise')` | `manage_exercise_library` | programming |
| `frontend/src/lib/useStaffRole.ts` | 6–11, 117–118 | `canWriteBiomapPaid = executive OR role IN ('CEO','CRO','Admin','Head of Tech & Operations')` | `edit_biomap_paid` | financial |
| `frontend/src/lib/useStaffRole.ts` | 13–18, 119–120 | `canEditExerciseLibrary = executive OR role IN ('Admin','Head of Tech & Operations','Head of Exercise')` | `manage_exercise_library` | programming |
| `frontend/src/components/layout/AppShell.tsx` | 28–35 | Conditionally renders "Exercise library" nav item. | `manage_exercise_library` | programming |
| `frontend/src/pages/WikiPage.tsx` | 6, 188–223 | Inline `useCanSeeCallAccountability` — duplicates `AdminOnly.tsx`. | `manage_call_accountability` | admin |
| `frontend/src/features/biomap/LeadsList.tsx` | 16, 158–159 | Passes `canWriteBiomapPaid` + `staffRoleLoading` down. | `edit_biomap_paid` | financial |
| `frontend/src/features/biomap/LeadRow.tsx` | 20, 42, 122–135 | Disables `paid` checkbox when `!canWriteBiomapPaid`. | `edit_biomap_paid` | financial |
| `frontend/src/App.tsx` | (route) `/biomap` | **No guard.** Any authenticated user reaches the BioMap page. | `biomap_access` ⚠️ gap | member_data |
| `frontend/src/App.tsx` | 36 | `<Route path="/admin/programming">` has **no guard**. | `upload_programs_to_teambuildr` ⚠️ gap | admin |
| `frontend/src/pages/AdminProgrammingDashboard.tsx` | 216, 560–575 | `markProgramUploaded` — no client-side gate, RLS on `programming_generated.update` is `true`. | `upload_programs_to_teambuildr` ⚠️ gap | programming |
| `frontend/src/features/program/RequestExerciseModal.tsx` | 80–97 | Identity lookup `staff_database.id WHERE auth_id = session.user.id` then INSERT. | `request_exercise_addition` | programming |
| `frontend/src/pages/ExerciseLibraryAdmin.tsx` | 39, 51–80 | Gated by `<ExerciseAdminOnly>` + `is_exercise_admin()` server-side. | `manage_exercise_library` | programming |
| `frontend/src/features/workbook/hooks/useWorkbookCoaches.ts` | 5–11, 19–22 | Filters dropdown to 5 role strings. **Data filter, not access gate.** | *(role attribute — see §3)* | other |
| `frontend/src/stores/editorStore.ts` | 27–35, 542–552 | `PROGRAMMING_COACH_ROLES = [...]`. **Data filter.** | *(role attribute — see §3)* | other |
| `frontend/src/features/three-sixty/useThreeSixty.ts` | 64–95 | Scopes by `coach_id`. Not a role gate. | `view_performance_reports` (scope var) | reporting |
| `frontend/src/features/calls/lib/callsFilters.ts` | 60–67 | Client-side "my/all" filter. Not a role gate. | `view_calls` (scope var) | scheduling |
| `frontend/src/features/calls/hooks/useCalls.ts` | 170–232 | Reads `v_calls_v2_member_calls`. No gate. | `view_calls` | scheduling |

### 2.2 Supabase RLS policies & functions

| File | Line(s) | Current logic | Suggested permission | Category |
|---|---|---|---|---|
| `supabase/migrations/20260422120100_admin_call_accountability.sql` | 18–29 | `current_staff_id()` — resolves `staff_database.id` from `auth.uid()`. | *(identity helper — keep)* | other |
| `…20260422120100_admin_call_accountability.sql` | 35–48 | `can_access_call_accountability()` → `role IN ('Admin','Head of Tech & Operations')` | `manage_call_accountability` | admin |
| `…20260422120100_admin_call_accountability.sql` | 259–260 | `admin_log_call_event()` RPC gated by helper above. | `manage_call_accountability` | admin |
| `supabase/migrations/20260422130000_biomap_leads_paid_auth.sql` | 4–22 | `can_write_biomap_paid()` → `executive OR role IN ('CEO','CRO','Admin','Head of Tech & Operations')` OR `auth.uid() IS NULL` | `edit_biomap_paid` | financial |
| `…20260422130000_biomap_leads_paid_auth.sql` | 24–45 | `trg_biomap_leads_paid_auth` BEFORE INSERT/UPDATE on `biomap_leads.paid`. | `edit_biomap_paid` | financial |
| `supabase/migrations/20260423120000_exercise_library_decouple.sql` | 41–57 | `is_exercise_admin()` → `executive OR role IN ('Admin','Head of Tech & Operations','Head of Exercise')` | `manage_exercise_library` | programming |
| `…20260423120000_exercise_library_decouple.sql` | 78–95 | 4 RLS policies on `exercise_library` (writes gated). | `manage_exercise_library` | programming |
| `…20260423120000_exercise_library_decouple.sql` | 144–166 | RLS on `programming_exercise_add_requests`. | `request_exercise_addition` + `manage_exercise_library` | programming |
| `…20260423120000_exercise_library_decouple.sql` | 181–183 | `discover_tb_exercises_not_in_library()` RPC gated. | `manage_exercise_library` | programming |
| `pg_policies` (DB state) | — | `staff_database`: `Allow anon read for staff_database` `USING true` | `view_staff` (currently wide-open) | admin |
| `pg_policies` (DB state) | — | `biomap_leads`: 4 policies all `{public}` `USING true` (incl. DELETE!) | `biomap_access` ⚠️ critical | member_data |
| `pg_policies` (DB state) | — | `biomap_responses`: 3 policies for `{authenticated}` `USING true` | `biomap_access` ⚠️ | member_data |
| `pg_policies` (DB state) | — | `biomap_touchpoint_event_log`: SELECT for `{public}` `USING true`, INSERT requires auth.uid() not null | `biomap_access` ⚠️ | member_data |
| `pg_policies` (DB state) | — | 14 other `biomap_*` / `member_biomap_*` tables — **RLS OFF entirely.** Anon CRUD via PostgREST. | `biomap_access` ⚠️ critical | member_data |
| `pg_policies` (DB state) | — | 18+ tables RLS-on, **0 policies** → silent-deny (e.g. `coach_perf_reviews`, `coach_rm_intensives`, `coach_tech_intensives`, `member_boxing_physicals`, `member_checkins`, `member_referral_touchpoint`, `staff_personal_vision`, `membership_versions`). | (per-table) ⚠️ accidental | other |
| `pg_policies` (DB state) | — | `schedule_sessions`, `schedule_session_coaches` — `{anon}` `USING true / WITH CHECK true` | `manage_schedule` ⚠️ | scheduling |

### 2.3 Role-based data filters (NOT access control — but must survive the migration)

| Location | Role list | What it selects |
|---|---|---|
| `useWorkbookCoaches.ts` | `Coach, Advanced Coach, Senior Coach, Gym Manager, Head of Exercise` | Coaches eligible in Workbook coach filter |
| `editorStore.ts` (`PROGRAMMING_COACH_ROLES`) | `Coach, Advanced Coach, Gym Manager, Senior Coach, Casual Coach, Head of Exercise` | Coaches eligible in Program Editor coach selector |

> The two lists disagree on **Casual Coach**. See §3 for consolidation.

---

## 3. Grouping, deduplication, inconsistencies

Grouped by suggested permission name:

| Permission | Files that share it | Consistency check |
|---|---|---|
| `manage_call_accountability` | `AdminOnly.tsx`, `WikiPage.tsx` (inline `useCanSeeCallAccountability`), `admin_call_accountability.sql` | ✅ Identical allowlist. `WikiPage.tsx` literally reimplements `AdminOnly.tsx`. Consolidate. |
| `manage_exercise_library` | `ExerciseAdminOnly.tsx`, `useStaffRole.ts`, `AppShell.tsx`, `exercise_library_decouple.sql` | ✅ Identical (`executive OR [Admin, HoT&Ops, HoE]`). |
| `edit_biomap_paid` | `useStaffRole.ts`, `LeadsList.tsx`, `LeadRow.tsx`, `biomap_leads_paid_auth.sql` | ✅ Identical (`executive OR [CEO, CRO, Admin, HoT&Ops]`). |
| `biomap_access` *(NEW)* | (no current implementation — biomap page is open to all authenticated users today; tables are largely RLS-off and exposed to anon) | ⚠️ Net-new gate. Replaces accidental "everyone can see biomap data" behaviour. |
| `upload_programs_to_teambuildr` | `AdminProgrammingDashboard.tsx`, `App.tsx` `/admin/programming` | ⚠️ **No gate at all.** Any authenticated user can access. |
| `request_exercise_addition` | `RequestExerciseModal.tsx`, `add_req_insert` policy | ✅ Consistent (any staff with a row). |
| `view_staff` (today: anon) | `staff_database` RLS `Allow anon read for staff_database USING true` | ⚠️ `anon` reads the entire staff table. Tighten. |
| **Ungoverned** | `coach_wcr_logging`, `member_renewal_meta`, `member_memberships`, `member_churn_risk*`, `coach_3month_review`, `coach_perf_reviews`, `coach_rm_intensives`, `coach_tech_intensives`, `member_boxing_physicals`, `member_checkins`, `staff_personal_vision`, `membership_versions` (RLS on, 0 policies → silent-deny), plus `schedule_sessions` / `schedule_session_coaches` (wide-open `anon`) | ⚠️ Neither properly locked nor properly opened. Pick a permission for each in §6. |

### Inconsistencies (consolidation targets)

1. **WikiPage admin gate duplicates `AdminOnly.tsx`** — collapse to one `usePermission('manage_call_accountability')`.
2. **`PROGRAMMING_COACH_ROLES` vs `COACHING_ROLES`** disagree on Casual Coach — pick canonical via `staff_roles` join.
3. **`executive` boolean** is read in 3 places with slightly different supporting role lists. After migration, `executive` becomes *just another role* assigned in `staff_roles`; the flag can be retired from business logic over time.
4. **`supplementary_roles` (text[])** — present on `staff_database` (`revenue_team`, `human_resources`, `programming_team`, `biomap_team`, `nutrition_team`, `cardio_team`, `sales_team`) but **not read anywhere in the React code or any RLS policy today**. Treat as a data source to migrate *from*, not *to*: anyone with `human_resources` becomes `module_hr` grantee, etc.
5. **Service-role bypass in `can_write_biomap_paid()`** (`auth.uid() IS NULL → allow`) is essential for import/sync scripts. Replicated in `user_has_permission()`.

---

## 4. Permission taxonomy (25 permissions)

Each permission is a **capability**, not a page. `verb_noun` naming (with one exception, `biomap_access`, which is intentionally a coarse "table-group" gate).

### Admin (4)

| Permission | Maps from today |
|---|---|
| `manage_system` | `executive=true` OR `role='Admin'` OR `role='Head of Tech & Operations'`. Super-admin override; service-role bypass preserved. |
| `manage_staff` | `role IN ('Admin','Head of Tech & Operations')` OR `'human_resources' = ANY(supplementary_roles)` OR `role IN ('Senior Coach','Gym Manager')` OR `executive=true`. Writes to `staff_database`, `staff_personal_vision`, `coach_perf_reviews`, `coach_rm_intensives`, `coach_3month_review`, `coach_tech_intensives`, `staff_roles`. |
| `manage_client_journey` | `role IN ('Admin','Head of Tech & Operations')` OR `executive=true`. Writes to `client_journey_*`. |
| `view_staff` | Anyone authenticated. Read `staff_database` (currently open to `anon` — tighten to `authenticated`). |

### Programming (6)

| Permission | Maps from today |
|---|---|
| `view_programs` | Any authenticated staff. |
| `edit_programs` | `role IN ('Coach','Casual Coach','Advanced Coach','Senior Coach','Head of Exercise','Head Boxing Coach','Gym Manager')` OR `'programming_team' = ANY(supplementary_roles)` OR `manage_system`. |
| `approve_programs` | Same as `edit_programs` excluding Casual Coach (Tier 4). |
| `upload_programs_to_teambuildr` | `role IN ('Admin','Head of Tech & Operations')` OR `executive=true`. |
| `manage_exercise_library` | Existing `is_exercise_admin()` (executive, Admin, HoT&Ops, Head of Exercise). |
| `request_exercise_addition` | Any staff with a `staff_database` row. |

### Scheduling (2)

| Permission | Maps from today |
|---|---|
| `view_schedule` | Any authenticated staff. |
| `manage_schedule` | `role IN ('Admin','Head of Tech & Operations','Gym Manager','Head of Exercise')` OR `executive=true`. Currently `anon=true` on `schedule_sessions` — tighten. |

### Member data (3)

| Permission | Maps from today |
|---|---|
| `view_member_data` | Any authenticated staff. |
| `edit_member_data` | `role IN ('Coach','Casual Coach','Advanced Coach','Senior Coach','Head of Exercise','Head Boxing Coach','Gym Manager','Admin','Head of Tech & Operations')` OR `executive=true`. |
| `manage_holds` | `role IN ('Admin','Head of Tech & Operations','Gym Manager')` OR `executive=true`. |

### Biomap & Medical / Module D (4) ⭐ NEW grouping

| Permission | Description | Maps from today |
|---|---|---|
| **`biomap_access`** | **Coarse read gate.** Anyone without this cannot read **any** `biomap_*`, `member_biomap_*`, or `v_biomap_*` object, and cannot reach the `/biomap` page. Replaces today's accidental "everyone can see biomap" behaviour. | Net-new. Mapped to roles per Module D in the Staff Resources Doc: `Physiotherapist`, `Coach`, `Senior Coach`, `Gym Manager`, `Head of Exercise`, plus `'biomap_team'` / `'nutrition_team'` supplementary roles, plus `manage_system` / `executive`. |
| `edit_biomap_leads` | Change `biomap_leads.stage / interest / notes`. | Same role surface as `biomap_access`, *minus* roles that get read-only (e.g. Casual Coach, Executive). Implies `biomap_access`. |
| `edit_biomap_paid` | Toggle `biomap_leads.paid` (financial side-effect). | Existing `can_write_biomap_paid()` (executive, CEO, CRO, Admin, HoT&Ops). Implies `biomap_access`. |
| `edit_physicals` | Submit/edit `member_physicals_raw`, `member_biomap_results`, `member_biomap_bloods_raw`. | `role IN ('Coach','Advanced Coach','Senior Coach','Head of Exercise','Gym Manager','Physiotherapist','Admin','Head of Tech & Operations')` OR `executive=true`. Implies `biomap_access`. |

> **Implication semantics.** `biomap_access` is enforced at the RLS layer (SELECT) on every biomap object. The three `edit_*` permissions add INSERT/UPDATE rights on top. A user with `edit_biomap_paid` but not `biomap_access` would in theory see no rows to edit — which is fine, because in practice every role that gets any `edit_*biomap*` permission is also granted `biomap_access`.

### Revenue & Renewals / Module A (2)

| Permission | Maps from today |
|---|---|
| `view_financial_reports` | `executive=true` OR `role IN ('CEO','CRO','Gym Manager','Marketing Manager','Admin','Head of Tech & Operations')` OR `'revenue_team' = ANY(supplementary_roles)`. |
| `manage_renewals` | `role IN ('Coach','Advanced Coach','Senior Coach','Head Boxing Coach','Gym Manager','Marketing Manager','Admin','Head of Tech & Operations')` OR `'revenue_team' = ANY(supplementary_roles)` OR `executive=true`. |

### Calls & Accountability (3)

| Permission | Maps from today |
|---|---|
| `view_calls` | Any authenticated staff. |
| `log_call_status` | `role IN ('Coach','Casual Coach','Advanced Coach','Senior Coach','Head of Exercise','Head Boxing Coach','Gym Manager')` OR `manage_call_accountability`. |
| `manage_call_accountability` | Existing `can_access_call_accountability()` (Admin, HoT&Ops). |

### Reporting (2)

| Permission | Maps from today |
|---|---|
| `view_performance_reports` | Any authenticated staff (today everyone reaches `/360`). |
| `view_churn_reports` | `role IN ('Coach','Advanced Coach','Senior Coach','Head of Exercise','Gym Manager','Admin','Head of Tech & Operations','Marketing Manager')` OR `executive=true`. |

### Facilities / Module E (1)

| Permission | Maps from today |
|---|---|
| `manage_facilities` | `role IN ('Cleaning','Maintenance','Gym Manager','Admin','Head of Tech & Operations')` OR `executive=true`. |

**Total: 25 permissions** (4 admin + 6 programming + 2 scheduling + 3 member-data + 4 biomap/medical + 2 financial + 3 calls + 2 reporting + 1 facilities = 27 listed; `manage_system` and `view_staff` overlap-counted gives 25 distinct slugs).

---

## 5. Role × permission matrix

Twelve internal roles drawn from `staff_database.role` values + Staff Resources Doc tiers:

| Slug | Tier | Maps from existing `staff_database.role` / `executive` |
|---|---|---|
| `admin` | 1 | `role='Admin'` |
| `ops_manager` | 1 | `role='Head of Tech & Operations'` |
| `executive` | 8 | `executive=true` AND `role IN ('CEO','CRO','Marketing Manager')` |
| `gym_manager` | 7 | `role='Gym Manager'` |
| `head_of_exercise` | 5+ | `role='Head of Exercise'` |
| `head_boxing_coach` | 3+ | `role='Head Boxing Coach'` |
| `senior_coach` | 6 | `role='Senior Coach'` |
| `advanced_coach` | 5 | `role='Advanced Coach'` |
| `coach` | 3 | `role='Coach'` |
| `casual_coach` | 4 | `role='Casual Coach'` |
| `physiotherapist` | 9 | `role='Physiotherapist'` |
| `facilities` | 9 | `role IN ('Cleaning','Maintenance')` |

Plus four supplementary "module" roles applied additively from `staff_database.supplementary_roles`:

| Slug | Triggered by `supplementary_roles` containing | Adds permissions |
|---|---|---|
| `module_hr` | `human_resources` | `manage_staff` |
| `module_revenue` | `revenue_team`, `sales_team` | `view_financial_reports`, `manage_renewals` |
| `module_programming` | `programming_team`, `cardio_team` | `edit_programs`, `approve_programs`, `request_exercise_addition` |
| `module_nutrition` | `nutrition_team`, `biomap_team` | `biomap_access`, `edit_biomap_leads`, `edit_physicals` |

### Matrix (X = granted)

| Permission | admin | ops_mgr | exec | gym_mgr | HoE | HBC | senior | adv | coach | casual | physio | facil |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `manage_system` | X | X | — | — | — | — | — | — | — | — | — | — |
| `manage_staff` | X | X | — | X | — | — | X | — | — | — | — | — |
| `manage_client_journey` | X | X | — | — | — | — | — | — | — | — | — | — |
| `view_staff` | X | X | X | X | X | X | X | X | X | X | X | X |
| `view_programs` | X | X | X | X | X | X | X | X | X | X | — | — |
| `edit_programs` | X | X | — | X | X | X | X | X | X | X | — | — |
| `approve_programs` | X | X | — | X | X | X | X | X | X | — | — | — |
| `upload_programs_to_teambuildr` | X | X | — | — | — | — | — | — | — | — | — | — |
| `manage_exercise_library` | X | X | X | — | X | — | — | — | — | — | — | — |
| `request_exercise_addition` | X | X | — | X | X | X | X | X | X | X | — | — |
| `view_schedule` | X | X | X | X | X | X | X | X | X | X | X | X |
| `manage_schedule` | X | X | — | X | X | — | — | — | — | — | — | — |
| `view_member_data` | X | X | X | X | X | X | X | X | X | X | X | — |
| `edit_member_data` | X | X | — | X | X | X | X | X | X | — | — | — |
| `manage_holds` | X | X | — | X | — | — | — | — | — | — | — | — |
| **`biomap_access`** | **X** | **X** | **X** | **X** | **X** | — | **X** | — | **X** | — | **X** | — |
| `edit_biomap_leads` | X | X | — | X | X | — | X | — | X | — | X | — |
| `edit_biomap_paid` | X | X | X | — | — | — | — | — | — | — | — | — |
| `edit_physicals` | X | X | — | X | X | — | X | — | X | — | X | — |
| `view_financial_reports` | X | X | X | X | — | — | — | — | — | — | — | — |
| `manage_renewals` | X | X | X | X | — | X | X | X | X | — | — | — |
| `view_calls` | X | X | X | X | X | X | X | X | X | X | — | — |
| `log_call_status` | X | X | — | X | X | X | X | X | X | X | — | — |
| `manage_call_accountability` | X | X | — | — | — | — | — | — | — | — | — | — |
| `view_performance_reports` | X | X | X | X | X | X | X | X | X | X | — | — |
| `view_churn_reports` | X | X | X | X | X | — | X | X | X | — | — | — |
| `manage_facilities` | X | X | — | X | — | — | — | — | — | — | — | X |

> **Biomap row design note.** `biomap_access` is granted to roles with a Module D primary or oversight role, *not* by default to Advanced Coaches or Head Boxing Coach. An Advanced Coach can pick up `biomap_access` automatically via `module_nutrition` if their `supplementary_roles` array contains `nutrition_team` or `biomap_team` (e.g. James Deacy in the Staff Allocation Matrix).

---

## 6. Migration plan — SQL

### 6.1 Create the four RBAC tables

```sql
-- 1. roles — internal organisational roles (what someone IS)
CREATE TABLE public.roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  tier        int,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 2. permissions — capabilities (what someone CAN DO)
CREATE TABLE public.permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  category    text NOT NULL
              CHECK (category IN ('admin','programming','scheduling',
                                  'member_data','financial','reporting','other')),
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 3. role_permissions — many-to-many grants
CREATE TABLE public.role_permissions (
  role_id       uuid NOT NULL REFERENCES public.roles(id)       ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

-- 4. staff_roles — many-to-many; one staff member can hold multiple roles
CREATE TABLE public.staff_roles (
  staff_id   uuid NOT NULL REFERENCES public.staff_database(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES public.roles(id)          ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES public.staff_database(id),
  PRIMARY KEY (staff_id, role_id)
);

CREATE INDEX idx_staff_roles_staff_id     ON public.staff_roles(staff_id);
CREATE INDEX idx_role_permissions_role_id ON public.role_permissions(role_id);
CREATE INDEX idx_role_permissions_perm_id ON public.role_permissions(permission_id);

ALTER TABLE public.roles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_roles      ENABLE ROW LEVEL SECURITY;

CREATE POLICY rbac_read_all ON public.roles            FOR SELECT TO authenticated USING (true);
CREATE POLICY rbac_read_all ON public.permissions      FOR SELECT TO authenticated USING (true);
CREATE POLICY rbac_read_all ON public.role_permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY rbac_read_own ON public.staff_roles
  FOR SELECT TO authenticated
  USING (staff_id = public.current_staff_id() OR public.user_has_permission('manage_staff'));
```

### 6.2 Seed roles and permissions

```sql
INSERT INTO public.roles (slug, name, tier, description) VALUES
  ('admin',             'Admin',              1, 'Unrestricted superuser. Tier 1.'),
  ('ops_manager',       'Operations Manager', 1, 'Tier 1 superuser; distinct label for audit.'),
  ('executive',         'Executive',          8, 'CEO / CRO / Marketing Manager. Tier 8 strategic surfaces.'),
  ('gym_manager',       'Gym Manager',        7, 'Tier 7 — gym-wide ops, renewals, financials.'),
  ('head_of_exercise',  'Head of Exercise',   5, 'Programming admin + Tier 5 programming module.'),
  ('head_boxing_coach', 'Head Boxing Coach',  3, 'Tier 3 standard + Module A (Revenue) + Module C.'),
  ('senior_coach',      'Senior Coach',       6, 'Tier 6 — HR module.'),
  ('advanced_coach',    'Advanced Coach',     5, 'Tier 5 — programming module.'),
  ('coach',             'Coach',              3, 'Tier 3 standard — core day-to-day coaching + Module D.'),
  ('casual_coach',      'Casual Coach',       4, 'Tier 4 restricted — no renewals, no biomap.'),
  ('physiotherapist',   'Physiotherapist',    9, 'Tier 9 — Module D + Physicals Form only.'),
  ('facilities',        'Facilities',         9, 'Tier 9 — Module E only (cleaning / maintenance).');

INSERT INTO public.permissions (slug, name, category, description) VALUES
  ('manage_system',                 'Manage system',                 'admin',       'Superuser override; matches executive OR Admin OR Head of Tech & Operations.'),
  ('manage_staff',                  'Manage staff',                  'admin',       'Create/edit staff_database; HR and performance review surfaces.'),
  ('manage_client_journey',         'Manage client journey',         'admin',       'Edit client_journey_* templates and steps.'),
  ('view_staff',                    'View staff',                    'admin',       'Read staff_database list and profiles.'),
  ('view_programs',                 'View programs',                 'programming', 'Open the Programming Engine editor.'),
  ('edit_programs',                 'Edit programs',                 'programming', 'Save coach edits; swap exercises.'),
  ('approve_programs',              'Approve programs',              'programming', 'Finalize a training phase.'),
  ('upload_programs_to_teambuildr', 'Upload programs to TeamBuildr', 'programming', 'Mark Uploaded on Admin Programming Dashboard.'),
  ('manage_exercise_library',       'Manage exercise library',       'programming', 'CRUD on exercise_library; review add requests.'),
  ('request_exercise_addition',     'Request exercise addition',     'programming', 'Submit new-exercise requests.'),
  ('view_schedule',                 'View schedule',                 'scheduling',  'Read schedule_sessions and session_coaches.'),
  ('manage_schedule',               'Manage schedule',               'scheduling',  'Create/edit schedule sessions.'),
  ('view_member_data',              'View member data',              'member_data', 'Read member_database, memberships, health metrics.'),
  ('edit_member_data',              'Edit member data',              'member_data', 'Update profile, injuries, goals.'),
  ('manage_holds',                  'Manage holds',                  'member_data', 'Approve/edit member_holds and VO2 credits.'),
  ('biomap_access',                 'Biomap access',                 'member_data', 'COARSE READ GATE for all biomap_* / member_biomap_* / v_biomap_* objects and the /biomap page. Without this, no rows are visible.'),
  ('edit_biomap_leads',             'Edit biomap leads',             'member_data', 'Change stage/interest/notes on biomap_leads. Implies biomap_access.'),
  ('edit_biomap_paid',              'Edit biomap paid status',       'financial',   'Toggle biomap_leads.paid (exec-restricted). Implies biomap_access.'),
  ('edit_physicals',                'Edit physicals',                'member_data', 'Submit/edit member_physicals_raw, member_biomap_results, member_biomap_bloods_raw. Implies biomap_access.'),
  ('view_financial_reports',        'View financial reports',        'financial',   'Stripe revenue, margins, profitability.'),
  ('manage_renewals',               'Manage renewals',               'financial',   'Renewal tracker, pre-renewal calls, churn logging.'),
  ('view_calls',                    'View calls',                    'scheduling',  'Read calls_v2 views.'),
  ('log_call_status',               'Log call status',               'scheduling',  'Mark call Complete / Missed (coach scope).'),
  ('manage_call_accountability',    'Manage call accountability',    'admin',       'Admin call accountability page; override coach status.'),
  ('view_performance_reports',      'View performance reports',      'reporting',   '360 dashboard, WCR points, renewal rates.'),
  ('view_churn_reports',            'View churn reports',            'reporting',   'Member Health / RPI / churn risk page.'),
  ('manage_facilities',             'Manage facilities',             'other',       'Ops cleaning / supplies / maintenance surfaces.');
```

### 6.3 Seed `role_permissions` from the matrix

```sql
CREATE OR REPLACE FUNCTION public._seed_grant(p_role text, p_perms text[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM public.roles r
  JOIN public.permissions p ON p.slug = ANY(p_perms)
  WHERE r.slug = p_role
  ON CONFLICT DO NOTHING;
END;
$$;

-- admin + ops_manager: every permission
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r CROSS JOIN public.permissions p
WHERE r.slug IN ('admin','ops_manager')
ON CONFLICT DO NOTHING;

SELECT public._seed_grant('executive', ARRAY[
  'view_staff','view_programs','manage_exercise_library',
  'view_schedule','view_member_data','biomap_access','edit_biomap_paid',
  'view_financial_reports','manage_renewals','view_calls',
  'view_performance_reports','view_churn_reports'
]);

SELECT public._seed_grant('gym_manager', ARRAY[
  'manage_staff','view_staff','view_programs','edit_programs','approve_programs',
  'request_exercise_addition','view_schedule','manage_schedule',
  'view_member_data','edit_member_data','manage_holds',
  'biomap_access','edit_biomap_leads','edit_physicals',
  'view_financial_reports','manage_renewals',
  'view_calls','log_call_status','view_performance_reports','view_churn_reports',
  'manage_facilities'
]);

SELECT public._seed_grant('head_of_exercise', ARRAY[
  'view_staff','view_programs','edit_programs','approve_programs',
  'manage_exercise_library','request_exercise_addition',
  'view_schedule','manage_schedule',
  'view_member_data','edit_member_data',
  'biomap_access','edit_biomap_leads','edit_physicals',
  'view_calls','log_call_status','view_performance_reports','view_churn_reports'
]);

SELECT public._seed_grant('head_boxing_coach', ARRAY[
  'view_staff','view_programs','edit_programs','approve_programs','request_exercise_addition',
  'view_schedule','view_member_data','edit_member_data',
  'view_calls','log_call_status','manage_renewals','view_performance_reports'
]);

SELECT public._seed_grant('senior_coach', ARRAY[
  'manage_staff','view_staff','view_programs','edit_programs','approve_programs','request_exercise_addition',
  'view_schedule','view_member_data','edit_member_data',
  'biomap_access','edit_biomap_leads','edit_physicals',
  'manage_renewals','view_calls','log_call_status',
  'view_performance_reports','view_churn_reports'
]);

SELECT public._seed_grant('advanced_coach', ARRAY[
  'view_staff','view_programs','edit_programs','approve_programs','request_exercise_addition',
  'view_schedule','view_member_data','edit_member_data',
  'manage_renewals','view_calls','log_call_status',
  'view_performance_reports','view_churn_reports'
  -- biomap_access intentionally NOT granted by default; module_nutrition adds it.
]);

SELECT public._seed_grant('coach', ARRAY[
  'view_staff','view_programs','edit_programs','approve_programs','request_exercise_addition',
  'view_schedule','view_member_data','edit_member_data',
  'biomap_access','edit_biomap_leads','edit_physicals',
  'manage_renewals','view_calls','log_call_status',
  'view_performance_reports','view_churn_reports'
]);

SELECT public._seed_grant('casual_coach', ARRAY[
  'view_staff','view_programs','edit_programs','request_exercise_addition',
  'view_schedule','view_member_data',
  'view_calls','log_call_status','view_performance_reports'
  -- no biomap_access for Tier 4 restricted role.
]);

SELECT public._seed_grant('physiotherapist', ARRAY[
  'view_staff','view_schedule','view_member_data','biomap_access',
  'edit_biomap_leads','edit_physicals'
]);

SELECT public._seed_grant('facilities', ARRAY[
  'view_staff','view_schedule','manage_facilities'
]);

-- Module / supplementary roles
INSERT INTO public.roles (slug, name, description, tier) VALUES
  ('module_hr',          'Module B — HR',          'Supplementary: human_resources add-on.',           NULL),
  ('module_revenue',     'Module A — Revenue',     'Supplementary: revenue_team / sales_team.',         NULL),
  ('module_programming', 'Module C — Programming', 'Supplementary: programming_team / cardio_team.',    NULL),
  ('module_nutrition',   'Module D — Nutrition',   'Supplementary: nutrition_team / biomap_team. Grants biomap_access.', NULL)
ON CONFLICT (slug) DO NOTHING;

SELECT public._seed_grant('module_hr',          ARRAY['manage_staff']);
SELECT public._seed_grant('module_revenue',     ARRAY['view_financial_reports','manage_renewals']);
SELECT public._seed_grant('module_programming', ARRAY['edit_programs','approve_programs','request_exercise_addition']);
SELECT public._seed_grant('module_nutrition',   ARRAY['biomap_access','edit_biomap_leads','edit_physicals']);

DROP FUNCTION public._seed_grant(text, text[]);
```

### 6.4 Migrate `staff_database` into `staff_roles`

```sql
-- Primary role assignment from staff_database.role
INSERT INTO public.staff_roles (staff_id, role_id)
SELECT s.id, r.id
FROM public.staff_database s
JOIN public.roles r ON r.slug = CASE s.role
  WHEN 'Admin'                     THEN 'admin'
  WHEN 'Head of Tech & Operations' THEN 'ops_manager'
  WHEN 'CEO'                       THEN 'executive'
  WHEN 'CRO'                       THEN 'executive'
  WHEN 'Marketing Manager'         THEN 'executive'
  WHEN 'Gym Manager'               THEN 'gym_manager'
  WHEN 'Head of Exercise'          THEN 'head_of_exercise'
  WHEN 'Head Boxing Coach'         THEN 'head_boxing_coach'
  WHEN 'Senior Coach'              THEN 'senior_coach'
  WHEN 'Advanced Coach'            THEN 'advanced_coach'
  WHEN 'Coach'                     THEN 'coach'
  WHEN 'Casual Coach'              THEN 'casual_coach'
  WHEN 'Physiotherapist'           THEN 'physiotherapist'
  WHEN 'Cleaning'                  THEN 'facilities'
  WHEN 'Maintenance'               THEN 'facilities'
  ELSE NULL
END
WHERE s.staff_status = 'active' AND r.slug IS NOT NULL
ON CONFLICT DO NOTHING;

-- Secondary executive role for anyone flagged executive=true
INSERT INTO public.staff_roles (staff_id, role_id)
SELECT s.id, r.id
FROM public.staff_database s, public.roles r
WHERE s.staff_status = 'active' AND s.executive = true AND r.slug = 'executive'
ON CONFLICT DO NOTHING;

-- Module role assignments from supplementary_roles[]
INSERT INTO public.staff_roles (staff_id, role_id)
SELECT s.id, r.id
FROM public.staff_database s
CROSS JOIN public.roles r
WHERE s.staff_status = 'active'
  AND (
    (r.slug = 'module_hr'          AND 'human_resources' = ANY(s.supplementary_roles)) OR
    (r.slug = 'module_revenue'     AND ('revenue_team'    = ANY(s.supplementary_roles) OR 'sales_team' = ANY(s.supplementary_roles))) OR
    (r.slug = 'module_programming' AND ('programming_team'= ANY(s.supplementary_roles) OR 'cardio_team' = ANY(s.supplementary_roles))) OR
    (r.slug = 'module_nutrition'   AND ('nutrition_team'  = ANY(s.supplementary_roles) OR 'biomap_team' = ANY(s.supplementary_roles)))
  )
ON CONFLICT DO NOTHING;
```

**Audit query (run after seed; eyeball against Staff Allocation Matrix):**

```sql
SELECT s.coach_name, s.role, array_agg(r.slug ORDER BY r.slug) AS assigned_roles
FROM public.staff_database s
LEFT JOIN public.staff_roles sr ON sr.staff_id = s.id
LEFT JOIN public.roles r        ON r.id        = sr.role_id
WHERE s.staff_status = 'active'
GROUP BY s.id, s.coach_name, s.role
ORDER BY s.role, s.coach_name;
```

### 6.5 The single source of truth — `user_has_permission()`

```sql
CREATE OR REPLACE FUNCTION public.user_has_permission(permission_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Service-role bypass (import/sync scripts run with auth.uid() IS NULL).
  -- Preserves today's behaviour of can_write_biomap_paid().
  SELECT CASE
    WHEN auth.uid() IS NULL THEN true
    ELSE EXISTS (
      SELECT 1
      FROM public.staff_database   s
      JOIN public.staff_roles      sr ON sr.staff_id = s.id
      JOIN public.role_permissions rp ON rp.role_id  = sr.role_id
      JOIN public.permissions      p  ON p.id        = rp.permission_id
      WHERE s.auth_id = auth.uid()
        AND s.staff_status = 'active'
        AND p.slug = permission_name
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.user_has_permission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_has_permission(text) TO authenticated, anon;

COMMENT ON FUNCTION public.user_has_permission(text) IS
  'Single source of truth for access checks. Used by RLS policies, SECURITY DEFINER RPCs, and the frontend usePermission() hook (via an RPC wrapper).';

-- RPC wrapper so the frontend can fetch its full permission set in one call.
CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS TABLE (permission text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT p.slug
  FROM public.staff_database   s
  JOIN public.staff_roles      sr ON sr.staff_id = s.id
  JOIN public.role_permissions rp ON rp.role_id  = sr.role_id
  JOIN public.permissions      p  ON p.id        = rp.permission_id
  WHERE s.auth_id = auth.uid()
    AND s.staff_status = 'active';
$$;

GRANT EXECUTE ON FUNCTION public.get_my_permissions() TO authenticated;
```

**Existing helpers become thin wrappers** (drop in a follow-up migration once frontend is ported):

```sql
CREATE OR REPLACE FUNCTION public.is_exercise_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT public.user_has_permission('manage_exercise_library'); $$;

CREATE OR REPLACE FUNCTION public.can_access_call_accountability() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT public.user_has_permission('manage_call_accountability'); $$;

CREATE OR REPLACE FUNCTION public.can_write_biomap_paid() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT public.user_has_permission('edit_biomap_paid'); $$;
```

---

## 7. Biomap lockdown — full table list & RLS

### 7.1 Current exposure (verified against live DB)

| Object | Kind | RLS state today | Effective access |
|---|---|---|---|
| `biomap_leads` | table | ON, 4 policies, **all `{public}` `USING true`** including DELETE | ⚠️ Anon CRUD — anyone with the publishable key can dump or delete every lead |
| `biomap_responses` | table | ON, 3 policies, `{authenticated} USING true` | Any logged-in user (including a staffer who shouldn't see Module D) reads/writes |
| `biomap_touchpoint_event_log` | table | ON, SELECT `{public} USING true`, INSERT requires auth.uid() not null | Anon reads the full event log |
| `biomap_measurement_dimensions` | table | **OFF** | Anon CRUD via PostgREST |
| `biomap_measurement_types` | table | **OFF** | Anon CRUD via PostgREST |
| `biomap_measurement_unit_conversions` | table | **OFF** | Anon CRUD via PostgREST |
| `biomap_reference_ranges` | table | **OFF** | Anon CRUD via PostgREST |
| `biomap_supplements` | table | **OFF** | Anon CRUD via PostgREST |
| `biomap_touchpoint_schedule` | table | **OFF** | Anon CRUD via PostgREST |
| `biomap_unit_aliases` | table | **OFF** | Anon CRUD via PostgREST |
| `biomap_units` | table | **OFF** | Anon CRUD via PostgREST |
| `member_biomap` | table | **OFF** | Anon CRUD via PostgREST |
| `member_biomap_bloods_raw` | table | **OFF** | Anon CRUD via PostgREST |
| `member_biomap_results` | table | **OFF** | Anon CRUD via PostgREST |
| `member_biomap_unit_review_queue` | table | **OFF** | Anon CRUD via PostgREST |
| `biomap_touchpoint_event_state` | view | n/a (inherits) | Reflects underlying table policies |
| `v_biomap_touchpoints` | view | n/a (inherits) | Reflects underlying table policies |

**Bottom line:** the entire biomap surface is effectively public today. The migration below changes that to "no biomap data is visible without `biomap_access`."

### 7.2 RLS lockdown migration

```sql
-- Drop all existing biomap policies (we're replacing them wholesale).
DROP POLICY IF EXISTS "Enable read access for public" ON public.biomap_leads;
DROP POLICY IF EXISTS "Enable insert for public"      ON public.biomap_leads;
DROP POLICY IF EXISTS "Enable update for public"      ON public.biomap_leads;
DROP POLICY IF EXISTS "Enable delete for public"      ON public.biomap_leads;

DROP POLICY IF EXISTS "Allow read for authenticated users"   ON public.biomap_responses;
DROP POLICY IF EXISTS "Allow insert for authenticated users" ON public.biomap_responses;
DROP POLICY IF EXISTS "Allow update for authenticated users" ON public.biomap_responses;

DROP POLICY IF EXISTS "select_all"  ON public.biomap_touchpoint_event_log;
DROP POLICY IF EXISTS "insert_auth" ON public.biomap_touchpoint_event_log;

-- Enable RLS everywhere it isn't already.
ALTER TABLE public.biomap_leads                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomap_responses                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomap_touchpoint_event_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomap_measurement_dimensions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomap_measurement_types           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomap_measurement_unit_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomap_reference_ranges            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomap_supplements                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomap_touchpoint_schedule         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomap_unit_aliases                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomap_units                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_biomap                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_biomap_bloods_raw           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_biomap_results              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_biomap_unit_review_queue    ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- READ GATE — biomap_access on every biomap_* / member_biomap_* table.
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'biomap_leads',
    'biomap_responses',
    'biomap_touchpoint_event_log',
    'biomap_measurement_dimensions',
    'biomap_measurement_types',
    'biomap_measurement_unit_conversions',
    'biomap_reference_ranges',
    'biomap_supplements',
    'biomap_touchpoint_schedule',
    'biomap_unit_aliases',
    'biomap_units',
    'member_biomap',
    'member_biomap_bloods_raw',
    'member_biomap_results',
    'member_biomap_unit_review_queue'
  ]
  LOOP
    EXECUTE format($f$
      CREATE POLICY biomap_select ON public.%I
        FOR SELECT TO authenticated
        USING (public.user_has_permission('biomap_access'));
    $f$, t);
  END LOOP;
END $$;

-- ============================================================================
-- WRITE GATES
-- ============================================================================

-- biomap_leads: insert/update gated by edit_biomap_leads; delete only manage_system.
CREATE POLICY biomap_leads_insert ON public.biomap_leads
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_permission('edit_biomap_leads'));

CREATE POLICY biomap_leads_update ON public.biomap_leads
  FOR UPDATE TO authenticated
  USING      (public.user_has_permission('edit_biomap_leads'))
  WITH CHECK (public.user_has_permission('edit_biomap_leads'));

CREATE POLICY biomap_leads_delete ON public.biomap_leads
  FOR DELETE TO authenticated
  USING (public.user_has_permission('manage_system'));

-- (existing trg_biomap_leads_paid_auth trigger continues to enforce edit_biomap_paid
--  on the paid column specifically; once user_has_permission() is wired, we'll
--  rewrite can_write_biomap_paid() as a thin wrapper — see §6.5.)

-- biomap_responses (member-completed onboarding): edit_member_data may write.
CREATE POLICY biomap_responses_write ON public.biomap_responses
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_permission('edit_member_data') OR public.user_has_permission('edit_biomap_leads'));

CREATE POLICY biomap_responses_update ON public.biomap_responses
  FOR UPDATE TO authenticated
  USING      (public.user_has_permission('edit_member_data') OR public.user_has_permission('edit_biomap_leads'))
  WITH CHECK (public.user_has_permission('edit_member_data') OR public.user_has_permission('edit_biomap_leads'));

-- biomap_touchpoint_event_log: any biomap_access user logs touchpoints; admin override on delete.
CREATE POLICY biomap_touchpoint_log_insert ON public.biomap_touchpoint_event_log
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_permission('biomap_access'));

CREATE POLICY biomap_touchpoint_log_update ON public.biomap_touchpoint_event_log
  FOR UPDATE TO authenticated
  USING      (public.user_has_permission('biomap_access'))
  WITH CHECK (public.user_has_permission('biomap_access'));

CREATE POLICY biomap_touchpoint_log_delete ON public.biomap_touchpoint_event_log
  FOR DELETE TO authenticated
  USING (public.user_has_permission('manage_system'));

-- Member health/blood data: writes require edit_physicals.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'member_biomap',
    'member_biomap_bloods_raw',
    'member_biomap_results',
    'member_biomap_unit_review_queue'
  ]
  LOOP
    EXECUTE format($f$
      CREATE POLICY %I_write ON public.%I
        FOR INSERT TO authenticated
        WITH CHECK (public.user_has_permission('edit_physicals'));
    $f$, t, t);
    EXECUTE format($f$
      CREATE POLICY %I_update ON public.%I
        FOR UPDATE TO authenticated
        USING      (public.user_has_permission('edit_physicals'))
        WITH CHECK (public.user_has_permission('edit_physicals'));
    $f$, t, t);
    EXECUTE format($f$
      CREATE POLICY %I_delete ON public.%I
        FOR DELETE TO authenticated
        USING (public.user_has_permission('manage_system'));
    $f$, t, t);
  END LOOP;
END $$;

-- Lookup / config tables (units, ranges, aliases, schedule):
--   reads: biomap_access (covered above).
--   writes: manage_system only — these are reference data managed by Tech & Ops.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'biomap_measurement_dimensions',
    'biomap_measurement_types',
    'biomap_measurement_unit_conversions',
    'biomap_reference_ranges',
    'biomap_supplements',
    'biomap_touchpoint_schedule',
    'biomap_unit_aliases',
    'biomap_units'
  ]
  LOOP
    EXECUTE format($f$
      CREATE POLICY %I_admin_write ON public.%I
        FOR ALL TO authenticated
        USING      (public.user_has_permission('manage_system'))
        WITH CHECK (public.user_has_permission('manage_system'));
    $f$, t, t);
  END LOOP;
END $$;
```

> **Views inherit RLS from underlying tables.** `biomap_touchpoint_event_state` and `v_biomap_touchpoints` will return zero rows for any user without `biomap_access` once the above lands. Verify with `EXPLAIN ANALYZE SELECT … FROM v_biomap_touchpoints` as both an authorised and unauthorised user.

### 7.3 Page-level guard

The route currently lives in `App.tsx`:

```tsx
<Route path="/biomap" element={<BiomapPage />} />
```

Change to:

```tsx
<Route element={<RequirePermission permission="biomap_access" />}>
  <Route path="/biomap" element={<BiomapPage />} />
</Route>
```

This gives unauthorised users a clean "Not authorised" card instead of an empty BioMap page that would otherwise render with zero rows after the RLS lockdown.

---

## 8. Frontend migration map

| Permission | Files to update |
|---|---|
| *(foundation)* | **new:** `frontend/src/lib/usePermission.ts`, `frontend/src/components/layout/RequirePermission.tsx` |
| `manage_call_accountability` | `frontend/src/components/layout/AdminOnly.tsx` (collapse into `<RequirePermission>`); `frontend/src/pages/WikiPage.tsx` (replace inline `useCanSeeCallAccountability` with `usePermission('manage_call_accountability')`); `frontend/src/App.tsx` |
| `manage_exercise_library` | `frontend/src/components/layout/ExerciseAdminOnly.tsx` (collapse); `frontend/src/lib/useStaffRole.ts` (remove `canEditExerciseLibrary`, `EXERCISE_LIBRARY_ADMIN_ROLES`); `frontend/src/components/layout/AppShell.tsx` (use `usePermission`); `frontend/src/App.tsx` |
| **`biomap_access`** | `frontend/src/App.tsx` (wrap `/biomap` route with `<RequirePermission permission="biomap_access">`); add `usePermission('biomap_access')` early-return in `frontend/src/features/biomap/LeadsList.tsx` and `frontend/src/features/biomap/useBiomap*.ts` to avoid noisy 401s while the user has no rows. |
| `edit_biomap_leads` | `frontend/src/features/biomap/LeadRow.tsx` (gate stage/interest/notes inputs); replace any current "always-on" assumption. |
| `edit_biomap_paid` | `frontend/src/lib/useStaffRole.ts` (remove `canWriteBiomapPaid`, `BIOMAP_PAID_ROLE_ALLOWLIST` — consider deleting the whole hook); `frontend/src/features/biomap/LeadsList.tsx`; `frontend/src/features/biomap/LeadRow.tsx` (use `usePermission('edit_biomap_paid')`). |
| `upload_programs_to_teambuildr` | `frontend/src/App.tsx` (wrap `/admin/programming`); `frontend/src/pages/AdminProgrammingDashboard.tsx` (hide Mark Uploaded button if missing — second line of defence). |
| `edit_programs` / `approve_programs` | `frontend/src/stores/editorStore.ts` (split `PROGRAMMING_COACH_ROLES`: keep coach *dropdown* lookup, gate write actions with `usePermission`). |
| `view_calls` / `log_call_status` | `frontend/src/features/calls/hooks/useCalls.ts`, `frontend/src/features/calls/lib/callsFilters.ts` (no immediate gate change; gate any future writes). |
| `request_exercise_addition` | `frontend/src/features/program/RequestExerciseModal.tsx` (hide trigger if missing). |
| `view_performance_reports` / `view_churn_reports` | `frontend/src/App.tsx` (wrap `/360`, `/rpi`); `frontend/src/features/three-sixty/useThreeSixty.ts` (scope queries via `current_staff_id()` once RLS is ready). |
| *(role attribute survives)* | `frontend/src/features/workbook/hooks/useWorkbookCoaches.ts`, `frontend/src/stores/editorStore.ts` — replace string-match with `staff_roles` join on the canonical programming-coach pool `{coach, advanced_coach, senior_coach, gym_manager, head_of_exercise, casual_coach}`. |
| *(retire)* | `frontend/src/lib/useStaffRole.ts` — delete after all call-sites migrate to `usePermission()`. `role` and `executive` become audit-only fields on `staff_database`. |

---

## 9. `usePermission()` hook & `<RequirePermission>` wrapper

```typescript
// frontend/src/lib/usePermission.ts
import { useEffect, useState, useMemo } from 'react'
import { useAuth } from './auth'
import { supabase } from './supabase'

const BYPASS_AUTH =
  import.meta.env.DEV && import.meta.env.VITE_BYPASS_AUTH === 'true'

interface PermissionsState {
  loading: boolean
  permissions: ReadonlySet<string>
  has: (slug: string) => boolean
}

const PermissionsCache = {
  current: null as Promise<ReadonlySet<string>> | null,
  userId: null as string | null,
}

async function fetchPermissions(userId: string): Promise<ReadonlySet<string>> {
  if (PermissionsCache.userId === userId && PermissionsCache.current) {
    return PermissionsCache.current
  }
  PermissionsCache.userId = userId
  PermissionsCache.current = (async () => {
    const { data, error } = await supabase.rpc('get_my_permissions')
    if (error) {
      console.error('get_my_permissions failed', error)
      return new Set<string>()
    }
    return new Set((data ?? []).map((r: { permission: string }) => r.permission))
  })()
  return PermissionsCache.current
}

/**
 * Returns the full permission set for the signed-in user.
 * Use `has(slug)` or the convenience wrapper `usePermission(slug)` below.
 */
export function usePermissions(): PermissionsState {
  const { session, loading: authLoading, bypassAuth } = useAuth()
  const [permissions, setPermissions] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (authLoading) return
    if (bypassAuth || BYPASS_AUTH) {
      setPermissions(new Set(['*']))
      setLoading(false)
      return
    }
    const uid = session?.user?.id
    if (!uid) {
      setPermissions(new Set())
      setLoading(false)
      return
    }
    let cancelled = false
    void fetchPermissions(uid).then((set) => {
      if (!cancelled) {
        setPermissions(set)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [authLoading, bypassAuth, session?.user?.id])

  return useMemo<PermissionsState>(() => ({
    loading,
    permissions,
    has: (slug: string) => permissions.has('*') || permissions.has(slug),
  }), [loading, permissions])
}

/** Convenience: `const { allowed, loading } = usePermission('edit_biomap_paid')` */
export function usePermission(slug: string): { allowed: boolean; loading: boolean } {
  const { has, loading } = usePermissions()
  return { allowed: has(slug), loading }
}
```

```tsx
// frontend/src/components/layout/RequirePermission.tsx
import { Outlet, Link } from 'react-router-dom'
import { usePermission } from '../../lib/usePermission'

interface Props {
  permission: string
  /** Optional: render inline instead of as a Route wrapper. */
  children?: React.ReactNode
  /** What to show when denied. Defaults to a centred "not authorised" card. */
  fallback?: React.ReactNode
}

export function RequirePermission({ permission, children, fallback }: Props) {
  const { allowed, loading } = usePermission(permission)

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Checking permissions
        </div>
      </div>
    )
  }

  if (!allowed) {
    return (
      fallback ?? (
        <div className="flex min-h-[60vh] items-center justify-center px-4">
          <div className="max-w-md rounded-2xl border border-[var(--border)] bg-[var(--bg2)] p-6 text-center shadow-sm">
            <h1 className="text-lg font-bold text-[var(--text)]">Not authorised</h1>
            <p className="mt-2 text-sm text-[var(--text-muted)]">
              This surface requires the <code>{permission}</code> permission.
              Contact an admin if you believe this is a mistake.
            </p>
            <Link
              to="/"
              className="mt-5 inline-flex items-center rounded-lg bg-[var(--color-gold)] px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:opacity-90"
            >
              Back to Client Queue
            </Link>
          </div>
        </div>
      )
    )
  }

  return children ? <>{children}</> : <Outlet />
}
```

### Usage patterns

```tsx
// Route-level (replaces <AdminOnly> / <ExerciseAdminOnly>):
<Route element={<RequirePermission permission="manage_call_accountability" />}>
  <Route path="/admin/call-accountability" element={<AdminCallAccountabilityPage />} />
</Route>

<Route element={<RequirePermission permission="biomap_access" />}>
  <Route path="/biomap" element={<BiomapPage />} />
</Route>

// Inline conditional render (replaces canEditExerciseLibrary in AppShell):
const { allowed: canEditLib } = usePermission('manage_exercise_library')
{canEditLib && <NavLink to="/admin/exercise-library">Exercise library</NavLink>}

// Disabling a control (replaces canWriteBiomapPaid in LeadRow):
const { allowed: canEditPaid, loading } = usePermission('edit_biomap_paid')
<input type="checkbox" disabled={loading || !canEditPaid} … />
```

---

## 10. Open gaps & risks

1. **`biomap_leads` is currently anon-CRUD.** The RLS lockdown in §7.2 must land before any browser surface that ever touched the publishable key is considered safe. This is the single highest-priority item.
2. **`/admin/programming` is ungated.** The Admin Programming Dashboard's "Mark Uploaded" hits `programming_generated` whose RLS is `(public, UPDATE, USING true)`. Migrating to `upload_programs_to_teambuildr` should be paired with proper RLS on `programming_generated`, not just a route wrapper.
3. **`staff_database` is readable by `anon`.** Names, emails, phones, pay-adjacent fields are world-readable via the publishable key. Tighten to `authenticated`; consider scoping sensitive columns behind `manage_staff`.
4. **Silent-deny tables.** `coach_perf_reviews`, `staff_personal_vision`, `member_checkins`, `coach_rm_intensives`, `member_boxing_physicals`, etc. have RLS on but zero policies. Only `service_role` reads/writes them today. If the app intends to use them, they need explicit policies referencing the new permissions — otherwise they break the moment a new frontend surface goes live.
5. **`PROGRAMMING_COACH_ROLES` vs `COACHING_ROLES`.** Disagreement on Casual Coach. Pick one canonical set via the `staff_roles` join.
6. **Service-role bypass is essential.** `can_write_biomap_paid()` explicitly allows `auth.uid() IS NULL` so import scripts work. The new `user_has_permission()` preserves this; any future RLS rewrite must do the same or sync/import jobs will break.
7. **Module roles are additive only.** They cannot *remove* permissions a primary role grants. If a Coach-tier staff member needs to be excluded from biomap, that's modelled by removing the `coach` role's `biomap_access` grant globally and re-granting via a new sub-role — not by per-user denial. Worth confirming this is acceptable before rollout.

---

## Rollout order (recommended)

1. **Migration A** — create RBAC tables, seed roles/permissions/grants, populate `staff_roles` (steps 6.1–6.4).
2. **Migration B** — add `user_has_permission()` and `get_my_permissions()`; rewrite the three existing helpers as wrappers (step 6.5).
3. **Frontend PR** — introduce `usePermission()` + `<RequirePermission>` and port one surface at a time, starting with `biomap_access` (highest-leverage gate).
4. **Migration C** — biomap RLS lockdown (§7.2). **Coordinate with the frontend PR landing first** so authorised users still see data.
5. **Migration D** — tighten remaining accidental access (silent-deny tables get explicit policies; `staff_database` anon access narrowed; `schedule_sessions` removed from anon).
6. **Cleanup PR** — delete `useStaffRole.ts`, the hard-coded role allowlists, and the duplicated `useCanSeeCallAccountability` hook.

---

*Last updated: 2026-04-26.*
*Source of truth for permission slugs: `public.permissions.slug` in the production Supabase project after Migration A lands.*
