import type { AppContext } from '../../lib/app/appContext';
import { InverterCurtailmentSettings } from '../../lib/solar/inverterCurtailmentSettings';
import type { InverterControlPolicy } from '../../lib/ports/inverterControl';

/** The solar owner's settings policy for this app lifetime. */
export const createInverterControlPolicy = (ctx: AppContext): InverterControlPolicy => (
  new InverterCurtailmentSettings(ctx.homey.settings)
);
