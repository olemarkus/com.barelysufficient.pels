#!/usr/bin/env node
// PELS end to end on a real Homey, from a clean install. Unlike the runtime
// e2e (`test/e2e/`), nothing here is a mock of Homey: the scenarios pair
// fixture devices, set PELS up through the settings keys and routes the
// settings UI uses, and read back what PELS does to the devices and what it
// serves the UI.
//
//   npm run e2e:homey                        every scenario, after a clean install
//   npm run e2e:homey -- --scenario drift-breaker
//   npm run e2e:homey -- --skip-install      reuse the Homey as the last run left it
//
// See notes/testing-taxonomy.md for target and fixture app configuration.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  commitOf,
  createFixtureDevices,
  createHomeyApi,
  createPels,
  installClean,
  resolveTarget,
  stopRunSessions,
  verifyTarget,
} from './lab.mjs';
import { driftBreaker } from './scenarios/driftBreaker.mjs';

const SCENARIOS = [driftBreaker];

const PELS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readAppId = (dir) => JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8')).id;

const resolveFixtureApp = (pelsAppId, skipInstall) => {
  const id = process.env.TEST_DEVICES_APP_ID;
  if (!id || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(id)) {
    throw new Error('Set TEST_DEVICES_APP_ID to the fixture app ID from its app.json.');
  }
  if (id === pelsAppId) throw new Error('TEST_DEVICES_APP_ID must differ from the PELS app ID.');
  if (skipInstall) return { id };
  const dir = process.env.TEST_DEVICES_DIR;
  if (!dir) throw new Error('Set TEST_DEVICES_DIR to the fixture app source checkout.');
  if (readAppId(dir) !== id) throw new Error('TEST_DEVICES_APP_ID must match app.json in TEST_DEVICES_DIR.');
  return { id, dir };
};

const parseArgs = (argv) => {
  const scenarioAt = argv.indexOf('--scenario');
  const scenario = scenarioAt >= 0 ? argv[scenarioAt + 1] : undefined;
  if (scenarioAt >= 0 && (!scenario || scenario.startsWith('--'))) {
    throw new Error('--scenario requires a scenario name.');
  }
  return { skipInstall: argv.includes('--skip-install'), scenario };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = args.scenario ? SCENARIOS.filter(({ name }) => name === args.scenario) : SCENARIOS;
  if (scenarios.length === 0) {
    throw new Error(`No scenario "${args.scenario}"; known: ${SCENARIOS.map(({ name }) => name).join(', ')}`);
  }
  const pelsAppId = readAppId(PELS_DIR);
  const fixtureApp = resolveFixtureApp(pelsAppId, args.skipInstall);
  const box = resolveTarget();
  const api = createHomeyApi(box);
  await verifyTarget(box, api);
  const pels = createPels(api, pelsAppId);
  const fixtures = createFixtureDevices(api, fixtureApp.id);
  console.log(`e2e on ${box.name} (${box.id}) at ${box.url}`);

  if (!args.skipInstall) {
    for (const appId of [fixtureApp.id, pelsAppId]) {
      for (const { pid, cwd } of await stopRunSessions(box, appId)) {
        console.log(`stopped homey app run ${pid} (${cwd}), which held ${appId} on this Homey`);
      }
    }
    console.log(`installing fixture app ${commitOf(fixtureApp.dir)} with --clean`);
    await installClean(box, api, fixtureApp.dir, fixtureApp.id);
    // The settings page is generated and untracked, and Homey refuses an app without it.
    execFileSync('npm', ['run', 'build:settings'], { cwd: PELS_DIR, stdio: 'inherit' });
    console.log(`installing PELS ${commitOf(PELS_DIR)} with --clean`);
    await installClean(box, api, PELS_DIR, pelsAppId);
  }

  const failures = [];
  for (const scenario of scenarios) {
    const startedAt = Date.now();
    console.log(`\n▶ ${scenario.name}: ${scenario.summary}`);
    try {
      await scenario.run({ api, fixtures, pels, log: (line) => console.log(`  ${line}`) });
      console.log(`✓ ${scenario.name} (${Math.round((Date.now() - startedAt) / 1000)} s)`);
    } catch (error) {
      failures.push(scenario.name);
      console.log(`✗ ${scenario.name}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    console.log(`\n${failures.length} of ${scenarios.length} failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`\nall ${scenarios.length} passed`);
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
