import type Homey from 'homey';
import { getLogger } from '../lib/logging/logger';
import { repairUnusableSteppedConfigurations } from './steppedProfileRepair';

const migrationLogger = getLogger('startup/boot-migrations');

type BootMigrationsParams = {
  homey: Homey.App['homey'];
};

const UNUSABLE_STEPPED_CONFIG_MARKER = 'boot_migrations_v2_unusable_stepped_config_repaired';

/**
 * Boot-time idempotent migrations.
 *
 * Each migration is gated by its own marker key in Homey settings so it runs
 * exactly once per Homey install. Migrations must be safe to skip on fresh
 * installs (no setting present). Add new entries by appending to
 * `BOOT_MIGRATIONS` with a fresh marker key.
 *
 * A migration that cannot tell "nothing to migrate" from "the read failed"
 * returns `'deferred'`, and the marker is withheld so the next boot retries —
 * the abandon-grace rule from `notes/persisted-settings-state.md`.
 */
type BootMigration = {
  marker: string;
  run: (homey: Homey.App['homey']) => 'applied' | 'deferred';
  describe: string;
};

const BOOT_MIGRATIONS: ReadonlyArray<BootMigration> = [
  {
    marker: UNUSABLE_STEPPED_CONFIG_MARKER,
    describe: 'drop stepped profiles and target-power ranges that yield no usable step ladder',
    run: repairUnusableSteppedConfigurations,
  },
];

export const runBootMigrations = (params: BootMigrationsParams): void => {
  const { homey } = params;
  for (const migration of BOOT_MIGRATIONS) {
    if (homey.settings.get(migration.marker) === true) continue;
    if (migration.run(homey) === 'deferred') {
      migrationLogger.warn({ event: 'boot_migration_deferred', migration: migration.describe });
      continue;
    }
    homey.settings.set(migration.marker, true);
    migrationLogger.info({ event: 'boot_migration_applied', migration: migration.describe });
  }
};
