# Device Layer — Orientation and State Invariants

`lib/device` owns observed current device state and device-specific actuation transport. The planner imports this module only through the producer seams allowlisted by `no-plan-to-device` (`deviceObservation.ts`, `deviceActionProjection.ts`, `deviceResidualKw.ts`); planning inputs cross that boundary as producer-resolved flat values.

## Map

- `deviceTransport.ts` — the hub class: syncs Homey state back, detects external changes, owns the actuation transport (split tracked in `TODO.md`).
- `transport/` — snapshot fetch/parse, realtime capability handlers, freshness, and retained-observation accounting (`managerObservation.ts`).
- `deviceObservation.ts` — read-only view over the snapshot store; plan/executor read consumers depend on this interface, not the concrete class. House-style docblock reference.
- `deviceActionProjection.ts` — the producer that resolves observed/planner-facing bits onto `PlanInputDevice`; consumers must not re-branch on source/provenance/evidence.
- `devicePowerEstimate.ts` / `devicePowerCalibration*.ts` / `deviceResidualKw.ts` — expected-power estimation and step calibration.
- `manager*.ts` — transport halves (control, energy, flow support, measured power, native EV, native stepped command).

Design-of-record: `notes/state-management/` (especially `observer-transport-split.md`).

## Device State Invariants

**The single most important rule:** PELS must keep these five concepts strictly separate:

| Concept | Meaning |
|---------|---------|
| `planned` | What the current plan wants |
| `commanded` | What PELS most recently asked Homey/device to do |
| `observed` | What trusted telemetry most recently says the device is doing |
| `effective planning` | What the planner should conservatively assume right now |
| `pending` | Requested but not yet confirmed |

**Most bugs in this area come from collapsing two of these into one.**

### Source trust order

| Question | Trust order |
|----------|-------------|
| "What did PELS ask for?" | 1. local command state → 2. pending command records |
| "What is the freshest observed value?" | 1. recent realtime event → 2. recent snapshot → 3. unknown/stale |
| "Did the command succeed?" | 1. confirming telemetry — timeout expiry = unknown, NOT success |

For planner assumptions: use conservative still-on/still-high for shed decisions; pending state may justify "requested, unconfirmed" for restore decisions. For hard-cap safety, trust whole-home power over per-device attribution.

### Hard invariants

- A local write (`setCapabilityValue`) is proof PELS requested a change — it is **not** proof the device converged.
- Binary `onoff` confirmation is **not** full convergence. Power draw and final behavior may still lag.
- A full snapshot refresh can be **older** than a recent realtime event or local write — never let it silently roll state backward.
- Fallback/estimated power is a planning input, not measured telemetry. Keep the distinction explicit.
- Fresh trusted observations must eventually win over local-write assumptions, older snapshots, and fallback estimates.
- "No confirmation yet" means pending/unknown — **never** treat it as success.
- Do not infer the `on` state of a device from its power consumption — power is unreliable for binary state attribution.
- An unobserved binary control resolves `currentOn` to **`false`** (non-optimistic), never a fabricated `true` — `currentOn` stays strictly `boolean` and the unknown signal lives on `binaryControlObservation`. A binary-less `device.update` must **not** synthesize an on-transition (it once did, via the optimistic default — a phantom off→on reconcile / Flow trigger). Do not re-introduce the optimism to "restore" a reconcile event.

### Rules when changing reconcile or merge logic

- Drift comparison must be against **plan state**, not the last stored snapshot value.
- Realtime updates must update the observed view before drift evaluation uses that field.
- Reapply must target plan state, not the observed transition direction.
- Never let an older full fetch erase a fresher local or realtime observation without evidence it is newer.
- Preserve pending command state until confirmation or timeout.
- If an equivalent command is already pending, suppress duplicate reapply unless retry policy explicitly allows it.
- Logs must distinguish: observed transition / planned target / commanded/pending target.

Observation freshness is a producer concern — quiescent devices are not broken. See `lib/observer/AGENTS.md` for the quiescence rules before consulting staleness flags.
