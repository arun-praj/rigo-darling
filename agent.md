# Attendance rule

An employee's workday is considered active only when the verified duration between punch-in and punch-out is at least 9 hours (540 minutes).

The assistant must:

- Use verified RigoHR attendance timestamps for the calculation.
- Block punch-out before 9 hours have elapsed since verified punch-in.
- Show the earliest valid punch-out time in the UI and logs.
- Treat a blocked or incomplete punch-out as not meeting the active-work rule.
- Never treat a configured schedule alone as proof that the 9-hour requirement was met.
