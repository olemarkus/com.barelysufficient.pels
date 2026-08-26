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

## The tracking modality (stepped loads) restates half of this

Everything above is written about the **lift** — a raise-only setpoint delta on a
temperature device — and about the binary dump load that shares its fit-test. The
third, *modulating* modality (`surplusTracking`, added for stepped loads and used
first by EV chargers) does not inherit the argument unchanged, because it is not
raise-only and, under one of its two floor policies, not net-neutral either.

### Half 1 — the tracked device is not "starved"

Starvation counts only where PELS commands a device **below the owner's intended
normal state**. A tracking device is held below what capacity alone would allow,
so unlike the lift this is not vacuously safe. What makes it acceptable is the
same thing that makes the dump load's baseline-off posture acceptable: it *is*
the owner's intended normal state. Turning on "match solar surplus" is a
statement that this device's normal operating point is "whatever the sun covers".
`resolveStarvationSuppressionSemantics` (`lib/planContract/planDecisionSemantics.ts`)
already maps `awaiting_solar_surplus` to an attributed pause rather than the
`unknown_suppression_reason` catch-all, and a tracking device reaches that map by
carrying the same reason code — the modality needed no new entry. What did have
to be unified is which devices earn the code: `resolveSurplusHold` and the
plan-side `isSurplusOnlyHoldShed` were hand-mirrored predicates (and had drifted
once), so both now delegate to a single `isSurplusHeldDevice`.

Note the hold is narrower than the posture: a device is only *held* when its
allocation clamped it to an off rung. Under the `'minimum'` floor it keeps
running at the ladder floor, so it is limited rather than waiting, and it never
carries the hold or the reason.

### Half 2 — the fit-test, restated for a chosen rung

Leg 1 of the original argument ("engage only when `availableSurplus >=
expectedDraw + reserve`") is stated over a draw the device cannot change. The
tracking modality chooses its draw, so the equivalent claim is:

> the rung the allocator writes never costs more than `pool − reserve`, measured
> in **calibrated admission power** (`resolveStepAdmissionKw`), not nameplate.

`resolveHighestStepWithinKw` enforces exactly that, and `claimForTrackingDevice`
subtracts the chosen rung from the running pool, so leg 3 (no two devices on the
same surplus) survives with fractional reservation intact — and in fact improves:
a fixed claimant reserves its whole highest-known draw and the remainder is
discarded, while a tracking device reserves only what it took.

Given that, legs 2 and 4 carry over unchanged: net grid import is unaltered by an
engaged tracking device, so it is structurally sub-cap and budget-neutral, and
capacity shedding remains the ceiling above the surplus ceiling.

### Where this argument is knowingly broken: the `'minimum'` floor

There is no rung between `off` and the ladder floor — 6 A on an EV preset, so
1.38 kW single-phase and 4.14 kW three-phase. A shortfall therefore has exactly
two honest answers, and `surplusFloor` lets the owner choose:

- **`'off'`** (the default, and the absent-value reading): the device stops. The
  argument above holds by construction.
- **`'minimum'`**: the device keeps drawing its floor rung and the grid covers
  the gap. **Leg 1 fails on purpose here.** Net grid import is *not* unchanged,
  and the sub-cap / budget-neutral corollaries do not follow from this argument.

What bounds it: the import is at most one ladder floor, it is the owner's
explicit choice, and the hard cap and daily budget still shed the device by the
ordinary rules — the surplus ceiling only ever *lowers* a step, so nothing here
can raise a device past a capacity decision. `claimForTrackingDevice` also
subtracts that floor from the pool even though the pool does not cover it,
driving it negative, so a lower-priority device is never offered surplus this one
is already importing against.

### Release safety, restated

A tracking device's release is a step DOWN its own ladder, so it carries no
starvation risk for the same reason the lift's does not. One thing differs and it
matters: the shared hard-off test (`isHardOffCondition`, raw net import above
`SURPLUS_ABSORB_HARD_OFF_IMPORT_KW`) is **not** used for this modality. For a
fixed-draw absorber, positive net is honest evidence that surplus is gone; for a
modulating one it is not, because the device's own draw is what pushed net
positive. Applying it would fire on any passing cloud and release the device
outright when the correct answer is to step down a rung. A tracking device is
therefore hard-off on `poolKw <= 0` — the pool being gone even after its own draw
is added back.
