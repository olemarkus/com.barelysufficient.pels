# TODO

## Backlog

- [ ] Use Homey Energy live reporting (`ManagerEnergy.getLiveReport`) as source for whole-home metering instead of relying on Flow-reported total power.
- [ ] Architecture tightening: reduce `settings/src/**` imports from `lib/{core,dailyBudget,price}` to a smaller shared-contract surface (current checks warn, not fail).
- [ ] Architecture tightening: remove remaining `lib/utils/** -> lib/{core,plan}` imports by moving those helpers to a better-owned module (current checks warn, not fail).
- [ ] Dead-code tightening: expand the dead-code export check to include settings UI modules so shared `lib/utils` exports no longer need allowlisted exceptions.

## Deferred: restore-pending follow-up tests

- [ ] Per-device scoping: one temperature device is stuck at shed temperature, another is healthy; verify the healthy device can still restore while the stuck one stays pending.
- [ ] Retry window expiry: verify no repeated restore writes within `RESTORE_CONFIRM_RETRY_MS`, then exactly one new restore attempt is allowed after the window expires.
- [ ] Confirmation clears pending: when reported target moves from shed temperature to planned temperature, `restore pending` state disappears immediately.
- [ ] No false pending: device at shed temperature without a recent restore attempt (`lastDeviceRestoreMs` missing or stale) should not be marked `restore pending`.
- [ ] On/off restore path unaffected: ensure `restore pending` logic does not interfere with normal `onoff` restoration.
- [ ] Status classification: devices in `restore pending` should not count as limit-driven shedding in `pels_status.limitReason`.
