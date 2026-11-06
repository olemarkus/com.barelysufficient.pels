# Device presence and task reservations

A device absent from an objectives evaluation is different from a device whose app is
unavailable. Objectives consume the accepted, metered device projection. Transport owns
inventory read failures and admission; objectives do not reinterpret an HTTP failure as
an empty roster or transfer a commitment between Homey device IDs.

## SHS lifecycle observations

On 2026-11-06, a fresh Homey Self-Hosted Server running 13.5.0 was tested with the local
Test Devices app and one synthetic setpoint heater. The device-manager inventory was
sampled every approximately 200 ms across each operation. App state was checked after
installation. These measurements describe this app and server, not every vendor driver.

| Operation | Inventory and identity observed |
| --- | --- |
| Restart app | Same device ID remained; `available` and `ready` briefly became false, with `App Unavailable`. |
| Disable then enable app | Same device ID remained while disabled; availability recovered after enabling. |
| Install same app version over itself | Same device ID remained; temporary app unavailability. |
| Upgrade app from 0.1.0 to 0.1.1 | Same device ID remained; temporary app unavailability. |
| Uninstall app | Device disappeared from inventory. |
| Install app after uninstall | Inventory remained empty; the old device was not recreated. |
| Pair the exact original driver data again | New Homey device ID; the original driver data was retained. |

During app unavailability, the declared capability list remained, but `capabilitiesObj`
was empty. The existing transport boundary retains previously accepted numeric
observations with their original timestamps; it does not fabricate first observations.
Binary control has its own admission rule and must not be inferred from this heater test.

Polling cannot exclude a transition shorter than the sampling interval. No missing
inventory sample or HTTP failure was observed during restart, reinstall-in-place, or
upgrade. These tests do not establish a one-hour recovery time, nor demonstrate that
an app update normally removes devices from the objectives roster.

To reproduce, use a disposable SHS and a synthetic device. Record the complete device
inventory before and during each operation, including Homey ID, driver data, availability,
readiness, capabilities, and failed reads separately. Preserve the original driver data
for the final re-pair test. Distinguish installing over an app from uninstalling it first.

## Reservation policy

The one-hour grace remains a scheduling policy for a device that is genuinely absent
from the accepted objectives inputs. Its consequence is conservative reservation of
capacity for lower-priority tasks; it does not authorize a command to a missing device.
An explicit unmanaged or out-of-scope decision bypasses that grace.

One objectives-owned presence history must supply lifecycle, planner decoration, and
preview. Live accepted inputs update that history. Preview overlays a hypothetical task
for allocation, but must not submit that overlay as presence evidence, restart a missing
device's grace, or change live commitments. A missing committed task gets at most one
restart grace window from the owner's startup, not a new window per preview request.

Priority ranks still come from the mode catalog, and scheduled energy reservations
still come from the allocator. Presence history is in-memory and carries neither a
second device cache nor persisted ranks. Reappearance and explicit exclusion must be
resolved before retaining a missing task's reservation.
