# Vehicle and charger current control

Tesla Car & Energy's Battery & charging device is an EV load in PELS, even though Homey calls it a sensor. Zaptec's charging switch remains independent of its current-control method. Planning, priorities, EV presets, Smart tasks and state of charge use the existing EV model.

## Setup and authority

Start/stop uses the owning app's writable capability. Current control can use an actual writable current capability, a built-in app action using a Homey API key, or a user Flow. PELS prefers the capability when it is writable according to the installed device's metadata. It never turns a read-only capability into a writable capability.

The owner creates one key per Homey through **Homey Web App → Settings → API Keys**, named **PELS**, granting **Flow** permission. See [Homey's API-key guide](https://support.homey.app/hc/en-us/articles/8178797067292-Create-and-use-API-Keys-on-Homey-Pro). PELS cannot provision this key from its app session. Its API exposes Check/Replace/Remove and sanitized status, never the saved key. The backend-only key setting is owned by `lib/device/transport/chargingAccess.ts`; it is excluded from the explicit settings bootstrap and diagnostics selection.

The key API does not change any device's current-control method. The settings UI makes built-in control the primary setup path: its combined save-and-enable action saves the key, then explicitly saves the selected device's built-in method and scope confirmation. Key replacement remains a key-only operation. If enabling fails after the key is saved, the UI refreshes saved state and offers activation again. Enabling built-in control requires a successful check of ordinary and Advanced Flow inventories. Current-setting actions block that switch; unrelated battery-level reports do not. A saved key and a current-setting Flow produce a recommendation to remove the redundant action and explicitly switch methods. PELS never edits the owner's Flows and never falls back to Flow or app credentials when a selected key route fails.

Choose the EV phase preset and installation limit using the existing Control model settings. The supported current commands are whole amps from 6 to 32 A. Zero/off uses the charging switch, not a sub-minimum charging-current command.

Futurehome Charge (`no.futurehome`, `ev_charger` driver) has no current capability. Its device-owned `currentLimit` action is the only write, so built-in control always uses the key. Each command reaches only that charger (`charger` scope), so it needs no confirmation. The vendor writes the charger and waits for its Zigbee reply before saving the same value to the device's `currentLimit` setting, and Homey publishes a settings change as a whole-device update (verified on SHS 2026-10-16), so the adapter reads that setting back as the current ceiling. It is reply evidence, not proof of application: the vendor ignores the per-attribute status in the Write Attributes Response, so a rejected or installer-clamped value is saved as sent. PELS accepts it as it accepts Tesla's echoed limit and adds no inference from measured draw, which can only show a limit is wrong, never confirm one; the gaps belong in the vendor app. Only an integer 6-32 A counts as a reading. The `phases` setting reports only a one-phase installation: it names no grid, and IT three-phase is not modelled. PELS writes only the current limit; the auto-start setting stays the owner's. Caveats: the vendor refreshes the setting from the charger only at startup, so a change made outside Homey (Futurehome hub, its own app) is invisible until the Futurehome Homey app restarts, and PELS keeps the old reading meanwhile. `FuturehomeChargerSession` dates a new value when an accepted read first shows it, and ignores a read that started before the last one it observed, so a full refresh fetched before a device update cannot bring the old limit back with a fresh date. The date goes only on a reported step at the current it dates: a parse of a read the session ignored, or of one it never saw (a full refresh observes sessions only while the live feed is trusted), stays undated, so the merge keeps the newer dated step and a command waits until a trusted read shows its limit. The settings UI's device picker re-parses the last full read and observes no session.

Zaptec installation-current commands affect the whole installation. Built-in control requires explicit single-charger confirmation and refuses a known second charger with the same installation ID. Shared installations retain their existing binary and Flow control.

For Tesla, explicitly choose the vehicle as the control point and disable Power-limit control for the physical charger. A Homey app action uses the exact installed card ID and owning app/device; the UI cannot supply arbitrary action IDs or arguments.

## Vehicle location and observations

The adapter pairs the battery, location and car devices through their raw vehicle identity. It requires a unique pair of siblings, an online parked vehicle, an AC cable and a connected charging state. Home authorization starts with coordinate samples from the preceding ten minutes within 100 m of Homey's configured location. The generic location-update capability is not evidence of a new coordinate sample.

An accepted stationary charging session does not expire merely because its values stay quiet. Away coordinates, motion, disconnection, unavailability, changed identity or a Homey live-feed trust gap revoke authorization. A new session needs fresh coordinate evidence; restart revalidates it. All Tesla writes use this owner. Charging outside that authorization is excluded from home power attribution. This remains dependent on the Tesla app publishing truthful vehicle and connection state; cloud control cannot provide fast overload protection.

Requested current is a ceiling, not actual draw. While charging, matching ceiling evidence also needs current and power observations at least as recent as the ceiling, and actual current at or below it. Lower draw is valid. While explicitly stopped (`charging_on=false`, `charging_state=Stopped`) with dated zero-current and zero-power observations, the reported ceiling confirms current preparation even if those unchanged zero measurements retain older timestamps. The Tesla app publishes that ceiling after its vehicle command completes successfully. This is evidence of the configured limit, never evidence of running power; binary state and measured power remain separate. An API response alone publishes no observation. The generic adapter activation policy prepares and observes current before issuing start; it does not assume an unknown initial step was applied.

## User Flow alternative

Use **Stepped device target changed**, select the PELS device, connect it to the vendor current action. Pass **EV charger current (A)** to that action. Start/stop stays with the capability adapter.

Built-in current control rejects stepped reports from an old user Flow.

## Verified boundary

On 2026-10-13, SHS running Homey 13.5.0 rejected app-session action execution with **403 Missing Scopes**. A temporary key with only `homey.flow` successfully executed the test-device app's current action. A read-only Flow key failed. The temporary keys were revoked and the original SHS app restored. That experiment used a virtual charger, not a physical Tesla or Zaptec.

The transport does not retry action POSTs or follow redirects. An unknown command outcome retains its device lock until the outstanding response completes or the bounded late-response timeout expires. Command acceptance does not publish observed state.


The Request ID guard mentioned in the historical validation below has since been removed. Current Flow setup uses only the trigger and current-setting action.

### SHS regression run, 2026-10-13

The feature build (Homey manifest version 3.12.2) was installed on SHS and exercised through its real app API, Homey Flow engine, device observations and meter-driven planner. Temporary simulator apps used the Tesla and Zaptec vendor IDs, capability definitions and device-owned action cards. They did not call Tesla Fleet or Zaptec cloud services. The writable Zaptec variant exercised the capability route as well. Local validation/install work ran serially; subsequent work used lightweight API calls. The final permission build ran on one CPU core at low priority.

The run found that the SDK geolocation manager returned null coordinates without the `homey:manager:geolocation` permission, which correctly blocked Tesla control. That permission was later dropped: the hub location is now read through the owner Web API (`manager/geolocation/option/location`), which `homey:manager:api` already grants and which the weather and solar forecasts also use (`lib/device/hubHomeLocation.ts`). Until the first read is accepted, Tesla home authorization fails closed; a failed read keeps the last accepted location.

Verified on the installed app:

- Flow-scoped key accepted; read-only and invalid keys rejected; failed replacement preserved the working key; revocation produced `permission_denied`; removal cleared access.
- Saving a key did not switch control methods. Status and settings bootstrap exposed neither the key value nor its private setting.
- Ordinary and Advanced Flow current actions blocked built-in activation and appeared by name; removing the actions cleared the conflict.
- Tesla discovery produced the ordinary EV model, 55% SoC, current steps and home-attributed power. Normal overload handling reduced current, paused charging and later resumed through the planner.
- Away, moving, offline, disconnected, complete, DC charging and unavailable-location cases blocked commands and attributed zero vehicle charging power to the home.
- Read-only Zaptec current used a device-owned action with all three phase arguments. A rejected action retained the observed 16 A; after clearing the fault and checking access, control recovered.
- A 23-second action delay exceeded the 15-second caller timeout. The observation remained 16 A at timeout, exactly one action ran, and the later device report confirmed the requested 6 A.
- Writable Zaptec current used capability writes with no key and no action-card invocation. A second known charger blocked installation-wide built-in control.
- A real PELS-triggered user Flow, including the Request ID condition, controlled Tesla current with no key. An invalid Request ID returned false.
- The ordinary EV Flow cards created a 60% charging task from Tesla's 55% SoC and cleared it again. This verified task admission and data availability, not a completed physical charging schedule.

**Fixed: paused-current confirmation stall.** The original run required zero-current/zero-power timestamps to advance after a successful current command, but unchanged Homey capability values did not advance them. The adapter now admits the reported current limit as preparation evidence only when the vehicle is explicitly stopped with dated zero measurements. Running adjustment confirmation retains the stricter measurement requirements. The change stays in Tesla normalization; generic planner and executor behavior is unchanged.

A follow-up SHS reproduction started paused at 16 A, requested 6 A once, and confirmed it without any change to either zero measurement or its timestamp. Charging then started after the ordinary restore cooldown (72 seconds including meter sampling), drawing 4.14 kW in the simulator. A separate failed-current scenario kept its 16 A limit and never issued start across six meter cycles. Focused tests cover missing/contradictory stopped evidence, realtime preparation without fabricated power, and continued running-measurement confirmation.

Cleanup verified restoration of all 12 edited configuration keys, revocation of both temporary keys, deletion of simulator apps/devices and temporary Flows, and removal of the temporary read-only diagnostic wrapper. At the end of that run, PELS 3.12.2 with the permission fix was left installed on SHS. The app reported running, not crashed, with zero crashes. The primary checkout stayed clean.

Local evidence is under `/tmp/pels-charging-shs-20261013/`: `access-results.json`, `flow-results.json`, `location-results.json`, `shared-result.json`, `zaptec-failure-result.json`, `delay-result.json`, `native-result.json`, `key-lifecycle-result.json`, `smart-task-result.json`, `echo-only-result.json`, `unchanged-telemetry-result.json`, `late-resume-result.json`, `samples.jsonl` and `cleanup-result.json`. Temporary key material was deleted after revocation.

Follow-up paused-current evidence is under `/tmp/pels-paused-tesla-fix-20261013/`: `assertions.json`, `samples.jsonl`, `resume-result.json`, `failure-result.json` and `cleanup-result.json`. Its temporary key was revoked and deleted, the Tesla simulator was removed, and all edited settings were restored. At the end of that follow-up, the corrected feature build was left on SHS. These checks exercise Homey's real API and planner with a simulator.


### Readiness review after updating to main, 2026-10-13

The feature was updated onto main `5aaf7d96f` before delivery. Hold its PR unmerged until the next release from main is complete; the feature does not bump the release version.

Review corrections:

- Transient vendor command failures no longer invalidate the shared verified key. A later planned command can retry after normal control policy permits it; action POSTs themselves are never automatically retried. Authentication failures still invalidate access. The earlier SHS scenario above used a manual check to recover; that is no longer required after a vendor failure.
- Explicit Tesla control revocation remains available when key access or Flow inventory checks fail.
- Complete device reads are validated before home-session ingestion. Malformed reads retain accepted observations. Valid Tesla `Unknown`, `NoPower` and `Calibrating` states revoke control without inventing a new EV plug observation.
- Fresh return-home evidence can restore availability, while an unavailable Homey device remains unavailable. Returning home does not replay stale charging power.
- Settings events invalidate outstanding Flow request IDs synchronously, including an off/on configuration cycle before the next condition check.
- Setup instructions and button layout were checked at 320 and 480 px in light and dark Homey rendering.

Focused integration, read-contract, recommendation and browser checks cover these corrections. The earlier SHS runs documented above preceded this main update and readiness pass; the final runtime was tested separately below.


### Final-runtime SHS regression, 2026-10-13

The readiness runtime from `c3ad7a4a5` (manifest 3.13.0) was installed on SHS after the main update. Through the real Homey API, Flow engine and meter-driven planner, the Tesla simulator verified:

- A rejected current command left the reported limit at 16 A, kept the shared access status ready and issued no start command.
- A later planned retry successfully prepared 6 A and resumed after the normal restore cooldown, without a manual access check.
- Fresh return-home coordinates restored availability without replaying the previous charging power.
- Full device refreshes in `Unknown`, `NoPower` and `Calibrating` each made the vehicle unavailable with zero attributed home power.
- Explicit vehicle-control authorization could be removed after removing the key.

Evidence is under `/tmp/pels-charging-readiness-20261013/`, including `readiness-results.json`, installation logs and `cleanup-result.json`. The temporary key was revoked, the simulator was deleted, all 12 edited settings were restored, and the previously installed SHS app was restored.

The subsequent full push suite also caught PELS battery-report actions being included in the new vendor app-action write inventory. The normalizer now preserves the existing exclusion for PELS bridge/report cards; existing inventory tests and a new vendor-action case cover that correction. This final normalizer change was made after the SHS run.

### PR review corrections, 2026-10-13

Copilot and CodeRabbit reviewed head `a9310e224`. Verified findings were fixed:

- Clamp the haversine term so antipodal rounding cannot authorize remote control.
- Admit Flow step reports against the live selected route while a snapshot refresh is pending or fails. A committed configuration save remains successful if only its projection refresh fails.
- Retain the actual Homey-action transport on unknown-outcome timeout diagnostics.
- Bound SDK address/identity resolution before the HTTP timeout begins.
- Provide a setup-load retry, retain entered keys after failed saves, and refresh charging recommendations after read failures and on tab revisits.

The reported stale-map save race was rejected: `list()` calls `setup()`/`sync()` after its awaited Flow inventory read, and concurrent saves mutate the same owner-held map synchronously. No separate settings-import writer for this key exists in the current implementation.

Focused regressions passed (115 runtime, 39 UI), and charging setup browser scenarios passed at 320/480 px in light/dark rendering. These review corrections were validated locally and remain subject to the final CI gate, not reinstalled on SHS; the SHS evidence above remains tied to its recorded commit.

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
