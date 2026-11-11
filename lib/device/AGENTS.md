# Device Layer

`lib/device/` owns runtime device configuration, Homey transport, snapshot and realtime ingestion, and device-level power estimates. `lib/observer/` resolves observation truth; `lib/planInput/` projects those facts into planner input. See `notes/state-management/observer-transport-split.md` for the ownership map and `notes/ev-car-link/README.md` for car association.

## Device State Invariants

Keep these concepts separate: **planned** is the desired plan, **commanded** is what PELS asked Homey to do, **observed** is trusted telemetry, **pending** is a command awaiting confirmation, and **effective planning** is the conservative producer-resolved input to the planner. A local write proves a request, not device convergence; a timeout means unknown, not success. Whole-home power is the safety authority when per-device attribution disagrees.

### Source trust order

A newer realtime observation can outrank an older snapshot. Snapshot refresh must not roll back fresher accepted state or a local command without evidence of a newer device value. Accepted observations persist until their owner replaces or invalidates them; a quiet device does not time out. The producer resolves evidence and pending commands before exposing flat `PlanInputDevice` fields; planner consumers do not inspect provenance.

### Hard invariants

- A full device fetch or `device.update` is resolved at `transport/deviceReadContract.ts`. Validate the capability list/map structurally and each capability PELS reads for its role independently, including vendor-converted fields. A null, malformed, missing, or undated capability rejects only that field; valid siblings still update. A rejected binary control field such as `onoff` removes the binary facet, including on a previously observed device. Do not retain its declaration, descriptor, or previous value to force binary admission. Other observation fields retain their last accepted value and original source timestamp according to their owner's policy, or are withheld when none exists. Do not invent a value or fresh timestamp. Apply the owning admission gates to the remaining semantic facets: keep usable facets, and omit the device when all gates fail rather than requiring a blank unsupported row. A device payload without a usable identity or capability list is dropped at the SDK parse (`parseHomeyDevicePayload`), which also normalizes Homey's older `driverUri` and local `driverId` shape. A rejected native-limit observation preserves independently usable native-control metadata and range; that metadata proves neither an observed limit nor binary authority, and must not select an unsafe binary-only start. Physical availability remains the Homey availability fact; an unreadable control observation does not make healthy sibling facets unavailable. Start prerequisites remain with the device write owner. Do not fall back from an unreadable charger charging control to an `onoff` that disables the charger. Charger identity does not prove plug state: without an accepted plug observation, preserve admitted telemetry but grant no session or start permission. Per-capability realtime events have their own narrower arrival-time contract.
- Facts implied by the inventory class are resolved only in this layer, as required flags: `isEvCharger` and `isBatteryOrSolar` on the descriptor, and `starvationSupported` on device configuration. Planner input, executor reads and smart-task eligibility read those flags, never `deviceClass`, which planner input does not carry. Elsewhere, branch on the class only for a choice about that specific class (a battery or panel role, class-keyed defaults, grouping in the device list). A fact a consumer needs is a required field on the producer's type: an optional one lets a carrier that lost it compile and read as "no".
- A stepped identity requires a usable ladder with a step above 0 W (`hasUsableSteppedLoadLadder`). Resolve the identity and ladder together. Consumers should never have to repair an empty or off-only stepped profile.
- Confirmation requires matching telemetry. Binary `onoff` confirmation alone does not prove that final power or stepped behavior has settled. Fallback and estimated power are planning inputs, not measured telemetry. Do not infer binary on/off state from power draw.
- A rejected binary control has no binary facet or trusted binary observation. Do not synthesize `currentOn` or a binary transition from a binary-less update.
- Admit a non-off flow step report even while the binary axis reports off; it is observed step evidence and may be needed to confirm preparation. The binary axis still controls effective on/off, and restore sizing uses the target step.
- EV state of charge is valid by physical charging session, not by elapsed silence. Only a plug-out ends that session. An associated car becoming unavailable suspends its live association and car-sourced level while retaining the session for recovery. A connected sub-state change does not create a new session anchor; a full refresh uses the retained session. Do not add an age cutoff.
- Retained trusted device power survives restart in `retainedPowerStore.ts`; an absent device in one save does not delete its row. The flow-backed state records shared with transport are updated in place so transport keeps the same references.

### Merge and convergence

Realtime observations update the observed view before any convergence decision. Preserve pending command state until confirmation or timeout, and suppress an equivalent pending write unless retry policy permits it. Execution compares a newly decided plan with observer truth through `lib/executor/`; it does not reapply a committed plan directly after a device event. Structured logs should distinguish observed, planned, commanded, and pending values.

## Integration adapters

Tesla vehicle charging, Easee, Enua, Alfen (official app), Alfen Pro-line/ACE, Peblar, Zappi, Wallbox, Zaptec,
Futurehome, amina, go-e, Smappee EV Wall, OSO, Adax, SMA, KNX, Sessy, Anker SOLIX, Zinvolt, Marstek Venus (Connector app), Sigenergy, Zendure
(local app), Huawei LUNA2000 (Modbus) and SolaX (Modbus) interpretation belongs in `tesla/`, `easee/`, `enua/`, `alfen/`,
`alfenProline/`, `peblar/`, `myenergi/`, `wallbox/`, `zaptec/`, `futurehome/`, `amina/`, `goe/`, `smappee/`, `oso/`, `adax/`, `sma/`, `knx/`,
`sessy/`, `anker/`, `zinvolt/`, `marstek/`, `sigenergy/`, `zendure/`, `huawei/` and `solax/`. Chargers stepped through one whole-amp
current whose app starts at a current PELS did not choose share `currentSwitchCharger.ts`. Chargers whose app
saves the current it last sent in a device setting (Futurehome, amina) date it with
`settingCurrentLimitSession.ts`. A home
battery's control binding (claim, setpoint sign, range defaults, or its app's Flow actions) is the adapter's
`homeBatteryBinding`; see `notes/battery-vendor-bindings.md`. Battery app actions run through the common host
`homeBatteryAppActions.ts` on the shared Homey API key (`transport/homeyActionAccess.ts`).
Each implements the common `DeviceAdapter` interface;
only `deviceAdapterRegistry.ts` imports their entrypoints. Integrations do not
import each other. Common transport dispatches adapter operations and publishes
existing device observations; it does not inspect vendor identities or capability
names to decide behavior. `npm run device:adapters` checks source imports,
including type-only imports, and raw vendor discriminators.

Keep companion matching, read validation, session authorization, current
confirmation and command translation with their integration. Adapter state is
owned by the transport instance, never a module singleton. Native current
controls and app-action bindings are discovered collections of actual supported
operations; rejected fields produce no new observations while valid siblings
remain usable. Do not add optional hooks, nullable resolved results, parameter
bundles or vendor policy fields to the
planner, executor or UI model. I/O, credentials and actuator delivery remain with
the common host. Public contracts and settings change only additively, such as a new control scope.
