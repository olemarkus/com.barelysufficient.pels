# Smart Task Flow Cards — Design Rationale

The smart-task trigger cards were redesigned around three decisions: **one
trigger per lifecycle event** (no dropdown filter args), **stable-id tokens
treated as public API** (not localizable display labels), and **condition cards
for filtering**. The original cards forced either one-flow-per-filtered-value or
the `any` option, and emitted display labels that downstream logic had to
compare as English strings. This note is the design-of-record for *why* the
cards are shaped this way and the stable token contract they expose.

**Status:** shipped (2026-05-15), then trimmed (2026-05-15, again 2026-05-18)
after comparing token counts against installed Homey apps (Easee, Home Connect,
myUplink, Power by the Hour). The "stable-id + display-label" duo, the
composed notification text, and the diagnostic-grade introspection tokens
(`risk_reason`, `planned_start/finish_local_time`, `required_kwh`,
`planning_speed_kw`, `estimated_duration_text`) had no equivalent in any other
app — convention is "trigger emits the thing that changed, full stop." The
per-card target shape in this note therefore overshot; delivered shape is the
minimum below.

**Composing notification text is the flow author's job, not PELS's.** We do
not emit a pre-baked `notification_text` (or `target_text` / `shortfall_text`
formatted strings shaped for one) on any trigger. Reasons: every other Homey
app pushes that composition to the flow (Logic / text concatenation); a
pre-baked English string locks out localisation; and the additional token
surface is a maintenance liability against a contract we actively discourage.
If a future need arises, revisit by changing this rule explicitly — do not
re-add the token quietly.

**Delivered token bag (minimum):**

- `deadline_ended` — `device_name` (string), `outcome` (string, stable
  lowercase id: `succeeded` / `missed` / `abandoned`), `shortfall`
  (number, 0 when succeeded; flow UI label "Gap to target"),
  `shortfall_known` (boolean — false when the device-side delta was not
  observable and `shortfall` fell back to 0; gate numeric comparisons on it).
- `deadline_status_changed` — `device_name` (string), `status` (string,
  stable lowercase id: `waiting` / `on_track` / `at_risk` /
  `unachievable` / `satisfied`).
- `deadline_plan_changed` — `device_name` (string), `remaining_kwh`
  (number), `planned_hours` (number), `projected_finish_local_time`
  (string). Trigger title is "Smart task schedule changed".

The stable lowercase token values stay a public API contract; renaming
one is a breaking change. Display formatting (e.g. capitalised "Missed")
is composed in the user's flow via Logic / text concatenation — same
convention every other Homey app uses.

If flow authors need diagnostic detail (`risk_reason`, planned start /
finish, charging rate, estimated duration), the future home for those is
**device capabilities** on the PELS device, surfaced via standard
`<capability>_changed` triggers — not as trigger tokens.

The shared token-bag implementation lives in
`flowCards/smartTaskTokens.ts`; the previous `flowCards/deadlineEndedTokens.ts`
was folded into it.

## Cards in scope

| Card | Kind | Today |
|---|---|---|
| `deadline_ended` | trigger | `outcome` dropdown arg + display-label tokens |
| `deadline_status_changed` | trigger | `status` dropdown arg + display-label tokens |
| `deadline_plan_changed` | trigger | no dropdown; tokens incomplete |
| `deadline_status_is` | condition | `status` dropdown arg |
| `has_active_deadline` | condition | shipped, no change needed |
| `set_temperature_deadline`, `set_ev_charge_deadline`, `clear_deadline` | action | not in scope (separate token list) |

## Design rules

### Rule 1 — One trigger per lifecycle event, no filtering args

Drop the `outcome` and `status` dropdown args from the trigger cards. The
trigger fires for every lifecycle change; users filter downstream with a
condition node on the stable-id token.

Cost: filtered flows gain one condition node. Benefit: single trigger to
maintain, and compound logic (e.g. "missed AND kind=ev_soc") works without
registering multiple triggers.

### Rule 2 — Stable id tokens (display-label duo trimmed)

Each enum value gets a **`<name>`** token (or just `<name>`) carrying the
stable lowercase id — public-API contract, never renamed without a deliberate
breaking-change call. Originally this rule paired each id with a localized
display-label companion (`<name>` for id, `<name>_label` for display); the
companion was trimmed after comparing against other Homey apps (Easee, Home
Connect, myUplink, Power by the Hour), which all surface only the id and
push display formatting into the user's Logic / text step. The current
shipped triggers therefore emit `outcome` / `status` as stable ids only, with
no display-label sibling.

### Rule 3 — Numeric tokens for values users want to compare or compute

Today, `target_text`, `shortfall_text`, etc. are pre-formatted strings.
Expose the underlying numbers as separate tokens so flows can do math
(`if shortfall > 5: warn loud`) without parsing strings. Shipped
example: `deadline_ended` emits a `shortfall` number token rather than a
`shortfall_text` string. Apply the same pattern when extending the other
triggers.

### Rule 4 — Notification text composition stays in the user's flow

PELS does not emit a composed `notification_text` token on any trigger, and
does not emit "_text" tokens whose only purpose is to feed one. Composing a
push body from the underlying tokens is the flow author's job — same as every
other Homey app. This avoids locking out localisation and avoids a token
contract whose stability we'd have to defend across copy revisions.

## Per-card target shape (rejected expansion — kept as backlog)

The original full-fat per-card token lists (the `*_value` / `*_unit` /
`*_local_time` / `delivered_kwh` / `revisions_count` / `risk_reason` proposals
for each trigger) were **deliberately trimmed** against peer-app conventions
before landing and are not the shipped contract. The shipped bag is the
"Delivered token bag (minimum)" section near the top of this note plus the
**Stable token contract** table below. The trimmed proposals are intentionally
not reproduced here — re-expanding them wholesale would walk back the trim
decision; revisit individual tokens only when a concrete flow-author need
surfaces. The `*_text` tokens and any composed `notification_text` stay out of
scope per Rule 4.

One condition-card constraint still matters: `deadline_status_is`'s shipped
dropdown is intentionally the canonical flow-status set only — `Waiting`,
`On track`, `At risk`, `Cannot finish`, `Satisfied` (`waiting`, `on_track`,
`at_risk`, `unachievable`, `satisfied`). Public docs must not describe
Smart-task list-only display states (`Scheduled`, `Paused — unplugged`) or
label variants (`Building plan…`) as selectable values unless the card JSON
grows matching dropdown options.

## Stable token contract

These are the tokens the cards actually emit today (verified against
`.homeycompose/flow/triggers/*.json` and `flowCards/smartTaskTokens.ts`). Their
stable-id *values* are public API — treat any rename as a breaking change.

| Trigger | Tokens | Stable-id values |
|---|---|---|
| `deadline_ended` | `device_name`, `outcome`, `shortfall` (number), `shortfall_known` (boolean) | `outcome`: `succeeded`, `missed`, `abandoned` |
| `deadline_status_changed` | `device_name`, `status` | `status`: `waiting`, `on_track`, `at_risk`, `unachievable`, `satisfied` |
| `deadline_plan_changed` | `device_name`, `remaining_kwh` (number), `planned_hours` (number), `projected_finish_local_time` | — |
| `smart_task_hours_remaining` | `device_name`, `hours_remaining` (number) | — |

The `deadline_status_is` condition compares against the same `status` enum. The
trimmed proposal-era tokens (`kind`, `*_id` suffixes, `previous_status_id`,
`change_reason_id`, `risk_reason`, `*_unit`) were **not** shipped — see the
rejected-expansion note above.

## Common flow scenarios this design serves

| Goal | Flow shape |
|---|---|
| Notify on every smart task outcome | `deadline_ended` + action, compose body from `device_name` + `outcome` in the flow |
| Notify only on failed outcomes | `deadline_ended` + Logic condition `outcome = missed` + action |
| Per-outcome routing | `deadline_ended` + branch on `outcome` |
| Alert when status reaches at-risk | `deadline_status_changed` + `deadline_status_is` condition `At risk` |
| Loud alarm only when shortfall is large | `deadline_ended` + Logic condition `outcome = missed AND shortfall > 5` (gate on `shortfall_known`) |
| React to a replanned schedule | `deadline_plan_changed` + read `remaining_kwh` / `planned_hours` in the flow |

## Implementation

Shipped across `.homeycompose/flow/triggers/deadline_*.json` (dropdown args
dropped, stable-id token bags added), `flowCards/deadlineObjectiveCards.ts`
(runlistener filtering removed), and `flowCards/smartTaskTokens.ts` (the token
builder). Stable-id values are asserted in `test/deadlineObjectiveCards.test.ts`
so a future rename breaks the test rather than user flows silently. The proposal
to also emit `outcome_id` / numeric introspection tokens (`delivered_kwh`,
`revisions_count`) was trimmed and not shipped.

## Migration notes

The smart-task flow surface is pre-1.0 and removing the dropdown args is the
deliberate path. The flow cards landed recently; the user base depending on
the current dropdown shape is small, and the user-flow refactor (drop the
dropdown trigger, add a condition node downstream) is a one-time
mechanical change for affected flows. Two options were considered:

1. **Hard cut (chosen path).** Document in the changelog; users re-pin
   their trigger and add a condition node on the stable-id token. The
   stable-id contract this redesign establishes is more durable than
   preserving the dropdown shape — keeping both indefinitely would compound
   the maintenance surface against a contract we want to discourage.
2. **Soft deprecation.** Keep the old cards alive (no edits), add the new
   cards alongside, encourage migration via docs. Considered and rejected:
   the dual surface area is the cost we want to avoid, and the dropdown
   shape doesn't compose with the richer-token redesign anyway.

A reviewer asking for soft deprecation is reading this as a 1.0+ stable
surface; it isn't. The decision lives in `TODO.md` along with the rest of
the redesign work.

## Related notes

- `notes/deferred-load-objectives/README.md` — shared objective model,
  reason codes, status semantics.
- `notes/ev-ready-by/README.md` §P2.3 — the original source of the
  extended-tokens proposal (the notification-text portion is deliberately
  not in scope; see Rule 4).
