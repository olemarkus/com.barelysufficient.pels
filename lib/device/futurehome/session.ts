import { SettingCurrentLimitSession } from '../settingCurrentLimitSession';
import { isFuturehomeCharger, readCurrentLimit } from './identity';

/** Dates the Futurehome charger's `currentLimit` setting (`SettingCurrentLimitSession`). */
export class FuturehomeChargerSession extends SettingCurrentLimitSession {
  constructor() { super({ matches: isFuturehomeCharger, readCurrentLimit }); }
}
