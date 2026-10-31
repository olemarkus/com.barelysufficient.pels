# Battery export arbitrage

**Status:** user-facing export remains proposed. The hidden economic evaluation
stage described below is implemented; it grants no export permission. Extends
[`continuous-battery-plan.md`](./continuous-battery-plan.md). Current battery
planning can charge cheaply and supply the house; it deliberately excludes
battery-driven grid export.

## Hidden economic evaluation

Continuous planning still returns only the household plan to control and the UI.
When the existing `plan` debug topic is enabled, the battery owner samples a
counterfactual export comparison at most once every five minutes, on a fresh
household solve. No export toggle, settings key, API route or command is added.

The hypothetical Main-meter export ceiling is the battery's current resolved
delivery ceiling. The diagnostic records that assumption explicitly; it is not
an owner-authorized export ceiling. Both solves share the accepted horizon and
represented energy states, and end with identical stored energy. Complete export
quotes are required even without solar. Missing quotes skip the comparison and
leave usable household planning intact. Existing baseline waiting policies remain.

`battery_export_shadow_evaluated` records the baseline and candidate energy cost,
selected alternative, estimated cost reduction, terminal energy, candidate
battery-added export periods, price unit, horizon bounds and solve duration.
These are overlapping forecast snapshots: never add their savings together or
interpret them as realized profit. Candidate periods remain hypothetical even
when numerical tolerance selects the household plan. No candidate schedule is
published to planner input or the settings UI, and no money ledger is created.

`battery_export_shadow_skipped` records incomplete quotes, unavailable discharge,
or a conservative search-work estimate exceeding two million transitions.
The estimate is owned by the optimizer; the sampling/work policy belongs to the
battery diagnostic owner. This limits work, not wall-clock time. Diagnostic
failures are logged and do not replace or prevent the household decision.

`npm run bench:battery-export` evaluates unrestricted 192-period quarter-hour
horizons. On 2026-10-31, local Linux x64 / Node 22.23.2 measurements (one warm-up,
three samples) gave extra candidate median/max times of **103/108 ms** for
10 kWh / 2.5 kW and **622/669 ms** for the 2 kWh / 12 kW stress case. These are
development-machine measurements, not Homey timing guarantees. The latter
scenario is excluded from live shadow sampling by the work budget.

Focused validation covers economic fixtures, quote coverage and native period
bounds, sampling/memo behavior, and a real SDK-boundary path where profitable
export is logged while the returned schedule and issued commands remain
household-only. Existing ownership, reserve and simulation checks are retained.

The [evidence assessment](./battery-export-evidence.md) distinguishes supported
economic arbitrage from strict household/EV-first preferences, minimum trading
reward and an additional overnight reserve. The latter remain separate product
choices; this stage does not silently add them.

Let an owner explicitly authorize PELS to sell stored energy when doing so lowers
the forecast household electricity cost compared with keeping export disabled.
Household-only planning remains the default. The feature applies to the existing
one-battery, Main-home continuous planner, independently of country or whether
the home has solar.

## User need

Owners use batteries in different ways: cover expensive household consumption,
store solar for later, or sell energy during favorable price periods. Some want
household use first and selective selling afterward. These are choices for the
same battery planner, rather than separate competing controllers.

Firsthand discussions establish demand for the export option:

- A [Danish Home Assistant owner](https://community.home-assistant.io/t/pull-cheapest-electricity-price-for-template-sensor-solar/619190)
  explicitly sought cheap grid charging followed by profitable export, accounting
  for the difference between purchase and sale prices.
- [Dutch battery owners](https://www.reddit.com/r/thuisbatterij/comments/1ths27b/thuisbatterij_opbrengsten_handel/)
  describe both automated buying/selling and prioritizing household and EV use
  before selling the remainder.
- [SlimLaden's developer](https://community.homey.app/t/app-pro-slimladen-thuis-auto/140156/6218)
  describes a trading threshold with a self-consumption fallback and an overnight
  reserve that restrains selling.

These are qualitative use cases, not population estimates or verified savings.
The PELS opportunity is an optional extension for owners who want it; ordinary
household battery planning remains useful without selling.

## First version

- Add a separate export opt-in beneath **Plan charging with PELS**. Existing and
  new configurations resolve to household-only behavior until the owner opts in.
- Use the existing usable capacity, reserve, round-trip efficiency, wear allowance,
  import prices, export prices, forecasts and Smart-task commitments.
- Require a positive owner-entered Main-meter export ceiling. This authorizes an
  amount of net export during battery discharge; the hardware delivery ceiling
  remains an independent bound.
- Plan cheap grid charging, delayed solar sales and household supply together.
  Do not maintain separate grid-charged and solar-charged energy inventories.
- Export only in periods with a **positive net export value**, and only when the
  complete export-capable plan beats the household-only alternative. Negative
  charging prices remain valid inputs. Rejecting paid export is an explicit
  first-version policy, not a claim that such trades are mathematically impossible.

Excluded: balancing-market participation, aggregator contracts, battery fleets,
meter-area batteries, V2G, vendor-specific trading services, new inverter control,
tax settlement, tiered-fee optimization and realized trading-profit accounting.
Do not add a configurable daily trading-profit threshold in this version.

## Economics

Read the prices the contract settles. Import is the marginal purchase cost,
including applicable per-kWh charges. Export is the marginal payment after
incremental deductions. Fixed charges that do not change with dispatch are not
charged to each cycle. Annual netting and nonlinear export-fee bands are not
calculated by this feature.

Use distinct resolved import and export prices, not the solar-blended
`budgetPrice` scheduling signal. Do not infer profitability from country, a
negative spot price, or a high export price alone.

For an isolated grid-charge/export cycle, the break-even illustration is:

```text
net export price > all-in import price / round-trip efficiency
                   + wear cost per AC kWh exported
```

For example, buying 10 kWh at 0.10 currency units/kWh costs 1.00. With 90%
round-trip efficiency, 9 kWh sold at 0.20 earns 1.80. Wear at 0.02 per AC kWh
supplied costs 0.18, leaving 0.62 before any additional action-dependent costs.
The example assumes the house needs none of that energy; it is not a dispatch rule.

### Compare complete plans

1. Build the current household-only baseline from one accepted input snapshot.
2. Build an export-capable candidate with the same initial stored energy,
   forecasts, native price periods, household demand, managed commitments,
   import limits, hardware limits, reserve, efficiency and wear.
3. Constrain the candidate to **the baseline's terminal stored-energy state**.
   Use the same represented energy states in both solves. The baseline trajectory
   remains feasible under the export permission; permission is not an obligation.
4. Compare `energyCost`: import cost minus export revenue plus wear. Terminal
   energy and its valuation are identical, so the terminal credit cancels.
5. Choose the candidate only when its cost is strictly lower beyond numerical
   comparison tolerance. Equal-cost or infeasible candidates keep the baseline.

This includes the value of keeping energy for later household use and the cost
of replenishing energy after a sale. Both plans account for solar export revenue;
the comparison reports their net cost difference, not the candidate's total
export revenue as trading income. Historical purchase prices and a FIFO ledger
are unnecessary for deciding between future alternatives.

Equal terminal energy is a conservative scope choice: the first version excludes
liquidating stored energy when replenishment would fall beyond the known horizon.
It must not advertise the resulting estimate as globally optimal trading income.

If the baseline cannot be constructed, follow existing continuous-plan waiting
behavior. Do not invent a household forecast to permit a sale.

### Price availability

The export candidate requires a resolved net export price for every period in its
horizon. Preserve actual period bounds, gaps and the existing price unit. An
absent quote is not a zero-price quote.

`continuousBatteryHorizon.ts` currently supplies `exportPrice ?? 0` when no solar
export is forecast. That shortcut cannot authorize battery export. When export
quotes are incomplete, retain a usable household-only plan and its continuous
claim, and explain that selling is waiting for export prices. Do not hand the
battery to its native trading mode merely because export quotes are missing.

Missing import prices, observations or forecasts keep their existing owner
policies. Transient failed reads retain accepted facts only within the existing
freshness and validity rules; an expired negative or positive quote never extends
its own settlement period.

## Export ceiling and live execution

The ceiling is a Main-meter net-export bound used to constrain **battery
discharge**. It is not a new whole-home export controller or electrical protection.
If independent PV already exceeds it, PELS adds no discretionary battery
discharge; it does not acquire control of that PV.

In the economic model, discharge may create grid export up to the ceiling. An
unavoidable PV export already above the ceiling must remain feasible: the battery
may hold or charge, but cannot worsen that excess. Apply the bound to battery-added
export rather than rejecting the household baseline for independent PV production.

On each normal meter-driven build, derive battery-free net import from accepted
signed observations:

```text
import without battery = measured Main net import - signed battery power
```

Positive battery power means charging. For the export-capable discharge intent,
the live maximum total discharge is bounded by:

```text
max(0, import without battery + export ceiling - response margin)
```

Also apply the planned setpoint, hardware/delivery ceiling, owner-resolved reserve
ceiling and supported setpoint steps. Keep the response margin with the owning
power/control policy rather than exposing another user setting. Measurements and
device response mean this is feedback control, not an instantaneous guarantee.

- Carry an explicit export reason/permission through the resolved storage intent.
  Removing the forecast demand clamp alone is insufficient: `continuousLever`
  separately caps live discharge to household demand today.
- Household demand can consume part or all of planned discharge. Do not increase
  discharge simply to preserve a forecast export quantity after demand changes.
- Existing capacity and grid-import limiting retain precedence. The export option
  grants no permission to limit extra devices, exceed the daily budget or move
  Smart-task commitments for trading.
- Discretionary discharge creates no restore/admission allowance, solar-surplus
  pool or speculative pending-relief credit. Battery exports must not start a
  solar dump load or induce extra restores that consume the traded energy.
- Retain the existing battery priority order, reserve owner, learned delivery
  ceilings and nonresponse handling. Reuse the existing battery executor, durable
  claim, verification and actuator seam. There is no second actuation loop.

## Settings and owner controls

Extend `ContinuousBatteryPlanConfig` with one owned export policy: household-only,
or price export with its required finite positive ceiling. Resolve legacy absence
to household-only at the settings boundary. Carry that coherent policy with the
battery energy model; do not add mirrored permission booleans and caps across layers.

The opt-in is effective only while continuous planning, Managed and Power-limit
control remain authorized. Export pricing must be configurable for a compatible
battery **without solar or prior export history**; do not reuse solar-presence
gating or label the battery as solar to expose that setup.

- Turning export off stops discretionary exporting on the next decided plan and
  returns to household-only planning while retaining the continuous claim.
- Turning continuous planning off follows existing hand-back policy once other
  holds no longer need the battery. Existing native trading is not run concurrently.
- Simulation never sends an export command. Manual takeover, revoked authority,
  unavailable devices, restart recovery and meter-silence escalation retain their
  existing battery ownership rules.
- Permission, ceiling, quote availability and price-unit changes invalidate the
  memoized economic choice. Period expiry prevents an old export decision from
  surviving the prices that authorized it.

## Presentation and evidence

Proposed settings label: **Sell stored energy when profitable**, default off.
Its supporting text explains that PELS compares selling with keeping energy for
the house and keeps the configured reserve. The associated ceiling is in kW.
Keep the existing efficiency, wear and reserve controls; do not introduce country
presets or expose the comparison algorithm in the normal settings flow.

The battery owner supplies the selected schedule, a resolved reason, and the
estimated reduction in net energy cost against the household-only baseline over
the displayed horizon. Both schedules use identical terminal energy. Label the
comparison as an estimate in the existing money unit, not realized profit or
annual savings. With incomplete export prices, show that household planning
continues and selling is waiting.

Add planned export periods to the existing trajectory and activity explanation.
Observed state remains observer truth: a battery asked to export may still be
charging or supplying only the house. While PELS controls the battery, a
**Selling to grid** state requires both observed battery discharge and
contemporaneous Main-meter export. Solar export alone must not produce that
battery state, and total grid export must not be attributed to the battery.
Extend canonical battery wording when implementing this feature; existing labels
remain unchanged until then.

Use existing structured activity/debug logging for policy changes, selected export
periods and the owner-resolved reason when export cannot run. Do not add a second
money ledger or claim verified trading income from a modeled comparison.

## Ownership and implementation seams

| Owner | Responsibility |
| --- | --- |
| `lib/battery/` | Settings boundary, price/forecast resolution, baseline/candidate comparison, reserve and plan memo. |
| `lib/battery/planning/` | Pure energy transitions, export constraints and economic optimization over complete typed inputs. |
| `packages/contracts/` | Browser-safe policy, schedule and read-model contracts. |
| `lib/planInput/storageProjection.ts` | Project the battery owner's complete decision into planner input. |
| `lib/plan/battery/` | Resolve live executable intent with measured power, priorities and control bounds. |
| Observer, executor and actuator | Supply accepted observations; converge and confirm the decided setpoint through existing seams. |
| Settings UI | Render the owner-resolved schedule/comparison and save explicit choices through existing channels. |
| `setup/` | Construct and connect owners and ports; no pricing, parsing, retained state or policy. |

Use existing settings and device channels rather than new Flow cards or manifest
capabilities. Update the settings ownership note and continuous-battery design
record with the implementation. Shared-domain gains logic only where real browser
and Node consumers require the same behavior.

## Acceptance criteria

Focused pure-planner fixtures must establish:

1. Export off preserves current household-only results, including solar exports.
2. A profitable complete charge/export cycle beats the baseline after conversion
   losses and wear; a headline spread erased by settled charges does not.
3. Keeping energy for expensive household use beats selling when it has higher
   forecast value. Existing Smart-task energy and power reservations are unchanged.
4. Both comparisons end with the same stored energy. Emptying initial inventory
   or counting pre-existing solar revenue cannot create apparent trading gains.
5. No positive net export value, equal modeled cost, missing export quotes or an
   infeasible candidate retains a usable household-only baseline. If that
   baseline is unavailable too, existing continuous-plan waiting rules apply.
6. Native quarters, partial periods, DST and source-grid changes preserve actual
   duration. A solar-only export already above the ceiling remains feasible and
   gains no battery-driven excess.

Focused integration and SDK-boundary coverage must establish:

7. A battery with no solar can configure export pricing, opt in, charge and export
   through the existing executor and actuator; the default sends no export intent.
8. Changing measured household demand or PV constrains the next decided setpoint.
   Reaching reserve or withdrawing export permission stops discretionary export.
9. Battery export supplies neither the solar-surplus pool nor extra admission or
   pending-relief credit. Import/capacity limits and task priorities still apply.
10. Missing/expired export quotes stop discretionary export and retain a usable
    household-only plan. If that baseline is unavailable too, existing waiting
    and recovery rules apply. Meter outages, restart, nonresponse and manual
    takeover follow existing ownership/recovery.
11. Turning export off retains continuous ownership; turning continuous planning
    off hands back under the existing hold policy. Simulation sends no writes.

UI checks cover explicit opt-in and ceiling, a battery-only home, the household
fallback reason, estimated comparison units and observed-versus-planned activity
at 320/480 px in both host themes. Choose the existing focused npm entrypoints
from `notes/testing-taxonomy.md`; hooks and CI own broader suites.

The user-facing feature is complete when these owner contracts, controls,
explanations and focused regressions are implemented. The hidden stage changes
diagnostics only; export authorization and execution remain future work.
