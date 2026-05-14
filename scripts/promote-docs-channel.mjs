import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const channelVariables = {
  live: 'PELS_DOCS_LIVE_REF',
  test: 'PELS_DOCS_TEST_REF',
};

function usage() {
  console.error('Usage: node scripts/promote-docs-channel.mjs <live|test> [ref]');
  console.error('If ref is omitted, the script uses v<app.json version>.');
}

function run(command, args, options = {}) {
  const cwd = options.cwd ?? rootDir;

  console.log(`$ ${command} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function readDefaultRef() {
  const appJson = JSON.parse(await fs.readFile(path.join(rootDir, 'app.json'), 'utf8'));
  return `v${appJson.version}`;
}

const channel = process.argv[2];
const variableName = channelVariables[channel];

if (!variableName) {
  usage();
  process.exit(1);
}

const ref = process.argv[3] ?? await readDefaultRef();

if (ref.startsWith('-')) {
  console.error(`Invalid ref: ${ref}`);
  process.exit(1);
}

await run('git', ['ls-remote', '--exit-code', 'origin', ref]);
await run('gh', ['auth', 'status', '-h', 'github.com']);
await run('gh', ['variable', 'set', variableName, '--body', ref]);
await run('gh', ['workflow', 'run', 'docs.yml', '--ref', 'main']);

console.log(`Promoted docs ${channel} channel to ${ref}.`);
