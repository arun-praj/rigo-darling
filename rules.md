# RigoHR scheduling rules

These are hard product rules. Any future UI, API, scheduler, randomizer, override, or automation change must preserve them.

## Planned punch times

- Punch-in must be selected inside the configured punch-in window.
- Punch-out must be strictly after the configured shift-end/punch-out window start and strictly before the configured punch-out window end. For example, a `19:00–20:00` punch-out window produces a planned punch-out between `19:01` and `19:59`.
- The planned span is calculated from the planned punch-in and planned punch-out times, not from a later observed or manually recorded attendance value.
- Planned span must never be less than 9 hours (`540` minutes).
- Planned span must be less than 10 hours (`600` minutes). A duration of exactly 10 hours is invalid.
- If the configured windows cannot produce a valid planned pair, reject the rule or override. Never generate or fall back to an invalid pair.
- A late actual punch-in does not rewrite the planned span. Actual attendance eligibility is evaluated separately and may block punch-out until the 9-hour minimum is reached.

## Examples

- For a planned punch-in at `10:00` and a shift ending at `19:00`, punch-out must be after `19:00` and before `20:00`; valid examples include `19:01` through `19:59`.
- The same ordering and duration rules apply to evening shifts.

## Verification expectations

- Validate schedule configuration and date-specific time overrides before saving them.
- Validate generated and persisted planned times before scheduling an automatic action.
- Keep tests for the minimum duration, exclusive punch-out boundaries, under-10-hour maximum, and infeasible windows.
