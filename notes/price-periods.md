# Price periods — why the level follows the quarter

**Status:** design of record. Owner ruling 2026-09-16, implemented across two PRs
(#2429 stores periods; this one makes the level follow them).

## The fact that forced this

A Homey Energy zone can publish prices per 15 minutes rather than per hour. Verified
against a live zone on 2026-09-15 (NO3): `pricesPerInterval` carries 96 distinct
quarters for one day — each listed twice, identically — where an hourly zone sends 24.

Quarter prices are not noise around their hour:

| Day (NO3) | Worst hour | Quarters | Spread vs the hour's own average |
|---|---|---|---|
| 2026-09-14 | 03:00 | 1.042 / 1.107 / 1.230 / 1.418 | last quarter +18% |
| 2026-09-12 | 08:00 | 1.382 / 1.320 / 1.204 / 1.085 | falls 21% across the hour |

Across four sampled days, **6 to 9 hours of every day** contained at least one quarter
whose cheap/normal/expensive verdict differed from its own hour's.

## The ruling

**The price level follows every period, with no damping.** Not a minimum hold, not a
"starts at a quarter, ends on the hour" rule — the level is what the price is now.

The owner accepted the cost when choosing this: up to four setpoint writes an hour per
price-aware device, four `price_level` trigger firings, and four insights updates,
against the previous one per hour. That matters most for cloud-connected thermostats
(see `project_myuplink_write_failures` — myUplink writes can take 22–60 s). If that
pressure turns out to hurt in production, the fix is a minimum hold on the *level*, not
a return to hourly prices.

## What did NOT change

Everything that reasons in whole hours still gets whole hours, because the hour is the
shape of what it reasons about:

- the capacity controller, whose independently configured period is hourly or
  a Belgian 15-minute peak;
- the daily budget, which fills hourly buckets;
- smart tasks, which claim hours;
- the owner's lowest-price Flow cards, whose arguments count hours;
- the `pels_prices_json` export tag, a documented 23/24/25-entry-per-day contract;
- the price charts.

`lib/price` serves those from `getCombinedHourlyPrices()` and the level from
`getCombinedPricePeriods()`. The two series are separate types so a period series
cannot be handed to an hour-shaped consumer by accident.

## Open question, deliberately not answered here

If a single sub-hour period is dropped at the persisted read boundary (junk duration or
price) while the rest of its hour survives, nothing covers those 15 minutes and the
level resolves `UNKNOWN` for them — the temperature shift drops out and `price_level`
fires to Unknown and back. Under the old hourly projection the hour's other quarters
covered that gap. It needs a ruling (fall back to the containing hour, or hold the last
level) rather than falling out of an implementation detail. Not reachable from a payload
PELS itself wrote, which is why it did not block the change.
