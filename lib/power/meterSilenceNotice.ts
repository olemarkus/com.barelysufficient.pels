import {
  readingAge,
  resolveStoppedReadingsHint,
  type BannerPowerSource,
} from '../../packages/shared-domain/src/powerReadingsBanner';
import type { Logger as PinoLogger } from '../logging/logger';
import type { NotificationsPort } from '../ports/homeyRuntime';
import { normalizeError } from '../utils/errorUtils';
import { isSamePass, type MeterSilencePass, type MeterSilenceMonitor } from './meterSilence';

export type MeterSilenceNoticeDeps = {
  meterSilence: MeterSilenceMonitor;
  notifications: NotificationsPort;
  /** The running power source, or `null` when the setting cannot be read: the notice then names no remedy. */
  readPowerSource: () => BannerPowerSource | null;
  nowMs: () => number;
  logger: () => Pick<PinoLogger, 'info' | 'warn'>;
};

const LIMITED_LEAD = 'has limited your managed devices to stay within your limits.';

const describeShed = (pass: MeterSilencePass, ageMs: number): string => (
  pass.cause === 'frozen_reading'
    ? `Your power reading has not changed for ${readingAge(ageMs)} while your devices' own readings did, `
      + `so PELS no longer trusts it and ${LIMITED_LEAD} They resume when the reading changes.`
    : `PELS has had no new power reading for ${readingAge(ageMs)} and ${LIMITED_LEAD} `
      + 'They resume when a new reading arrives.'
);

// No limit relies on the meter, so nothing was limited (owner ruling 2026-11-28).
const HELD_LEAD = 'No limit is on, so PELS leaves your managed devices as they are, apart from solar-surplus loads,';

const describeHold = (pass: MeterSilencePass, ageMs: number): string => (
  pass.cause === 'frozen_reading'
    ? `Your power reading has not changed for ${readingAge(ageMs)} while your devices' own readings did, `
      + `so PELS no longer trusts it. ${HELD_LEAD} until the reading changes.`
    : `PELS has had no new power reading for ${readingAge(ageMs)}. ${HELD_LEAD} until a new reading arrives.`
);

const describeStopped = (pass: MeterSilencePass, ageMs: number): string => (
  pass.directive === 'shed' ? describeShed(pass, ageMs) : describeHold(pass, ageMs)
);

const RESUMED_TEXT: Record<MeterSilencePass['directive'], string> = {
  shed: 'PELS has new power readings again and is resuming your managed devices.',
  hold: 'PELS has new power readings again and is planning your managed devices as usual.',
};

/**
 * Tells the owner on Homey's timeline when a meter outage has made PELS limit
 * every managed device, and again when readings return (owner ruling
 * 2026-11-22: the no-readings banner stays the one surface inside settings;
 * the timeline carries this one alert so an owner who is not looking at PELS
 * learns why their devices went off).
 *
 * Driven by the silence policy's block, so it speaks exactly when the
 * fail-closed pass has run: once per silence, never in Simulation mode (the
 * block never engages there), and never for a gap that ends before the pass.
 * The memory of what was sent lives in this process: an outage that spans a
 * restart is announced again once the restarted app's own pass runs.
 */
export class MeterSilenceNotice {
  private announced: MeterSilencePass | null = null;

  private inFlight = false;

  constructor(private readonly deps: MeterSilenceNoticeDeps) {}

  async check(): Promise<void> {
    if (this.inFlight) return;
    const pass = this.deps.meterSilence.blockedSilence();
    if (pass !== null) {
      if (isSamePass(this.announced, pass)) return;
      await this.send(describeStopped(pass, this.deps.nowMs() - pass.silentSinceMs), pass);
      return;
    }
    const announced = this.announced;
    if (announced === null) return;
    // Still silent with its pass owed again (a limit turned on during a hold):
    // the shed's own notice follows, and readings have not returned.
    if (this.deps.meterSilence.shedPassOwedFor() !== null) return;
    await this.send(RESUMED_TEXT[announced.directive], null);
  }

  private async send(lead: string, silence: MeterSilencePass | null): Promise<void> {
    const source = silence === null ? null : this.deps.readPowerSource();
    const excerpt = source === null ? lead : `${lead} ${resolveStoppedReadingsHint(source)}`;
    this.inFlight = true;
    try {
      await this.deps.notifications.createNotification({ excerpt });
      this.announced = silence;
      this.deps.logger().info({
        event: silence === null ? 'meter_silence_resumed_notice_sent' : 'meter_silence_notice_sent',
        ...(silence ?? {}),
      });
    } catch (error) {
      // Left unannounced, so the next check tries again.
      this.deps.logger().warn({ event: 'meter_silence_notice_failed', err: normalizeError(error) });
    } finally {
      this.inFlight = false;
    }
  }
}
