// Canonical user-facing strings for the Overview device cards.
//
// PELS intentionally shares UI strings with runtime logging from shared-domain
// helpers; these constants keep `deviceOverview.ts` (and any runtime/log
// consumer of `formatDeviceOverview`) drawing from one canonical source aligned
// with `notes/ui-terminology.md`. Keeping the literals here — rather than inline
// in `deviceOverview.ts` — means a terminology change lands in exactly one place
// and the same word reaches the settings UI and the logs.
//
// Terminology rules honoured here (see notes/ui-terminology.md §"Style rules"):
//   - "resume", not "restore" (so the resuming-state line reads `Resuming`).
//   - "available power", not "headroom".
//   - Concrete action words; no internal planner jargon in live status.

// --- Secondary "state" text on a device card (`stateMsg`) ---

// EV charger held / paused. Matches the language on the charger itself.
export const DEVICE_OVERVIEW_CHARGING_PAUSED = 'Charging paused';
// EV charger: a charge command is in flight but the charger still reads off.
export const DEVICE_OVERVIEW_CHARGING_REQUESTED = 'Charging requested';
// EV charger actively charging.
export const DEVICE_OVERVIEW_ACTIVE_CHARGING = 'Active (charging)';

// EV idle variants — name the physical reason so the user can act.
export const DEVICE_OVERVIEW_INACTIVE_CAR_UNPLUGGED = 'Inactive (car unplugged)';
export const DEVICE_OVERVIEW_INACTIVE_CAR_NOT_CHARGING = 'Inactive (car not charging)';
export const DEVICE_OVERVIEW_INACTIVE_DISCHARGING = 'Inactive (discharging)';
export const DEVICE_OVERVIEW_IDLE = 'Idle';
export const DEVICE_OVERVIEW_INACTIVE = 'Inactive';

// Non-EV resume in flight (binary command pending) vs PELS bringing the device
// back as power becomes available. "Resuming" matches the canonical Resuming
// chip — never "Restoring" (notes/ui-terminology.md §"Style rules" rule 1).
export const DEVICE_OVERVIEW_RESUME_REQUESTED = 'Resume requested';
export const DEVICE_OVERVIEW_RESUMING = 'Resuming';

// Active variants for non-EV devices.
/**
 * A device PELS knows about and has not decided anything for this cycle — the
 * ordinary state before the first power reading, and again after a restart.
 *
 * States what PELS is waiting ON rather than what it lacks: the owner's device
 * is fine, the measurement has not arrived. Reuses the wording of the Overview's
 * own no-plan sentence so the card and the page cannot drift apart.
 *
 * Deliberately NOT "yet"-framed as a first-run message — a returning user
 * reaches this state on every restart, and "first" framing would misdescribe it
 * (`notes/ui-terminology.md` §"Empty-state headlines").
 */
export const DEVICE_OVERVIEW_AWAITING_FIRST_READING = 'Waiting for the first power reading';

export const DEVICE_OVERVIEW_ACTIVE = 'Active';
export const DEVICE_OVERVIEW_ACTIVE_TEMPERATURE_MANAGED = 'Active (temperature-managed)';

// Held (shed) state lines. "Limited"/"Lowered"/"Turned off" follow the
// concrete-action vocabulary; "Limited to <step>" names the step the device was
// held at.
export const DEVICE_OVERVIEW_LOWERED = 'Lowered';
export const DEVICE_OVERVIEW_LIMITED = 'Limited';
export const DEVICE_OVERVIEW_TURNED_OFF = 'Turned off';
export const deviceOverviewLimitedToStep = (stepId: string): string => `Limited to ${stepId}`;

// Gray / non-controllable state lines.
// Named after the Setup switch it reflects — the log chip and the toggle must
// not use two names for one control (was 'Capacity control off').
export const DEVICE_OVERVIEW_CAPACITY_CONTROL_OFF = 'Power-limit control off';
export const DEVICE_OVERVIEW_UNAVAILABLE = 'Unavailable';
export const DEVICE_OVERVIEW_STATE_UNKNOWN = 'State unknown';
export const DEVICE_OVERVIEW_UNKNOWN = 'Unknown';

// Deleted 2026-08-02: `Turned off by PELS` / `Lowered by PELS` and their three
// `Would be …(simulation)` variants, along with `resolveHeldStateActionLabel`
// which produced them. They named the ACTION on a card whose bold state word
// already said `Limited`, so they answered nothing the reader could not see; the
// card now states what the device needs instead (`planCardReasonLine.ts`), and
// the hero names the ceiling limiting the house. Do not reintroduce — see
// notes/ui-terminology.md § "Device cards say what a device needs".

// --- Status line (`statusMsg`) ---
// Sentinel: the planner emits this when the device is waiting on power becoming
// available (no richer reason). `appendOverviewStatus` treats it as a blank
// baseline that an SoC/extra status replaces. "available power", not "headroom"
// (notes/ui-terminology.md §"Style rules" rule 1).
export const DEVICE_OVERVIEW_WAITING_FOR_AVAILABLE_POWER = 'Waiting for available power';

// --- Usage readout (`usageMsg`) ---
// Diagnostic data readout, not a vocabulary label, but pinned here so the
// device-overview surface owns its strings in one module.
export const deviceOverviewEvBatteryStatus = (percent: number): string => (
  `EV battery: ${percent} %`
);
