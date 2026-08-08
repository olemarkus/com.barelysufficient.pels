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
// Ordering rationale (importance × frequency of use):
// - EV charger: the Charging card is the device's identity (control readout,
//   boost, limiting statement); Car feeds it; a step editor exists only for
//   non-preset chargers. Wiring sinks to Setup.
// - Temperature: per-mode targets are the controls owners revisit; price and
//   solar are the tuning layer; the limiting choice is consequential but
//   set-once, so it closes the open cards.
// - Stepped: the profile is the device's identity and the thing verified
//   after installation; the limiting choice follows it.
// - Binary: almost nothing to configure — the limiting statement up top and
//   Setup auto-expanded (see autoExpandSetupWhenBare).
// Every list carries all ten sections so hidden, inapplicable ones keep a
// stable DOM position (their own gates keep them hidden).
const SECTION_IDS = {
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
} as const;

type SectionKey = keyof typeof SECTION_IDS;

const ALL_SECTION_KEYS = Object.keys(SECTION_IDS) as SectionKey[];

// The activity log reads before advanced diagnostics for every kind: recent
// state changes are an owner read, the 21-day counters a support read. Only
// the meaningful head is stated per kind; the tail (sections that kind's own
// gates hide) is derived, so an omitted key can never strand a section at the
// previous kind's position.
const SECTION_HEAD: Record<DeviceDetailKind, readonly SectionKey[]> = {
  ev_charger: ['charging', 'car', 'stepped', 'setup', 'activityLog', 'diagnostics'],
  temperature: ['modes', 'delta', 'surplus', 'stepped', 'shedding', 'setup', 'activityLog', 'diagnostics'],
  stepped: ['stepped', 'shedding', 'setup', 'activityLog', 'diagnostics'],
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

// The EV page carries its limiting statement inside the Charging card (the
// separate "Power limiting" card disappears for EVs); every other kind keeps
// the field in its own section. The field node is a singleton, so it moves.
const placeShedField = (kind: DeviceDetailKind): void => {
  const field = document.getElementById('device-detail-shed-field');
  if (!field) return;
  if (kind === 'ev_charger') {
    const chargingContent = sectionElement('charging')?.querySelector('.collapse-content');
    if (chargingContent && field.parentElement !== chargingContent) {
      chargingContent.appendChild(field);
    }
  } else {
    const sheddingContent = sectionElement('shedding')?.querySelector('.collapse-content');
    if (sheddingContent && field.parentElement !== sheddingContent) {
      // The statement/radiogroup field leads the section, ahead of the
      // limited-temperature parameter row.
      sheddingContent.insertBefore(field, sheddingContent.firstChild);
    }
  }
  const shedding = sectionElement('shedding');
  if (shedding) shedding.hidden = kind === 'ev_charger';
};

export const applyDeviceDetailSectionLayout = (
  device: Parameters<typeof resolveDeviceDetailKind>[0],
): void => {
  const kind = resolveDeviceDetailKind(device);
  if (appliedKind === kind) return;

  const parent = sectionElement('modes')?.parentElement;
  if (!parent) return;
  // The shed-field placement and the shedding-section visibility must track
  // the kind even when the reorder is deferred: the Charging card's own
  // visibility follows the new kind immediately, and skipping this leaves a
  // page with its limiting surface inside a hidden card (or two limiting
  // cards at once) after a control-model change re-kinds the device.
  placeShedField(kind);
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

// A page whose open cards carry no interactive control has one job: get the
// device set up. Expand Setup once per device for unmanaged devices and for
// plain binary devices (their behavior area is a single statement).
let setupAutoExpandedForDeviceId: string | null = null;

export const autoExpandSetupWhenBare = (params: {
  deviceId: string;
  device: Parameters<typeof resolveDeviceDetailKind>[0];
  isManaged: boolean;
}): void => {
  const kind = resolveDeviceDetailKind(params.device);
  const shouldExpand = !params.isManaged || kind === 'binary';
  if (!shouldExpand) {
    setupAutoExpandedForDeviceId = null;
    return;
  }
  if (setupAutoExpandedForDeviceId === params.deviceId) return;
  setupAutoExpandedForDeviceId = params.deviceId;
  const disclosure = document.getElementById('device-detail-setup-disclosure') as HTMLDetailsElement | null;
  if (disclosure && !disclosure.open) disclosure.open = true;
};

// Test seam: clears the applied-layout memo so specs can assert re-application.
export const resetDeviceDetailSectionLayoutForTest = (): void => {
  appliedKind = null;
  setupAutoExpandedForDeviceId = null;
};
