#!/usr/bin/env node
/**
 * The PostToolUse hook itself. See fence.mjs for what it does and why.
 *
 * Fails open on purpose: any error writes nothing and exits 0, which leaves the
 * tool's output as it was. A fence that throws would stop every browser call,
 * and the fence is a mitigation, not the boundary. The failure goes to stderr,
 * which Claude Code logs, so a broken fence is visible rather than silent.
 */
import { fence } from './fence.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const out = fence(JSON.parse(raw));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    process.stderr.write(`fence-hook: left output unfenced: ${err.message}\n`);
  }
  process.exit(0);
});
