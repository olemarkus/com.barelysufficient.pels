# Smart Task Flow Cards — Redesign Proposal

The shipped trigger cards have a design issue: the `outcome` and `status`
dropdown args make users either set up one flow per filtered value or pick the
`any` option, and the tokens carrying those values today emit display labels
rather than stable identifiers — so even when a user does land on a single
trigger, downstream condition logic has to compare English strings that may
localize or be renamed.

This note collects the proposed redesign: one trigger per lifecycle event,
stable-id tokens treated as public API, condition cards used for filtering.

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
  (number, 0 when succeeded; flow UI label "Gap to target").
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
(`if shortfall_value > 5: warn loud`) without parsing strings. Shipped
example: `deadline_ended` emits a `shortfall` number token rather than a
`shortfall_text` string. Apply the same pattern when extending the other
triggers.

### Rule 4 — Notification text composition stays in the user's flow

PELS does not emit a composed `notification_text` token on any trigger, and
does not emit "_text" tokens whose only purpose is to feed one. Composing a
push body from the underlying tokens is the flow author's job — same as every
other Homey app. This avoids locking out localisation and avoids a token
contract whose stability we'd have to defend across copy revisions.

## Per-card target shape

> **Pre-trim proposal — not the shipped contract.** The token lists below
> are the original full-fat redesign and were deliberately trimmed against
> peer-app conventions before landing. The shipped shape is the "Delivered
> token bag (minimum)" section near the top of this note. Treat what
> follows as a backlog of tokens to revisit one-by-one if a concrete
> flow-author need surfaces, not as a target to implement wholesale —
> re-expansion would walk back the trim decision. In particular, the
> `*_text` tokens (`target_text`, `shortfall_text`, `deadline_local_time`,
> `estimated_duration_text`) and any composed `notification_text` are out
> of scope per Rule 4.

### `deadline_ended`

**Args:** `device` (autocomplete). No outcome dropdown.

**Title formatting:** `Smart task ended for [[device]]`.

**Tokens (pre-trim proposal — see banner above):**
- `device_name` (string) — shipped
- `outcome` (string, stable id: `succeeded` / `missed` / `abandoned`) — shipped
- `shortfall` (number, 0 when succeeded; flow UI label "Gap to target") — shipped
- `kind` (string, stable id) — proposed
- `target_value` (number) and `target_unit` (string id: `c` / `percent`) — proposed
- `final_progress_value` (number, nullable) and `final_progress_unit` (string id) — proposed
- `delivered_kwh` (number) — proposed
- `finished_at_local_time` (string, formatted, empty when not succeeded) — proposed
- `revisions_count` (number) — proposed

### `deadline_status_changed`

**Args:** `device` (autocomplete). No status dropdown.

**Title formatting:** `Smart task status changed for [[device]]`.

**Tokens (pre-trim proposal — see banner above):**
- `device_name` (string) — shipped
- `status` (string, stable id: `waiting` / `on_track` / `at_risk` /
  `unachievable` / `satisfied`) — shipped
- `kind` (string, stable id) — proposed
- `previous_status_id` (string, stable id, nullable) — proposed
- `target_value` (number), `target_unit` (string id) — proposed
- `planned_start_local_time` (string, formatted, nullable) — proposed
- `planned_finish_local_time` (string, formatted, nullable) — proposed
- `required_kwh` (number, nullable) — proposed
- `planning_speed_kw` (number, nullable) — proposed
- `risk_reason` (string id, nullable) — proposed

The runtime-side suppression rules already in place (first observation, same-
status re-fire) stay.

### `deadline_plan_changed`

**Args:** `device` (autocomplete). No change.

**Tokens (pre-trim proposal — see banner above):**
- `device_name` — shipped
- `remaining_kwh` — shipped
- `planned_hours` — shipped
- `projected_finish_local_time` — shipped
- `kind` (stable id) — proposed
- `change_reason_id` (string, stable id: `prices_revised` / `rate_refined` /
  `objective_changed` / `measured_deviation`) — proposed. The recorder already classifies
  the first three; `measured_deviation` is reserved and will fire once the observability
  work lands. The `flow_card` and `prices_arrived` revision reasons mark plan *creation*
  rather than *change* and are not emitted on `deadline_plan_changed`.

### `deadline_status_is` (condition)

Today the dropdown arg uses stable ids (`waiting` / `on_track` / etc.) but the
runlistener accepts legacy values too. After Rule 2 lands, this card stays —
users who prefer a condition card over a token comparison still get one — but
the comparison value is the same stable id surfaced as `status_id` in the
trigger.

The shipped dropdown is intentionally the canonical flow-status set only:
`Waiting`, `On track`, `At risk`, `Cannot finish`, and `Satisfied`
(`waiting`, `on_track`, `at_risk`, `unachievable`, `satisfied`). Public docs
must not describe Smart-task list-only display states such as `Scheduled` or
`Paused — unplugged`, or label variants such as `Building plan…`, as
selectable values on this condition card unless the card JSON grows matching
dropdown options.

## Stable token contract

The following token *values* become public API. Treat any change as a
breaking change.

| Token | Values |
|---|---|
| `kind` | `temperature`, `ev_soc` |
| `outcome_id` | `succeeded`, `missed`, `abandoned` |
| `status_id`, `previous_status_id` | `waiting`, `on_track`, `at_risk`, `unachievable`, `satisfied` |
| `change_reason_id` | `prices_revised`, `rate_refined`, `objective_changed`, `measured_deviation` |
| `risk_reason` | reason codes from `lib/plan/deferredObjectives/types.ts` |
| `target_unit`, `shortfall_unit`, `final_progress_unit` | `c`, `percent` |

Document these in the card JSON and the token-building code so future-
refactor PRs know not to rename them silently.

## Common flow scenarios this design serves

| Goal | Flow shape |
|---|---|
| Notify on every smart task outcome | trigger + action, compose body from `device_name` + `outcome` in the flow |
| Notify only when EV charge fails | trigger + condition `outcome_id = missed AND kind = ev_soc` + action |
| Per-outcome routing | trigger + branch on `outcome_id` |
| Alert when status reaches at-risk | trigger + condition `status_id = at_risk` |
| Alert when leaving satisfied (e.g. temp drop) | trigger + condition `previous_status_id = satisfied AND status_id != satisfied` |
| Replanned because rates refined | `deadline_plan_changed` + condition `change_reason_id = rate_refined` |
| Loud alarm only when shortfall is large | `deadline_ended` + condition `outcome_id = missed AND shortfall_value > 5` |

## Implementation outline

Files that need to change:

- `.homeycompose/flow/triggers/deadline_ended.json` — drop `outcome` arg,
  add new token list.
- `.homeycompose/flow/triggers/deadline_status_changed.json` — drop
  `status` arg, add new token list.
- `.homeycompose/flow/triggers/deadline_plan_changed.json` — add new
  tokens.
- `flowCards/deadlineObjectiveCards.ts` — update `buildTriggerTokens`
  for status_changed; remove dropdown-based runlistener filtering.
- `flowCards/deadlineEndedTokens.ts` — emit `outcome_id` alongside
  `outcome`; add numeric tokens.
- Active-plan recorder / planHistory — surface the new numeric fields the
  tokens depend on (`delivered_kwh`, `revisions_count`, numeric target /
  progress) if not already available.
- Tests under `test/deadlineObjectiveCards.test.ts` — extend token-shape
  coverage; assert stable-id values explicitly so future renames break the
  test rather than user flows silently.

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
- `notes/hard-deadlines/README.md` — when hard enforcement ships, the cards
  will need an `enforcement_id` token and possibly an `enforcement` arg on
  the set actions.
