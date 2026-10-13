# Vehicle and charger current control

Tesla Car & Energy's Battery & charging device is an EV load in PELS, even though Homey calls it a sensor. Zaptec's charging switch remains independent of its current-control method. Planning, priorities, EV presets, Smart tasks and state of charge use the existing EV model.

## Setup and authority

Start/stop uses the owning app's writable capability. Current control can use an actual writable current capability, a built-in app action using a Homey API key, or a user Flow. PELS prefers the capability when it is writable according to the installed device's metadata. It never turns a read-only capability into a writable capability.

The owner creates one key per Homey through **Homey Web App → Settings → API Keys**, named **PELS**, granting **Flow** permission. See [Homey's API-key guide](https://support.homey.app/hc/en-us/articles/8178797067292-Create-and-use-API-Keys-on-Homey-Pro). PELS cannot provision this key from its app session. Its API exposes Check/Replace/Remove and sanitized status, never the saved key. The backend-only key setting is owned by `lib/device/transport/chargingAccess.ts`; it is excluded from the explicit settings bootstrap and diagnostics selection.

Saving a key does not change any device's current-control method. Enabling built-in control requires a successful check of ordinary and Advanced Flow inventories. Current-setting actions block that switch; unrelated battery-level reports do not. A saved key and a current-setting Flow produce a recommendation to remove the redundant action and explicitly switch methods. PELS never edits the owner's Flows and never falls back to Flow or app credentials when a selected key route fails.

Choose the EV phase preset and installation limit using the existing Control model settings. The supported current commands are whole amps from 6 to 32 A. Zero/off uses the charging switch, not a sub-minimum charging-current command.

Zaptec installation-current commands affect the whole installation. Built-in control requires explicit single-charger confirmation and refuses a known second charger with the same installation ID. Shared installations retain their existing binary and Flow control.

For Tesla, explicitly choose the vehicle as the control point and disable Power-limit control for the physical charger. A Homey app action uses the exact installed card ID and owning app/device; the UI cannot supply arbitrary action IDs or arguments.

## Vehicle location and observations

The adapter pairs the battery, location and car devices through their raw vehicle identity. It requires a unique pair of siblings, an online parked vehicle, an AC cable and a connected charging state. Home authorization starts with coordinate samples from the preceding ten minutes within 100 m of Homey's configured location. The generic location-update capability is not evidence of a new coordinate sample.

An accepted stationary charging session does not expire merely because its values stay quiet. Away coordinates, motion, disconnection, unavailability, changed identity or a Homey live-feed trust gap revoke authorization. A new session needs fresh coordinate evidence; restart revalidates it. All Tesla writes and Flow request checks use this owner. Charging outside that authorization is excluded from home power attribution. This remains dependent on the Tesla app publishing truthful vehicle and connection state; cloud control cannot provide fast overload protection.

Requested current is a ceiling, not actual draw. While charging, matching ceiling evidence also needs current and power observations at least as recent as the ceiling, and actual current at or below it. Lower draw is valid. While explicitly stopped (`charging_on=false`, `charging_state=Stopped`) with dated zero-current and zero-power observations, the reported ceiling confirms current preparation even if those unchanged zero measurements retain older timestamps. The Tesla app publishes that ceiling after its vehicle command completes successfully. This is evidence of the configured limit, never evidence of running power; binary state and measured power remain separate. An API response alone publishes no observation. The generic adapter activation policy prepares and observes current before issuing start; it does not assume an unknown initial step was applied.

## User Flow alternative

Use **Stepped device target changed**, select the PELS device, then check **Stepped-load request is still valid** with the **Request ID** tag immediately before the vendor current action. Pass **EV charger current (A)** to that action. Do not insert a delay between the check and action. Start/stop stays with the capability adapter.

Request IDs are per device and are invalidated by a newer request, stop, changed control configuration, or an ineligible vehicle session. The condition is a just-before-action guard, not an atomic transaction with another app's action. Built-in current control rejects stepped reports from an old user Flow.

## Verified boundary and remaining hardware validation

On 2026-10-13, SHS running Homey 13.5.0 rejected app-session action execution with **403 Missing Scopes**. A temporary key with only `homey.flow` successfully executed the test-device app's current action. A read-only Flow key failed. The temporary keys were revoked and the original SHS app restored. That experiment used a virtual charger, not a physical Tesla or Zaptec.

The transport does not retry action POSTs or follow redirects. An unknown command outcome retains its device lock until the outstanding response completes or the bounded late-response timeout expires. Command acceptance does not publish observed state. Physical vehicle/charger behavior, Fleet latency and installation-specific limits still need validation before advertising production hardware support.


### SHS regression run, 2026-10-13

The feature build (Homey manifest version 3.12.2) was installed on SHS and exercised through its real app API, Homey Flow engine, device observations and meter-driven planner. Temporary simulator apps used the Tesla and Zaptec vendor IDs, capability definitions and device-owned action cards. They did not call Tesla Fleet or Zaptec cloud services. The writable Zaptec variant exercised the capability route as well. Local validation/install work ran serially; subsequent work used lightweight API calls. The final permission build ran on one CPU core at low priority.

The run found and fixed a missing `homey:manager:geolocation` manifest permission. Without it the SDK returned null coordinates and correctly blocked Tesla control. After adding the permission, the home session was accepted.

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

Cleanup verified restoration of all 12 edited configuration keys, revocation of both temporary keys, deletion of simulator apps/devices and temporary Flows, and removal of the temporary read-only diagnostic wrapper. PELS 3.12.2 with the permission fix remains installed on SHS. The app reported running, not crashed, with zero crashes. The primary checkout stayed clean.

Local evidence is under `/tmp/pels-charging-shs-20261013/`: `access-results.json`, `flow-results.json`, `location-results.json`, `shared-result.json`, `zaptec-failure-result.json`, `delay-result.json`, `native-result.json`, `key-lifecycle-result.json`, `smart-task-result.json`, `echo-only-result.json`, `unchanged-telemetry-result.json`, `late-resume-result.json`, `samples.jsonl` and `cleanup-result.json`. Temporary key material was deleted after revocation. Physical hardware, real vendor cloud timing, multi-hour scheduling and competing cloud controllers remain unverified.

Follow-up paused-current evidence is under `/tmp/pels-paused-tesla-fix-20261013/`: `assertions.json`, `samples.jsonl`, `resume-result.json`, `failure-result.json` and `cleanup-result.json`. Its temporary key was revoked and deleted, the Tesla simulator was removed, and all edited settings were restored. The corrected feature build remains on SHS. These checks exercise Homey's real API and planner with a simulator; physical Tesla hardware remains unverified.


### Readiness review after updating to main, 2026-10-13

The feature was updated onto main `5aaf7d96f` before delivery. Hold its PR unmerged until the next release from main is complete; the feature does not bump the release version.

Review corrections:

- Transient vendor command failures no longer invalidate the shared verified key. A later planned command can retry after normal control policy permits it; action POSTs themselves are never automatically retried. Authentication failures still invalidate access. The earlier SHS scenario above used a manual check to recover; that is no longer required after a vendor failure.
- Explicit Tesla control revocation remains available when key access or Flow inventory checks fail.
- Complete device reads are validated before home-session ingestion. Malformed reads retain accepted observations. Valid Tesla `Unknown`, `NoPower` and `Calibrating` states revoke control without inventing a new EV plug observation.
- Fresh return-home evidence can restore availability, while an unavailable Homey device remains unavailable. Returning home does not replay stale charging power.
- Settings events invalidate outstanding Flow request IDs synchronously, including an off/on configuration cycle before the next condition check.
- Setup instructions and button layout were checked at 320 and 480 px in light and dark Homey rendering.

Focused integration, read-contract, recommendation and browser checks cover these corrections. The SHS runs documented above preceded this main update and readiness pass; they do not establish that the final candidate has been installed. Physical Tesla/Zaptec cloud behavior remains unverified.
