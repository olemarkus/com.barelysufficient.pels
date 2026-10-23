import type { DeviceReason } from '../../../shared-domain/src/planReasonSemantics.ts';
import { buildFixturePlanReason } from '../../../../test/utils/planReasonFixtureParser.ts';

// Settings-UI entry point to the shared fixture-prose grammar. Both test trees
// are the same architectural layer (test code), so this imports the runtime
// tree's parser rather than duplicating 200 lines of regex that would drift.
//
// The grammar moved out of `packages/shared-domain/src/planReasonParsing.ts`
// on 2026-08-07; see that file's replacement header for why. The short version:
// it shipped in production, and its half-populated output forced
// `insufficient_headroom`'s admission fields to be nullable in the production
// reason type.
export const fixtureDeviceReason = (reason: string | undefined): DeviceReason => (
  buildFixturePlanReason(reason)
);
