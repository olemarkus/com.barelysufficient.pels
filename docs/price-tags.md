---
title: Price Tags in Flow and HomeyScript
description: Subscribe to PELS adjusted hourly prices from Homey Flow or HomeyScript using the price_list_updated trigger and its prices_json token.
---

# Using PELS price tags in Flow and HomeyScript

PELS publishes its **adjusted** electricity prices — the all-in price you see inside the app, i.e. spot + grid tariff + provider surcharge + tax + VAT + electricity support + Norgespris adjustment, depending on your configuration — as a single global Flow tag, with a matching trigger card so flows can also react when the data changes. Both surfaces carry the same JSON payload from the same publisher; pick whichever fits your flow:

- **Global tag** — read at any time from any Flow or HomeyScript. Use for scheduled flows ("every day at 06:00, pick cheapest hours") and on-demand reads.
- **Trigger card** — fires when the content meaningfully changes. Use for event-driven flows ("when tomorrow's prices arrive, do X").

## Global tag

**PELS price list JSON** (`pels_prices_json`, type: string):

```json
{
  "today":    [74.2, 69.8, 65.1, 64.0, 70.5, ...],
  "tomorrow": [70.5, 68.0, ...],
  "unit": "øre/kWh"
}
```

- `today` / `tomorrow` — adjusted hourly totals indexed by local hour. Array length is the day length (23, 24, or 25 across DST transitions). When a source publishes data sparsely (allowed for the Flow and Homey schemes), the missing hour slots are `null` so per-hour lookups stay correct — skip nulls when summing or filtering.
- `tomorrow` is `[]` until day-ahead prices arrive — check `tomorrow.length > 0` before iterating.
- `unit` — the unit PELS uses internally. Norway scheme is `øre/kWh`; the Homey / Flow schemes use whatever the source provides. Always read this field rather than assuming a currency.

## Trigger card

**PELS price list was updated** (`price_list_updated`) fires when the exported price content meaningfully changes — when tomorrow's prices arrive, when grid tariffs are re-fetched, when Norgespris-adjusted amounts shift, at local midnight when today rolls forward. Identical refreshes do not fire it.

Local token: `prices_json` (string) — the same payload as the global tag.

## Example (paste into a HomeyScript) — pick the N cheapest upcoming hours before a deadline

This script uses HomeyScript-only APIs (`Homey.flowtoken`, top-level `await`, `console.log()`). Paste it into a HomeyScript in the HomeyScript app or IDE — then reference that script from a Flow's "Run code" card. It will not run as a plain Node script.

The HomeyScript `tag()` helper only resolves Homey Logic variables and built-in tokens — it does **not** read app-published flow tokens. To read PELS' price tag from a script, call `Homey.flowtoken.getFlowTokenValue({ id })` with the fully-qualified token id and unwrap `.value`.

```javascript
const result = await Homey.flowtoken.getFlowTokenValue({
  id: 'homey:app:com.barelysufficient.pels:pels_prices_json',
});
const data = JSON.parse(result.value);

// Tomorrow at 07:00 local time
const deadlineDate = new Date();
deadlineDate.setDate(deadlineDate.getDate() + 1);
deadlineDate.setHours(7, 0, 0, 0);
const deadline = deadlineDate.getTime();

const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
const startOfTomorrow = startOfToday.getTime() + 24 * 3600 * 1000;

const upcoming = [];
data.today.forEach((price, hour) => {
  if (price === null) return;
  const time = startOfToday.getTime() + hour * 3600 * 1000;
  if (time >= Date.now() && time < deadline) upcoming.push({ time, price });
});
data.tomorrow.forEach((price, hour) => {
  if (price === null) return;
  const time = startOfTomorrow + hour * 3600 * 1000;
  if (time >= Date.now() && time < deadline) upcoming.push({ time, price });
});

const cheapest = upcoming.sort((a, b) => a.price - b.price).slice(0, 3);
console.log(`Cheapest hours (in ${data.unit}):`);
for (const e of cheapest) console.log(`  ${new Date(e.time).toISOString()} — ${e.price.toFixed(2)}`);
```

## Notes

- The token value is standard JSON — double-quoted keys and strings, no trailing commas, no single quotes. In HomeyScript, `Homey.flowtoken.getFlowTokenValue({ id })` returns an object whose `.value` field is the JSON string; pass that to `JSON.parse` directly. In Flow, drop `[[prices_json]]` into a card argument and Homey substitutes the JSON string at execution time.
- Prices are **post-adjustment**. Grid tariff, VAT, Norgespris, etc. are already baked into each number — there is no separate component breakdown in this payload.
- Apply your own cheap/expensive thresholds (percentile, "lowest N hours", below-average, …) directly on the arrays. PELS' internal classification is intentionally **not** exported; choose the policy that suits your flow.
- On DST fall-back days the day array contains 25 entries; on spring-forward, 23. Iterate by index; don't assume 24.
- The publisher dedups by content fingerprint, so the tag is rewritten and the trigger fires only when the price content meaningfully changes. The fingerprint is in-memory, so the first publish after an app restart always fires the trigger once — even when the content hasn't changed from the prior session.
