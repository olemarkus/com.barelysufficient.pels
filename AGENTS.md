# PELS

Repo-wide instructions only:

- Root is the Homey app root. The only safe Homey CLI command is `homey app validate`. Do not run `homey app run`, `homey app install`, `homey app publish`, or any other Homey CLI command unless the user explicitly asks.
- The settings UI source lives in `packages/settings-ui`. Generated deployable assets sync into `settings/` via `npm run build:settings`.
- Shared browser-safe modules for the settings UI live in `packages/contracts/src` and `packages/shared-domain/src`.
- For settings-only work, start from `packages/settings-ui` and stay out of `app.ts`, `drivers/`, `flowCards/`, and `lib/` unless a missing contract blocks the task.
- Runtime code uses TypeScript with strict mode and Jest with the mock SDK in `test/mocks/homey.ts`. If a runtime change uses a new Homey SDK API, update that mock.
- When `.homeycompose` changes, `homey app validate` updates root `app.json`; include that generated change.
- Runtime logging is structured (pino, `lib/logging/`). New logs go through `logger.info/warn/error/debug()` with stable field names. Legacy `this.log()` / `this.logDebug()` calls exist but must not be added to. Debug topics in `lib/utils/debugLogging.ts` gate whether debug events fire.
- Internal engineering notes for Homey state trust, freshness, and drift/reconcile pitfalls live under `notes/`. Read those before changing snapshot/realtime merge logic.
- **Before writing any UI label, status string, tab name, help text, or doc:** read `notes/ui-terminology.md`. It defines the canonical user-facing vocabulary for all of PELS.

## UI terminology (short rules)

Say what happens, not what the planner does internally.

| Avoid | Use instead |
|---|---|
| shed | limited / paused / turned down / lowered |
| restore | resume |
| headroom | available power |
| controlled/uncontrolled load | managed / background usage |
| daily budget | daily energy target |
| capacity limit | hourly power limit |
| soft margin | safety margin |
| PELS limit / soft limit | safety threshold (or daily energy pace — see below) |
| hard cap | hourly power limit |

**Do NOT rename internal code identifiers, test fixtures, or log strings** — only user-visible text changes.

### Power bar tick labels

The tick showing where PELS starts reacting has two sources — distinguish them:

- `softLimitSource = capacity` → **Safety threshold** (tooltip: hourly power limit minus safety margin)
- `softLimitSource = daily_budget` → **Daily energy pace** (tooltip: slowing to stay on today's energy target)
- User-configured ceiling (`hardLimitKw`) → always **Hourly power limit**

### Chips vs reason lines

Chips must be one or two words: `Limited`, `Resuming`, `Running`.
Reason lines (below chip or in tooltip) may be a short sentence: `staying under hourly power limit`.
Do not put multi-word sentences in chips.

### Terms that stay internal (do not surface in normal UI)

`shed`, `restore`, `headroom`, `shortfall`, `backoff`, `invariant`, `soft limit`, `capacity`, `controlled`, `uncontrolled`
