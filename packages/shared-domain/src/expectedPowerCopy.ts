/*
 * User-facing copy for the device page's "Power when running" field — the
 * manual expected-power figure.
 *
 * Shared rather than inlined in the view per
 * `packages/settings-ui/src/ui/views/AGENTS.md`, so the wording has one home.
 * Plain language throughout: the owner is told where the number standing right
 * now came from, never which rung of a ladder won.
 */

import type { ExpectedPowerSource } from '../../contracts/src/types';

/**
 * Reached only for a value outside the contract's union — `source` narrows to
 * `never`, so adding a rung to the expected-power ladder is a compile error
 * until it gets a sentence below. The branch exists because the payload crosses
 * a JSON boundary: rendering nothing beats throwing inside the device page.
 */
const noSourceSentence = (_source: never): string => '';

/**
 * Where the figure standing right now came from — one sentence about the
 * present, never a history. No timestamps, no "changed from X to Y": what makes
 * the override decision informed is the source answering NOW.
 *
 * This is the sanctioned use of `expectedPowerSource` (see its docblock in
 * `packages/contracts/src/types.ts`): telling the owner where the number came
 * from. It must never gate behaviour.
 *
 * `default` is the case that matters most. PELS has nothing to go on and picked
 * a figure, which is what makes a device look far cheaper or dearer to resume
 * than it is — so that line reads as an invitation to correct it, not as a fact.
 *
 * The parameter is REQUIRED: the producer always knows which rung it took, so
 * there is no absent case for this copy to invent a sentence for.
 * (`DeviceDescriptor.expectedPowerSource` is still declared optional; the caller
 * carries that one narrowing until the contract tightens.)
 */
export const expectedPowerSourceLine = (source: ExpectedPowerSource): string => {
  switch (source) {
    case 'manual':
      return 'This is your figure.';
    case 'load-setting':
      return 'From this device’s own settings in Homey.';
    case 'measured-peak':
      return 'PELS measured this while the device was running.';
    case 'homey-energy':
      return 'From Homey’s energy information for this device.';
    case 'default':
      return 'PELS has no reading for this device yet, so it is using a rough estimate. '
        + 'Enter the figure if you know it.';
    default:
      return noSourceSentence(source);
  }
};
