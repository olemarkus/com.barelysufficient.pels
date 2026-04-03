# Device State Invariants

**The single most important rule:** PELS must keep these five concepts strictly separate:

| Concept | Meaning |
|---------|---------|
| `planned` | What the current plan wants |
| `commanded` | What PELS most recently asked Homey/device to do |
| `observed` | What trusted telemetry most recently says the device is doing |
| `effective planning` | What the planner should conservatively assume right now |
| `pending` | Requested but not yet confirmed |

**Most bugs in this area come from collapsing two of these into one.**

## Source Trust Order

| Question | Trust order |
|----------|-------------|
| "What did PELS ask for?" | 1. local command state → 2. pending command records |
| "What is the freshest observed value?" | 1. recent realtime event → 2. recent snapshot → 3. unknown/stale |
| "Did the command succeed?" | 1. confirming telemetry — timeout expiry = unknown, NOT success |

For planner assumptions: use conservative still-on/still-high for shed decisions; pending state may justify "requested, unconfirmed" for restore decisions. For hard-cap safety, trust whole-home power over per-device attribution.

## Hard Invariants

- A local write (`setCapabilityValue`) is proof PELS requested a change — it is **not** proof the device converged.
- Binary `onoff` confirmation is **not** full convergence. Power draw and final behavior may still lag.
- A full snapshot refresh can be **older** than a recent realtime event or local write — never let it silently roll state backward.
- Fallback/estimated power is a planning input, not measured telemetry. Keep the distinction explicit.
- Fresh trusted observations must eventually win over local-write assumptions, older snapshots, and fallback estimates.
- "No confirmation yet" means pending/unknown — **never** treat it as success.
- Do not infer the `on` state of a device from its power consumption — power is unreliable for binary state attribution.

## Rules When Changing Reconcile or Merge Logic

- Drift comparison must be against **plan state**, not the last stored snapshot value.
- Realtime updates must update the observed view before drift evaluation uses that field.
- Reapply must target plan state, not the observed transition direction.
- Never let an older full fetch erase a fresher local or realtime observation without evidence it is newer.
- Preserve pending command state until confirmation or timeout.
- If an equivalent command is already pending, suppress duplicate reapply unless retry policy explicitly allows it.
- Logs must distinguish: observed transition / planned target / commanded/pending target.
