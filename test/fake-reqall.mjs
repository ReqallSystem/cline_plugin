/**
 * Offline stand-in for the Reqall MCP endpoint. Records every JSON-RPC call;
 * no request ever leaves the process.
 */
export const FAKE_URL = 'https://reqall.test';

const WRITE_SCHEMA = { type: 'object', properties: { session_id: { type: 'string' } } };

export function fakeReqall({ projectId = 42, records = [], fail = false } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    if (!String(url).startsWith(FAKE_URL)) throw new Error(`unexpected URL ${url}`);
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, name: body.params?.name, args: body.params?.arguments, auth: init.headers.Authorization });
    if (fail) return new Response('nope', { status: 503 });
    let result;
    if (body.method === 'tools/list') {
      result = {
        tools: [
          { name: 'upsert_project', inputSchema: { type: 'object', properties: { name: {}, session_id: {} } } },
          { name: 'upsert_record', inputSchema: WRITE_SCHEMA },
          { name: 'search', inputSchema: { type: 'object', properties: { query: {} } } },
          { name: 'list_records', inputSchema: { type: 'object', properties: { project_id: {} } } },
        ],
      };
    } else {
      const name = body.params.name;
      const data = name === 'upsert_project'
        ? { ok: true, data: { action: 'created_or_found', project: { id: projectId, name: body.params.arguments.name } } }
        : name === 'search'
          ? { ok: true, data: { results: records } }
          : name === 'list_records'
            ? { ok: true, data: { records: records.filter((r) => r.status === 'open') } }
            : { ok: true, data: {} };
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

export const SAMPLE_RECORDS = [
  { id: 7, kind: 'spec', status: 'open', title: 'SPEC: widget export', project_name: 'acme/widgets' },
  { id: 9, kind: 'issue', status: 'resolved', title: 'BUG: export crash' },
];

export function testEnv(extra = {}) {
  return {
    REQALL_API_KEY: 'rq_test',
    REQALL_URL: 'https://reqall.test',
    REQALL_PROJECT_NAME: 'acme/widgets',
    REQALL_MACHINE_NAME: 'testhost',
    ...extra,
  };
}
