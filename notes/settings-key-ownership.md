# One settings key, one reader/writer

**Every persisted settings key has exactly one module that knows what its bytes
mean.**

This note governs keys **both sides read**. A key only the runtime reads belongs
wholly to its `lib/` module, which reads it through a `SettingsPort` handed over
by `setup/` — see `setup/AGENTS.md` § "No domain logic". Either way the wiring
layer never reads a key itself. That module owns the read policy (how a malformed or partial value is
interpreted) and the write policy (what may be persisted at all). Callers own
their transport and nothing else.

Owners live in `packages/shared-domain/src/settings/`, because a key is almost
never read by only one side: the runtime reads through `homey.settings`, and the
settings UI reads the same bytes over the Homey API bridge. Shared-domain is the
lowest layer both may import, and it is browser-safe.

## What the owner does and does not hold

**Holds** — the value's type; the read policy applied to a raw `unknown`; the
write policy, as a predicate or an assertion.

**Does not hold** — the transport (`settings.get`/`set` vs the async bridge), or
the meaning of *absence*. Absence stays with the caller because the two sides
genuinely differ: the runtime can cross-check `getKeys()` to tell "never
written" from "read failed", and the settings UI cannot. An owner that tried to
answer absence would have to be told the answer anyway.

## Why

`mode_device_targets` is the worked example, and the reason this note exists.
Fifteen files read or wrote that one key, each bringing its own parser — and the
two sides had drifted into **opposite policies for the same bytes**:

| | malformed mode value, e.g. `{ "Home": {...}, "Away": null }` |
|---|---|
| runtime `parseModeDeviceTargets` | coerce `Away` to `{}`, keep the key, carry on |
| settings UI `parseModeNumberMap` | reject the entire catalog, raise "Mode catalog unavailable" |

Nobody chose that. It is what a shared key does when each caller writes its own
parser, and it is invisible until a malformed value actually appears — at which
point the runtime quietly repairs and the UI refuses to load. Neither side is
wrong on its own; there simply was no one place where the question was answered.

## The policies, and the asymmetry between them

Read and write are deliberately not the same test. The reader tolerates what the
writer refuses:

- **Read: sanitize and keep.** A malformed mode value becomes an empty mode
  rather than dropping the key or failing the read. Dropping the key silently
  deletes a mode the owner configured; failing the read stops the pass that
  fills missing targets, and a device with no target is one PELS can shed with
  nothing to restore it to (`notes/temperature-ownership.md`).
- **Write: refuse anything the reader would have to repair.** The store may
  already hold a malformed catalog — written by an older build, by `homey api`,
  or by a partial write — so the reader has no choice. A writer is choosing the
  bytes and has no such excuse.

The asymmetry is the point: tolerate what you are handed, never be the source of
it. With every write path behind the owner, a malformed catalog can only enter
from outside PELS.

## Applying it

- Adding a settings key: give it an owner module before it has two callers.
- Touching a key with scattered parsing: move the meaning into an owner first,
  then migrate the callers, rather than adding one more local parser.
- A caller that needs to know how the bytes are shaped is a caller that should be
  asking the owner.

Keys with owners so far: `mode_device_targets`, `pv_forecast_source`.
`capacity_priorities` has the same shape and the same two parsers and is the
obvious next one — until then it keeps the older reject-the-whole-map policy,
which is why `parseModeNumberMap` still exists alongside
`readModeDeviceTargetsSetting`.

`pv_forecast_source` is the cheap case the rule still earns: a flat three-value
union with nothing to sanitize partially, but two callers from day one (the
runtime reader and the settings UI's select), so a second local parser would
have been one drift away from planning and the UI naming different sources for
the same bytes. Its policy is recognise-or-default rather than sanitize-and-keep
— see the module for why defaulting is safe at this particular key.

## Which store a key lives in

Part of an owner's contract is *where* the bytes live, and there are two stores
with opposite cost profiles:

- **`homey.settings`** — configuration and mission-critical state: managed and
  controllable devices, priorities, mode targets and the mode-target ownership
  state (a restore target the app cannot recover is not regenerable), device
  control profiles, smart-task definitions, price/budget/EV/weather settings,
  meter and source choice, small live latches. The SDK's `ManagerSettings.set`
  stringifies the value, stringifies the stored value to compare, parses a copy,
  and then ships the **entire settings object** to Homey core over the runner's
  websocket — on every write of any key. Every byte in any key is paid on every
  write of every other key, so this store must stay small and rarely written.
- **`/userdata/pels.sqlite`** (`lib/store/userdataDatabase.ts`) — history,
  learned data and caches: sad if lost, never mission-critical, always
  regenerable. A write costs the bytes written and core never sees it. The
  power tracker's hourly/daily series were the first to move
  (`lib/power/trackerStore.ts`, one row per bucket, diffed writes), the
  weather history second (`lib/weather/weatherHistoryStore.ts`, one row per
  day), the smart-task plan history (`lib/objectives/deferredObjectives/planHistoryStore.ts`,
  one row per run) and the device diagnostics
  (`lib/diagnostics/deviceDiagnosticsStateStore.ts`, one row per device-day)
  after them; calibration and the price/tariff caches follow.
- **Nowhere** — a value that is a fact of the running app and nothing else. The
  live status (`PelsStatus`, once the `pels_status` / `pels_status:<homeId>`
  keys) is held in memory by `lib/plan/planStatusRegistry.ts`: every reader —
  the settings-UI API, the headroom widget, the Insights driver — runs in this
  process, the WebView and the driver hear a publish over the
  `plan_status_published` realtime push, and a previous run's status was never
  the right thing to serve. The old keys are unset once at boot and nothing is
  imported.

Owner ruling 2026-09-07. A key that moves is imported ONCE, at boot, on the
first boot that finds the store empty for the home and the legacy value
plausible; the key is then unset and nothing reads it again. A suspect read
leaves the key for the next boot — one transient must never cost a user's
history (`lib/store/legacySettingsImport.ts` holds the rules; each family's
import beside its store hands in what "holds" and "adopt" mean). The settings UI
reaches history through `api.js` endpoints and the store's own realtime push,
never through a settings key.
