#!/usr/bin/env node
/**
 * Reqall file hook for Cline (VS Code extension and CLI).
 *
 * Installed as one small wrapper per event (TaskStart, UserPromptSubmit,
 * PreToolUse, PostToolUse, TaskComplete) that runs this script with the event
 * name as argv[2]. Reads Cline's hook JSON on stdin and writes
 * `{"cancel":false,"contextModification":"…"}` to stdout.
 *
 * Fail-open: any error produces `{"cancel":false}`; this hook never cancels.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { extractProjectHint, resolveProjectBinding } from '../lib/project-policy.mjs';
import {
  ReqallClient,
  bindingNote,
  intentDirective,
  isMutatingTool,
  isReqallWriteTool,
  isTrivialPrompt,
  persistDirective,
  recallContext,
  sessionLabel,
  toolTarget,
} from '../lib/reqall.mjs';
import { loadState, saveState, stateDir } from '../lib/state.mjs';

const HOST = 'Cline';
const EVENTS = {
  taskstart: 'TaskStart',
  agentstart: 'TaskStart',
  taskresume: 'TaskStart',
  agentresume: 'TaskStart',
  userpromptsubmit: 'UserPromptSubmit',
  promptsubmit: 'UserPromptSubmit',
  pretooluse: 'PreToolUse',
  toolcall: 'PreToolUse',
  posttooluse: 'PostToolUse',
  toolresult: 'PostToolUse',
  taskcomplete: 'TaskComplete',
  agentend: 'TaskComplete',
};

const DEFAULT_STATE = {
  project: '',
  selected: '',
  bound: false,
  turn: 0,
  dirty: false,
  remindedTurn: -1,
  pendingNudge: false,
  recalled: [],
};

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function normalizeEvent(name) {
  return EVENTS[String(name || '').replace(/[_\-\s]/g, '').toLowerCase()] || '';
}

/** Accept both the VS Code (proto) and SDK/CLI hook envelopes. */
export function normalizeInput(raw, argvEvent = '') {
  const input = asRecord(raw);
  const event = normalizeEvent(argvEvent) || normalizeEvent(input.hookName);
  const roots = Array.isArray(input.workspaceRoots) ? input.workspaceRoots.filter((r) => typeof r === 'string') : [];
  const cwd = roots[0] || asRecord(input.workspaceInfo).rootPath || process.cwd();
  const taskId = String(input.taskId || asRecord(input.sessionContext).rootSessionId || '').trim();
  const pre = asRecord(input.preToolUse);
  const post = asRecord(input.postToolUse);
  const call = asRecord(input.tool_call);
  const toolName = String(pre.toolName || post.toolName || call.name || '');
  const toolArgs = asRecord(pre.parameters || post.parameters || call.input);
  const prompt = String(
    asRecord(input.userPromptSubmit).prompt
      ?? asRecord(asRecord(input.taskStart).taskMetadata).initialTask
      ?? '',
  );
  const success = post.success !== false && !input.error;
  // The SDK/CLI runner names events in snake_case (agent_start, tool_call);
  // the VS Code extension sends PascalCase proto names.
  const sdk = typeof input.hookName === 'string' && /^[a-z]+(_[a-z]+)*$/.test(input.hookName);
  return { event, cwd, taskId, toolName, toolArgs, prompt, success, sdk };
}

function out(contextModification = '') {
  const result = { cancel: false };
  if (contextModification) result.contextModification = contextModification;
  return result;
}

function bind(state, input, env) {
  const selected = extractProjectHint(input.prompt || '') || state.selected || '';
  const binding = resolveProjectBinding(input.cwd, env, input.prompt || '', selected);
  return { ...state, selected, project: binding.name };
}

export async function handle(input, { env = process.env, client = new ReqallClient({ env }) } = {}) {
  // On the CLI/SDK runner the Reqall Cline plugin covers these events (and
  // prompt hooks there cannot inject); stand down unless explicitly enabled.
  if (!input.event || (input.sdk && env.REQALL_CLINE_FILE_HOOKS !== 'all')) return out();
  const dir = stateDir('cline-hooks', env);
  const key = input.taskId || input.cwd;
  let state = loadState(dir, key, DEFAULT_STATE);
  const label = sessionLabel('cline', input.taskId);

  switch (input.event) {
    case 'TaskStart': {
      // VS Code fires TaskStart before every run and concatenates it with
      // UserPromptSubmit, which carries the binding; only bind once here.
      if (!state.bound) saveState(dir, key, bind({ ...state, bound: true }, input, env));
      return out();
    }

    case 'UserPromptSubmit': {
      state = bind(state, input, env);
      state.turn += 1;
      const parts = [];
      if (state.pendingNudge) {
        parts.push(`[reqall] The previous turn changed files or ran commands but recorded nothing in Reqall. ${persistDirective(state.project, label)}`);
        state.pendingNudge = false;
      }
      const mode = String(env.REQALL_AUTO_CONTEXT || 'inject').toLowerCase();
      if (!isTrivialPrompt(input.prompt) && mode !== 'off') {
        if (mode === 'inject' && client.configured) {
          const recall = await recallContext(client, {
            projectName: state.project,
            query: input.prompt.slice(0, 500),
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
      saveState(dir, key, state);
      return out(parts.join('\n\n'));
    }

    case 'PreToolUse': {
      if (!isMutatingTool(input.toolName, input.toolArgs) || !client.configured) return out();
      const target = toolTarget(input.toolArgs);
      if (!target || !/[\\/]|\.\w{1,8}$/.test(target) || state.recalled.includes(target)) return out();
      state.recalled = [...state.recalled, target].slice(-50);
      saveState(dir, key, state);
      const result = await client.search(target, state.project || undefined, 3);
      if (!result.ok) return out();
      const rows = result.data?.data?.results || result.data?.results || [];
      if (!rows.length) return out();
      const lines = rows.map((r) => `- #${r.id} ${r.kind}/${r.status}: ${r.title}`);
      return out(`[reqall] Records related to ${target} (background data; verify before relying on it):\n${lines.join('\n')}`);
    }

    case 'PostToolUse': {
      if (!input.success) return out();
      if (isReqallWriteTool(input.toolName)) {
        saveState(dir, key, { ...state, dirty: false, pendingNudge: false });
        return out();
      }
      if (!isMutatingTool(input.toolName, input.toolArgs)) return out();
      const first = state.remindedTurn !== state.turn;
      saveState(dir, key, { ...state, dirty: true, remindedTurn: state.turn });
      const mode = String(env.REQALL_AUTO_PERSIST || 'reminder').toLowerCase();
      return first && mode !== 'off' ? out(persistDirective(state.project || 'the bound project', label)) : out();
    }

    case 'TaskComplete': {
      if (state.dirty && String(env.REQALL_AUTO_PERSIST || '').toLowerCase() !== 'off') {
        saveState(dir, key, { ...state, dirty: false, pendingNudge: true });
      }
      return out();
    }

    default:
      return out();
  }
}

async function main() {
  let raw = {};
  try {
    const text = readFileSync(0, 'utf8');
    raw = text.trim() ? JSON.parse(text) : {};
  } catch { /* empty or invalid stdin */ }
  let result = out();
  try {
    result = await handle(normalizeInput(raw, process.argv[2]));
  } catch (err) {
    process.stderr.write(`[reqall-hook] ${err?.message || err}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
