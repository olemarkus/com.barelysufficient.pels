# Vehicle and charger current control

Tesla Car & Energy's Battery & charging device is an EV load in PELS, even though Homey calls it a sensor. Zaptec's charging switch remains independent of its current-control method. Planning, priorities, EV presets, Smart tasks and state of charge use the existing EV model.

## Setup and authority

Start/stop uses the owning app's writable capability. Current control can use an actual writable current capability, a built-in app action using a Homey API key, or a user Flow. PELS prefers the capability when it is writable according to the installed device's metadata. It never turns a read-only capability into a writable capability.

Zaptec supports writable capability control and user Flows, not the API-key action fallback. Its Automatic power route remains independent of manual current setup. A saved built-in current selection with read-only current cannot send an app action; the owner updates the Zaptec app or explicitly selects Flow control. Other integrations retain their supported app-action routes.

The owner creates one key per Homey through **Homey Web App → Settings → API Keys**, named **PELS**, granting **Flow** permission. See [Homey's API-key guide](https://support.homey.app/hc/en-us/articles/8178797067292-Create-and-use-API-Keys-on-Homey-Pro). PELS cannot provision this key from its app session. Its API exposes Check/Replace/Remove and sanitized status, never the saved key. The backend-only key setting is owned by `lib/device/transport/homeyActionAccess.ts` (which also runs home-battery app actions, `notes/battery-vendor-bindings.md`); it is excluded from the explicit settings bootstrap and diagnostics selection.

The key API does not change any device's current-control method. The settings UI makes built-in control the primary setup path: its combined save-and-enable action saves the key, then explicitly saves the selected device's built-in method and scope confirmation. Key replacement remains a key-only operation. If enabling fails after the key is saved, the UI refreshes saved state and offers activation again. Enabling built-in control requires a successful check of ordinary and Advanced Flow inventories. Current-setting actions block that switch; unrelated battery-level reports do not. A saved key and a current-setting Flow produce a recommendation to remove the redundant action and explicitly switch methods. PELS never edits the owner's Flows and never falls back to Flow or app credentials when a selected key route fails.

Choose the EV phase preset and installation limit using the existing Control model settings. The supported current commands are whole amps from 6 to 32 A. Zero/off uses the charging switch, not a sub-minimum charging-current command.

Futurehome Charge (`no.futurehome`, `ev_charger` driver) has no current capability. Its device-owned `currentLimit` action is the only write, so built-in control always uses the key. Each command reaches only that charger (`charger` scope), so it needs no confirmation. The vendor writes the charger and waits for its Zigbee reply before saving the same value to the device's `currentLimit` setting, and Homey publishes a settings change as a whole-device update, so the adapter reads that setting back as the current ceiling. It is reply evidence, not proof of application: the vendor ignores the per-attribute status in the Write Attributes Response, so a rejected or installer-clamped value is saved as sent. PELS accepts it as it accepts Tesla's echoed limit and adds no inference from measured draw, which can only show a limit is wrong, never confirm one; the gaps belong in the vendor app. Only an integer 6-32 A counts as a reading. The `phases` setting reports only a one-phase installation: it names no grid, and IT three-phase is not modelled. PELS writes only the current limit; the auto-start setting stays the owner's. Caveats: the vendor refreshes the setting from the charger only at startup, so a change made outside Homey (Futurehome hub, its own app) is invisible until the Futurehome Homey app restarts, and PELS keeps the old reading meanwhile. `FuturehomeChargerSession` dates a new value when an accepted read first shows it, and ignores a read that started before the last one it observed, so a full refresh fetched before a device update cannot bring the old limit back with a fresh date. The date goes only on a reported step at the current it dates: a parse of a read the session ignored, or of one it never saw (a full refresh observes sessions only while the live feed is trusted), stays undated, so the merge keeps the newer dated step and a command waits until a trusted read shows its limit. The settings UI's device picker re-parses the last full read and observes no session.

Zaptec installation-current commands affect the whole installation. Built-in control requires explicit single-charger confirmation and refuses a known second charger with the same installation ID. Shared installations retain their existing binary and Flow control.

For Tesla, explicitly choose the vehicle as the control point and disable Power-limit control for the physical charger. A Homey app action uses the exact installed card ID and owning app/device; the UI cannot supply arbitrary action IDs or arguments.

## Vehicle location and observations

The adapter pairs the battery, location and car devices through their raw vehicle identity. It requires a unique pair of siblings, an online vehicle at 0 km/h, an AC cable and a connected charging state. A reported shift state must be P; an unreported one does not block, because Tesla Car & Energy sets it only from a Fleet API poll and a car followed by telemetry can leave it unset, while a connected AC cable already rules out driving. Home authorization needs dated coordinates within 100 m of Homey's configured location, when the vehicle has a location device. A vehicle with none in a complete device list is admitted on the car and charging checks alone (`home_without_location`): those rule out DC and driving, not an AC charger away from home. A list is complete only when it was fetched under the trust epoch in force when it is retained and dropped no payload at the parse; a live update, a read that crossed a reconnect, or one that rejected a payload cannot show a device is unpaired, so it does not admit. The charging read reports the gap as `missingCompanion: 'vehicle_location'`, and the settings UI turns it into a dismissable recommendation. Their age is not evidence: Homey re-dates a capability only when its value changes, so a car parked for hours keeps the date it arrived with. The generic location-update capability is not a coordinate.

Authorization is a function of the current observations and never expires because they stay quiet. Away coordinates, motion, disconnection, unavailability or changed identity revoke it at once; a Homey live-feed trust gap discards the pre-gap observations until the next full read. Replugging or restarting while the car stays parked restores it from the unchanged coordinates. All Tesla writes use this owner. Charging outside that authorization is excluded from home power attribution. This remains dependent on the Tesla app publishing truthful vehicle and connection state; cloud control cannot provide fast overload protection.

Requested current is a ceiling, not actual draw. While charging, matching ceiling evidence also needs current and power observations at least as recent as the ceiling, and actual current at or below it. Lower draw is valid. While explicitly stopped (`charging_on=false`, `charging_state=Stopped`) with dated zero-current and zero-power observations, the reported ceiling confirms current preparation even if those unchanged zero measurements retain older timestamps. The Tesla app publishes that ceiling after its vehicle command completes successfully. This is evidence of the configured limit, never evidence of running power; binary state and measured power remain separate. An API response alone publishes no observation. The generic adapter activation policy prepares and observes current before issuing start; it does not assume an unknown initial step was applied.

While charging, the limit echo still matters: it acknowledges the command. The Tesla adapter publishes `measure_charge_current_max`, dated by its update, as the canonical `pels_acknowledged_current` (`ACKNOWLEDGED_CURRENT_CAPABILITY_ID`) in its overlay and control events, and common transport resolves it to the snapshot's `acknowledgedStep`. The executor then stops re-sending the command (each send can be a paid vehicle API call) and waits up to `ACKNOWLEDGED_COMMAND_SETTLE_MS` (20 minutes, one Tesla poll with margin) from issue for the confirmed current; the planner keeps planning on measured draw meanwhile. A newer limit or confirmed current naming another step, or the window closing unconfirmed, returns the command to the ordinary stale-and-retry ladder. See `notes/state-management/actuation-clocks-and-settle.md` § "An acknowledged command".

## User Flow alternative

Use **Stepped device target changed**, select the PELS device, connect it to the vendor current action. Pass **EV charger current (A)** to that action. Start/stop stays with the capability adapter.

The settings UI offers this route only to an owner whose Flow already sets the current, or whose installation is shared. A device with neither built-in control nor a current-setting Flow has no current route (`ChargingCurrentControl.lacksCurrentRoute`): its setup section, its card and its recommendation all point at built-in control, never at building a Flow.

Built-in current control rejects stepped reports from an old user Flow.

## Command and observation boundaries

App-session action execution can return **403 Missing Scopes**. Built-in
action-card control needs a Homey API key with `homey.flow`. Read-only Flow
access does not grant execution. Vendor command failures preserve the shared
key; authentication failures invalidate it. Explicit Tesla control revocation
remains available if key access or Flow inventory checks fail.

The transport does not retry action POSTs or follow redirects. An unknown
command outcome retains its device lock until the response completes or the
bounded late-response timeout expires. Command acceptance does not publish
observed state.

Home coordinates are read through the owner Web API
(`manager/geolocation/option/location`), which weather and solar forecasts
also use (`lib/device/hubHomeLocation.ts`). Tesla authorization requires an
accepted location; a failed read keeps the last accepted location.

A reported current limit can confirm preparation for an explicitly stopped
Tesla with dated zero measurements, even when those zero values retain their
timestamps. Running current changes retain the measurement requirements.
A failed preparation leaves the observed limit in place and does not authorize
a start.

## Integration boundary

`lib/device/tesla/`, `lib/device/easee/`, `lib/device/zaptec/` and `lib/device/futurehome/` own their raw
Homey identities, capability interpretation and command translation. Only
`lib/device/deviceAdapterRegistry.ts` imports their public entrypoints. Each
implements the required `DeviceAdapter` operations; transport instances own
session state through the registry. The common host owns I/O, credentials,
subscriptions and actuator delivery.

Tesla sibling matching, home-session authorization and current confirmation stay
inside its adapter. The host receives existing device observations and resolved
control eligibility. Planner, executor and UI
contracts gain no vendor flags or session requirements. Adapter operations have
no optional hooks or nullable resolved results. `npm run device:adapters` guards
this boundary, including type-only imports and raw vendor discriminators.

Resolve SDK uncertainty at ingestion. Malformed capability values are ignored
without replacing accepted observations. Valid Tesla `Unknown`, `NoPower` and
`Calibrating` reports block control while retaining the last real plug observation;
they do not become an unknown plug state or a fabricated disconnect. Full inventory
reads resolve companion membership before publishing device eligibility, retaining
ignored entries and respecting transient-empty protection. Partial reads cannot
remove companions.
