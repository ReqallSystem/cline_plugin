/**
 * Reqall plugin for the Cline SDK (Cline CLI, Kanban and SDK hosts).
 *
 * - registers the Reqall MCP server (bearer from REQALL_API_KEY)
 * - registers the memory-autopilot rule
 * - beforeRun: binds the project and injects recall for the latest prompt
 * - afterTool: tracks unpersisted edits; Reqall writes clear them
 * - beforeTool: holds `submit_and_exit` once while edits are unpersisted
 *
 * The VS Code extension does not run SDK plugins; use the file hooks there.
 * Every Reqall call fails open.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractProjectHint, resolveProjectBinding } from './lib/project-policy.mjs';
import {
  ReqallClient,
  bindingNote,
  intentDirective,
  isMutatingTool,
  isReqallWriteTool,
  isTrivialPrompt,
  persistDirective,
  recallContext,
  resolveApiKey,
  resolveApiUrl,
  sessionLabel,
} from './lib/reqall.mjs';

const HOST = 'Cline';
const ROOT = dirname(fileURLToPath(import.meta.url));

function readPolicy() {
  try {
    return readFileSync(join(ROOT, 'REQALL.md'), 'utf8');
  } catch {
    return 'Use Reqall memory: load context before non-trivial work, record agreed intent, and persist outcomes before finishing.';
  }
}

function latestUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = (message.content || [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .filter((t) => !t.includes('<hook_context'))
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

/** Build a plugin instance. Tests inject `env`, `client` and `cwd`. */
export function createReqallPlugin({ env = process.env, client, cwd } = {}) {
  const reqall = client || new ReqallClient({ env });
  const sessions = new Map();
  let workspace = cwd || '';
  let rootSession = '';

  function session(snapshot) {
    const key = snapshot?.conversationId || rootSession || 'default';
    if (!sessions.has(key)) {
      sessions.set(key, { project: '', selected: '', dirty: false, held: false, pendingNudge: false, lastPrompt: '' });
    }
    return { key, state: sessions.get(key), label: sessionLabel('cline', key) };
  }

  return {
    name: 'reqall',
    manifest: { capabilities: ['hooks', 'rules', 'mcp'] },

    setup(api, ctx = {}) {
      workspace = cwd || ctx.workspaceInfo?.rootPath || process.cwd();
      rootSession = ctx.session?.sessionId || '';
      api.registerRule?.({ id: 'reqall-memory', source: 'reqall', content: readPolicy });
      const apiKey = resolveApiKey(env);
      if (apiKey && env.REQALL_CLINE_MCP !== 'off') {
        api.registerMcpServer?.({
          name: 'reqall',
          transport: {
            type: 'streamableHttp',
            url: `${resolveApiUrl(env)}/mcp`,
            headers: { Authorization: `Bearer ${apiKey}` },
          },
        });
      }
    },

    hooks: {
      async beforeRun({ snapshot } = {}) {
        if (snapshot?.parentAgentId) return undefined;
        const { state, label } = session(snapshot);
        const prompt = latestUserText(snapshot?.messages);
        if (!prompt || prompt === state.lastPrompt) return undefined;
        state.lastPrompt = prompt;
        state.selected = extractProjectHint(prompt) || state.selected;
        state.project = resolveProjectBinding(workspace, env, prompt, state.selected).name;
        state.held = false;

        const parts = [];
        if (state.pendingNudge) {
          parts.push(`[reqall] The previous turn changed files or ran commands but recorded nothing in Reqall. ${persistDirective(state.project, label)}`);
          state.pendingNudge = false;
        }
        const mode = String(env.REQALL_AUTO_CONTEXT || 'inject').toLowerCase();
        if (!isTrivialPrompt(prompt) && mode !== 'off') {
          if (mode === 'inject' && reqall.configured) {
            const recall = await recallContext(reqall, {
              projectName: state.project,
              query: prompt.slice(0, 500),
              label,
              host: HOST,
              contextLimit: Number(env.REQALL_CONTEXT_LIMIT) || 5,
              openLimit: Number(env.REQALL_OPEN_LIMIT) || 10,
            });
            parts.push(recall.text);
          } else {
            parts.push(bindingNote(state.project, label, HOST));
          }
          parts.push(intentDirective(state.project));
        }
        return parts.length ? { appendContext: parts.join('\n\n') } : undefined;
      },

      async beforeTool({ snapshot, tool, toolCall } = {}) {
        const name = tool?.name || toolCall?.toolName || '';
        if (name !== 'submit_and_exit' || snapshot?.parentAgentId) return undefined;
        const { state, label } = session(snapshot);
        if (!state.dirty || state.held || String(env.REQALL_AUTO_PERSIST || '').toLowerCase() === 'off') return undefined;
        state.held = true;
        return { skip: true, reason: persistDirective(state.project || 'the bound project', label) };
      },

      async afterTool({ snapshot, tool, toolCall, input, result } = {}) {
        if (snapshot?.parentAgentId) return undefined;
        const name = tool?.name || toolCall?.toolName || '';
        if (result?.isError || result?.error) return undefined;
        const { state, label } = session(snapshot);
        if (isReqallWriteTool(name)) {
          state.dirty = false;
          return undefined;
        }
        if (!isMutatingTool(name, input ?? toolCall?.input)) return undefined;
        const first = !state.dirty;
        state.dirty = true;
        if (!first || String(env.REQALL_AUTO_PERSIST || '').toLowerCase() === 'off') return undefined;
        return { appendContext: persistDirective(state.project || 'the bound project', label) };
      },

      async afterRun({ snapshot } = {}) {
        if (snapshot?.parentAgentId) return;
        const { state } = session(snapshot);
        if (state.dirty) {
          state.pendingNudge = true;
          state.dirty = false;
        }
      },
    },
  };
}

export default createReqallPlugin();
