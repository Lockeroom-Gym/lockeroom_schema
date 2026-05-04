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
5. Prefer repairing raw actual rows or adding an audited adjustment path, then recomputing the snapshot.
6. Verify the final result in `view_coach_session_balance_sep25`.

## Correction Safety

- Do not mutate Supabase data without clearly stating the intended SQL and getting user approval.
- Use transactions for manual correction SQL where practical.
- Record the reason for every manual adjustment.
- After any correction, verify raw actuals, snapshot rows, and the final balance view.

## Reference

Read `reference.md` for the baseline data flow, diagnostic SQL templates, and correction decision tree.
