# Auto-Adjust Daily Budget — Design Constraints

> This feature is **not yet implemented**. Read this before starting any implementation.

**Purpose:** increase tomorrow's effective daily budget based on recent eligible exempted energy from completed days, to prevent the planner from chasing thermal demand too aggressively after starvation-driven exemptions.

## Hard Constraints

- Tomorrow's budget = `baseBudget + autoBudgetCorrection`. Never `yesterdayEffectiveBudget + correction` — correction must always be relative to the **configured base**, not compounded.
- Correction source is **eligible exempted kWh from completed days** — not starved minutes, not starved device count, not arbitrary percentage bumps.
- In v1, only `starvation_policy` exemptions are eligible. Manual, flow-driven, and ad hoc exemptions are excluded.
- Hourly capacity protection is **completely unaffected** — this is a daily budget policy feature only.
- Exempted energy still behaves as uncontrolled in the daily-budget split.
- Ignore the current incomplete day — compute at day rollover from finalized values only.
- Data model must keep `baseDailyBudgetKwh`, `autoBudgetCorrectionKwh`, and `effectiveDailyBudgetKwh` as **separate fields**.
