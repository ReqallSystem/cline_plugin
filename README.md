# Reqall Cline Plugin

Persistent semantic memory for [Cline](https://cline.bot) — the VS Code /
JetBrains extension and the Cline CLI — backed by the
[Reqall](https://reqall.net) MCP server.

Cline now runs on its SDK, and its two front ends extend differently, so this
package ships both integrations plus shared skills:

| Surface | Cline CLI / Kanban / SDK | VS Code / JetBrains extension |
|---|---|---|
| Reqall MCP tools | registered by the plugin | `cline_mcp_settings.json` entry |
| Memory-autopilot rule | registered by the plugin | `reqall.md` rule file |
| Recall per prompt | `beforeRun` context | `UserPromptSubmit` file hook |
| Path recall before edits | — | `PreToolUse` file hook |
| Persist reminders | `afterTool` / `afterRun` | `PostToolUse` / `TaskComplete` file hooks |
| Completion hold | holds `submit_and_exit` once | — (Cline has no blocking Stop hook) |
| Skills | loaded from the package | copied to `~/.cline/skills` |

## Install

Set a Reqall API key first (create one at [reqall.net](https://www.reqall.net)):

```bash
export REQALL_API_KEY="rq_..."
```

The plugin installs from GitHub; it is not published to npm.

### Cline CLI

```bash
cline plugin install git:github.com/ReqallSystem/cline_plugin
```

Re-run with `--force` to update. The plugin registers the `reqall` MCP server with a bearer header built from
`REQALL_API_KEY` in the CLI's environment (it registers nothing when the key is
missing), the Reqall rule, lifecycle hooks, and the bundled skills. Check it
with `cline config` (Plugins tab).

### VS Code / JetBrains extension

The extension does not run SDK plugins yet, so install the file hooks, skills
and rule, and add the MCP server:

```bash
npx github:ReqallSystem/cline_plugin install             # global: ~/Documents/Cline/Hooks, ~/.cline/skills, ~/.cline/rules
npx github:ReqallSystem/cline_plugin install --workspace # this repo: .clinerules/hooks, .cline/skills, .clinerules/reqall.md
npx github:ReqallSystem/cline_plugin mcp-config          # prints the MCP entry
```

Merge the printed entry into `~/.cline/data/settings/cline_mcp_settings.json`
(or use **MCP Servers → Configure**). The extension expands
`${env:REQALL_API_KEY}` from the VS Code process environment, so launch VS Code
from a shell that exports the key:

```json
{
  "mcpServers": {
    "reqall": {
      "type": "streamableHttp",
      "url": "https://www.reqall.net/mcp",
      "headers": { "Authorization": "Bearer ${env:REQALL_API_KEY}" },
      "timeout": 60
    }
  }
}
```

Hooks are enabled by default (`Settings → Features → Hooks`). Reload the window
afterwards. The installer copies the hook runtime to `~/.cline/reqall-runtime`,
writes one small wrapper per event (`TaskStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `TaskComplete`; `.ps1` on Windows), and never
overwrites hooks, skills or rules it did not write unless you pass `--force`.
`npx github:ReqallSystem/cline_plugin uninstall [--workspace]` removes only its own files.

The CLI also reads `~/Documents/Cline/Hooks` and `.clinerules/hooks`. There the
file hooks stand down, because the plugin covers the same events and CLI prompt
hooks cannot inject context. Set `REQALL_CLINE_FILE_HOOKS=all` to use them on
the CLI anyway.

## How it behaves

- **Recall before work.** Each non-trivial prompt binds the project, then
  `upsert_project` → `search` → `list_records status=open`, injected as
  background data alongside a reminder to run `reqall-intend` for agreed scope.
- **Persist before done.** The first edit or mutating command of a turn adds a
  `reqall-persist` reminder. If the turn ends with edits but no Reqall
  `upsert_record`, the next prompt starts with a nudge to persist them. On the
  CLI, `submit_and_exit` is held once with the same instruction. Read-only
  commands and git add/commit/push bookkeeping do not count as work.
- **Attribution.** Each task gets an opaque `cline:<sha256>` label. The plugin
  passes it as `session_id` only to tools whose schema advertises the field, and
  tells the model to do the same on its own writes.
- **Fail open.** Network, auth or parse failures never cancel a task; the hook
  always prints `{"cancel": false}`.

## Skills

`reqall-context`, `reqall-intend`, `reqall-document`, `reqall-persist`,
`reqall-review`, `reqall-triage`, `reqall-sleep` — invoke with `/reqall-persist`
or let Cline pick them via `use_skill`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `REQALL_API_KEY` | — | Reqall API key (falls back to a `reqall login` token) |
| `REQALL_URL` | `https://www.reqall.net` | Server base URL |
| `REQALL_PROJECT_NAME` | auto | Project override (see contract below) |
| `REQALL_WORKSPACE_ROOT` / `.reqall-workspace` | — | Workspace boundary for path-based names |
| `REQALL_MACHINE_NAME` | hostname | Host segment of the machine project |
| `REQALL_AUTO_CONTEXT` | `inject` | `inject`, `reminder` (binding note only) or `off` |
| `REQALL_AUTO_PERSIST` | `reminder` | `reminder` or `off` |
| `REQALL_CONTEXT_LIMIT` / `REQALL_OPEN_LIMIT` | `5` / `10` | Recall sizes |
| `REQALL_CLINE_MCP` | on | `off` stops the CLI plugin registering the MCP server |
| `REQALL_CLINE_FILE_HOOKS` | — | `all` runs file hooks on the CLI too |
| `REQALL_STATE_DIR` | OS temp | File-hook session state |

## Project identity

The plugin resolves the project once per prompt with the shared
[naming contract](https://github.com/ReqallSystem/plugins/blob/main/doc/PROJECT_NAMING.md)
(`lib/project-policy.mjs` is vendored byte-for-byte from `@reqall/core`):
`REQALL_PROJECT_NAME` → Git `origin` (`org/repo`) → a labelled
`project_name: …` in the prompt → `.reqall.yml` → package identity →
workspace-relative path → `.machine/<host>/<user>`.

## Development

```bash
npm test   # offline: node --test, CLI manifest, npm pack --dry-run
```

Tests use an in-process fake of the Reqall endpoint; nothing touches the network,
your Cline profile or `~/Documents`.

## License

MIT
