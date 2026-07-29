import {
  getTerminationExitCode,
  signalExitCode,
  spawnManagedChild,
} from './managed-child.mjs';

export const createLinePrefixer = (label, write) => {
  let buffer = '';
  return {
    push: (chunk) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        write(`[${label}] ${line}\n`);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    },
    flush: () => {
      if (buffer.length > 0) {
        write(`[${label}] ${buffer}\n`);
        buffer = '';
      }
    },
  };
};

export const runOne = (command, args, label) => new Promise((resolve) => {
  const start = Date.now();
  console.log(`[${label}] starting: ${command} ${args.join(' ')}`);
  const child = spawnManagedChild(command, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutPrefixer = createLinePrefixer(label, (line) => process.stdout.write(line));
  const stderrPrefixer = createLinePrefixer(label, (line) => process.stderr.write(line));

  child.stdout.on('data', (chunk) => stdoutPrefixer.push(chunk));
  child.stderr.on('data', (chunk) => stderrPrefixer.push(chunk));

  child.on('error', (error) => {
    stdoutPrefixer.flush();
    stderrPrefixer.flush();
    console.error(`[${label}] failed to spawn: ${error.message}`);
    resolve({ label, code: 1 });
  });

  child.on('close', (code, signal) => {
    stdoutPrefixer.flush();
    stderrPrefixer.flush();
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    const resultCode = getTerminationExitCode()
      ?? (signal ? signalExitCode(signal) : (code ?? 1));
    const status = resultCode === 0 ? 'ok' : `exit ${resultCode}`;
    console.log(`[${label}] done (${status}) in ${seconds}s`);
    resolve({ label, code: resultCode });
  });
});

export const runBounded = async (commands, maxConcurrency = 2) => {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('maxConcurrency must be a positive integer');
  }

  const results = [];
  let nextIndex = 0;
  let failed = false;

  const worker = async () => {
    while (!failed && nextIndex < commands.length) {
      const entry = commands[nextIndex];
      nextIndex += 1;
      const result = await runOne(entry.command, entry.args, entry.label);
      results.push(result);
      if (result.code !== 0) {
        failed = true;
      }
    }
  };

  const workerCount = Math.min(maxConcurrency, commands.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  const failures = results.filter((result) => result.code !== 0);
  if (failures.length > 0) {
    console.error(`\nFailed: ${failures.map((result) => result.label).join(', ')}`);
    process.exit(failures[0].code);
  }
};

export const runParallel = (commands) => runBounded(commands, 2);

export const runSequential = (commands) => runBounded(commands, 1);
