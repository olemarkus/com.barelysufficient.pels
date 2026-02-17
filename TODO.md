# TODO

## Backlog

- [ ] Use Homey Energy live reporting (`ManagerEnergy.getLiveReport`) as source for whole-home metering instead of relying on Flow-reported total power.
- [ ] Investigate apparent priority mismatch in plan view where a higher-priority shed device remains off while a lower-priority device is active (`keep`), and document whether this is cooldown/swap behavior or a planner bug.
- [ ] Fix plan UI responsiveness when changing capacity priorities/order: ensure reordering triggers a plan rebuild and the overview updates immediately.
- [ ] Handle unavailable-device actuation errors (`This device is currently unavailable`) without stalling effective planning: explicitly mark/skip unavailable devices for a cooldown window and surface this in plan status/UI.

## Deferred: restore-pending follow-up tests

- [ ] Per-device scoping: one temperature device is stuck at shed temperature, another is healthy; verify the healthy device can still restore while the stuck one stays pending.
- [ ] Retry window expiry: verify no repeated restore writes within `RESTORE_CONFIRM_RETRY_MS`, then exactly one new restore attempt is allowed after the window expires.
- [ ] Confirmation clears pending: when reported target moves from shed temperature to planned temperature, `restore pending` state disappears immediately.
- [ ] No false pending: device at shed temperature without a recent restore attempt (`lastDeviceRestoreMs` missing or stale) should not be marked `restore pending`.
- [ ] On/off restore path unaffected: ensure `restore pending` logic does not interfere with normal `onoff` restoration.
- [ ] Status classification: devices in `restore pending` should not count as limit-driven shedding in `pels_status.limitReason`.
