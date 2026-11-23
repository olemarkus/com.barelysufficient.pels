import { resolveDeviceDetailKind, type DeviceDetailKind } from '../deviceKind.ts';

// Per-kind composition of the device-detail page: which order the sections
// read in, top to bottom. The section elements are singletons (dom.ts captures
// them once at boot), so the layout REPARENTS the existing nodes rather than
// duplicating markup — element references and listeners survive appendChild
// moves, and `<details open>` state is an attribute that moves with the node.
//
// The layout runs on open and again only when the resolved kind changes (a
// control-model switch to an EV preset re-kinds the page); never per repaint.
// A reorder is also skipped while focus sits inside a section, so a node
// holding focus is never moved mid-interaction — the next open applies it.
//
// Each behaviour switch heads the card it governs: Price-based control in
// Price response, the solar switches in Solar surplus, Power-limit control and
// the rows that refine it in Power limiting. Setup keeps what is set once:
// Managed, Budget exempt, the control model and the wiring.
//
// Ordering rationale (importance × frequency of use):
// - EV charger: Charging (when and how much to charge: boost, solar surplus)
//   is the device's identity; Car says where the battery level comes from;
//   then Power limiting. Setup is set-once, and the step editor (only for
//   non-preset chargers) follows it, collapsed.
// - Temperature: per-mode targets are the controls owners revisit; price and
//   solar are the tuning layer; the limiting choice is consequential but
//   set-once, so it closes the open cards.
// - Stepped: the profile is the device's identity and the thing verified
//   after installation; the limiting choice and solar follow it.
// - Binary: the limiting choice, then running on solar surplus.
// - Battery: continuous planning, its Managed and Power-limit control switches,
//   and its place in the priority order; none of a load's sections apply, so they are hidden
//   here rather than by their own gates (`applyBatteryKindVisibility`).
// - The Temporary card (override, Smart task, schedules) is not in these lists:
//   it stays directly under the status header for every kind.
// Every list carries all sections so hidden, inapplicable ones keep a
// stable DOM position (their own gates keep them hidden).
const SECTION_IDS = {
  batteryPlan: 'device-detail-battery-plan-section',
  battery: 'device-detail-battery-section',
  modes: 'device-detail-modes-section',
  delta: 'device-detail-delta-section',
  surplus: 'device-detail-surplus-section',
  shedding: 'device-detail-shedding-section',
  stepped: 'device-detail-stepped-section',
  charging: 'device-detail-charging-section',
  car: 'device-detail-car-section',
  setup: 'device-detail-setup-section',
  activityLog: 'device-detail-activity-log-section',
  diagnostics: 'device-detail-diagnostics-section',
  // Report a problem: last for every kind, so it is in no kind's own list.
  report: 'device-detail-report-section',
} as const;

type SectionKey = keyof typeof SECTION_IDS;

const ALL_SECTION_KEYS = Object.keys(SECTION_IDS) as SectionKey[];

// The activity log reads before advanced diagnostics for every kind: recent
// state changes are an owner read, the 21-day counters a support read. Only
// the meaningful head is stated per kind; the tail (sections that kind's own
// gates hide) is derived, so an omitted key can never strand a section at the
// previous kind's position.
const SECTION_HEAD: Record<DeviceDetailKind, readonly SectionKey[]> = {
  battery: ['batteryPlan', 'battery', 'activityLog', 'diagnostics'],
  ev_charger: ['charging', 'car', 'shedding', 'setup', 'stepped', 'activityLog', 'diagnostics'],
  temperature: [
    'modes', 'delta', 'surplus', 'stepped', 'shedding', 'setup', 'activityLog', 'diagnostics',
  ],
  stepped: ['stepped', 'shedding', 'surplus', 'setup', 'activityLog', 'diagnostics'],
  binary: ['shedding', 'surplus', 'setup', 'activityLog', 'diagnostics'],
};

const sectionOrderFor = (kind: DeviceDetailKind): readonly SectionKey[] => [
  ...SECTION_HEAD[kind],
  ...ALL_SECTION_KEYS.filter((key) => !SECTION_HEAD[kind].includes(key)),
];

let appliedKind: DeviceDetailKind | null = null;

const sectionElement = (key: SectionKey): HTMLElement | null => (
  document.getElementById(SECTION_IDS[key])
);

const sectionContent = (key: SectionKey): HTMLElement | null => (
  sectionElement(key)?.querySelector<HTMLElement>('.collapse-content') ?? null
);

// Moves are guarded so a refresh that changes nothing touches no node.
const placeBefore = (node: HTMLElement | null, anchor: HTMLElement | null): void => {
  if (!node || !anchor?.parentElement || node.nextElementSibling === anchor) return;
  anchor.parentElement.insertBefore(node, anchor);
};

const placeAfter = (node: HTMLElement | null, anchor: HTMLElement | null): void => {
  if (!node || !anchor?.parentElement || anchor.nextElementSibling === node) return;
  anchor.parentElement.insertBefore(node, anchor.nextSibling);
};

const appendTo = (node: HTMLElement | null, parent: HTMLElement | null): void => {
  if (!node || !parent || node.parentElement === parent && parent.lastElementChild === node) return;
  parent.appendChild(node);
};

// The Managed switch is a singleton: a battery's page carries it in its own
// section, every other page at the head of Setup.
const placeManagedRow = (kind: DeviceDetailKind): void => {
  const row = document.getElementById('device-detail-managed-row');
  if (!row) return;
  if (kind === 'battery') {
    const batteryList = document.getElementById('device-detail-battery-list');
    const notice = document.getElementById('device-detail-battery-takeover-notice');
    if (batteryList && row.parentElement !== batteryList) batteryList.insertBefore(row, notice?.nextSibling ?? null);
    return;
  }
  placeBefore(row, document.getElementById('device-detail-budget-exempt-row'));
  // Managed's hint points to these, so they follow it.
  const energyLink = document.getElementById('device-detail-homey-energy-setup');
  placeAfter(energyLink, row);
  placeAfter(document.getElementById('device-detail-power-setup'), energyLink ?? row);
};

// Power-limit control and the two rows that refine it ("Only PELS starts this
// device", "Leave off until turned on again") are singletons in the Power
// limiting card: the switch and the start policy lead, ahead of what limiting
// does; "Leave off" follows the limited fields. A battery's page carries
// Power-limit control under Managed in its own section instead (the other two
// never show there). Runs after placeManagedRow, so the battery's Managed row
// is already in place to anchor it.
const placePowerLimitRows = (kind: DeviceDetailKind): void => {
  const controllable = document.getElementById('device-detail-controllable-row');
  const startPolicy = document.getElementById('device-detail-start-policy-row');
  const respectExternalOff = document.getElementById('device-detail-respect-external-off-row');
  if (kind === 'battery') {
    placeAfter(controllable, document.getElementById('device-detail-managed-row'));
    return;
  }
  const shedField = document.getElementById('device-detail-shed-field');
  placeBefore(startPolicy, shedField);
  placeBefore(controllable, startPolicy);
  placeBefore(respectExternalOff, document.getElementById('device-detail-electrical-connection-row'));
};

// A battery's page has no Power limiting section; its Electrical connection row
// joins the battery's own control settings. Runs before placePowerLimitRows,
// which anchors "Leave off" on it.
const placeElectricalConnectionRow = (kind: DeviceDetailKind): void => {
  const row = document.getElementById('device-detail-electrical-connection-row');
  const home = kind === 'battery' ? document.getElementById('device-detail-battery-list') : sectionContent('shedding');
  appendTo(row, home);
};

// "Charge on solar surplus" is a charging rule on an EV charger's page, so it
// joins Charge boost in the Charging card; every other page keeps it in the
// Solar surplus card with the other solar switches. The note that stands in
// for the solar switches while solar is on its way goes with it: a charger's
// page places no Solar surplus card, so a note left there would show in a card
// of its own at the foot of the page.
const placeSurplusTrackRow = (kind: DeviceDetailKind): void => {
  const row = document.getElementById('device-detail-surplus-track-row');
  const pendingNote = document.getElementById('device-detail-solar-pending-hint');
  const chargingSetup = document.getElementById('device-detail-solar-charging-setup');
  if (kind === 'ev_charger') {
    // The row and its setup notice sit before the note that closes the card.
    // Place them from the final anchor backward so an unchanged refresh moves nothing.
    if (!pendingNote) {
      appendTo(chargingSetup ?? row, sectionContent('charging'));
      placeBefore(row, chargingSetup);
      return;
    }
    appendTo(pendingNote, sectionContent('charging'));
    placeBefore(chargingSetup, pendingNote);
    placeBefore(row, chargingSetup ?? pendingNote);
    return;
  }
  placeAfter(row, document.getElementById('device-detail-dump-load-row'));
  placeAfter(chargingSetup, row);
  placeAfter(pendingNote, chargingSetup ?? row);
};

// A battery's page shows its own section and none of a load's: Setup holds
// nothing else that applies to it once Managed has moved out. Resolved with the
// kind, so a page that re-kinds (never for a battery) gets them back.
const applyBatteryKindVisibility = (kind: DeviceDetailKind): void => {
  const isBattery = kind === 'battery';
  const battery = sectionElement('battery');
  if (battery) battery.hidden = !isBattery;
  const setup = sectionElement('setup');
  if (setup) setup.hidden = isBattery;
};

export const applyDeviceDetailSectionLayout = (
  device: Parameters<typeof resolveDeviceDetailKind>[0],
): void => {
  const kind = resolveDeviceDetailKind(device);
  placeManagedRow(kind);
  placeElectricalConnectionRow(kind);
  placePowerLimitRows(kind);
  placeSurplusTrackRow(kind);
  applyBatteryKindVisibility(kind);
  if (appliedKind === kind) return;

  const parent = sectionElement('modes')?.parentElement;
  if (!parent) return;
  // Never move the node the user is interacting with (md-select keeps its
  // menu/focus state through a change handler that can re-kind the page).
  // The reorder retries on the next apply; appliedKind stays unset so it does.
  if (document.activeElement && parent.contains(document.activeElement)) return;
  for (const key of sectionOrderFor(kind)) {
    const section = sectionElement(key);
    if (section) parent.appendChild(section);
  }
  appliedKind = kind;
};

// An unmanaged device has one job on its page: get it managed. Expand Setup,
// where Managed by PELS lives, once per device.
// Per-device memory: returning to a device whose Setup the user already
// closed must not re-expand it.
const setupAutoExpandedDeviceIds = new Set<string>();

export const autoExpandSetupWhenUnmanaged = (params: {
  deviceId: string;
  isManaged: boolean;
}): void => {
  if (params.isManaged) {
    setupAutoExpandedDeviceIds.delete(params.deviceId);
    return;
  }
  if (setupAutoExpandedDeviceIds.has(params.deviceId)) return;
  setupAutoExpandedDeviceIds.add(params.deviceId);
  const disclosure = document.getElementById('device-detail-setup-disclosure') as HTMLDetailsElement | null;
  if (disclosure && !disclosure.open) disclosure.open = true;
};
