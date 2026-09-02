import { resolveExplicitMainMeterDeviceId } from '../lib/home/homeConfig';
import type { SoleMeterAdoptionEligibility } from '../lib/power/soleMeterAdoption';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../lib/utils/settingsKeys';
import { readPowerSourceChoice } from './powerSourceChoice';

type SettingsPort = {
  get(key: string): unknown;
  getKeys(): string[];
};

/**
 * The settings adapter for the adoption's eligibility. The source question
 * goes to its owner (`readPowerSourceChoice`: chosen, unset, or suspect).
 * The meter key is read RAW here: this is the one place that must tell a
 * never-written or stored-null meter (nothing chosen, adoptable) apart from
 * a transient miss of an explicit value (defer, try next boot). The reader's
 * job is the post-choice meaning; this classifier owns the pre-choice one.
 */
export const classifySoleMeterAdoptionEligibility = (
  settings: SettingsPort,
): SoleMeterAdoptionEligibility => {
  const choice = readPowerSourceChoice(settings);
  if (choice.state === 'suspect') return { kind: 'defer', reasonCode: choice.reason };
  if (choice.state === 'chosen' && choice.value === 'flow') return { kind: 'settled', detail: 'flow_source' };
  // An unset source is read together with the meter key: the seam writes the
  // meter FIRST and the source second, so a crash in between leaves an
  // explicit meter with no source. That meter is the owner's — never
  // something to overwrite with whatever sole meter is visible today, and
  // the missing source half is completed with it.
  try {
    const meter = classifyMeterKey(settings, choice.state === 'unset' ? 'unset_source' : 'no_meter_chosen');
    if (meter.kind !== 'explicit') return meter;
    return choice.state === 'unset'
      ? { kind: 'complete', meterDeviceId: meter.meterDeviceId }
      : { kind: 'settled', detail: 'explicit_meter' };
  } catch {
    return { kind: 'defer', reasonCode: 'read_failed' };
  }
};

type MeterKeyClassification =
  | Exclude<SoleMeterAdoptionEligibility, { kind: 'settled' | 'complete' }>
  | { kind: 'explicit'; meterDeviceId: string };

const classifyMeterKey = (
  settings: SettingsPort,
  nothingChosen: 'unset_source' | 'no_meter_chosen',
): MeterKeyClassification => {
  const rawMeter = settings.get(HOMEY_ENERGY_METER_DEVICE_ID);
  if (typeof rawMeter === 'string') {
    const meterDeviceId = resolveExplicitMainMeterDeviceId(rawMeter);
    return meterDeviceId === null
      ? { kind: 'defer', reasonCode: 'suspect_meter_value' }
      : { kind: 'explicit', meterDeviceId };
  }
  const keys = settings.getKeys();
  if (keys.length === 0) return { kind: 'defer', reasonCode: 'empty_key_list' };
  const listed = keys.includes(HOMEY_ENERGY_METER_DEVICE_ID);
  // A listed key answering `null` is the legacy stored-null Automatic
  // selection or a transient miss of an explicitly stored id; the value
  // cannot tell them apart, so the component applies a bounded grace before
  // reading it as "nothing chosen". A listed key answering `undefined` is
  // the miss shape this repo has observed, and it defers outright.
  if (rawMeter === null) {
    return { kind: 'eligible', detail: nothingChosen, meterKey: listed ? 'listed_null' : 'unwritten' };
  }
  // A value that is neither a string nor absent is a malformed or transient
  // read of SOMETHING stored: never "nothing chosen".
  if (rawMeter !== undefined) return { kind: 'defer', reasonCode: 'suspect_meter_value' };
  return listed
    ? { kind: 'defer', reasonCode: 'missing_existing_key' }
    : { kind: 'eligible', detail: nothingChosen, meterKey: 'unwritten' };
};
