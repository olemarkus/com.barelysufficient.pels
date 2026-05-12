import { spawn } from 'node:child_process';

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

const runOne = (command, args, label) => new Promise((resolve) => {
  const start = Date.now();
  console.log(`[${label}] starting: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
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

  child.on('close', (code) => {
    stdoutPrefixer.flush();
    stderrPrefixer.flush();
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    const status = code === 0 ? 'ok' : `exit ${code}`;
    console.log(`[${label}] done (${status}) in ${seconds}s`);
    resolve({ label, code: code ?? 1 });
  });
});

export const runParallel = async (commands) => {
  const results = await Promise.all(
    commands.map(({ command, args, label }) => runOne(command, args, label)),
  );

  const failed = results.filter((result) => result.code !== 0);
  if (failed.length > 0) {
    console.error(`\nFailed: ${failed.map((result) => result.label).join(', ')}`);
    process.exit(failed[0].code);
  }
};

export const runSequential = async (commands) => {
  for (const entry of commands) {
    const { code } = await runOne(entry.command, entry.args, entry.label);
    if (code !== 0) {
      process.exit(code);
    }
  }
};
