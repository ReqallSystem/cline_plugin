#!/usr/bin/env node
/**
 * Installer for the Reqall Cline file hooks, skills and rule (VS Code / JetBrains).
 * The Cline CLI loads the SDK plugin instead: `cline plugin install git:github.com/ReqallSystem/cline_plugin`.
 *
 *   reqall-cline-plugin install   [--scope global|workspace] [--cwd DIR] [--force] [--no-hooks] [--no-skills] [--no-rule]
 *   reqall-cline-plugin uninstall [--scope global|workspace] [--cwd DIR]
 *   reqall-cline-plugin mcp-config
 *   reqall-cline-plugin --json
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
export const HOOK_EVENTS = ['TaskStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'TaskComplete'];
const MARKER = 'reqall-cline-plugin managed';
const WINDOWS = process.platform === 'win32';

function documentsDir(home) {
  // xdg-user-dir reports the real account's folder, so only ask it for the real home.
  if (!WINDOWS && process.platform !== 'darwin' && home === homedir()) {
    try {
      const dir = execFileSync('xdg-user-dir', ['DOCUMENTS'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (dir && dir !== home) return dir;
    } catch { /* xdg-user-dirs not installed */ }
  }
  return join(home, 'Documents');
}

export function targets({ scope = 'global', cwd = process.cwd(), home = homedir() } = {}) {
  const runtime = join(home, '.cline', 'reqall-runtime');
  if (scope === 'workspace') {
    return {
      runtime,
      hooks: join(cwd, '.clinerules', 'hooks'),
      skills: join(cwd, '.cline', 'skills'),
      rule: join(cwd, '.clinerules', 'reqall.md'),
    };
  }
  return {
    runtime,
    hooks: join(documentsDir(home), 'Cline', 'Hooks'),
    skills: join(home, '.cline', 'skills'),
    rule: join(home, '.cline', 'rules', 'reqall.md'),
  };
}

function wrapper(event, script) {
  return WINDOWS
    ? `# ${MARKER}\n$payload = [Console]::In.ReadToEnd()\n$payload | node "${script}" ${event}\n`
    : `#!/bin/sh\n# ${MARKER}\nexec node "${script}" ${event}\n`;
}

/** Skills and the rule are ours when they carry the Reqall name; hooks use MARKER. */
function managed(file) {
  try {
    return /Reqall/.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

export function install(opts = {}) {
  const t = targets(opts);
  const done = [];
  const skipped = [];
  if (opts.hooks !== false) {
    // Copy the hook runtime to a stable location so npx/temporary installs keep working.
    rmSync(t.runtime, { recursive: true, force: true });
    mkdirSync(t.runtime, { recursive: true });
    for (const part of ['hooks', 'lib', 'package.json']) cpSync(join(ROOT, part), join(t.runtime, part), { recursive: true });
    const script = join(t.runtime, 'hooks', 'reqall-hook.mjs');
    mkdirSync(t.hooks, { recursive: true });
    for (const event of HOOK_EVENTS) {
      const file = join(t.hooks, WINDOWS ? `${event}.ps1` : event);
      if (existsSync(file) && !readFileSync(file, 'utf8').includes(MARKER) && !opts.force) {
        skipped.push(`${file} (existing hook; use --force to replace)`);
        continue;
      }
      writeFileSync(file, wrapper(event, script));
      if (!WINDOWS) chmodSync(file, 0o755);
      done.push(file);
    }
  }
  if (opts.skills !== false) {
    for (const name of readdirSync(join(ROOT, 'skills'))) {
      const dest = join(t.skills, name);
      if (existsSync(dest) && !managed(join(dest, 'SKILL.md')) && !opts.force) {
        skipped.push(`${dest} (existing skill; use --force to replace)`);
        continue;
      }
      rmSync(dest, { recursive: true, force: true });
      cpSync(join(ROOT, 'skills', name), dest, { recursive: true });
      done.push(dest);
    }
  }
  if (opts.rule !== false) {
    if (existsSync(t.rule) && !managed(t.rule) && !opts.force) {
      skipped.push(`${t.rule} (existing rule; use --force to replace)`);
    } else {
      mkdirSync(dirname(t.rule), { recursive: true });
      writeFileSync(t.rule, readFileSync(join(ROOT, 'REQALL.md'), 'utf8'));
      done.push(t.rule);
    }
  }
  return { installed: done, skipped };
}

export function uninstall(opts = {}) {
  const t = targets(opts);
  const removed = [];
  for (const event of HOOK_EVENTS) {
    const file = join(t.hooks, WINDOWS ? `${event}.ps1` : event);
    if (existsSync(file) && readFileSync(file, 'utf8').includes(MARKER)) {
      rmSync(file);
      removed.push(file);
    }
  }
  for (const name of readdirSync(join(ROOT, 'skills'))) {
    const dest = join(t.skills, name);
    if (managed(join(dest, 'SKILL.md'))) {
      rmSync(dest, { recursive: true, force: true });
      removed.push(dest);
    }
  }
  if (managed(t.rule)) {
    rmSync(t.rule);
    removed.push(t.rule);
  }
  return { removed };
}

export function mcpConfig() {
  return {
    mcpServers: {
      reqall: {
        type: 'streamableHttp',
        url: 'https://www.reqall.net/mcp',
        headers: { Authorization: 'Bearer ${env:REQALL_API_KEY}' },
        disabled: false,
        timeout: 60,
        autoApprove: ['search', 'get_record', 'list_records', 'list_links', 'impact', 'list_projects'],
      },
    },
  };
}

function manifest() {
  return {
    name: PKG.name,
    version: PKG.version,
    plugin: './plugin.js',
    hookEvents: HOOK_EVENTS,
    skills: readdirSync(join(ROOT, 'skills')).sort(),
    rule: 'REQALL.md',
    mcpServer: 'https://www.reqall.net/mcp',
  };
}

function parse(argv) {
  const opts = { scope: 'global' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scope') opts.scope = argv[++i];
    else if (arg === '--workspace') opts.scope = 'workspace';
    else if (arg === '--global') opts.scope = 'global';
    else if (arg === '--cwd') opts.cwd = resolve(argv[++i]);
    else if (arg === '--force') opts.force = true;
    else if (arg === '--no-hooks') opts.hooks = false;
    else if (arg === '--no-skills') opts.skills = false;
    else if (arg === '--no-rule') opts.rule = false;
    else rest.push(arg);
  }
  if (!['global', 'workspace'].includes(opts.scope)) throw new Error(`Unknown scope: ${opts.scope}`);
  return { command: rest[0] || 'help', opts };
}

function main() {
  const { command, opts } = parse(process.argv.slice(2));
  switch (command) {
    case '--json':
    case 'manifest':
      console.log(JSON.stringify(manifest(), null, 2));
      break;
    case 'install': {
      const result = install(opts);
      for (const p of result.installed) console.log(`installed ${p}`);
      for (const p of result.skipped) console.log(`skipped   ${p}`);
      console.log('\nAdd the Reqall MCP server: `reqall-cline-plugin mcp-config` prints the entry for cline_mcp_settings.json.');
      console.log('Restart Cline (or reload the VS Code window) so hooks, skills and rules are picked up.');
      break;
    }
    case 'uninstall': {
      const result = uninstall(opts);
      for (const p of result.removed) console.log(`removed ${p}`);
      if (!result.removed.length) console.log('Nothing to remove.');
      break;
    }
    case 'mcp-config':
      console.log(JSON.stringify(mcpConfig(), null, 2));
      break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 10).map((l) => l.replace(/^ \*\s?/, '')).join('\n'));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
