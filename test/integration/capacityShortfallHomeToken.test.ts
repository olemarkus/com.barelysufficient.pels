// Manifest coverage for the `capacity_shortfall` trigger's `home` token.
//
// The token's `example` is what the Flow editor shows before the card has ever
// fired, and compose JSON cannot import TypeScript — so it hand-duplicates
// `HOMES_MAIN_HOME_NAME`. Nothing else pins the two together: renaming the
// constant would silently leave the Flow editor advertising the old word.
// `app.json` is generated from the compose source by `homey app validate`, so
// the second assertion catches a compose edit that was never regenerated.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HOMES_MAIN_HOME_NAME } from '../../packages/shared-domain/src/homesManagementCopy';

type FlowToken = {
  name: string;
  type: string;
  title: Record<string, string>;
  example?: Record<string, string>;
};

const repoRoot = path.resolve(__dirname, '../..');

const readJson = (relativePath: string): unknown => JSON.parse(
  readFileSync(path.join(repoRoot, relativePath), 'utf8'),
) as unknown;

const composeTrigger = (): { tokens?: FlowToken[]; args?: unknown[] } => (
  readJson('.homeycompose/flow/triggers/capacity_shortfall.json') as {
    tokens?: FlowToken[];
    args?: unknown[];
  }
);

const generatedTrigger = (): { tokens?: FlowToken[]; args?: unknown[] } => {
  const app = readJson('app.json') as { flow?: { triggers?: Array<{ id?: string }> } };
  const trigger = app.flow?.triggers?.find((entry) => entry.id === 'capacity_shortfall');
  if (!trigger) throw new Error('capacity_shortfall is missing from the generated app.json');
  return trigger as { tokens?: FlowToken[]; args?: unknown[] };
};

const homeToken = (trigger: { tokens?: FlowToken[] }): FlowToken => {
  const token = trigger.tokens?.find((entry) => entry.name === 'home');
  if (!token) throw new Error('the capacity_shortfall trigger has no `home` token');
  return token;
};

describe('capacity_shortfall `home` token manifest', () => {
  it('advertises the same Main-home name the runtime fires', () => {
    expect(homeToken(composeTrigger()).example?.en).toBe(HOMES_MAIN_HOME_NAME);
  });

  it('is regenerated into app.json as a string token', () => {
    const token = homeToken(generatedTrigger());
    expect({ type: token.type, example: token.example?.en }).toEqual({
      type: 'string',
      example: HOMES_MAIN_HOME_NAME,
    });
  });

  it('takes no args, so existing Flows keep firing', () => {
    // Tokens are trigger OUTPUTS. Growing `args` would add a filter every saved
    // Flow would suddenly have to satisfy; growing `tokens` cannot.
    expect(generatedTrigger().args).toEqual([]);
  });
});
