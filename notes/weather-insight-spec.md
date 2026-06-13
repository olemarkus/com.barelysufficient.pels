# Weather insight — UI copy and state spec (design of record)

Design-of-record for the weather-insight surface (PR 3 of the
weather-advisor plan). The feature ships default-off but is now enableable from
the UI: the Settings nav card is always visible and its sub-page carries a
master on/off switch (the feature gate). Runtime/data design lives in the plan notes; this file
owns the user-facing surface: surface map, card layouts, exact state copy
(S1–S8), formatting rules, and the chart marker grammar. All strings live in
`packages/shared-domain/src/weatherInsightCopy.ts`; UI components must consume
those helpers, never inline copies, so future runtime logs can quote the same
words.

User-facing feature name: **Weather insight**. Never "model", "regression",
"fit", "R²", "HDD", or "Theil–Sen" anywhere in copy. Confidence is words, not
numbers, reusing the smart-task vocabulary (`Estimating` / `Refining` / no
chip). Remedies name the daily budget, never the hard cap (the cap is
physical). The suggested budget is display-only — `Adjust budget` opens the
normal Adjust flow with **nothing prefilled**.

---

## 1. Surface map

| Surface | What renders (flag on) | Why here |
|---|---|---|
| Budget page, plan view | One card appended after the chart card: the **Tomorrow card** (prediction + suggested budget + verdict). In pre-ready states the same slot renders the setup / backfill / learning card instead. | Budget's mission is "where will I land". Tomorrow's predicted kWh vs the daily budget is a landing question. Not Overview (protects persona 1's one-glance hero), not Usage (retrospective). Appended last so the existing hero → warning → confidence → chart order is untouched. |
| Budget page, `localView: 'weather'` | The **Weather insight detail view**: summary sentence card, "Your home in numbers", scatter + coverage band, device footer. Header per the Budget-Adjust precedent: eyebrow `Budget`, headline `Weather insight`, outlined `Done` returning to plan. | The tinkerer's exploration surface; reuses Budget's existing local-view mechanism, page count stays zero. |
| Settings | An always-visible **Weather insight** nav card → a dedicated sub-page. The sub-page always renders a master on/off switch (the feature gate); when off it adds a payoff-led pitch, when on it adds the two device pickers (native `select` + `.field`, `/homey_devices`) and a `See tomorrow's outlook in Budget` cross-link. The Budget setup card deep-links here via `data-settings-target`. | Device configuration is a Settings concern everywhere else in PELS; the master switch is the discoverable way to turn the feature on without the CLI. |
| Overview / Usage / Smart tasks / widgets / notifications | Nothing. | Deliberate — v1 makes zero claims on shared real estate. |

When the feature is off: structural absence on Budget/Overview/Usage/etc. — no
weather DOM ids, no hidden cards, no Budget Tomorrow card. The **exception** is
the Settings sub-page, which is always reachable and renders the master switch
(off) + the pitch, so the feature can be turned on from the UI. The Budget
cross-link is hidden while off. Playwright guards both the off and on states.

**Navigation:** Budget plan → Tomorrow card → `Weather details` →
`localView='weather'` → `Done` → plan. Budget plan (no device yet) → setup
card → `Choose temperature device` → Settings, Weather insight section.
`budget-weather` is a virtual `data-settings-target` (parity with
`budget-adjust`) that opens the Budget tab with the weather view active.

---

## 2. Formatting rules (apply everywhere)

| Quantity | Format | Example |
|---|---|---|
| Daily kWh | whole number when ≥ 10, one decimal below | `47 kWh`, `8.5 kWh` |
| Expected range (q10–q90) | whole kWh, en dash | `41–52 kWh` |
| Per-degree extra | one decimal, leading `+` | `+1.8 kWh/day` |
| Slope range (Sen CI, never called that) | sentence form | `Usually between +1.5 and +2.1 kWh per degree.` |
| Balance temperature | whole °C, `≈` prefix | `≈ 13 °C` |
| Forecast temp | whole °C | `2 °C` |
| Heat loss | nearest 10 W | `≈ 150 W per °C` |
| Days | exact integer | `Based on 287 days` |
| Negative numbers | U+2212 minus | `−8 °C` |
| Confidence | chip words only: low = `Estimating`, medium = `Refining`, high = no chip; learning tier = dedicated card state, no chip. Never a percentage. | — |

---

## 3. Cards

### Tomorrow card (Budget plan view)

```
┌──────────────────────────────────────────┐
│ Tomorrow: around 2 °C          [chip?]   │  h3 plan-card__title
│ Forecast for tomorrow’s average          │  pels-card-supporting
│ ──────────────────────────────────────── │
│ Expected usage              41–52 kWh    │  budget-setting-row
│ Suggested daily budget      54 kWh       │  budget-setting-row
│ Your daily budget           50 kWh       │  budget-setting-row
│ ──────────────────────────────────────── │
│ Tomorrow may be tight — a cold evening   │  verdict paragraph
│ could use the whole budget.              │
│ [Adjust budget]        [Weather details] │  text buttons
└──────────────────────────────────────────┘
```

- Title carries the temperature: `Tomorrow: around 2 °C`.
- Source line, by producer-resolved `forecastStatus` (one field on the readout
  payload, valid in every state):
  - `forecast`: `Forecast for tomorrow’s average`
  - `recent_no_device`: `If recent weather continues — no forecast device set.` (S7a)
  - `recent_device_unreadable`: `Forecast device isn’t reporting tomorrow’s temperature — using recent days.` (S7b)
- `Suggested daily budget` is the q80-headroom figure, clamped [20, 360],
  capped by capacity. Informational only.
- Verdict line (exactly one, current budget vs prediction quantiles):
  - current ≥ q90: `Your budget covers tomorrow with room to spare.` (ok)
  - q80 ≤ current < q90: `Your budget should cover tomorrow.` (ok)
  - q50 ≤ current < q80: `Tomorrow may be tight — a cold evening could use the whole budget.` (warn)
  - current < q50: `Tomorrow likely needs more than your budget. PELS will hold managed devices back to stay inside it.` (warn)
- Optional chip (one max): `Rough estimate` for colder-than-observed or drift,
  with a reason line (S6/S8).

### Detail card 1 — summary sentence

- Headline: `Your home uses about 23 kWh on a warm day, and about 1.8 kWh
  more for each degree below ≈ 13 °C.`
- Subline: `Based on 287 days over the last year.`
- Yesterday line from the residual: within the typical band →
  `Yesterday: 47 kWh — about what’s typical for 3 °C.`; above →
  `Yesterday: 53 kWh — 6 kWh more than typical for 3 °C.`; below →
  `… 4 kWh less than typical for 3 °C.` (Today is never judged — incomplete.)
- Chip rail: `Estimating` (low) / `Refining` (medium) / none (high).

### Detail card 2 — "Your home in numbers"

Rows (reuse `budget-settings-list` / `budget-setting-row`):
`Warm-day usage  ≈ 23 kWh/day` · `Each degree colder  +1.8 kWh/day` ·
`Heating kicks in below  ≈ 13 °C`. Supporting line names the backfill when
backfilled days contribute: `Based on 287 days, backfilled from your usage
history.` `▸ More detail` expander (`<details>`, BudgetConfidenceCard
pattern): `Usually between +1.5 and +2.1 kWh per degree.`; curvature note
(only when flagged): `Usage rises faster on the coldest days — common for
heat pumps.`; caveated heat loss (never a headline): `Rough heat loss:
≈ 150 W per °C of indoor–outdoor difference. Treat as a ballpark — it assumes
electric heating covers all heat loss; with a heat pump the true figure is
higher.`

Row labels deliberately avoid `Base load` (collides with `Background usage`)
and `sensitivity` (jargon-adjacent).

### Detail card 3 — scatter + coverage

- Title `Usage and outside temperature`, subtitle `Each dot is one day from
  the last year.` Legend: `● One day · ─ Estimate · ○ Tomorrow`.
- ECharts scatter (SVG), temperature **value axis** × kWh/day, height ~220 px,
  no zoom/pan, 3–4 y ticks, x ticks every 10 °C as `−10°  0°  10°  20°`.
- Server-decimated: 1 °C bins (count-weighted symbol size) + raw last ~90
  days. Recent 14 days in accent at full opacity; yesterday largest solid dot.
  Quality-flagged (`partial`/`unreliable`) days dimmed; `backfilled` days
  render normally (they are good data). Today is never plotted.
- Fit line: accent 2 px, sloped below the balance point, flat at warm-day
  usage above it. Winter-only: sloped segment only across the observed range,
  no flat segment, no balance tick. Uncorrelated: no line (flat cloud is
  self-explanatory).
- Balance-point marker: thin vertical tick (marker grammar: thin tick =
  threshold) with micro-label `≈13°`; tooltip `Below about 13 °C, heating
  pushes usage up.` Drawn as a line series (not `markLine`).
- Tomorrow marker: hollow dot (hollow = projected) on the line at the
  forecast temp; tooltip `Tomorrow ≈ 2 °C — expect 41–52 kWh.`
- Dot tooltip: `12 Mar · 4 °C · 44 kWh`, suffixed `· partial day` when
  flagged. Bin tooltip: `Around 4 °C: typically 41–49 kWh (12 days)`.
- **Coverage band**: token-styled HTML strip under the chart (not a chart),
  5 °C bins from observed min to max (extended one bin if tomorrow falls
  outside). Three shades by usable-day count: solid (≥ 14), light (4–13),
  outline (≤ 3). Tomorrow's hollow dot repeats on the band. Caption:
  `Solid from −5 °C to 15 °C.` + at most one edge sentence: `Few days colder
  than −5 °C — estimates there are rougher.` Legend line: `Darker = more days
  measured.`

### Detail card 4 — device footer

One muted row: `Temperature: Outdoor sensor · Forecast: Yr` + text button
`Change in Settings` (deep-link). Both halves are producer-resolved:
- Temperature: device name; `not set` when no outdoor device is configured;
  `not responding` when one is configured but its name couldn’t be read.
- Forecast (by `forecastStatus`): name when reporting; `none — using recent
  days` when no device is configured; `<name> isn’t reporting — using recent
  days` when a device is configured but silent.

### Settings section — device pickers + live validity

The **Weather insight** Settings sub-page (reached via the always-visible
Settings nav card or the Budget setup card's deep-link) leads with the master
on/off switch; once on it shows the two native `select`
pickers, each **hard-filtered to temperature devices**: `/homey_devices` exposes
`hasTemperature` (a bare `measure_temperature` capability) and the picker lists
only those, so a guaranteed-broken non-temperature pick isn't even offered. A
device exposing temperature only on a sub-capability is **excluded** here (no
bare `measure_temperature`), so it never reaches the picker; when the filter
leaves nothing, the section shows an explicit empty state. The live validity line
below is the backstop for devices that DO pass the filter but still fail to
deliver a readable value at runtime. Each picker is followed by that
producer-resolved **live validity line** so a chosen device confirms itself
instead of making the owner wait ~21 days. The producer
resolves `outdoorReading` / `forecastReading` on the payload from an INSTANT
on-demand read of each device's bare `measure_temperature` (done in the
assembler — the collector's cached sample is cleared on the restart a selection
change triggers, so it can't be trusted right after a pick). Three states per
picker:

- **reading** — accent line. Outdoor: `Reading 4 °C now`. Forecast: `Reading tomorrow ≈ 2 °C`.
- **unreadable** — `.field__hint--alert` warning line, self-contained (the static
  hint is hidden once a device is selected). Outdoor: `PELS can’t read a temperature
  from this device — pick one that reports temperature on its main reading.`
  Forecast: `This device isn’t reporting tomorrow’s temperature on its main reading — using recent days for now.`
- **no_device** — no line; the static picker hint shows instead.

The reading is checked per-picker against the current selection, so a just-changed
device shows its hint (not the previous device's reading) until the re-fetch lands.

The line is suppressed (hint shows) until a readout matching the CURRENT selection
arrives, so a just-changed device never shows the previous device's reading.

---

## 4. States (exact copy)

**S1 — flag on, no temperature device.** Budget-page card (replaces the
Tomorrow slot); detail view unreachable.
> Title: `Weather insight`
> Body: `PELS can learn how outside temperature drives your daily usage, and predict tomorrow’s total. Pick the device that measures outdoor temperature to start.`
> Button: `Choose temperature device` (→ Settings section)

**S2 — backfill running.** Same slot.
> Title: `Reading your history…`
> Body: `Matching the past year of your usage with past temperatures. This runs once and can take a few minutes the first time.`
> Liveness cue: an indeterminate `md-circular-progress` spinner (accent) under
> the body, so a slow single-fetch run reads as progress, not a freeze. The
> backfill has no incremental counts, so the spinner is indeterminate (no
> percentage / "Checked N of 365 days" line).

**S3 — learning (< 21 usable days).**
> Budget card: title `Learning your home`, body `PELS has 9 days of usage and temperature so far. The first estimate appears after about 21 days.` Button: `Weather details`.
> Stuck note (warn, `.field__hint--alert`) when the configured outdoor device
> reads `unreadable`: `PELS can’t read your outdoor device right now — if this keeps up, learning will stall. Check it in Settings.`
> Conditional wording because the trigger is a single live read that may be a
> transient miss — it must not assert the feature is broken on one failed read.
> Detail view: summary and numbers cards hidden; scatter card renders with
> whatever dots exist, subtitle swapped to `Each dot is one day. Estimates appear after about 21 days.`
> The visibly filling scatter is the comeback hook.

**First-estimate arrival.** The first time a `ready` readout is seen ON THE BUDGET
TAB (where the outlook is visible), a one-time `ok`-tone toast fires:
`Weather insight is ready — here’s tomorrow’s outlook.` Persisted behind a UI-only
`weather_advisor_first_estimate_seen` key (written before the toast; the in-session
flag is monotonic) so it fires once, never on the Settings sub-page.

**S4 — winter-only data (balance temperature not identifiable).**
> Summary headline: `On a day around 0 °C your home uses about 52 kWh, and about 2.1 kWh more for each degree colder.`
> Numbers card: `Each degree colder  +2.1 kWh/day`; `Heating kicks in below  Not clear yet`; `Warm-day usage  Not clear yet`; supporting line: `PELS has only seen days below 8 °C so far. Cold-weather estimates are solid; warm-weather numbers will fill in as the season turns.`
> Scatter: sloped segment only, no flat segment, no balance tick. Coverage
> band shows only cold bins shaded.

**S5 — usage doesn't track temperature (slope ≤ 0).**
> Detail summary card: `Your usage doesn’t follow the weather. Across 214 days, colder days don’t use noticeably more energy — normal for homes without electric heating.`
> Numbers card and coverage hidden; scatter shown.
> Tomorrow card: temp line unchanged; `Expected usage 28–34 kWh` with supporting `Based on your recent days.` Suggestion and verdict still render (from the recent-day distribution).

**S6 — drift detected.**
> Detail summary subline (warn tone): `Recent days run about 5 kWh/day above what’s typical for the temperature. If something changed — a new device, guests, heating settings — the estimate will catch up over a few weeks.`
> Tomorrow card adds one supporting line: `Recent days ran higher than usual, so the range is wider.` (+ `Rough estimate` chip)

**S7a — no forecast device (persistence fallback).**
> Tomorrow card title: `Tomorrow: around 4 °C`; supporting line: `If recent weather continues — no forecast device set.`
> Detail device footer: `Forecast: none — using recent days` + `Change in Settings`.

**S7b — forecast device configured but not reporting (persistence fallback).**
> A forecast device is set, but PELS can’t read tomorrow’s temperature from it
> (e.g. a Yr device exposing its forecast on a sub-capability). The prediction
> falls back to recent days — but the copy must NOT claim no device is set.
> Tomorrow card supporting line: `Forecast device isn’t reporting tomorrow’s temperature — using recent days.`
> Detail device footer: `Forecast: <name> isn’t reporting — using recent days`.
> Settings forecast-picker hint: `Optional. Point this at a device that reports tomorrow’s outdoor temperature on its main temperature reading — a Yr “next 24 hours” device works. If PELS can’t read a forecast, it uses your recent days instead.`

**S8 — colder than anything observed.**
> Tomorrow card chip: `Rough estimate`; reason line: `Tomorrow looks colder than any day PELS has measured — the range is wider than usual.`
> If combined with the short verdict, the verdict already names the
> consequence, and the remedy stays the daily budget — never the hard cap.

Failure/uncertainty paths must render visually distinct (warn-tone chip or
subline), never a happy chart over bad data. A fetch failure renders its own
quiet error card (`Weather insight isn’t available right now.`) rather than an
empty slot.

---

## 5. Marker grammar

| Marker | Meaning |
|---|---|
| Solid dot | Actual (one measured day; yesterday largest) |
| Hollow dot | Projected (tomorrow) |
| Solid line | Estimate (typical usage at a temperature) |
| Thin vertical tick | Threshold (`≈13°` — heating starts) |
| Band shade (dark → light → outline) | Coverage (more days → fewer days) |

---

## 6. What not to build (deliberate)

1. Auto-applying the suggested budget (or a one-tap "apply suggestion").
2. W/K heat loss as a headline number — caveated expander row only.
3. Percentage confidence or any goodness-of-fit number.
4. Confidence-band shading on the scatter (mud at 320 px) — uncertainty
   surfaces as the text range and the Tomorrow band.
5. Cost prediction for tomorrow (prices partial until ~13:00).
6. Anything on Overview (chip, hero subline, widget, notification).
7. Scatter controls (date filters, season toggles, zoom, overlays).
8. Manual model overrides (editable balance point, excluded days).
9. Weather notifications.
10. "Compare with similar homes."

Documented future follow-ups: deep-link from a budget-overshoot postmortem
(persona 5), money on the Tomorrow card once same-evening price completeness
exists (persona 4). The UI enable switch (master switch on the sub-page) has
shipped; remaining pre-promotion polish lives in `TODO.md`.
