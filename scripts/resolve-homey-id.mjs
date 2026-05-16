#!/usr/bin/env node
// Resolves a short Homey identifier for log filenames so concurrent
// `npm start` runs against different Homeys don't clobber each other.
// Reads the same config the Homey CLI reads: $HOMEY_HOME if set
// (the `with-homey-shs` wrapper sets this), else ~/.athom-cli.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveHomeyId() {
  const cliHome = process.env.HOMEY_HOME || join(homedir(), ".athom-cli");
  try {
    const raw = readFileSync(join(cliHome, "settings.json"), "utf8");
    const id = JSON.parse(raw)?.activeHomey?.id;
    if (id) return id;
  } catch {
    // fall through
  }
  return "unknown";
}

const id = resolveHomeyId().replace(/[^A-Za-z0-9._-]+/g, "-");
// Short form keeps filenames readable; Homey ids are 24 hex chars.
process.stdout.write(id.length > 12 ? id.slice(-8) : id);
