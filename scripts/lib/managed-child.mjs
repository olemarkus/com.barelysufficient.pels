import { spawn } from 'node:child_process';
import process from 'node:process';

const SIGNAL_EXIT_CODES = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
});

const activeChildren = new Set();
let terminationExitCode;
let handlersInstalled = false;
let exitScheduled = false;

const terminateProcessGroup = (child, signal) => {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};

const scheduleTermination = () => {
  if (exitScheduled || terminationExitCode === undefined) return;
  exitScheduled = true;
  setImmediate(() => process.exit(terminationExitCode));
};

const handlers = Object.fromEntries(
  Object.keys(SIGNAL_EXIT_CODES).map((signal) => [signal, () => {
    terminationExitCode = SIGNAL_EXIT_CODES[signal];
    process.exitCode = terminationExitCode;
    for (const child of activeChildren) {
      terminateProcessGroup(child, signal);
    }
    if (activeChildren.size === 0) scheduleTermination();
  }]),
);

const installHandlers = () => {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const [signal, handler] of Object.entries(handlers)) {
    process.on(signal, handler);
  }
};

const releaseHandlers = () => {
  if (!handlersInstalled) return;
  handlersInstalled = false;
  for (const [signal, handler] of Object.entries(handlers)) {
    process.removeListener(signal, handler);
  }
};

export const getTerminationExitCode = () => terminationExitCode;
export const signalExitCode = (signal) => SIGNAL_EXIT_CODES[signal] ?? 1;

export const spawnManagedChild = (command, args, options) => {
  installHandlers();
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
  });
  activeChildren.add(child);
  child.once('close', () => {
    activeChildren.delete(child);
    if (activeChildren.size > 0) return;
    if (terminationExitCode !== undefined) {
      scheduleTermination();
    } else {
      releaseHandlers();
    }
  });
  return child;
};
