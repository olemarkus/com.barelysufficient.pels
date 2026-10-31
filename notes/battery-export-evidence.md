# Battery export: evidence and scope assessment

Research date: 2026-10-31. Assesses the proposed
[`battery-export-arbitrage.md`](./battery-export-arbitrage.md). “Covered”
below means specified behavior, not a claim that implementation is complete.

The sources support optional day-ahead battery export. They also establish
distinct preferences that a single cost-minimizing policy does not satisfy.
The proposed feature covers profitable household-aware arbitrage; it does not
cover every meaning of “household first” or every product sold as battery trading.

## Original discussion evidence

| Primary source | Verified need | Fit to proposed behavior |
| --- | --- | --- |
| [Home Assistant question, 2023-09-27](https://community.home-assistant.io/t/pull-cheapest-electricity-price-for-template-sensor-solar/619190) | A Danish owner wants cheap grid charging followed by selling only when worthwhile, explicitly distinguishing the purchase tariff from the export payment. | Covered: distinct marginal prices, losses, wear and the complete-plan comparison answer this need. The thread establishes a request, not a working installation or measured savings. |
| [Dutch owner discussion, retrieved 2026-10-31](https://www.reddit.com/r/thuisbatterij/comments/1ths27b/thuisbatterij_opbrengsten_handel/) | One participant uses Day Ahead Optimizer for batteries and two EVs. Another explicitly prioritizes household consumption and a plug-in hybrid before selling the remainder, and emphasizes charge/discharge power limits. | Partial: PELS preserves Smart-task commitments and models household demand, but can sell energy and later buy replacement household energy when cheaper. That is an economic preference, not a strict self-consumption-first policy. |
| [SlimLaden release 9.7.0, 2026-08-15](https://community.homey.app/t/app-pro-slimladen-thuis-auto/140156/6218) | The developer adds a minimum predicted daily trading profit with self-consumption/solar fallback, plus extra overnight energy retained only by restraining sales. The latter does not trigger extra grid charging. | Partial: PELS supplies a household-only fallback and configured reserve. It explicitly excludes the daily threshold; a static minimum reserve is not the same as an additional forecast-relative overnight buffer. |

The Dutch discussion mixes day-ahead optimization, supplier-controlled products
and claims about imbalance revenue. Its financial anecdotes cannot validate
PELS savings or the economics of the excluded balancing-market category. The
retrieved page displayed relative dates, so no exact publication date is inferred.
These public discussions are qualitative evidence, not population estimates.

## What comparable applications actually offer

### SlimLaden

The [developer's product description](https://slim-laden.app/info), retrieved
2026-10-31, describes quarter-hour replanning from price, solar and household
forecasts, EV deadlines, household-following operation, battery exclusions for
selected appliances and mixed-brand batteries. Solar is optional. This supports
the proposal's battery-only home requirement and coordinated demand model.

The [Homey store listing](https://homey.app/nl-nl/app/com.energyprices.app/SlimLaden-Thuis-%26amp%3B-Auto/)
reported version **9.9.62** when read. It presents profit and self-consumption
planning as different choices, learned consumption and efficiency, financial
history, and an adjustable minimum daily profit. Its current Flow description
gives a 05:15 daily threshold evaluation; the older 9.7.0 announcement gives
06:30. Use the dated release as historical evidence, not current scheduling
documentation. The store also exposes an inventory/transaction reset, establishing
that its accounting scope exceeds the proposed estimate-only PELS comparison.

No SlimLaden package was downloaded or executed for this assessment. Public
documentation establishes advertised choices; it does not establish its optimizer,
runtime correctness, or measured economic advantage.

### Power by the Hour

Inspected the public repository at commit
[`64bc7ff82a938e74ee41d98813aa9d5c9302de9e`](https://github.com/gruijter/com.gruijter.powerhour/tree/64bc7ff82a938e74ee41d98813aa9d5c9302de9e),
dated 2026-10-02; its package declares **8.19.0**. No package was installed or run.

Its [TradeStrategy](https://github.com/gruijter/com.gruijter.powerhour/blob/64bc7ff82a938e74ee41d98813aa9d5c9302de9e/lib/strategies/TradeStrategy.js)
selects buy/hold/sell through a bounded peak/trough search, using a minimum price
spread and terminal inventory value. Its separate
[RoiStrategy](https://github.com/gruijter/com.gruijter.powerhour/blob/64bc7ff82a938e74ee41d98813aa9d5c9302de9e/lib/strategies/RoiStrategy.js)
uses linear programming with separate import/export prices, charge/discharge
efficiencies, a throughput cost derived from `minPriceDelta`, fixed household
baseload and terminal salvage value. It can compress periods to cap model size.
Missing export prices fall back to import prices in these functions.

This is source-level evidence about those functions, not a complete execution-path
audit. PELS should retain its explicit quote-completeness rule, native period
durations and household-only counterfactual. Another app using linear programming
does not establish a need to replace PELS's one-battery dynamic program.

### Predbat

The [configuration guide](https://springfall2008.github.io/batpred/configuration-guide/),
retrieved 2026-10-31, distinguishes charge-only operation from charge-and-export,
accounts for conversion losses, exposes a cycling cost and an export improvement
threshold, and includes EV demand. It also describes suppressing otherwise
economic cycling within cheap windows when the owner's tariff requires it.

Its [configuration reference](https://springfall2008.github.io/batpred/apps-yaml/)
distinguishes modeled inverter export limits, forced-export discharge-rate caps
and battery-export permission while preserving household supply and solar export.
PELS's proposed Main-meter ceiling is its own feedback-control contract; it should
not be described as equivalent to an inverter-enforced connection limit.

These are moving documentation pages, not a tested Predbat release. The repository
head at retrieval was `12feb642fe50995a21ad0610721db7a8f2557798`, dated 2026-10-30;
the deployed documentation's exact build commit was not established.

### EMHASS

The [official concepts documentation](https://emhass.readthedocs.io/en/latest/main_core_concepts.html),
served as **0.18.7** on retrieval, explicitly separates maximizing net import/export
value, minimizing import spending, and minimizing grid interaction. It describes
forecast-based battery and deferrable-load planning with repeated replanning.
That distinction reinforces the main product decision: economic optimization
and strict self-consumption are different objectives, even with identical hardware.

## Scope decisions and requirements

1. **Keep the economic objective explicit.** The feature minimizes forecast net
   energy cost while protecting reserve and existing commitments. Do not promise
   “use your own energy first” as a strict ordering. If that ordering is required,
   specify a separate policy constraint before implementation; merely increasing
   wear cost does not express it.
2. **Preserve the supported core.** Distinct settled prices, efficiency, wear,
   household demand, native periods, power limits and equal terminal energy are
   substantive requirements supported by the evidence. Retain the usable
   household plan when selling lacks complete quotes.
3. **Treat selective trading as a product choice.** SlimLaden and Predbat expose
   controls that can reject small positive benefits. The proposal intentionally
   accepts any benefit above numerical tolerance after wear. It covers rational
   modeled cost reduction, but not an owner's minimum reward for extra activity.
   Do not add a daily threshold implicitly or use inflated wear as a substitute.
4. **Distinguish reserves.** Existing minimum SoC protects a fixed amount. A buffer
   above forecast overnight consumption, applied only to selling, is a separate
   behavior and is not delivered by the current spec.
5. **Keep contract and accounting scope bounded.** Annual netting, nonlinear fees,
   supplier settlement adjustments, imbalance markets and realized trading profit
   are excluded. An input tariff must already express the marginal import cost
   and export payment applicable to dispatch. These sources do not establish
   that a simple tariff model is sufficient for every supplier contract.
6. **Do not infer superiority from peer feature lists.** Different terminal-value
   policies, forecasts, hardware and constraints produce different schedules.
   A larger predicted saving is not a comparable benchmark without common inputs
   and an identical counterfactual. Equal terminal energy deliberately excludes
   some profitable inventory liquidation near the horizon boundary.

The evidence supports implementing this as an extension of the existing battery
owner and planner. None of the verified use cases requires a second controller,
an inventory ledger, or a replacement optimizer for the proposed first version.
Strict household-first behavior and forecast-relative reserves would be additional
policy scope; fleet dispatch and market participation would be materially larger
architectural work.
