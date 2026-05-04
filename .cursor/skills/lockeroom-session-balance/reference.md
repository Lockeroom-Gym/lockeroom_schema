# Lockeroom Session Balance Reference

This is the baseline context for investigating and correcting coach session balance data in Supabase.

## Core Reporting View

Primary reporting surface:

- `public.view_coach_session_balance_sep25`

It reads:

- `coach_session_expectation_log` for expected sessions and role-hour components.
- `coach_weekly_hours_snapshot.actual_hours` for materialized actual hours.
- `work_calendar` for business days and holidays.
- `staff_leave_confirmed` for leave weekdays.
- `get_perform_hours()` for perform session duration.

It calculates:

- `expected_hours_adjusted` = full-week `session_expectation` scaled by `(business_days_this_week - leave_weekdays) / 5`, then multiplied by `get_perform_hours()`.
- `hours_balance_adjusted` = `actual_hours - expected_hours_adjusted`, with a known hard-coded exception for one staff member before/around 2025-06-30.

Important: this view does not sum raw session rows directly. It reads actuals from `coach_weekly_hours_snapshot`.

## Expected Sessions Flow

Operational source:

- `coach_session_expectation_log`

Expected-session rows may be inserted or refreshed by:

- `upsert_coach_expectations_from_workload(p_from date, p_to date)`

That function derives:

- Contract baseline hours from `system_config` (`Full Time Hours`, `Part Time Hours`, matched by employment type), with fallback to `work_estimations.weekly_allocation`, then `38`.
- Role hours via `get_role_hours_for_week(...)`.
- HR direct-report hours via `get_hr_direct_report_hours_for_week(...)`.
- Supplementary hours via `get_staff_sup_hours_for_week(...)`.
- `total_hours` as the sum of role, HR, and supplementary hours.
- `remaining_hours` as `greatest(contract_hours - total_hours, 0)`.
- `session_expectation` as `round(remaining_hours / perform_hours, 2)`.

Planning/reference view:

- `view_coach_session_expectations`

This computes similar forward-looking expectations, but the Sep25 reporting view uses logged expectations from `coach_session_expectation_log`.

## Role-Hour Helpers

`get_role_hours_for_week(p_staff_id, p_week_start, p_role)` uses `work_estimations.per_client_allocation` and `member_memberships` assignment columns:

- `results_manager`: `member_memberships.coach_id`, excluding secondary memberships and records with a handoff coach.
- `handoff_coach`: `member_memberships.handoff_coach_id`.
- `programming_coach`: `member_memberships.programming_coach_id`.
- `revenue_team`: `member_memberships.revenue_team_assignee`.
- `renewal_lead`: `member_memberships.renewal_assignee`.
- `nutrition_lead`: `member_memberships.nutrition_lead`.

Most role counts require `member_memberships.end_date > p_week_start` and `primary_membership_id is null`.

`get_hr_direct_report_hours_for_week(...)` counts active staff where `staff_database.direct_report = p_staff_id`, excluding self, multiplied by the human resources allocation in `work_estimations`.

`get_staff_sup_hours_for_week(...)` combines:

- Latest default hours from `staff_supplementary_default_hours` effective at week start.
- Additional hours from `staff_supplementary_additional_hours` inside that week.

## Actual Hours Flow

Raw actual source:

- `coach_session_actual`

Important columns:

- `staff_id`
- `coach_name`
- `session_date`
- `session_name`
- attendance/count columns such as `sessions_attended`, `late_cancels`, `no_shows`, `sessions_covered`, `sessions_missed`
- `week_start`

Trigger:

- `coach_session_tracker_fill_staff_id`

This fills `staff_id` from `coach_name` when `staff_id` is missing.

Computed actual source:

- `view_session_balance_adjusted_25`

It calculates `actual_hours` by grouping `coach_session_actual` by `staff_id` and Monday `week_start`, then summing matching duration config values:

```sql
sum(
  case
    when sc.config_value is not null and sc.config_key like 'duration_%'
    then sc.config_value
    else 0
  end
)
```

The match is based on:

```sql
csa.session_name ilike '%' || sc.match_pattern || '%'
and sc.config_key like 'duration_%'
```

This means actual hours depend on whether each raw `session_name` matches a `system_config.match_pattern` row with a `duration_*` key.

Snapshot table:

- `coach_weekly_hours_snapshot`

Snapshot functions include:

- `run_coach_weekly_snapshot(p_week_start, p_use_last_completed_week)`
- `run_correction_coach_weekly_snapshot_for_week(p_any_date)`
- `run_correction_coach_weekly_snapshot_range(p_from, p_to)`
- `run_correction_recompute_and_snapshot_for_staff_week(p_staff_id, p_week_start)`
- `run_correction_recompute_and_snapshot_for_week(p_any_date)`
- `run_correction_recompute_and_snapshot_range(p_from, p_to)`

These upsert snapshot rows from `view_session_balance_adjusted_25` or, in the staff/week correction function, from `view_coach_session_balance_sep25`.

## Investigation Checklist

Use this order for anomalies.

1. Identify coach:

```sql
select id, coach_name, role, employment_type, staff_status
from staff_database
where coach_name ilike '%NAME%';
```

2. Compare reporting view:

```sql
select *
from view_coach_session_balance_sep25
where staff_id = 'STAFF_ID'
  and week_start in ('YYYY-MM-DD', 'YYYY-MM-DD')
order by week_start;
```

3. Inspect snapshot rows:

```sql
select *
from coach_weekly_hours_snapshot
where staff_id = 'STAFF_ID'
  and week_start in ('YYYY-MM-DD', 'YYYY-MM-DD')
order by week_start, logged_at;
```

4. Inspect computed source:

```sql
select *
from view_session_balance_adjusted_25
where staff_id = 'STAFF_ID'
  and week_start in ('YYYY-MM-DD', 'YYYY-MM-DD')
order by week_start;
```

5. Inspect raw actual rows across each week:

```sql
select id, staff_id, coach_name, session_date, week_start, session_time,
       session_name, sessions_attended, late_cancels, no_shows,
       sessions_covered, sessions_missed, notes
from coach_session_actual
where (
    staff_id = 'STAFF_ID'
    or coach_name ilike '%NAME%'
  )
  and session_date between 'YYYY-MM-DD' and 'YYYY-MM-DD'
order by session_date, session_time, session_name;
```

6. Check whether session names match duration config:

```sql
select csa.id, csa.session_date, csa.session_name,
       sc.config_key, sc.match_pattern, sc.config_value
from coach_session_actual csa
left join system_config sc
  on csa.session_name ilike '%' || sc.match_pattern || '%'
 and sc.config_key like 'duration_%'
where csa.staff_id = 'STAFF_ID'
  and csa.session_date between 'YYYY-MM-DD' and 'YYYY-MM-DD'
order by csa.session_date, csa.session_name, sc.config_key;
```

7. Check expectation log:

```sql
select *
from coach_session_expectation_log
where staff_id = 'STAFF_ID'
  and week_start in ('YYYY-MM-DD', 'YYYY-MM-DD')
order by week_start;
```

## Correction Decision Tree

Choose the smallest correction that preserves provenance.

Raw actual rows are missing:

- Prefer inserting the missing `coach_session_actual` rows with correct `staff_id`, `coach_name`, `session_date`, and `session_name`.
- Then rerun the appropriate weekly snapshot correction function.

Raw actual rows exist but `staff_id` is missing or wrong:

- Fix `staff_id`/`coach_name` on the affected raw rows.
- Then rerun the snapshot correction.

Raw actual rows exist but `session_name` does not match any duration config:

- If the name is wrong, fix the raw `session_name`.
- If the name is valid and recurring, add or update a `system_config` duration mapping only after confirming it should affect all future calculations.
- Then rerun the snapshot correction.

Snapshot is stale but computed view is correct:

- Rerun `run_correction_coach_weekly_snapshot_for_week(...)` for the affected week.

One-off reconciliation is needed:

- Prefer an audited adjustment mechanism over direct snapshot edits.
- Do not directly edit `coach_weekly_hours_snapshot.actual_hours` unless the user explicitly approves a derived-data override.

## Preferred Audited Adjustment Pattern

If recurring manual reconciliation is required, create a dedicated table such as:

```sql
coach_session_actual_adjustments
- id uuid primary key
- staff_id uuid not null
- week_start date not null
- adjustment_hours numeric not null
- reason text not null
- source_note text
- created_at timestamptz not null default now()
```

Then include adjustments in the computed source feeding snapshots:

```sql
actual_hours = raw_actual_hours + coalesce(adjustment_hours, 0)
```

This preserves history and avoids silent manual edits to derived snapshot data.

## Verification After Any Correction

Always verify:

```sql
select *
from view_coach_session_balance_sep25
where staff_id = 'STAFF_ID'
  and week_start in ('YYYY-MM-DD')
order by week_start;
```

Check:

- `actual_hours`
- `expected_hours_adjusted`
- `hours_balance_adjusted`
- `business_days_this_week`
- `leave_weekdays`
- `holiday_weekdays`

Report what changed and why.
