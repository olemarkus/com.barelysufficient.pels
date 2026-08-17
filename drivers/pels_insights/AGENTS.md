# pels_insights Driver

The virtual device PELS exposes so owners can chart capacity/plan state in Homey Insights.

## Capabilities are a compatibility floor

`driver.compose.json` is the constrained file here: a capability declared in the manifest raises
the **whole app's** `minCompatibility`, not just this driver's.

- **Never declare `target_power`.** It carries `minCompatibility 12.13.0`, and PELS ships
  `>=12.4.0` — declaring it would strip the app from every Homey below 12.13.0.
- Reading or writing `target_power` on a *third-party* device is fine and needs no compat bump,
  provided it degrades gracefully when the capability is absent. The constraint is only on what
  this manifest declares.
- Before adding any capability, check its `minCompatibility` against the app's floor in
  `.homeycompose/app.json`.

## Retired capabilities

Capabilities removed from this driver stay listed in `RETIRED_CAPABILITIES` (`device.ts:70`) and are
never pruned on install age — a removal that fails is swallowed, so the list *is* the retry. Do not
"clean it up" because an entry looks long-dead.
