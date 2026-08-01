// Manifest coverage for the two hard-cap alert triggers.
//
// The `home` token's `example` is what the Flow editor shows before the card has
// ever fired, and compose JSON cannot import TypeScript — so it hand-duplicates
// `HOMES_MAIN_HOME_NAME`. Nothing else pins the two together: renaming the
// constant would silently leave the Flow editor advertising the old word.
// `app.json` is generated from the compose source by `homey app validate`, so
// asserting BOTH sides is what catches a compose edit that was never
// regenerated — either side alone would pass while the two disagreed.
//
// The sustained card's `seconds` range is pinned on both sides too: the
// dispatcher only emits crossings on its own step grid, so a manifest that
// offered finer or larger values than the runtime serves would advertise
// thresholds no Flow could ever reach.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS,
  CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS,
} from '../../setup/capacityShortfallAlertDispatch';
import { HOMES_MAIN_HOME_NAME } from '../../packages/shared-domain/src/homeNames';

type FlowToken = {
  name: string;
  type: string;
  title: Record<string, string>;
  example?: Record<string, string>;
};

type FlowArg = {
  name: string;
  type: string;
  min?: number;
  max?: number;
  step?: number;
};

type FlowTrigger = { tokens?: FlowToken[]; args?: FlowArg[] };

const repoRoot = path.resolve(__dirname, '../..');

const readJson = (relativePath: string): unknown => JSON.parse(
  readFileSync(path.join(repoRoot, relativePath), 'utf8'),
) as unknown;

const composeTrigger = (id: string): FlowTrigger => (
  readJson(`.homeycompose/flow/triggers/${id}.json`) as FlowTrigger
);

const generatedTrigger = (id: string): FlowTrigger => {
  const app = readJson('app.json') as { flow?: { triggers?: Array<{ id?: string }> } };
  const trigger = app.flow?.triggers?.find((entry) => entry.id === id);
  if (!trigger) throw new Error(`${id} is missing from the generated app.json`);
  return trigger as FlowTrigger;
};

const homeToken = (trigger: FlowTrigger, id: string): FlowToken => {
  const token = trigger.tokens?.find((entry) => entry.name === 'home');
  if (!token) throw new Error(`the ${id} trigger has no \`home\` token`);
  return token;
};

describe.each(['capacity_shortfall', 'capacity_shortfall_sustained'])(
  '%s `home` token manifest',
  (id) => {
    it('advertises the same Main-home name the runtime fires', () => {
      expect(homeToken(composeTrigger(id), id).example?.en).toBe(HOMES_MAIN_HOME_NAME);
    });

    it('is regenerated into app.json as a string token', () => {
      const token = homeToken(generatedTrigger(id), id);
      expect({ type: token.type, example: token.example?.en }).toEqual({
        type: 'string',
        example: HOMES_MAIN_HOME_NAME,
      });
    });
  },
);

describe('hard-cap alert trigger args', () => {
  it('leaves capacity_shortfall arg-less, so existing Flows keep firing', () => {
    // Tokens are trigger OUTPUTS. Growing `args` would add a filter every saved
    // Flow would suddenly have to satisfy; growing `tokens` cannot.
    expect(generatedTrigger('capacity_shortfall').args).toEqual([]);
  });

  it.each([
    ['compose source', composeTrigger],
    ['generated app.json', generatedTrigger],
  ])('offers only sustained durations the dispatcher reaches (%s)', (_label, read) => {
    expect(read('capacity_shortfall_sustained').args?.[0]).toMatchObject({
      name: 'seconds',
      type: 'range',
      min: CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS,
      max: CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS,
      step: CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS,
    });
  });
});
