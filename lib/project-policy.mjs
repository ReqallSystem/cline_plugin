/** Canonical portable policy. Keep this module dependency-free for vendoring. */
import { execFileSync } from 'node:child_process';
import { hostname, userInfo, homedir } from 'node:os';
import { openSync, closeSync, fstatSync, readSync, realpathSync, statSync, constants } from 'node:fs';
import { resolve, relative, dirname, join, isAbsolute, sep } from 'node:path';
export function extractProjectHint(text) {
    // Synthetic task notifications can quote labels without selecting a project.
    if (/^\s*\[ASYNC (?:DELEGATION (?:BATCH COMPLETE|COMPLETE|TASK FAILED)\b|SUBAGENT REPORT\])/.test(text))
        return '';
    const match = text.match(/(?<![\w/-])project(?:_name)?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([^\s"'`,;]+))/i);
    return match ? (match[1] ?? match[2] ?? match[3] ?? match[4].replace(/[.,:;!?)\]]+$/, '')).trim() : '';
}
export function machineProjectName(env = process.env) {
    let user = 'unknown';
    let host = 'unknown';
    try {
        user = userInfo().username || user;
    }
    catch { /* restricted OS */ }
    const override = env.REQALL_MACHINE_NAME?.trim();
    if (override)
        host = override;
    else {
        try {
            host = hostname().split('.')[0] || host;
        }
        catch { /* unavailable hostname */ }
    }
    const clean = (segment) => segment.trim().replace(/[\\/\s]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
    return `.machine/${clean(host).toLowerCase()}/${clean(user)}`;
}
export function resolveProjectBinding(cwd = process.cwd(), env = process.env, prompt = '', selected = '') {
    const override = env.REQALL_PROJECT_NAME?.trim();
    if (override)
        return { name: override, source: 'override' };
    try {
        const name = normalizeRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
        if (name)
            return { name, source: 'git' };
    }
    catch { /* no usable origin */ }
    const hint = extractProjectHint(prompt) || selected.trim();
    if (hint)
        return { name: hint, source: 'prompt' };
    return localPortableBinding(cwd, env) ?? { name: machineProjectName(env), source: 'machine' };
}
const MAX_BYTES = 64 * 1024;
function readSmall(path, boundary) {
    let fd;
    try {
        if (boundary !== undefined && !contains(boundary, realpathSync(path)))
            return undefined;
        // NONBLOCK prevents a replaced file/FIFO from hanging a hook.
        fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_BYTES)
            return undefined;
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
            const n = readSync(fd, buffer, length, buffer.length - length, null);
            if (!n)
                break;
            length += n;
        }
        if (length > MAX_BYTES)
            return undefined;
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    }
    catch {
        return undefined;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function safeName(value) {
    if (typeof value !== 'string')
        return '';
    const name = value.trim();
    return name && name.split('/').every(s => s !== '.' && s !== '..' && /^[A-Za-z0-9._-]+$/.test(s)) ? name : '';
}
/** Small scalar grammar, deliberately not a YAML/TOML parser. */
function scalar(raw, quotedOnly = false) {
    const value = raw.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
        const match = value.match(/^(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/);
        return match ? safeName(match[1] ?? match[2]) : '';
    }
    if (quotedOnly)
        return '';
    const plain = value.replace(/\s+#.*$/, '').trim();
    if (/^(?:null|true|false|yes|no|on|off|~|[-+]?(?:(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:e[-+]?\d+)?|0x[\da-f_]+|0o[0-7_]+|0b[01_]+|\.inf|\.nan))$/i.test(plain))
        return '';
    return safeName(plain);
}
function yamlName(text) {
    if (text === undefined)
        return '';
    const values = new Map();
    for (const line of text.split(/\r?\n/)) {
        // Indented content can extend a scalar or start unsupported nested YAML.
        if (/^\s+\S/.test(line) && !/^\s*#/.test(line))
            return '';
        const match = line.match(/^(project|name)\s*:\s*(.*)$/);
        if (!match)
            continue;
        const value = scalar(match[2]);
        if (values.has(match[1]) && values.get(match[1]) !== value)
            return '';
        values.set(match[1], value);
    }
    return values.get('project') || values.get('name') || '';
}
function packageName(dir, boundary) {
    try {
        const text = readSmall(join(dir, 'package.json'), boundary);
        const name = text === undefined ? undefined : JSON.parse(text)?.name;
        if (typeof name === 'string') {
            const trimmed = name.trim();
            const candidate = /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed.slice(1) : trimmed;
            const valid = safeName(candidate);
            if (valid)
                return valid;
        }
    }
    catch { /* invalid JSON */ }
    const go = readSmall(join(dir, 'go.mod'), boundary);
    if (go !== undefined) {
        const declarations = go.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).filter(l => /^\s*module\b/.test(l));
        if (declarations.length === 1) {
            // Like Go's modfile lexer, an unquoted module path ends at an adjacent `//` comment.
            const match = declarations[0].match(/^\s*module\s+(?:"([^"\\]+)"|`([^`]+)`|((?:(?!\/\/)[^\s"`])+))\s*(?:\/\/.*)?$/);
            const valid = match && safeName(match[1] ?? match[2] ?? match[3]);
            if (valid)
                return valid;
        }
    }
    const cargo = readSmall(join(dir, 'Cargo.toml'), boundary);
    // This constrained reader rejects multiline TOML instead of scanning its contents.
    if (cargo && /"{3}|'{3}/.test(cargo))
        return '';
    let inPackage = false;
    let name = '';
    let seen = false;
    for (const line of cargo?.split(/\r?\n/) ?? []) {
        if (/^\s*\[/.test(line)) {
            inPackage = /^\s*\[package\]\s*(?:#.*)?$/.test(line);
            continue;
        }
        const match = inPackage && line.match(/^\s*name\s*=\s*(.*)$/);
        if (match) {
            const value = scalar(match[1], true);
            if (seen && value !== name)
                return '';
            name = value;
            seen = true;
        }
    }
    return name;
}
function contains(root, cwd) {
    const rel = relative(root, cwd);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
export function localPortableBinding(cwd, env = process.env) {
    let current;
    try {
        current = realpathSync(cwd);
        if (!statSync(current).isDirectory())
            return undefined;
    }
    catch {
        return undefined;
    }
    let root;
    const configured = env.REQALL_WORKSPACE_ROOT?.trim();
    if (configured) {
        try {
            const expanded = configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
            const candidate = realpathSync(resolve(cwd, expanded));
            if (statSync(candidate).isDirectory() && contains(candidate, current))
                root = candidate;
        }
        catch { /* invalid configured root never selects a marker */ }
    }
    else {
        for (let dir = current;; dir = dirname(dir)) {
            try {
                if (statSync(join(dir, '.reqall-workspace')).isFile()) {
                    root = dir;
                    break;
                }
            }
            catch { /* no marker */ }
            if (dirname(dir) === dir)
                break;
        }
    }
    const dirs = [];
    for (let dir = current;; dir = dirname(dir)) {
        dirs.push(dir);
        if (dir === root || dirname(dir) === dir)
            break;
    }
    for (const dir of dirs) {
        for (const file of ['.reqall.yml', '.reqall.yaml']) {
            const name = yamlName(readSmall(join(dir, file), root));
            if (name)
                return { name, source: 'reqall_yml' };
        }
    }
    for (const dir of dirs) {
        const name = packageName(dir, root);
        if (name)
            return { name, source: 'package' };
    }
    if (root) {
        const name = safeName(relative(root, current).split(sep).join('/'));
        if (name)
            return { name, source: 'workspace_relative' };
    }
    return undefined;
}
export function normalizeRemote(remote) {
    const value = remote.trim().replace(/\/+$/, '');
    if (/^(?:[A-Za-z]:|[\\/]|\.|~)/.test(value) || value.includes('\\'))
        return '';
    let path = '';
    if (/^(?:https?|ssh|git):\/\//i.test(value)) {
        try {
            const url = new URL(value);
            if (!url.hostname)
                return '';
            path = url.pathname;
        }
        catch {
            return '';
        }
    }
    else {
        if (value.includes('://') || /^file:/i.test(value))
            return '';
        const match = value.match(/^(?:[^\s/@:]+@)?[^\s/:]+:(.+)$/);
        if (!match)
            return '';
        path = match[1];
    }
    const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
    if (parts.length < 2 || parts.some(p => !p || p === '.' || p === '..'))
        return '';
    // The final candidate must satisfy the automatic-name grammar untrimmed: escapes,
    // Unicode, spaces, and other unsupported characters fall through to portable metadata.
    const name = parts.slice(-2).join('/');
    return safeName(name) === name ? name : '';
}
