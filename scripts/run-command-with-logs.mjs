#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const TMP_DIR = path.join(REPO_ROOT, 'tmp');
const SIGNALS_TO_FORWARD = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const sanitizeFileToken = (value) => value
  .trim()
  .replace(/[^A-Za-z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  || 'unknown';

const parseArgs = (argv) => {
  const args = [...argv];
  let label = 'command';

  while (args[0]?.startsWith('--')) {
    const option = args.shift();
    if (option === '--label') {
      label = args.shift() ?? '';
      continue;
    }
    if (option === '--') break;
    throw new Error(`Unknown option: ${option}`);
  }

  if (args[0] === '--') {
    args.shift();
  }

  if (args.length === 0) {
    throw new Error('Missing command after `--`');
  }

  return {
    command: args[0],
    commandArgs: args.slice(1),
    label: sanitizeFileToken(label),
  };
};

const resolveBranchToken = () => {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (branch) {
      return sanitizeFileToken(branch);
    }
  } catch {
    // Fall through to a stable fallback when git metadata is unavailable.
  }

  return sanitizeFileToken(path.basename(REPO_ROOT));
};

const main = async () => {
  const { command, commandArgs, label } = parseArgs(process.argv.slice(2));
  const branchToken = resolveBranchToken();
  const stdoutPath = path.join(TMP_DIR, `${label}.${branchToken}.stdout.log`);
  const stderrPath = path.join(TMP_DIR, `${label}.${branchToken}.stderr.log`);

  fs.mkdirSync(TMP_DIR, { recursive: true });

  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'w' });
  const stderrStream = fs.createWriteStream(stderrPath, { flags: 'w' });

  console.error(`[${label}] stdout -> ${path.relative(REPO_ROOT, stdoutPath)}`);
  console.error(`[${label}] stderr -> ${path.relative(REPO_ROOT, stderrPath)}`);

  const child = spawn(command, commandArgs, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  let forwardedSignal = null;
  const forwardSignalHandlers = new Map();
  for (const signal of SIGNALS_TO_FORWARD) {
    const handler = () => {
      if (!child.killed) {
        forwardedSignal = signal;
        child.kill(signal);
      }
    };
    forwardSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    stdoutStream.write(chunk);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    stderrStream.write(chunk);
  });

  const closePromise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  let result;
  try {
    result = await closePromise;
  } finally {
    for (const [forwarded, handler] of forwardSignalHandlers) {
      process.removeListener(forwarded, handler);
    }

    await Promise.all([
      new Promise((resolve) => stdoutStream.end(resolve)),
      new Promise((resolve) => stderrStream.end(resolve)),
    ]);
  }

  const { code, signal } = result;

  if (signal) {
    const signalToRaise = forwardedSignal ?? signal;
    process.kill(process.pid, signalToRaise);
    return;
  }

  process.exitCode = code ?? 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
