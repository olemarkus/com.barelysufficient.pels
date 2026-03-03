import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TextDecoder, TextEncoder } from 'node:util';

const globalWithEncoding = globalThis as typeof globalThis & {
  TextDecoder?: typeof TextDecoder;
  TextEncoder?: typeof TextEncoder;
};

globalWithEncoding.TextEncoder = TextEncoder;
globalWithEncoding.TextDecoder = TextDecoder as typeof TextDecoder;

const {
  readOptionValue,
  stripScriptElements,
} = require('../scripts/lib/settingsUiScriptUtils.cjs') as {
  readOptionValue: (argv: string[], index: number, option: string, valueHint?: string) => string;
  stripScriptElements: (html: string) => string;
};
const { SETTINGS_UI_BOOTSTRAP_KEYS: SCRIPT_BOOTSTRAP_KEYS } = require('../scripts/lib/settingsUiBootstrapKeys.cjs') as {
  SETTINGS_UI_BOOTSTRAP_KEYS: string[];
};

describe('settings UI measurement scripts', () => {
  it('removes script tags from benchmark HTML fixtures', async () => {
    const sanitized = stripScriptElements(`
      <html>
        <body>
          <script src="https://example.com/a.js"></script>
          <script>window.alert('boom')</script>
          <script type="module" src="/assets/app.js"></script>
          <div>safe</div>
        </body>
      </html>
    `);

    expect(sanitized).toContain('<div>safe</div>');
    expect(sanitized.toLowerCase()).not.toContain('<script');
  });

  it('reports missing benchmark option values clearly', async () => {
    expect(() => readOptionValue(['--baseline-dir'], 0, '--baseline-dir')).toThrow('Missing value for --baseline-dir');
    expect(() => readOptionValue(['--latencies'], 0, '--latencies')).toThrow('Missing value for --latencies');
    expect(() => readOptionValue(['--iterations'], 0, '--iterations', ' (expected a number)')).toThrow(
      'Missing value for --iterations (expected a number)',
    );
  });

  it('reports missing Homey measurement option values clearly', async () => {
    expect(() => readOptionValue(['--app-id'], 0, '--app-id')).toThrow('Missing value for --app-id');
    expect(() => readOptionValue(['--baseline-dir'], 0, '--baseline-dir')).toThrow('Missing value for --baseline-dir');
    expect(() => readOptionValue(['--homey-id'], 0, '--homey-id')).toThrow('Missing value for --homey-id');
    expect(() => readOptionValue(['--iterations'], 0, '--iterations', ' (expected a number)')).toThrow(
      'Missing value for --iterations (expected a number)',
    );
  });

  it('loads the Homey measurement module without a TypeScript loader', async () => {
    const result = spawnSync(
      process.execPath,
      ['-e', "import('./scripts/measure-settings-ui-homey.mjs').then((module) => { console.log(typeof module.parseArgs); })"],
      {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('function');
  });

  it('keeps the script bootstrap keys aligned with the runtime list', async () => {
    const runtimeModule = fs.readFileSync(
      path.resolve(__dirname, '../lib/utils/settingsUiBootstrapKeys.ts'),
      'utf8',
    );
    const runtimeBootstrapKeys = Array.from(
      runtimeModule.matchAll(/'([^']+)'/g),
      (match) => match[1],
    );

    expect(SCRIPT_BOOTSTRAP_KEYS).toEqual([...runtimeBootstrapKeys]);
  });
});
