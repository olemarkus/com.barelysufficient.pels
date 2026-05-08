# PELS

Repo-wide instructions only:

- Root is the Homey app root. The only safe Homey CLI command is `homey app validate`. Do not run `homey app run`, `homey app install`, `homey app publish`, or any other Homey CLI command unless the user explicitly asks.
- The settings UI source lives in `packages/settings-ui`. Generated deployable assets sync into `settings/` via `npm run build:settings`.
- Shared browser-safe modules for the settings UI live in `packages/contracts/src` and `packages/shared-domain/src`.
- For settings-only work, start from `packages/settings-ui` and stay out of `app.ts`, `drivers/`, `flowCards/`, and `lib/` unless a missing contract blocks the task.
- For Settings UI Material Design work, use `@material/web` components when a matching component exists and fits the semantics. If Material Web is not a fit, reuse or create a shared PELS primitive built on the existing design tokens; do not add page-local custom chips, cards, buttons, or segmented controls.
- Runtime code uses TypeScript with strict mode and Jest with the mock SDK in `test/mocks/homey.ts`. If a runtime change uses a new Homey SDK API, update that mock.
- When `.homeycompose` changes, `homey app validate` updates root `app.json`; include that generated change.
- Runtime logging is structured (pino, `lib/logging/`). New logs go through `logger.info/warn/error/debug()` with stable field names. Legacy `this.log()` / `this.logDebug()` calls exist but must not be added to. Debug topics in `lib/utils/debugLogging.ts` gate whether debug events fire.
- Internal engineering notes for Homey state trust, freshness, and drift/reconcile pitfalls live under `notes/`. Read those before changing snapshot/realtime merge logic.
- **Before writing any UI label, status string, tab name, help text, or doc:** read `notes/ui-terminology.md`. It defines the canonical user-facing vocabulary for all of PELS.

## UI terminology (short rules)

Say what happens, not what the planner does internally. See `notes/ui-terminology.md` for the full reference.

**Change these** — they are jargon:

| Avoid | Use instead |
|---|---|
| shed | limited / paused / lowered / turned off |
| restore | resume |
| headroom | available power |
| controlled/uncontrolled load | managed / background usage |
| soft margin | safety margin |

**Leave these alone** — they are established with users:

`budget`, `daily budget`, `capacity` (in settings context), `managed`, `priority`, `mode`

**Do NOT rename internal code identifiers, test fixtures, or log strings** — only user-visible text changes.

### Hero bar labels

| Concept | Label |
|---|---|
| Current instantaneous draw | Power now |
| Dynamic kW threshold (either source) | Safe pace now |
| Fixed user-configured ceiling | Hard cap |
| kWh used so far this hour | Energy used this hour |
| kWh allowed for this hour | Budget this hour |
| Projected end-of-hour kWh | Projected this hour |

The "Safe pace now" tick uses a single label regardless of whether the binding constraint is capacity-based or daily-budget-based. The tooltip explains the source.

### Chips vs reason lines

Chips must be one or two words: `Limited`, `Resuming`, `Running`.
Reason lines (below chip or in tooltip) may be a short sentence: `staying within today's budget`.
Do not put multi-word sentences in chips.

### Terms that stay internal (do not surface in normal UI)

`shed`, `restore`, `headroom`, `shortfall`, `backoff`, `invariant`, `soft limit`, `controlled`, `uncontrolled`
