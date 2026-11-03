// The drift breaker on a real Homey (`lib/executor/controlContest.ts`): a
// heater that something outside PELS keeps setting away from PELS's limit is
// reported as contested once it has happened four times within an hour, and
// not before. The outside actor is a Web API write, which is what another app
// or a Flow setting the heater looks like to PELS.
import {
  pairMock,
  readCapability,
  runMockCard,
  setCapability,
  waitFor,
} from '../lab.mjs';

const LIMITED_C = 15;
const OUTSIDE_C = 23;
/** Long enough after a setpoint reads PELS's value for PELS to have confirmed it on a whole-home reading. */
const CONFIRMATION_SETTLE_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const driftBreaker = {
  name: 'drift-breaker',
  summary: 'a heater set away from PELS\'s limit four times in an hour is reported; three times is not',
  async run({ api, pels, log }) {
    const meter = await pairMock(api, 'han');
    const heater = await pairMock(api, 'mill_v2');
    log(`paired meter ${meter.name} (${meter.id}) and heater ${heater.name} (${heater.id})`);

    const readHeater = async () => {
      const payload = await pels.get('/ui_devices');
      return payload?.devices?.find((device) => device.id === heater.id);
    };
    await waitFor('PELS to list the heater', readHeater, Boolean, { timeoutMs: 180_000 });

    // The whole-home meter, as the Power source page saves it.
    const saved = await pels.post('/ui_homes_save', {
      op: 'set_power_source', source: 'homey_energy', meterDeviceId: meter.id,
    });
    if (saved?.ok !== true) throw new Error(`PELS refused the meter: ${JSON.stringify(saved)}`);
    // A house drawing 5 kW against a 1 kW limit, whose one managed device PELS
    // limits by lowering its setpoint, so PELS keeps asking for that setpoint.
    await runMockCard(api, 'mock_set_power_override', { device: { id: meter.id }, power_w: 5000 });
    await pels.writeSetting('capacity_limit_kw', 1);
    await pels.writeSetting('capacity_margin_kw', 0);
    await pels.writeSetting('capacity_dry_run', false);
    await pels.writeSetting('capacity_enabled', true);
    await pels.writeSetting('overshoot_behaviors', {
      [heater.id]: { action: 'set_temperature', temperature: LIMITED_C },
    });
    await pels.writeSetting('controllable_devices', { [heater.id]: true });
    await pels.writeSetting('managed_devices', { [heater.id]: true });

    const readSetpoint = () => readCapability(api, heater.id, 'target_temperature');
    await waitFor(`PELS to limit the heater to ${LIMITED_C} °C`, readSetpoint, (value) => value === LIMITED_C, {
      timeoutMs: 300_000,
    });
    log(`PELS limited the heater to ${LIMITED_C} °C`);
    await sleep(CONFIRMATION_SETTLE_MS);

    for (let round = 1; round <= 4; round += 1) {
      await setCapability(api, heater.id, 'target_temperature', OUTSIDE_C);
      await waitFor(`round ${round}: PELS to set the heater back`, readSetpoint, (value) => value === LIMITED_C, {
        timeoutMs: 180_000,
      });
      await sleep(CONFIRMATION_SETTLE_MS);
      const contest = (await readHeater())?.controlContest;
      log(`round ${round}: set back to ${LIMITED_C} °C; contest ${contest ? JSON.stringify(contest) : 'none'}`);
      if (round < 4 && contest) throw new Error(`reported as contested after only ${round} rounds`);
    }

    const contest = (await readHeater())?.controlContest;
    if (contest?.setting !== 'temperature' || contest.commanded !== LIMITED_C || contest.observed !== OUTSIDE_C
      || contest.count !== 4) {
      throw new Error(`expected ${LIMITED_C} °C set and ${OUTSIDE_C} °C reported 4 times, got ${JSON.stringify(contest)}`);
    }
  },
};
