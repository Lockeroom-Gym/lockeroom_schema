# Lockeroom — Supabase Schema Reference

**Database:** PostgreSQL (Supabase)
**Project ID:** dvrhazdtbsttzduaedzu
**Last updated:** 2026-04-06

This document describes the core tables, column definitions, foreign key relationships, and business rules for the Lockeroom database. Intended for developer reference.

---

## Table of Contents

1. [Core Member Tables](#1-core-member-tables)
2. [Membership Lifecycle](#2-membership-lifecycle)
3. [Financial Metadata](#3-financial-metadata)
4. [Churn & Cancellations](#4-churn--cancellations)
5. [Holds & Pauses](#5-holds--pauses)
6. [Session Attendance](#6-session-attendance)
7. [Staff & Scheduling](#7-staff--scheduling)
8. [Coach Hour Calculation Config](#8-coach-hour-calculation-config)
9. [Membership Config](#9-membership-config)
10. [Key Views](#10-key-views)
11. [FK Relationship Map](#11-fk-relationship-map)

---

## 1. Core Member Tables

### `member_database`
The single source of truth for member demographics, contact info, and primary coach assignment.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `first_name` | text | |
| `last_name` | text | |
| `member_name` | text | Denormalized full name — for display/querying without joins |
| `email` | text | |
| `phone` | bigint | |
| `dob` | date | |
| `gender` | USER-DEFINED (enum) | |
| `coach_id` | uuid | FK → `staff_database.id` — primary RM assignment |
| `salesperson` | uuid | FK → `staff_database.id` |
| `current_status` | USER-DEFINED (enum) | |
| `gym_string` | text | Home gym location |
| `referral_source_name` | text | |
| `referral_source_email` | text | |
| `referrer_id` | uuid | FK → `member_database.id` — if referred by another member |
| `stripe_primary_fk` | uuid | Stripe billing reference |
| `initial_weight` | numeric | |
| `initial_bf_percentage` | numeric | |
| `height` | numeric | |
| `injuries` | text | |
| `goals` | text | |
| `medications` | text | |
| `contraindications` | text | |
| `lifestyle_grouping` | text | |
| `personality_archetype` | text | |
| `test_account` | boolean | Exclude test/dummy records from all queries |
| `created_at` | timestamptz | |

> **Note:** `coach_id` here is the member's default coach. The active assignment may differ at the membership level — always use `member_memberships.coach_id` and `member_memberships.handoff_coach_id` for current operational context.

---

## 2. Membership Lifecycle

### `member_memberships`
The central table. Each row represents one membership term. A member can have multiple rows (first sale + renewals, and/or simultaneous secondary tiers).

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `member_id` | uuid | FK → `member_database.id` |
| `membership_type_id` | uuid | FK → `membership_types.id` |
| `start_date` | date | |
| `end_date` | date | |
| `status` | text | Do NOT filter by status for active count — see counting rules |
| `membership_stage` | text | e.g. `new_sale`, `renewal` |
| `journey_stage` | USER-DEFINED (enum) | Exclude `no_sale` from all member counts |
| `gym` | text | Assigned gym location |
| `rm` | boolean | `true` = member has a dedicated Results Manager. `false` = no-RM tier |
| `primary_membership_id` | uuid | FK → `member_memberships.id` (self-ref). `NULL` = primary/core membership. `NOT NULL` = secondary/add-on tier |
| `newsale_metadata` | uuid | FK → `member_newsale_metadata.id` |
| `renewal_metadata` | uuid | FK → `member_renewal_meta.id` |
| `pipeline_lost` | USER-DEFINED (enum) | Pipeline lost status flag |
| `renewal_date` | date | |
| `membership_notes` | text | |
| `check1` | boolean | Milestone check flags |
| `check2` | boolean | |
| `check3` | boolean | |
| `created_at` | timestamptz | |

#### Staff Assignment Columns

| Column | Type | Who it is |
|--------|------|-----------|
| `coach_id` | uuid | FK → `staff_database.id`. Primary RM / Results Manager |
| `handoff_coach_id` | uuid | FK → `staff_database.id`. If populated, this coach takes over the RM assignment from `coach_id` |
| `programming_coach_id` | uuid | FK → `staff_database.id`. Writes the member's training programs. In future will likely merge with the RM role, but currently tracked separately |
| `salesperson_id` | uuid | FK → `staff_database.id`. Person who closed the deal |
| `renewal_lead` | uuid | FK → `staff_database.id`. The person who physically sits down and conducts the renewal conversation |
| `revenue_team_assignee` | uuid | FK → `staff_database.id`. Handles 3-month and 9-month calls — applies to second membership or later only. Performed by the RM; requires Advanced Coach level or above |
| `nutrition_lead` | uuid | FK → `staff_database.id`. Coach responsible for nutrition support |

> **Critical disambiguation — `renewal_lead` vs `coach_id`:**
> "How many renewals does [coach] have?" has two valid answers:
> - Renewals they are **personally leading** → filter on `renewal_lead`
> - Renewals for **their clients** → filter on `coach_id` / `handoff_coach_id`
> Always clarify which is meant before querying.

#### Key Business Rules

**Active member count:**
- `COUNT(DISTINCT member_id)`
- Filter: `primary_membership_id IS NULL` (primary memberships only)
- Filter: `CURRENT_DATE <= end_date` (include future starts, do not enforce `start_date <= CURRENT_DATE`)
- Do NOT filter by `status` — active, pending, indefinite_hold, F&F, and inactive all count
- Exclude: `journey_stage = 'no_sale'`

**New sale vs. renewal:**
- New client = row with earliest `start_date` for a `member_id`
- Renewal = any subsequent row with a later `start_date`

**Handoff assignment logic:**
- Active coach = `coach_id` UNLESS `handoff_coach_id IS NOT NULL` → handoff coach takes the assignment
- Not-renewing attribution: if a handed-off client goes to not renewing, the `member_not_renewing` record attributes to the **original `coach_id`**, not the handoff coach
- Renewal points: awarded to `handoff_coach_id` if not null, otherwise default to `coach_id`

---

## 3. Financial Metadata

Two tables store the financial snapshot at the time a deal was closed. Join via FK columns on `member_memberships`.

### `member_newsale_metadata`
Financial record for first/new-sale memberships.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK — referenced by `member_memberships.newsale_metadata` |
| `member_id` | uuid | FK → `member_database.id` |
| `coach_id` | uuid | FK → `staff_database.id` |
| `salesperson_id` | uuid | FK → `staff_database.id` |
| `membership_type_id` | uuid | FK → `membership_types.id` |
| `holds_policy_fk` | uuid | FK → holds policy table |
| `membership_selected` | text | Name of the membership product selected |
| `session_credits` | numeric | Sessions per week included |
| `membership_weeks` | numeric | Duration of membership in weeks |
| `total_sessions` | smallint | Total session count for the membership |
| `base_membership_value` | numeric | **Amount paid for the core membership only.** Use this for margin calculations. Excludes add-ons and fees |
| `price_paid` | numeric | **Total amount paid** — includes membership + add-ons + any setup fees |
| `addons` | text | Add-on products purchased |
| `holds_agreement` | text | Holds terms agreed at point of sale |
| `gym` | text | Gym location assigned |
| `per_session_value` | numeric | |
| `psv_norm` | numeric | Normalised per-session value |
| `membership_duration` | text | |
| `expiry_date` | timestamptz | |
| `cohort_start_date` | timestamptz | |
| `date_created` | timestamp | |

### `member_renewal_meta`
Financial record for renewal memberships. Same structure as `member_newsale_metadata` with the following additions:

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK — referenced by `member_memberships.renewal_metadata` |
| `renewal_duration_points` | numeric | Points awarded for this renewal duration |
| `hold_value` | numeric | Value of any hold credit applied |
| `old_coach_email` | text | Previous coach at time of renewal (denormalized) |
| `secondary_memberships` | text | Secondary/add-on memberships attached |
| `secondary_membership_session_per_week` | numeric | |

> **Rule:** Most financial and package data lives in these two tables. For revenue, margin, or package details — join through these, not `member_memberships` alone.

---

## 4. Churn & Cancellations

### `member_not_renewing`
Tracks members who are leaving, why, and who is assigned to attempt to save them.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `member_id` | uuid | FK → `member_database.id` |
| `membership_id` | uuid | FK → `member_memberships.id` |
| `coach_id` | uuid | FK → `staff_database.id` — **always the original coach_id, even if the member was handed off** |
| `handoff_coach_id` | uuid | FK → `staff_database.id` — the coach who was handling them at time of not-renewing |
| `renewal_assignee` | uuid | FK → `staff_database.id` |
| `revenue_team_assignee` | uuid | FK → `staff_database.id` |
| `programming_coach_id` | uuid | FK → `staff_database.id` |
| `salesperson_id` | uuid | FK → `staff_database.id` |
| `newsale_metadata_id` | uuid | FK → `member_newsale_metadata.id` |
| `renewal_metadata_id` | uuid | FK → `member_renewal_meta.id` |
| `primary_reason_for_leaving` | text | |
| `reason_description` | text | |
| `good_bad` | USER-DEFINED (enum) | Good churn (legitimate reason) vs. Bad churn (saveable) |
| `attempt_to_save_client` | text | |
| `reason_for_not_trying` | text | |
| `reactivation_notes` | text | |
| `confirmation_date` | date | |
| `expiry_date` | date | |
| `date_joined` | date | |
| `total_months` | integer | |
| `total_number_sessions` | integer | |
| `lc_ns` | integer | Late cancel / no show count |
| `estimated_return_12_months` | integer | |
| `can_close_accounts` | USER-DEFINED (enum) | |
| `notified` | boolean | |
| `notified_at` | timestamptz | |
| `entry_order` | bigint | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

> **Attribution rule:** `coach_id` in this table is always the **original coach** regardless of handoff. `handoff_coach_id` records who was actually handling the client. This is by design for performance tracking.

---

## 5. Holds & Pauses

### `member_holds`
Tracks periods where a member paused their membership. Holds impact effective end date and revenue calculations.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `member_id` | uuid | FK → `member_database.id` |
| `membership_id` | uuid | FK → `member_memberships.id` |
| `hold_start` | date | |
| `hold_end` | date | |
| `full_hold_week` | integer | Number of full weeks on hold |
| `financial_hold_credit` | numeric | Dollar value of hold credit applied |
| `session_account_credit` | numeric | Session credits returned during hold |
| `policy_applied` | text | Which hold policy was used |
| `hold_notes` | text | |
| `travel_programming_notes` | text | |
| `email` | text | Denormalized |
| `RM` | text | Denormalized coach name at time of hold |
| `created_at` | timestamptz | |

---

## 6. Session Attendance

### `member_daily_sessions_attended`
Most accurate source of truth for actual member attendance. One row per session attended.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `member_id` | uuid | FK → `member_database.id` |
| `session_date` | date | |
| `session_start` | time | |
| `session_end` | time | |
| `session_name` | text | |
| `class_type` | text | e.g. PERFORM, BOX, SQUAD, VO2, WAM |
| `gym` | text | |
| `coach_name` | text | Denormalized |
| `member_name` | text | Denormalized |
| `email` | text | |
| `phone` | text | |
| `membership_type` | text | |
| `client_id` | text | External system ID |
| `remaining_visits` | text | |
| `created_at` | timestamptz | |

### `member_lcns`
Tracks Late Cancels and No Shows separately from attendance.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `member_id` | uuid | FK → `member_database.id` |
| `coach_id` | uuid | FK → `staff_database.id` |
| `date` | date | |
| `late_cancel` | integer | Count for that entry |
| `no_show` | integer | Count for that entry |
| `entry_seq` | integer | |
| `member_name` | text | Denormalized |
| `coach_name` | text | Denormalized |
| `created_at` | timestamptz | |

### `member_batch_attendance`
Rolled-up weekly attendance per member.

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint | PK |
| `member_id` | uuid | FK → `member_database.id` |
| `date` | date | Week date |
| `sessions_attended` | integer | |
| `booked` | integer | |
| `late_cancel` | integer | |
| `no_shows` | integer | |
| `last_visit_date` | date | |
| `created_at` | timestamptz | |

---

## 7. Staff & Scheduling

### `staff_database`
All staff profiles — coaches, admin, leadership.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `first_name` | text | |
| `last_name` | text | |
| `coach_name` | text | Denormalized full name |
| `role` | text | Job title/role label |
| `staff_status` | USER-DEFINED (enum) | Active, inactive, etc. |
| `lockeroom_email` | text | |
| `personal_email` | text | |
| `mobile_number` | text | |
| `home_gym` | text | Primary gym location |
| `tod_coaching` | text | Time-of-day coaching preference/assignment |
| `rm_ceiling` | numeric | Max RM client capacity |
| `direct_report` | uuid | FK → `staff_database.id` (self-ref) — manager of this staff member |
| `employment_type` | text | Full-time / Part-time |
| `session_bracket_fk` | uuid | FK → session bracket config |
| `supplementary_roles` | ARRAY | Additional roles beyond primary |
| `kpi` | text | |
| `state` | text | NSW / VIC |
| `executive` | boolean | |
| `buddy_coach` | uuid | FK → `staff_database.id` |
| `slack_channel_id` | text | |
| `slack_member_id` | text | |
| `updated_at` | timestamptz | |

### `staff_leave_confirmed`
Approved leave days per staff member. Used in session balance calculations.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `staff_id` | uuid | FK → `staff_database.id` |
| `leave_date` | date | Individual day of leave |
| `leave_type` | USER-DEFINED (enum) | |
| `leave_request_id` | uuid | FK → `staff_leave_requests.id` |
| `coach_name` | text | Denormalized |
| `date_created` | timestamptz | |

### `staff_supplementary_default_hours`
Baseline supplementary hours allocated to a staff member (not tied to client count).

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `staff_id` | uuid | FK → `staff_database.id` |
| `hours` | numeric | Weekly supplementary hours |
| `effective_from` | date | |
| `effective_to` | date | |
| `note` | text | |
| `staff_name` | text | Denormalized |
| `created_at` | timestamptz | |

### `staff_supplementary_additional_hours`
One-off or temporary additional hours on top of the default.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `staff_id` | uuid | FK → `staff_database.id` |
| `active_date` | date | Date this applies to |
| `hours` | numeric | |
| `note` | text | |
| `approved_by` | uuid | FK → `staff_database.id` |
| `created_by` | uuid | FK → `staff_database.id` |
| `approved_at` | timestamptz | |
| `created_at` | timestamptz | |

---

## 8. Coach Hour Calculation Config

These tables drive the session balance and expected hours calculations. Do not hardcode values — always query from source.

### `work_estimations`
Defines how many hours per client each staff role is allocated. **Source of truth for per-client hour allocations.**

| Column | Type | Notes |
|--------|------|-------|
| `staff_roles` | text | Role identifier — e.g. `results_manager`, `handoff_coach`, `programming_coach`, `revenue_team`, `renewal_lead`, `nutrition_lead`, `human_resources` |
| `per_client_allocation` | numeric | Hours per client (or per direct report for HR). Always query this — do not hardcode |

**Role definitions:**

| `staff_roles` value | What it covers |
|--------------------|---------------|
| `results_manager` | Per member where this coach is the active RM (no handoff) |
| `handoff_coach` | Per member assigned to this coach via handoff |
| `programming_coach` | Per member where this coach writes programs |
| `revenue_team` | Per member assigned to this coach as revenue team assignee |
| `renewal_lead` | Per member where this coach is conducting the renewal |
| `nutrition_lead` | Per member where this coach is nutrition lead |
| `human_resources` | Per direct report in `staff_database` where `direct_report` = this coach |

### `system_config`
System-wide configuration values, including session durations and contract hour baselines. **Source of truth for session length and FTE/PTE hours.**

| Column | Type | Notes |
|--------|------|-------|
| `config_key` | text | Identifier |
| `match_pattern` | text | Pattern used to match session types (e.g. `PERFORM`, `BOX`, `SQUAD`, `VO2`, `WAM`, `FTE`, `PTE`) |
| `duration` | numeric | The value — hours for session types, hours/week for contract types |

> Always join on `match_pattern` to get session durations. Do not hardcode values from this table.

### `coach_session_expectation_log`
Logged expected sessions per coach per week. Used by the balance view.

| Column | Type | Notes |
|--------|------|-------|
| `staff_id` | uuid | FK → `staff_database.id` |
| `week_start` | date | Start of the week |
| `expected_sessions` | numeric | How many sessions expected this week |
| `role_hours` | numeric | Pre-calculated role-based hours for this week |

### `coach_session_actual` / `coach_weekly_hours_snapshot`
Actual hours worked — individual sessions roll up into weekly snapshots.

`coach_session_actual` — one row per session logged.
`coach_weekly_hours_snapshot` — rolled-up actual hours per coach per week. The balance view reads `actual_hours` from here.

**Session balance formula:**
```
Balance = actual_hours − (expected_sessions × adjusted_working_days × session_length)
```
Where `session_length` = `system_config.duration` for the relevant `match_pattern`.

---

## 9. Membership Config

### `membership_types`
Defines the category/product level of a membership.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `name` | text | Membership category name |
| `session_frequency_per_week` | integer | |
| `session_total` | integer | |
| `category` | USER-DEFINED (enum) | |
| `tod_category` | USER-DEFINED (enum) | Time-of-day category |
| `sort_order` | integer | |
| `created_at` | timestamp | |

### `membership_versions`
Historical pricing and policy snapshots. Older memberships retain their original agreed-upon terms by referencing their version at time of sale.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `membership_type_id` | uuid | FK → `membership_types.id` |
| `membership_name` | text | |
| `base_price` | numeric | |
| `newsale_price_adjusted` | numeric | |
| `renewal_price_adjusted` | numeric | |
| `sessions_per_week` | smallint | |
| `sessions_total` | smallint | |
| `duration_weeks` | smallint | |
| `membership_duration` | USER-DEFINED (enum) | |
| `price_per_session` | numeric | |
| `cancellation_policy` | text | |
| `holds_policy` | text | |
| `inclusions` | text | |
| `internal_notes` | text | |
| `is_active_version` | boolean | |
| `version_number` | integer | |
| `sort_order` | integer | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

---

## 10. Key Views

| View | Purpose |
|------|---------|
| `view_all_members` | `member_database` without age calculation — use for general member queries |
| `view_active_members` | Pre-filtered active members with coach and membership info |
| `view_member_membership_full_details` | Members + memberships + version info joined — avoids manual joins |
| `view_active_memberships` | Active memberships with financial metadata joined |
| `view_member_count_per_coach` | Per-coach member counts, capacity, and ceiling |
| `view_active_member_names_per_coach` | Active client list per coach |
| `view_member_calls_with_status` | All scheduled calls (3-month, 9-month, renewal) with status and all staff role assignments denormalized |
| `view_member_calls_flat` | Simplified call list without status |
| `view_membership_costs` | Full cost breakdown per membership — margin, per-session value, total cost |
| `view_coach_session_expectations` | Computed expected sessions from contract hours minus role hours (planning/reference only — balance view uses logged expectations) |
| `view_coach_session_balance_sep25` | Main balance view — actual vs expected hours per coach per week |
| `view_staff_hours_weekly` | Supplementary hours per coach per week |

---

## 11. FK Relationship Map

```
member_database
  ├── id ←── member_memberships.member_id
  ├── id ←── member_not_renewing.member_id
  ├── id ←── member_holds.member_id
  ├── id ←── member_daily_sessions_attended.member_id
  ├── id ←── member_lcns.member_id
  ├── id ←── member_batch_attendance.member_id
  ├── id ←── member_programs.member_id
  ├── id ←── member_biomap.member_id
  ├── id ←── member_physicals_raw.member_id
  ├── id ←── member_health_metrics.member_id
  └── id ←── member_coach_notes.member_id

member_memberships
  ├── id ←── member_holds.membership_id
  ├── id ←── member_not_renewing.membership_id
  ├── id ←── member_programs.membership_id
  ├── id ←── member_biomap.membership_id
  ├── newsale_metadata ──→ member_newsale_metadata.id
  ├── renewal_metadata ──→ member_renewal_meta.id
  ├── primary_membership_id ──→ member_memberships.id  [self-ref: child → parent]
  ├── membership_type_id ──→ membership_types.id
  ├── coach_id ──→ staff_database.id
  ├── handoff_coach_id ──→ staff_database.id
  ├── programming_coach_id ──→ staff_database.id
  ├── salesperson_id ──→ staff_database.id
  ├── renewal_lead ──→ staff_database.id
  ├── revenue_team_assignee ──→ staff_database.id
  └── nutrition_lead ──→ staff_database.id

member_newsale_metadata
  ├── coach_id ──→ staff_database.id
  ├── salesperson_id ──→ staff_database.id
  ├── membership_type_id ──→ membership_types.id
  └── holds_policy_fk ──→ [holds policy table]

member_renewal_meta
  ├── coach_id ──→ staff_database.id
  ├── salesperson_id ──→ staff_database.id
  ├── membership_type_id ──→ membership_types.id
  └── holds_policy_fk ──→ [holds policy table]

member_not_renewing
  ├── coach_id ──→ staff_database.id        [original coach — always, even on handoff]
  ├── handoff_coach_id ──→ staff_database.id
  ├── renewal_assignee ──→ staff_database.id
  ├── revenue_team_assignee ──→ staff_database.id
  ├── programming_coach_id ──→ staff_database.id
  ├── salesperson_id ──→ staff_database.id
  ├── newsale_metadata_id ──→ member_newsale_metadata.id
  └── renewal_metadata_id ──→ member_renewal_meta.id

staff_database
  ├── id ←── [multiple member_memberships staff columns]
  ├── direct_report ──→ staff_database.id   [self-ref: staff → manager]
  └── buddy_coach ──→ staff_database.id     [self-ref]

membership_types
  └── id ←── membership_versions.membership_type_id
```

---

## Appendix: General Query Rules

1. **Never double-count members.** Always `COUNT(DISTINCT member_id)`.
2. **Primary memberships only.** Filter `primary_membership_id IS NULL` when counting core clients.
3. **Do not filter by status** for active member counts — all statuses count except expired (`end_date < CURRENT_DATE`) and `journey_stage = 'no_sale'`.
4. **Date logic.** Active = `CURRENT_DATE <= end_date`. Do not enforce `start_date <= CURRENT_DATE` (future starts count).
5. **Use views where available.** `view_member_membership_full_details`, `view_active_members`, `view_member_calls_with_status` handle complex joins.
6. **Financial data lives in metadata tables.** Join `member_memberships` → `member_newsale_metadata` or `member_renewal_meta` for pricing, package details, and margin calculations.
7. **Coach hour config is live.** Never hardcode values from `work_estimations` or `system_config` — always query the DB.
