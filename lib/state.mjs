/**
 * Small JSON state store for out-of-process hooks (one file per session key).
 * In-process plugins keep state in memory instead. Failures never throw.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function stateDir(name, env = process.env) {
  const base = String(env.REQALL_STATE_DIR || '').trim();
  return base ? resolve(base, name) : join(tmpdir(), `reqall-${name}`);
}

function fileFor(dir, key) {
  const id = createHash('sha256').update(String(key || 'default')).digest('hex').slice(0, 24);
  return join(dir, `session-${id}.json`);
}

export function loadState(dir, key, defaults = {}) {
  try {
    return { ...defaults, ...JSON.parse(readFileSync(fileFor(dir, key), 'utf8')) };
  } catch {
    return { ...defaults };
  }
}

export function saveState(dir, key, state) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = fileFor(dir, key);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* fail open */ }
  return state;
}
