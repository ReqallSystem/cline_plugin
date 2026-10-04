import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  ReqallClient, commandsOf, decodeToolResult, formatRecall, isMutatingTool, isReqallWriteTool,
  isTrivialPrompt, parseProjectId, recallContext, sessionLabel,
} from '../lib/reqall.mjs';
import { FAKE_URL, SAMPLE_RECORDS, fakeReqall, testEnv } from './fake-reqall.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

test('session labels are stable, prefixed and opaque', () => {
  const a = sessionLabel('host', 'abc');
  assert.equal(a, sessionLabel('host', 'abc'));
  assert.match(a, /^host:[0-9a-f]{32}$/);
  assert.notEqual(a, sessionLabel('host', 'abd'));
  assert.equal(sessionLabel('host', ''), '');
});

test('session_id is sent only where the tool schema advertises it', async () => {
  const fake = fakeReqall();
  const client = new ReqallClient({ env: testEnv(), fetch: fake.fetch });
  await client.call('upsert_record', { title: 't', session_id: 'forged' }, { sessionId: 'host:1' });
  await client.call('search', { query: 'q' }, { sessionId: 'host:1' });
  const [record, search] = fake.calls.filter((c) => c.method === 'tools/call');
  assert.equal(record.args.session_id, 'host:1');
  assert.equal(search.args.session_id, undefined);
  assert.equal(record.auth, 'Bearer rq_test');
  assert.equal(fake.calls.filter((c) => c.method === 'tools/list').length, 1, 'tools/list is cached');
});

test('client fails open without credentials or on HTTP errors', async () => {
  const fake = fakeReqall({ fail: true });
  const none = new ReqallClient({ env: { REQALL_API_KEY: '', REQALL_URL: FAKE_URL }, fetch: fake.fetch });
  assert.deepEqual(await none.search('q'), { ok: false, error: 'auth_missing' });
  const failing = new ReqallClient({ env: testEnv(), fetch: fake.fetch });
  assert.equal((await failing.search('q')).error, 'http_503');
});

test('recallContext binds project, searches and lists open records', async () => {
  const fake = fakeReqall({ records: SAMPLE_RECORDS });
  const client = new ReqallClient({ env: testEnv(), fetch: fake.fetch });
  const recall = await recallContext(client, { projectName: 'acme/widgets', query: 'export', label: 'host:1', host: 'Test' });
  assert.equal(recall.projectId, 42);
  assert.match(recall.text, /project_name: "acme\/widgets"/);
  assert.match(recall.text, /#7 spec\/open: SPEC: widget export/);
  assert.match(recall.text, /### Open records/);
  assert.match(recall.text, /session_id="host:1"/);
  const upsert = fake.calls.find((c) => c.name === 'upsert_project');
  assert.equal(upsert.args.session_id, 'host:1');
});

test('result decoding and project ids', () => {
  assert.equal(parseProjectId({ ok: true, data: { ok: true, data: { project: { id: 5 } } } }), 5);
  assert.equal(parseProjectId({ ok: true, data: 'Project #12 ready' }), 12);
  assert.equal(decodeToolResult({ isError: true, content: [{ type: 'text', text: 'x' }] }).ok, false);
  assert.equal(decodeToolResult({ content: [{ type: 'text', text: '{"ok":false}' }] }).ok, false);
  assert.deepEqual(decodeToolResult({ content: [{ type: 'text', text: 'plain' }] }).data, 'plain');
  assert.match(formatRecall({ projectName: 'p', searchResult: { ok: false, error: 'timeout' } }), /unavailable: timeout/);
});

test('tool classification', () => {
  assert.equal(isMutatingTool('editor', { path: 'a.ts' }), true);
  assert.equal(isMutatingTool('edit', { filePath: 'a.ts' }), true);
  assert.equal(isMutatingTool('read', { filePath: 'a.ts' }), false);
  assert.equal(isMutatingTool('bash', { command: 'git status && ls' }), false);
  assert.equal(isMutatingTool('bash', { command: 'git commit -m x && git push' }), false);
  assert.equal(isMutatingTool('bash', { command: 'npm run build' }), true);
  assert.equal(isMutatingTool('run_commands', { commands: '["ls","rm -rf dist"]' }), true);
  assert.equal(isMutatingTool('exec', { command: 'cat x' }), false);
  assert.deepEqual(commandsOf({ commands: [{ command: 'npm', args: ['test'] }] }), ['npm test']);
  assert.equal(isReqallWriteTool('reqall__upsert_record'), true);
  assert.equal(isReqallWriteTool('reqall_upsert_record'), true);
  assert.equal(isReqallWriteTool('reqall__search'), false);
  assert.equal(isTrivialPrompt('thanks!'), true);
  assert.equal(isTrivialPrompt('fix the export bug'), false);
});

test('skills are rendered, named after their directories and keep the SLEEP policy', () => {
  const dirs = readdirSync(join(ROOT, 'skills')).sort();
  assert.deepEqual(dirs, ['reqall-context', 'reqall-document', 'reqall-intend', 'reqall-persist', 'reqall-review', 'reqall-sleep', 'reqall-triage']);
  for (const dir of dirs) {
    const text = readFileSync(join(ROOT, 'skills', dir, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${dir}\\ndescription: .{20,1024}\\n`), dir);
    assert.doesNotMatch(text, /\{\{|Grok/, dir);
    assert.match(text, /## Project identity contract/, dir);
    assert.match(text, /## Write attribution/, dir);
  }
  const sleep = readFileSync(join(ROOT, 'skills/reqall-sleep/SKILL.md'), 'utf8');
  assert.equal(sleep.split('## WORK review policy').length, 2);
  assert.match(sleep, /no unique durable information/);
});
