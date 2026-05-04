---
name: lockeroom-session-balance
description: Investigate, explain, and safely correct Lockeroom coach session balance data in Supabase. Use when the user mentions session balance, view_coach_session_balance_sep25, coach_session_expectation_log, coach_session_actual, coach_weekly_hours_snapshot, coach actual hours anomalies, missing coach sessions, or adjusting/reconciling a coach's weekly hours.
---

# Lockeroom Session Balance

Use this skill for Lockeroom coach session balance analysis and corrections.

Before querying or changing data, read `reference.md`.

## Default Workflow

1. Treat `view_coach_session_balance_sep25` as the reporting surface, not the raw source of truth.
2. Work backwards through:
   - `coach_session_expectation_log` for expected sessions and role-hour components.
   - `coach_weekly_hours_snapshot` for materialized actual hours.
   - `view_session_balance_adjusted_25` for the computed source of snapshot rows.
   - `coach_session_actual` for raw session rows.
3. For anomalies, investigate read-only first and identify which layer is wrong.
4. Do not directly edit `coach_weekly_hours_snapshot.actual_hours` unless the user explicitly approves a one-off derived-data correction.
5. Prefer repairing raw actual rows or adding an audited adjustment path, then refreshing snapshot rows.
6. Default snapshot refresh after a **single-coach** fix is `run_correction_recompute_and_snapshot_for_staff_week(...)`. Avoid `run_correction_coach_weekly_snapshot_for_week` unless you intentionally want **all** coaches rebuilt for that Monday from `view_session_balance_adjusted_25`.
7. To intentionally **zero** `hours_balance_adjusted` for selected weeks while keeping `actual_hours` as reported, tune `coach_session_expectation_log.session_expectation` so `expected_hours_adjusted` rounds to actual (see `reference.md`). Then run `run_correction_recompute_and_snapshot_for_staff_week` for that coach/week.
8. Verify the final result in `view_coach_session_balance_sep25`.

## Correction Safety

- Do not mutate Supabase data without clearly stating the intended SQL and getting user approval.
- Use transactions for manual correction SQL where practical.
- Record the reason for every manual adjustment.
- After any correction, verify raw actuals, snapshot rows, and the final balance view.

## Reference

Read `reference.md` for the baseline data flow, diagnostic SQL templates, and correction decision tree.
