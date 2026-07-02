# Surplus-absorb and starvation safety

> Sibling to [`README.md`](README.md) (Temperature Device Starvation Detection
> v1). The README's model is scoped to PELS **holding a device below its mode
> target**; the solar surplus-absorb feature only ever raises a target, so it
> lives in its own note. This records the starvation-safety rationale that
> otherwise survives only in code comments (`lib/plan/admission/surplusAbsorb.ts`,
> `lib/plan/planSurplusAbsorb.ts`).

## The claim

The solar **surplus-absorb** lift ("Use solar surplus" on a managed temperature
device) is **structurally starvation-safe** — it can neither be flagged as
starvation on the lifted device nor manufacture starvation on any other device.
The safety comes from the **fit-test**, not from any "don't raise while some
device is shed" gate (no such gate exists).

## Why a lifted device is never "starved"

Starvation counts only when PELS's **commanded** effective target sits **below**
the device's intended/mode target (`commandedTargetC < intendedNormalTargetC`;
see README § Core Rule). The surplus lift is **raise-only** — it applies
`max(pricedTarget, baseTarget + surplusDelta)` (`applySurplusAbsorbDelta`), so the
commanded target is at or **above** the mode target while engaged. A device
being lifted for surplus is therefore, by construction, never below its mode
target on that account, so it can never enter a starvation episode because of the
surplus feature.

A **willing-but-not-engaged** device ("awaiting solar surplus" — willing, but the
allocator has reserved it no surplus this cycle) is **starvation-exempt by
design** with respect to the surplus mechanism: when not eligible the delta is
not applied and the device falls back to its **normal** priced/mode target
(`applySurplusAbsorbDelta` returns `pricedTarget` unchanged). The surplus feature
never drops it below its mode target while it waits. (It can, of course, still be
shed below target by ordinary capacity/budget suppression — but that is normal
starvation, not caused by, and not masked by, the surplus feature.)

## Why a lift never starves *other* devices

The concern is the inverse: a lift on device A draws more power, which could push
whole-home draw up and force capacity/budget shedding of lower-priority devices
B, C — starving them. The **fit-test** forecloses this:

- Eligibility gates on the allocated surplus **covering** the device's expected
  draw: `availableSurplus >= expectedDraw + reserve` (the overshoot-fit / "reverse
  admission" guard in `admission/surplusAbsorb.ts`). A raise engages only when
  exported solar already covers what the lifted device will draw, so the home does
  **not tip into import** on account of the lift.
- Net grid import is therefore **unchanged** by an engaged lift (the extra draw is
  soaked from surplus that was otherwise exported). That makes the lift:
  - **structurally sub-cap** — it consumes no capacity headroom, so it cannot push
    the home toward the hard cap and trigger a capacity shed of B/C; and
  - **budget-neutral** — the daily budget is measured on net grid import (an export
    hour is zero energy used), so a lift that stays covered by surplus adds nothing
    to budget consumption and cannot bring forward a budget shed of B/C.
- The priority-greedy allocator (`resolveSurplusEligibility`) reserves each
  engaged device's draw from the shared pool before offering it to the next, so
  two willing devices cannot both claim the same surplus and oscillate; a
  lower-priority device only ever sees surplus the higher-priority ones left.
- The capacity shed layer remains the ceiling regardless: the lift is
  **capacity-independent** (`applySurplusAbsorbDelta` is documented as such), so
  if the home genuinely were near the cap, capacity shedding still applies on top
  — the lift never bypasses it.

Because these hold by construction (net-neutral ⇒ sub-cap ∧ budget-neutral), the
safety needs **no** "refuse to raise while any device is shed" gate. Such a gate
would be both unnecessary (the fit-test already prevents the pressure) and wrong
(it would suppress a legitimate free-solar raise whenever an unrelated device was
shed for reasons the lift does not affect).

## Release safety (aftermath)

Releasing a lift only lowers the commanded target back toward the normal mode
target — it can never push a device below it — so the release path carries no
starvation risk either. The release timing rules (settle window, min dwell,
hard-off bypass, hard-off entry retention) exist to bound the passing-cloud
chatter / measured-feedback limit cycle, not for starvation; see the invariants
in `admission/surplusAbsorb.ts`.
