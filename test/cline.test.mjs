import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { install, targets, uninstall, HOOK_EVENTS } from '../bin/reqall-cline-plugin.mjs';
import { handle, normalizeInput } from '../hooks/reqall-hook.mjs';
import { ReqallClient } from '../lib/reqall.mjs';
import plugin, { createReqallPlugin } from '../plugin.js';
import { SAMPLE_RECORDS, fakeReqall, testEnv } from './fake-reqall.mjs';

const HOOK = fileURLToPath(new URL('../hooks/reqall-hook.mjs', import.meta.url));

function hookEnv(extra = {}) {
  return testEnv({ REQALL_STATE_DIR: mkdtempSync(join(tmpdir(), 'reqall-cline-test-')), ...extra });
}

function vscode(hookName, taskId, body) {
  return { clineVersion: '4.1.22', hookName, timestamp: '1', taskId, workspaceRoots: ['/tmp'], ...body };
}

test('normalizes VS Code proto and SDK envelopes', () => {
  const vs = normalizeInput(vscode('PostToolUse', 't1', { postToolUse: { toolName: 'editor', parameters: { path: 'a.ts' }, success: true } }));
  assert.equal(vs.event, 'PostToolUse');
  assert.equal(vs.sdk, false);
  assert.equal(vs.toolName, 'editor');
  const sdk = normalizeInput({ hookName: 'tool_result', taskId: 't1', tool_call: { name: 'editor', input: { path: 'a' } } });
  assert.equal(sdk.event, 'PostToolUse');
  assert.equal(sdk.sdk, true);
  assert.equal(normalizeInput({}, 'UserPromptSubmit').event, 'UserPromptSubmit');
});

test('VS Code turn: recall on prompt, one persist reminder, carry-over nudge', async () => {
  const env = hookEnv();
  const fake = fakeReqall({ records: SAMPLE_RECORDS });
  const client = new ReqallClient({ env, fetch: fake.fetch });
  const run = (raw) => handle(normalizeInput(raw), { env, client });

  assert.deepEqual(await run(vscode('TaskStart', 't1', { taskStart: { taskMetadata: { taskId: 't1', initialTask: 'fix export' } } })), { cancel: false });

  const prompt = await run(vscode('UserPromptSubmit', 't1', { userPromptSubmit: { prompt: 'Fix the widget export bug' } }));
  assert.equal(prompt.cancel, false);
  assert.match(prompt.contextModification, /project_name: "acme\/widgets"/);
  assert.match(prompt.contextModification, /#7 spec\/open/);
  assert.match(prompt.contextModification, /session_id="cline:[0-9a-f]{32}"/);
  assert.match(prompt.contextModification, /reqall-intend/);

  const edit = vscode('PostToolUse', 't1', { postToolUse: { toolName: 'editor', parameters: { path: 'src/export.ts' }, success: true } });
  assert.match((await run(edit)).contextModification, /reqall-persist/);
  assert.equal((await run(edit)).contextModification, undefined, 'reminds once per turn');

  await run(vscode('TaskComplete', 't1', { taskComplete: { taskMetadata: { taskId: 't1' } } }));
  const next = await run(vscode('UserPromptSubmit', 't1', { userPromptSubmit: { prompt: 'thanks' } }));
  assert.match(next.contextModification, /previous turn changed files/);
  const after = await run(vscode('UserPromptSubmit', 't1', { userPromptSubmit: { prompt: 'ok' } }));
  assert.equal(after.contextModification, undefined, 'nudges once');
});

test('a Reqall write clears pending persistence', async () => {
  const env = hookEnv();
  const client = new ReqallClient({ env, fetch: fakeReqall().fetch });
  const run = (raw) => handle(normalizeInput(raw), { env, client });
  await run(vscode('UserPromptSubmit', 't2', { userPromptSubmit: { prompt: 'hi' } }));
  await run(vscode('PostToolUse', 't2', { postToolUse: { toolName: 'run_commands', parameters: { commands: '["npm run build"]' }, success: true } }));
  await run(vscode('PostToolUse', 't2', { postToolUse: { toolName: 'reqall__upsert_record', parameters: {}, success: true } }));
  await run(vscode('TaskComplete', 't2', {}));
  const next = await run(vscode('UserPromptSubmit', 't2', { userPromptSubmit: { prompt: 'ok' } }));
  assert.equal(next.contextModification, undefined);
});

test('read-only tools and git bookkeeping do not count as work', async () => {
  const env = hookEnv();
  const client = new ReqallClient({ env, fetch: fakeReqall().fetch });
  const run = (raw) => handle(normalizeInput(raw), { env, client });
  const git = vscode('PostToolUse', 't3', { postToolUse: { toolName: 'run_commands', parameters: { commands: 'git add -A && git commit -m x' }, success: true } });
  assert.equal((await run(git)).contextModification, undefined);
  const read = vscode('PostToolUse', 't3', { postToolUse: { toolName: 'read_files', parameters: { path: 'a' }, success: true } });
  assert.equal((await run(read)).contextModification, undefined);
});

test('pre-tool recall is path focused and deduplicated', async () => {
  const env = hookEnv();
  const fake = fakeReqall({ records: SAMPLE_RECORDS });
  const client = new ReqallClient({ env, fetch: fake.fetch });
  const pre = vscode('PreToolUse', 't4', { preToolUse: { toolName: 'editor', parameters: { path: 'src/export.ts' } } });
  assert.match((await handle(normalizeInput(pre), { env, client })).contextModification, /src\/export\.ts/);
  assert.deepEqual(await handle(normalizeInput(pre), { env, client }), { cancel: false });
});

test('file hooks stand down on the SDK/CLI runner unless enabled', async () => {
  const env = hookEnv();
  const fake = fakeReqall();
  const client = new ReqallClient({ env, fetch: fake.fetch });
  const raw = { hookName: 'prompt_submit', taskId: 't5', userPromptSubmit: { prompt: 'Implement export' } };
  assert.deepEqual(await handle(normalizeInput(raw), { env, client }), { cancel: false });
  assert.equal(fake.calls.length, 0);
  const enabled = await handle(normalizeInput(raw), { env: { ...env, REQALL_CLINE_FILE_HOOKS: 'all' }, client });
  assert.match(enabled.contextModification, /acme\/widgets/);
});

test('hook script always prints valid JSON and never cancels', () => {
  const env = { ...process.env, ...hookEnv({ REQALL_API_KEY: '' }) };
  for (const input of ['', 'not json', JSON.stringify(vscode('UserPromptSubmit', 't6', { userPromptSubmit: { prompt: 'Refactor the exporter' } }))]) {
    const res = spawnSync(process.execPath, [HOOK, 'UserPromptSubmit'], { input, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.cancel, false);
  }
});

test('SDK plugin: manifest, MCP + rule registration, context and completion hold', async () => {
  assert.equal(plugin.name, 'reqall');
  assert.deepEqual(plugin.manifest.capabilities, ['hooks', 'rules', 'mcp']);

  const env = testEnv();
  const fake = fakeReqall({ records: SAMPLE_RECORDS });
  const p = createReqallPlugin({ env, client: new ReqallClient({ env, fetch: fake.fetch }), cwd: '/tmp' });
  const registered = { rules: [], mcp: [] };
  p.setup({ registerRule: (r) => registered.rules.push(r), registerMcpServer: (s) => registered.mcp.push(s) }, { session: { sessionId: 's1' } });
  assert.equal(registered.mcp[0].transport.type, 'streamableHttp');
  assert.equal(registered.mcp[0].transport.url, 'https://reqall.test/mcp');
  assert.equal(registered.mcp[0].transport.headers.Authorization, 'Bearer rq_test');
  assert.match(registered.rules[0].content(), /Reqall Memory Autopilot/);

  const snapshot = { conversationId: 'c1', messages: [{ role: 'user', content: [{ type: 'text', text: 'Add CSV export to widgets' }] }] };
  const start = await p.hooks.beforeRun({ snapshot });
  assert.match(start.appendContext, /#7 spec\/open/);
  assert.equal(await p.hooks.beforeRun({ snapshot }), undefined, 'same prompt is not re-injected');
  assert.equal(await p.hooks.beforeRun({ snapshot: { ...snapshot, parentAgentId: 'root' } }), undefined, 'subagents skipped');

  const edit = await p.hooks.afterTool({ snapshot, tool: { name: 'editor' }, input: { path: 'a.ts' }, result: {} });
  assert.match(edit.appendContext, /reqall-persist/);
  const held = await p.hooks.beforeTool({ snapshot, tool: { name: 'submit_and_exit' } });
  assert.equal(held.skip, true);
  assert.match(held.reason, /reqall-persist/);
  assert.equal(await p.hooks.beforeTool({ snapshot, tool: { name: 'submit_and_exit' } }), undefined, 'holds once');

  await p.hooks.afterRun({ snapshot, result: { status: 'completed' } });
  const nextSnap = { ...snapshot, messages: [...snapshot.messages, { role: 'user', content: [{ type: 'text', text: 'thanks' }] }] };
  assert.match((await p.hooks.beforeRun({ snapshot: nextSnap })).appendContext, /previous turn changed files/);
});

test('SDK plugin skips MCP registration without a key', () => {
  const env = testEnv({ REQALL_API_KEY: '' });
  const p = createReqallPlugin({ env, client: new ReqallClient({ env, fetch: fakeReqall().fetch }), cwd: '/tmp' });
  const mcp = [];
  p.setup({ registerRule() {}, registerMcpServer: (s) => mcp.push(s) }, {});
  assert.equal(mcp.length, 0);
});

test('installer writes managed hooks, skills and rule, and removes only its own files', () => {
  const home = mkdtempSync(join(tmpdir(), 'reqall-cline-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'reqall-cline-ws-'));
  for (const scope of ['workspace', 'global']) {
    const t = targets({ scope, cwd, home });
    const result = install({ scope, cwd, home });
    assert.equal(result.skipped.length, 0);
    for (const event of HOOK_EVENTS) {
      const file = join(t.hooks, process.platform === 'win32' ? `${event}.ps1` : event);
      assert.match(readFileSync(file, 'utf8'), /reqall-cline-plugin managed/);
      if (process.platform !== 'win32') assert.ok(statSync(file).mode & 0o100);
    }
    assert.ok(existsSync(join(t.skills, 'reqall-persist', 'SKILL.md')));
    assert.match(readFileSync(t.rule, 'utf8'), /Reqall Memory Autopilot/);
    assert.ok(existsSync(join(t.runtime, 'hooks', 'reqall-hook.mjs')));
    assert.ok(uninstall({ scope, cwd, home }).removed.length >= HOOK_EVENTS.length + 8);
    assert.equal(existsSync(t.rule), false);
  }
  // installed wrapper runs the copied runtime
  install({ scope: 'workspace', cwd, home });
  if (process.platform !== 'win32') {
    const wrapper = join(targets({ scope: 'workspace', cwd, home }).hooks, 'PostToolUse');
    const output = execFileSync(wrapper, { input: '{}', env: { ...process.env, ...hookEnv({ REQALL_API_KEY: '' }) }, encoding: 'utf8' });
    assert.equal(JSON.parse(output).cancel, false);
  }
});
