# End-of-hour mode (hourly sustainable-rate drain)

Contributor-facing design-of-record for the end-of-hour behaviour of the hourly
capacity safe pace. Code: `lib/plan/planBudget.ts` (`computeDynamicSoftLimit`).
User-facing description: `docs/technical.md` (“Dynamic Hourly Safe Pace”).

## What problem it solves

PELS enforces a Norwegian grid **capacity tariff**: the cost driver is the
*average* power over each **clock hour** (kWh consumed in a clock hour = average
kW). So the thing to protect is the hour boundary: if managed devices are still
drawing hard at `HH:00`, that draw inflates the *new* hour’s average from its
first instant.

Within an hour the planner lets you **burst** — spend the remaining hourly
budget at whatever instantaneous rate fits the time left
(`burstRate = remainingKWh / remainingHours`). Left unchecked, that invites an
“end-of-hour burst”: devices ramp up at `:55` to use leftover budget, then carry
that high draw across `:00` into the next hour.

## The mechanism: an exponential drain toward the sustainable rate

The hourly safe pace (`allowedKw`, the capacity `softLimit`) caps the burst rate
by a **ceiling that decays exponentially toward the steady sustainable rate** as
the hour ends:

```text
sustainable   = limitKw - marginKw                       // steady kW == kWh/h
drainCeiling  = sustainable * e^(minutesRemaining / TAU)  // TAU = EOH_DRAIN_TAU_MIN
allowedKw     = min(burstRate, drainCeiling)
```

- **Far from the boundary** the ceiling sits far above any feasible burst
  (`e^(minutesRemaining/TAU)` is large), so the budget-driven `burstRate`
  governs — full freedom to use the budget.
- **As the hour ends** the ceiling collapses toward `sustainable`, pulling the
  allowed pace down **gradually**. At `minutesRemaining → 0` the ceiling **is**
  `sustainable`, so the boundary is crossed at the steady rate and the next hour
  starts clean.

`allowedKw` is the capacity soft limit; `headroom = softLimit − measuredTotal`
(`planContext.ts`). A negative headroom drives shedding, so the drain both blocks
new turn-ons *and* trims devices already drawing above the (now lower) ceiling —
priority-ordered, by the normal shedding lane (`lib/plan/shedding`).

### Why exponential, and not the old cliff

This replaced a hard binary cliff (`minutesRemaining <= 10 ? min(burst, sustainable) : burst`).
The cliff cut everything to the sustainable rate the instant 10 minutes
remained — a single, coordinated batch-shed at `:50`. The exponential drain
smooths that into a gradual wind-down over the final minutes, so most managed
devices keep running into the last few minutes and are trimmed progressively
rather than all at once. Shed *ordering* is unchanged — it has always been
priority-based; this only changes the *ceiling over time*, not which device goes
first.

## TAU (`EOH_DRAIN_TAU_MIN`), and the trade-off

`TAU` is the only tuning knob (a hardcoded constant — deliberately not a user
setting; consistent with “the hard cap is physical, don’t add capacity dials”).
It sets how late the drain bites. The ceiling multiplier over the sustainable
rate is `e^(minutesRemaining / TAU)`:

| min left | TAU=2 | TAU=3 | **TAU=4** | TAU=5 |
|---------:|------:|------:|---------:|------:|
| 10       | 148×  | 28×   | **12.2×** | 7.4× |
| 5        | 12.2× | 5.3×  | **3.5×**  | 2.7× |
| 3        | 4.5×  | 2.7×  | **2.1×**  | 1.8× |
| 1        | 1.65× | 1.40× | **1.28×** | 1.22×|
| 0        | 1.0×  | 1.0×  | **1.0×**  | 1.0× |

Current value: **`TAU = 4`** — the drain is negligible until ~8 minutes left,
meaningful through the last ~5 minutes, and pinches to the sustainable rate at
`:00`. Larger `TAU` → tighter/earlier wind-down (closer to the old cliff);
smaller `TAU` → devices run later, more headroom near the boundary. (`TAU` must
stay well above ~0.085 min: `Math.exp` overflows to `Infinity` once
`minutesRemaining / TAU` exceeds ~709. Even then the `min(burstRate, …)` keeps
`allowedKw` finite, but don’t rely on that — keep `TAU` in single-digit minutes.)

**The trade you are accepting:** the old cliff pinned the pace to exactly
`sustainable` for a full 10 minutes, so the boundary was crossed at the steady
rate with margin to spare. The exponential sits *above* `sustainable` until the
final minutes, so the carryover into the next hour is governed by how far the
shed lags the falling ceiling — i.e. by command latency in the last 1–2 minutes,
not by the `:00` instant itself (where `e^0 = 1`). With a slow (cloud-mediated)
device and a realistic 60–120 s shed-to-effect lag, the device can cross `:00`
still drawing roughly `1.3–1.65×` the sustainable rate (the ceiling ~1–2 min
earlier) and persist for that lag into the new hour. Worst case that inflates the
new hour’s tariff-measured average by ≈ 0.1–0.2 kWh on a 10 kW system — small
(1–2 % of a ~10 kWh hourly budget) and self-correcting, since the new hour’s
ceiling reopens to full burst at `:00` and its own headroom goes negative
immediately, re-shedding the carry. This is a deliberate softening of a
previously hard guarantee, in exchange for gentler, progressive shedding. **Do
not “fix” it back to a cliff** without revisiting this note; if the carryover
ever proves to matter in production, raise `TAU` (tighter wind-down) rather than
restoring the step.

## Invariants

- **`min(burstRate, …)` is load-bearing.** `burstRate` is the most you can draw
  and still land within *this* hour’s budget; the drain may only pull the
  allowance *below* burst, never above. This also handles a nearly-spent budget:
  when `burstRate < sustainable`, the `min` collapses to `burstRate` and the
  drain ceiling is irrelevant.
- **Crosses the boundary at the sustainable rate.** `e^0 = 1`, so at
  `minutesRemaining = 0` the ceiling is exactly `sustainable`.
- **`burstRate` floor.** `remainingHours` is floored at
  `BURST_RATE_MIN_REMAINING_MIN` (10 min) so the burst rate stays finite as the
  hour ends; this is a divisor floor only, unrelated to the drain.

## Daily budget is exempt by design

`computeDailyUsageSoftLimit` does **not** apply the drain (`allowedKw = burstRate`).
The daily budget is a soft pacing target with no per-hour grid penalty, so the
planner stays free to make the right call at `23:55`. Only the hourly hard-cap
side needs boundary protection. See `docs/daily-budget.md`.

## Tests

`test/integration/planBudget.test.ts` (pure math: drain near hour end, no cliff
at the 10-minute mark, boundary crossing at sustainable, monotone taper over the
final minutes) and `test/integration/app.test.ts` (`computeDynamicSoftLimit`
through the app).
