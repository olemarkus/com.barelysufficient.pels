# Smart Task Flow Cards — Redesign Proposal

The shipped trigger cards have a design issue: the `outcome` and `status`
dropdown args make users either set up one flow per filtered value or pick the
`any` option, and the tokens carrying those values today emit display labels
rather than stable identifiers — so even when a user does land on a single
trigger, downstream condition logic has to compare English strings that may
localize or be renamed.

This note collects the proposed redesign: one trigger per lifecycle event,
stable-id tokens treated as public API, condition cards used for filtering.
It also folds in the token gaps surfaced in
`notes/ev-ready-by/README.md` §P2.3 (richer tokens for notification text) so
the same change can land them together.

**Status:** shipped (2026-05-15), then trimmed (2026-05-15) after
comparing token counts against installed Homey apps (Easee, Home Connect,
myUplink, Power by the Hour). The "stable-id + display-label" duo, the
composed `notification_text`, and the diagnostic-grade introspection
tokens (`risk_reason`, `planned_start/finish_local_time`, `required_kwh`,
`planning_speed_kw`, `estimated_duration_text`) had no equivalent in any
other app — convention is "trigger emits the thing that changed, full
stop." The per-card target shape in this note therefore overshot;
delivered shape is the minimum below.

**Delivered token bag (minimum):**

- `deadline_ended` — `device_name` (string), `outcome` (string, stable
  lowercase id: `succeeded` / `missed` / `abandoned`), `shortfall`
  (number, 0 when succeeded).
- `deadline_status_changed` — `device_name` (string), `status` (string,
  stable lowercase id: `waiting` / `on_track` / `at_risk` /
  `unachievable` / `satisfied`).
- `deadline_plan_changed` — `device_name` (string), `remaining_kwh`
  (number), `planned_hours` (number), `projected_finish_local_time`
  (string).

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
maintain, tokens flow through to notification text without re-fetching, and
compound logic (e.g. "missed AND kind=ev_soc") works without registering
multiple triggers.

### Rule 2 — Stable id tokens + display label tokens

Each enum value gets two tokens:

- **`<name>_id`** — stable, lowercase, never renamed without a deliberate
  breaking-change call. Public-API contract.
- **`<name>`** — display label, may localize, used for notification text.

The `kind` token already follows this pattern (`temperature` / `ev_soc` are
stable ids); extend the precedent to `outcome_id` / `status_id` /
`previous_status_id` / `change_reason_id`.

### Rule 3 — Numeric tokens for values users want to compare or compute

Today, `target_text`, `shortfall_text`, etc. are pre-formatted strings.
Expose the underlying numbers as separate tokens so flows can do math
(`if shortfall_value > 5: warn loud`) without parsing strings.

### Rule 4 — Composed notification text is provided by PELS

PELS does not deliver notifications directly, but composing a useful one-line
notification from five sparse tokens is friction. Expose a `notification_text`
token on each trigger that combines the relevant fields into a
ready-to-use string. Users can still ignore it and build their own.

## Per-card target shape

### `deadline_ended`

**Args:** `device` (autocomplete). No outcome dropdown.

**Title formatting:** `Smart task ended for [[device]]`.

**Tokens:**
- `device_name` (string)
- `kind` (string, stable id — already shipped)
- `outcome_id` (string, stable id: `succeeded` / `missed` / `abandoned`)
- `outcome` (string, display label: `Succeeded` / `Missed` / `Abandoned`)
- `target_value` (number) and `target_unit` (string id: `c` / `percent`)
- `target_text` (string, formatted — for notification text)
- `final_progress_value` (number, nullable) and `final_progress_unit` (string id)
- `delivered_kwh` (number) — actual energy delivered during the run
- `shortfall_value` (number, 0 when succeeded), `shortfall_unit` (string id)
- `shortfall_text` (string, formatted — for notification text)
- `deadline_local_time` (string, formatted)
- `finished_at_local_time` (string, formatted, empty when not succeeded)
- `revisions_count` (number) — how many times the plan replanned during the run
- `notification_text` (string, composed one-liner)

### `deadline_status_changed`

**Args:** `device` (autocomplete). No status dropdown.

**Title formatting:** `Smart task status changed for [[device]]`.

**Tokens:**
- `device_name` (string)
- `kind` (string, stable id)
- `status_id` (string, stable id: `waiting` / `on_track` / `at_risk` /
  `unachievable` / `satisfied`)
- `status` (string, display label)
- `previous_status_id` (string, stable id, nullable) — enables
  "transitioned FROM x" logic
- `target_value` (number), `target_unit` (string id)
- `target_text` (string, formatted)
- `deadline_local_time` (string, formatted)
- `planned_start_local_time` (string, formatted, nullable)
- `planned_finish_local_time` (string, formatted, nullable)
- `required_kwh` (number, nullable) — remaining energy needed
- `planning_speed_kw` (number, nullable) — observed/configured charging rate
- `estimated_duration_text` (string, formatted, nullable)
- `risk_reason` (string id, nullable) — when status is `at_risk` or
  `unachievable`, the stable reason code from the diagnostics bridge
- `notification_text` (string, composed one-liner)

The runtime-side suppression rules already in place (first observation, same-
status re-fire) stay.

### `deadline_plan_changed`

**Args:** `device` (autocomplete). No change.

**Tokens:** (add to today's set)
- `device_name` (existing)
- `kind` (add — stable id)
- `remaining_kwh` (existing)
- `planned_hours` (existing)
- `projected_finish_local_time` (existing)
- `change_reason_id` (string, stable id: `prices_revised` / `rate_refined` /
  `objective_changed` / `measured_deviation`) — the recorder already classifies the first three;
  `measured_deviation` is reserved and will fire once the observability work lands. The
  `flow_card` and `prices_arrived` revision reasons mark plan *creation* rather than *change*
  and are not emitted on `deadline_plan_changed`.
- `notification_text` (string, composed one-liner)

### `deadline_status_is` (condition)

Today the dropdown arg uses stable ids (`waiting` / `on_track` / etc.) but the
runlistener accepts legacy values too. After Rule 2 lands, this card stays —
users who prefer a condition card over a token comparison still get one — but
the comparison value is the same stable id surfaced as `status_id` in the
trigger.

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
| Notify on every smart task outcome | trigger + action, use `notification_text` |
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
  `outcome`; add numeric tokens; compose `notification_text`.
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
  notification-text + extended-tokens proposal.
- `notes/hard-deadlines/README.md` — when hard enforcement ships, the cards
  will need an `enforcement_id` token and possibly an `enforcement` arg on
  the set actions.
