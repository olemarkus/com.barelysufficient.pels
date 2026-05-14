import type Homey from 'homey';

type BootMigrationsParams = {
  homey: Homey.App['homey'];
  log: (message: string) => void;
};

const EV_SETTING_CLEANUP_MARKER = 'boot_migrations_v1_ev_setting_cleanup_done';
const ORPHAN_EV_SUPPORT_KEY = 'experimental_ev_support_enabled';

/**
 * Boot-time idempotent migrations.
 *
 * Each migration is gated by its own marker key in Homey settings so it runs
 * exactly once per Homey install. Migrations must be safe to skip on fresh
 * installs (no setting present). Add new entries by appending to
 * `BOOT_MIGRATIONS` with a fresh marker key.
 */
type BootMigration = {
  marker: string;
  run: (homey: Homey.App['homey']) => void;
  describe: string;
};

const BOOT_MIGRATIONS: ReadonlyArray<BootMigration> = [
  {
    marker: EV_SETTING_CLEANUP_MARKER,
    describe: `unset orphan setting "${ORPHAN_EV_SUPPORT_KEY}" (removed in EV-by-default rollout)`,
    run: (homey) => {
      homey.settings.unset(ORPHAN_EV_SUPPORT_KEY);
    },
  },
];

export const runBootMigrations = (params: BootMigrationsParams): void => {
  const { homey, log } = params;
  for (const migration of BOOT_MIGRATIONS) {
    if (homey.settings.get(migration.marker) === true) continue;
    migration.run(homey);
    homey.settings.set(migration.marker, true);
    log(`Boot migration applied: ${migration.describe}`);
  }
};
