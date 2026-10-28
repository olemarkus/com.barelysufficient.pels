# Slow response and pressure persistence

The comparison in `test/integration/slowResponseSimulation.test.ts` separates a
pressure decision from the electrical effect of its command. It uses synthetic
inputs; no household diagnostics are fixtures. Related field report:
`2026-10-28-diag-heat-pump-setpoint-churn`.

## Reproduce

```sh
PELS_TEST_WORKERS=1 PELS_PLAYWRIGHT_WORKERS=1 \
PELS_SLOW_RESPONSE_SIMULATION_OUTPUT=/tmp/pels-slow-response-evidence.json \
npm run test:integration -- test/integration/slowResponseSimulation.test.ts
```

The JSON contains the scenario inputs and all four policy results. The frozen
reference is commit `172819bee`, with no open activation attempt. An open
attempt can also give that version grace; this comparison isolates the proposed
extension to background-driven pressure.

## What the configured margin covers

A 0.2 kW margin protects 200 Wh in an hourly period and 50 Wh in a
quarter-hour period. A 6 kW load running an additional minute consumes 100 Wh:
half the hourly cushion, or twice the quarter-hour cushion. That extra energy
alone is not evidence of an unsafe hourly grace.

The earlier stress cases below use a 0.1 kW margin. Increasing it to 0.2 kW
covers the illustrated boundary delays:

| Hourly 0.2 kW margin, synthetic case | Delayed policy | Current import | Delayed import | Actual cap headroom after delay |
| --- | --- | --- | --- | --- |
| 80 Wh net remaining, 45 s response, 30 s readings | Universal grace | 141.7 Wh | 191.7 Wh | 88.3 Wh |
| Same, 60 s readings | Universal grace | 141.7 Wh | 241.7 Wh | 38.3 Wh |
| 540 Wh net remaining, second rise, 70 s response | Daily-only grace | 616.7 Wh | 650 Wh | 90 Wh |
| Same, 130 s response | Daily-only grace | 716.7 Wh | 750 Wh | -10 Wh |

The daily-only candidate does not delay the first two capacity-pressure cases;
it matches their current reference.

The first pair has 280 Wh below the actual cap: 80 Wh of net allowance plus
200 Wh margin. Keeping the original actual usage at 9.82 kWh instead would
already exhaust the 9.8 kWh operating allowance; every policy then sheds
immediately. These are different comparisons and must not be mixed.

The long-response case has 740 Wh below the actual cap. The current response
uses 176.7 Wh of its 200 Wh margin, leaving 23.3 Wh. Delaying the reduction by
20 s adds 33.3 Wh, which exceeds that remaining cushion by 10 Wh. Existing
response lag is not counted twice as incremental grace cost: both policies
incur it. The extra cost is the later useful reduction.

The design question is how much configured margin grace may spend while
retaining response reserve, with the capacity period included. The comparison
shows both covered cases and deliberately tight cases; it does not estimate
their frequency in a household.

## Two rejected capacity-grace proposals

The original proposal applied the existing grace to every soft deficit. The
second proposal bypassed grace when measured import projected above the actual
capacity-period cap. Both fail a concrete recovery case.

| Synthetic case | Current reference | Universal grace | Projection guard | Daily-only candidate |
| --- | --- | --- | --- | --- |
| Last two minutes, 30 s meter cadence | Off decided at 0 s; 141.7 Wh used | At 30 s; 191.7 Wh used | At 0 s; 141.7 Wh used | At 0 s; 141.7 Wh used |
| Another 6 kW load starts during response | Off decided at 0 s; 575 Wh used | At 20 s; 608.3 Wh used | At 20 s; 608.3 Wh used | At 0 s; 575 Wh used |
| Daily-only pressure, then another 6 kW rise | Off decided at 0 s; 616.7 Wh used | At 20 s; 650 Wh used | At 20 s; 650 Wh used | At 20 s; 650 Wh used |
| Brief daily-only spike | One restriction | No restriction | No restriction | No restriction |
| Sustained daily-only pressure | Restriction at 0 s | At 60 s | At 60 s | At 60 s |

In the first case a 10 kWh hourly cap has 180 Wh remaining, and the
margin-adjusted allowance has 80 Wh remaining. Import is 2 kW background plus a
6 kW controlled load. Electrical relief takes 45 s after the decision. The
nominal grace is about one second, but it schedules no reading: a 30 s meter
cadence delays the decision by 30 s and relief until 75 s. The proposal exceeds
the actual cap by 11.7 Wh; the current reference stays below it. At a 60 s
cadence, the proposal exceeds it by 61.7 Wh.

In the second case four minutes remain, with 600 Wh of actual allowance and
500 Wh after margin. Initial import is 8 kW: 2 kW background and 6 kW controlled.
This fits the 9 kW hard-cap projection but exceeds the 7.5 kW capacity pace.
Another 6 kW background load starts at 20 s and is observed then. Even an
immediate response to that second rise delivers relief at 65 s rather than
45 s. The projection guard exceeds the cap by 8.3 Wh. It preserved feasibility
only for unchanged demand, consuming response margin before the second rise.

A nominal 60 s wait at 6 kW adds 100 Wh before cadence and response delay. The
old 2% formula is a nominal duration calculation, not an integrated energy
guarantee: variable deficits, episode resets, and discrete readings break that
interpretation.

Even daily-only patience changes resilience to future load. With four minutes
left, 640 Wh below the actual cap, 540 Wh after margin, initial import of 8 kW,
and a 6 kW daily pace, the capacity pace is 8.1 kW. A second 6 kW background
rise starts at 20 s. With 70 s of response delay, current daily shedding uses
616.7 Wh, while the daily-only candidate uses 650 Wh and exceeds the cap by
10 Wh. The later capacity decision is immediate; the earlier wait still costs
response margin. This remains an unresolved policy trade, so the runtime
candidate stays a draft experiment.

## Narrower implementation direction

Only daily-budget pressure gains persistence independent of recent activation.
Capacity-pace and grid pressure receive no additional waiting; existing
restore-specific capacity behavior is retained. The selected
runtime policy must also be exercised by the simulation; reference policies
remain frozen so later changes cannot silently move the comparison baseline.

A temperature setback requests less demand. Its echoed target does not promise
zero electrical draw. Under grid pressure or a projected actual-cap breach,
selection must continue to direct electrical options rather than count a
temperature restriction as dependable immediate relief. An earlier temperature
credit must be withdrawn too. Ordinary pacing retains a bounded opportunity for
a demand restriction to help, preserving priority ordering rather than
immediately cascading through higher-ranked devices.

Command confirmation stays with execution/observation; decision pacing stays
with planning. No new pending-power reservation or whole-home attribution rule
is introduced. Restores keep their existing admission and home-wide pacing.

## Interpretation limits

The plant integrates actual power independently each second and reports exact
cumulative energy at discrete samples. It exercises production capacity pacing
and period accounting, with frozen reference pressure decisions. It models one
restriction, including delayed, partial, or absent electrical relief; the
restricted load stays restricted. It does not model restores, priority
selection, retries, startup, scheduler suppression, or thermal dynamics. Its
command counts and energy differences are scenario results, not predicted
household savings or a complete heat-pump response model. SDK-boundary tests
cover the runtime command path separately.

Meter latency, missed pulses, and scheduler suppression can worsen response.
Keeping additional grace off the capacity axis avoids the first two
demonstrated regressions but leaves the third. No candidate here guarantees
capacity control against arbitrary unobserved loads or a device that never
reduces power. Changing the policy needs an explicit response assumption and
accepted risk budget; a passing simulation suite records the trade and does
not approve it.
