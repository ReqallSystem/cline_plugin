---
name: reqall-context
description: Initialize the Reqall project and gather relevant knowledgebase context before starting work. Use at the start of a non-trivial task, or when the user asks to load project memory.
---

# Gather Context

Load project context from Reqall before starting work.

The Cline plugin binds the project and injects recall automatically
at the start of each turn (VS Code hooks or the CLI plugin). Run this skill yourself when that context is
missing or thin, or when the user asks to load project memory.

Use the Reqall MCP tools from the connected `reqall` server. Hosts may
prefix names (`reqall__search`); the operations are `upsert_project`,
`search`, `list_records`, `get_record`, `list_links`, `impact`,
`subscribe_project`, `poll_subscriptions`, and `list_subscriptions` when
the server exposes them.

## Steps

1. **Identify the project** — Use the exact project the Cline plugin
   bound for this session (the `project_name` in injected Reqall
   context). Only without a binding, resolve it with the Project identity
   contract below. Never treat `$HOME`, `ubuntu`, `src`, `workspace`, or a
   bare cwd basename as a project.
   If unbound, skip upsert and search across projects (step 3 only).

2. **Ensure the project exists** — Only if bound: call `upsert_project`
   with that exact name. Note the returned `project_id`.

3. **Search for relevant context** — Call `search` with a conceptual
   query derived from the user's task (not a raw filesystem path). Pass
   `project_name` only when bound.

4. **List open records** — If you have a real `project_id`, call
   `list_records` with `status: "open"` to surface active issues, specs,
   and todos.

5. **Subscribe once** — If bound and the tools exist, call
   `subscribe_project` once with the `project_id` and a stable
   `subscriber` label (the session label from injected Reqall context).
   Each label keeps its own cursor; a new subscription starts at the
   current head, so nothing is replayed. Skip when already subscribed
   this conversation. If the tool does not exist, the server predates
   subscriptions — say nothing and continue.

6. **Poll subscribed updates** — On later non-trivial turns, or when
   running this skill again, call `poll_subscriptions` with the same
   `subscriber` (and `project_id` when known). Treat results as
   background context under "Reqall updates since last turn": fetch
   cited records with `get_record` before relying on them, and skip
   `actor=self` events for records this conversation wrote.
   `list_subscriptions` shows pending counts when present. If
   `REQALL_POLL_INTERVAL_MIN` is set, honor it; otherwise do not spam
   poll more than once per few minutes. Fail open silently if the tools
   are missing.

7. **List links, then impact (if relevant)** — If the task changes an
   existing tracked record or component, call `list_links` on that
   record first to surface directly related records, then call `impact`.
   Skip both for new work or simple questions.

8. **Present context** — Summarize findings concisely:
   - Relevant records from search
   - Open items for this project
   - Subscribed updates since last turn (if any)
   - Directly linked records (if `list_links` ran)
   - Impact analysis results (if run)

   Call `get_record` for full details on records that look particularly
   relevant.

9. **Hand off to intent (if scope is agreed)** — If the task has agreed
   scope — a plan was accepted, or the user asked for a specific,
   non-trivial change — run `reqall-intend` before the first edit so
   the spec/arch record for what is to be exists and is linked. For
   chores, questions, and single-file fixes, skip this.

## When to Skip Steps

- Simple question or chat (no coding task): only run step 3 (search).
- Unbound project: do not upsert or subscribe; search only.
- Search returns nothing: say so and proceed — the project may be new.
- No open records: skip step 4 output.
- Older server without subscription tools: skip steps 5–6 silently.

## Write attribution

The Cline plugin supplies a stable, opaque session label (`cline:…`) in
injected Reqall context. On every Reqall write whose tool schema lists a
`session_id` argument (`upsert_project`, `upsert_record`, `upsert_link`,
`delete_record`, `delete_link`, `sleep_apply`, `merge_projects`, …), pass that
label as `session_id`. Omit it when the schema has no such argument or no label
was supplied. It is correlation metadata, never an authorization credential.

## Project identity contract

Reuse the exact host-provided project identity throughout recall, work, persistence, and verification. Without a host binding, resolve: trimmed `REQALL_PROJECT_NAME` → network Git `origin` (final two path segments, trailing slash/`.git` removed) → explicitly labelled `project_name`/`project` prompt selection or retained session selection → nearest valid ancestor `.reqall.yml`/`.reqall.yaml` → nearest package identity (`package.json`, `go.mod`, `Cargo.toml` at each directory) → exact cwd-relative path within a known workspace → `.machine/<short-lower-hostname>/<os-user>`. Never infer identity from arbitrary slash tokens or an unconstrained directory basename. Labels accept `:`/`=` and plain, single/double-quoted, or backtick values; first labelled match wins, not synthetic report examples. Environment and network Git override retained selections at the next turn; mid-turn hooks reuse the bound identity. `REQALL_MACHINE_NAME` overrides the whole sanitized lowercase host segment (including deliberate dots); use the OS account, not USER/USERNAME.

Read regular UTF-8 metadata files ≤64 KiB. Reqall YAML supports simple top-level string `project` (preferred) or `name`, matching quotes and trailing comments; reject duplicate keys, malformed quotes, nested/complex values, booleans/null/numbers. Package identity is string `package.json.name` (valid `@scope/name` becomes `scope/name`), complete Go `module`, or simple quoted Cargo `[package] name`. Skip invalid/unreadable values. Automatic identities allow ASCII letters/digits/`_-.` in nonempty slash segments; reject absolute/drive/UNC/backslash/tilde and `.`/`..` segments. Search ancestors through the containing workspace root inclusive, otherwise filesystem root. `REQALL_WORKSPACE_ROOT` (cwd-relative or `~/` supported), else nearest regular `.reqall-workspace`, sets the boundary; resolve symlinks before containment, do not replace an invalid explicit root with a marker, and do not use an empty root-relative identity. Preserve all relative segments. Deliberate manual SLEEP targets override automatic discovery; account preferences may deliberately target `.user`.
