---
name: reqall-persist
description: Classify and persist all work completed in this session to the Reqall knowledgebase. Use before ending a non-trivial turn or when the user asks to save session memory.
---

# Persist Work

Classify the work completed in this session and save it to the Reqall
knowledgebase. Create one record per distinct work item — sessions often
produce multiple artifacts worth tracking.

Cline has no blocking Stop hook: the plugin reminds you after the first edit of a turn, and again on the next prompt when work was left unpersisted. Run this skill before the final user-facing answer of a
non-trivial turn; do not wait for the reminder. Use Reqall MCP tools
`upsert_project`, `search`, `list_records`, `get_record`,
`upsert_record`, `upsert_link`, and `list_links`. Never persist secrets.

## Classification Table

| Work type                          | kind    | status   |
|------------------------------------|---------|----------|
| Bug fix                            | issue   | resolved |
| New bug discovered (not yet fixed) | issue   | open     |
| Completed task                     | todo    | resolved |
| New task identified (not yet done) | todo    | open     |
| Architectural change or decision   | arch    | resolved |
| New or updated specification       | spec    | open     |
| Test / verification evidence       | test    | resolved |
| Durable note (convention, how-to)  | info    | resolved |
| Ephemeral session / progress log   | work    | resolved |
| Trivial / Q&A / unclassifiable     | --      | skip     |

Prefer **durable** kinds. Use `work` only for a session log you expect
SLEEP to `promote` or `discard` later.

## Title Conventions

- Issues: `BUG:`, `TASK:`, `BLOCKER:`, `QUESTION:`
- Specs/architecture: `ARCH:`, `API:`, `AUTH:`, `DATA:`, `UI:`
- Features: `FEAT:`, `REFACTOR:`
- Verification: `TEST:`
- Notes: `INFO:`, `WORK:`

## Steps

1. **Identify the project** — Use the exact project the Cline plugin
   bound for this session (the `project_name` in injected Reqall
   context). Only without a binding, resolve it with the Project identity
   contract below. Never treat `$HOME`, `ubuntu`, `src`, `workspace`, or a
   bare cwd basename as a project.
   Call `upsert_project` with that exact name to get `project_id`.

2. **Analyze the session** — Review the conversation to identify all
   distinct work items. Scan each category explicitly:
   - Files created or modified
   - Bugs fixed or discovered
   - Architectural or design decisions made
   - Specs written, changed, or discussed
   - Tests added or updated
   - Tasks identified for future work
   - Plans produced by subagents

   A session may produce multiple records, e.g. a bug fix
   (issue/resolved), a new spec (spec/open), and a follow-up task
   (todo/open).

3. **Search, then upsert** — For each non-trivial work item, call
   `search` first (conceptual query, not a raw path). If an existing
   record already tracks this work — especially an open issue, spec, or
   todo — call `upsert_record` with that `record_id` so you update it
   (for example `open` → `resolved`) instead of creating a second
   record. Only omit `record_id` when search finds no match.

   Pass:
   - `project_id` from step 1
   - `record_id` when updating an existing record
   - `kind` and `status` from the classification table
   - A short, descriptive `title` with the appropriate prefix
   - A `body` summarizing what was done, why, and any relevant context.
     Include enough detail for semantic search to find this later.
   - `links` (when the tool schema offers it): the record's
     relationships from steps 4 and 5, inline — e.g. the `work` record
     with `{target_id: <spec>, relationship: "implements"}`, a gap
     `todo` with `{target_id: <spec>, relationship: "blocks"}`. One
     call, no separate `upsert_link` to forget.

4. **Reconcile intent** — If `reqall-intend` wrote or selected a
   spec/arch this session (or you know one was agreed), measure
   outcomes against it:
   - Call `get_record` if you need its acceptance criteria. Do not
     resolve intent whose acceptance criteria are unverified, and never
     mark a spec resolved as a substitute for the `implements` link.
   - **Fulfilled** → a `work`, `todo`, or `issue` outcome
     `--implements-->` the intent (inline `links` on its upsert, or
     `upsert_link`). Set that outcome `status: "resolved"`. Leave the
     spec itself `open` unless the user treats specs as tickets to
     close.
   - **Partly or not fulfilled** → create a `todo`/`open` naming the
     gap with an inline link that `blocks` the intent. Keep a session
     `work` record `active` if one exists.
   - **Superseded** → update the intent record's body to the approach
     actually taken, and note the change in the outcome. Do not leave a
     stale spec behind.

5. **Create links** — For each other meaningful relationship between
   records: inline via `links` on the record's own upsert, or
   `upsert_link` between two records that already exist:
   - A bug fix `implements` a spec
   - A test `tests` an architecture decision
   - A new task is `related` to or `blocks` an existing record
   - A spec is `parent` of sub-specifications

   Use `search` to find existing records worth linking to.

6. **Verify each write** — After every meaningful `upsert_record`,
   confirm the tool result succeeded (an `id` returned / no error).
   For intended relationships, confirm via per-link results
   (`created` / `existing`) and `list_links` readback. An `error` link,
   a missing entry, or a count mismatch is partial failure even though
   the record saved. Repair with `upsert_link` once when safe — never
   recreate a saved record. Retry the record write once when the
   transport failed and no `id` was returned. Never tell the user
   "persisted" if the record write failed or a required link errored;
   report the partial failure.

7. **Summarize** — Tell the user what was persisted: records
   created/updated, links established, intent fulfilled or blocked.
   Separate verified successes from remaining failures.

8. **Sanity-check** — Call `list_records` with the `project_id` to
   review the records just created or updated. Cross-check against the
   work items identified in step 2. If anything was missed, search then
   upsert (update an existing match; do not duplicate).

## Inline links and verification

Prefer passing `links` on `upsert_record` (at most 20) over a separate
`upsert_link`-only flow. Each entry names `target_id`, `relationship`,
and, when it matters, `target_table` (`records` or `projects`) and
`direction` (`outgoing`: this record → target, the default; `incoming`:
target → this record). Use `implements` for outcome → intent, `tests`
for evidence → subject, `blocks` for blocker → blocked item, and
`parent` / `related` only when justified.

Check the record result **and every per-link result**: `created` or
`existing` succeeds; `error`, a missing entry, or a count mismatch is
partial failure even though the record saved. After writes, call
`list_links` to confirm intended edges. Repair a missing link with
`upsert_link` (reverse the endpoints for an incoming link) — never
recreate a record that already saved.

Keep `upsert_link` only as a fallback when updating an existing
record's links without rewriting the body, or when the host truncates
`links[]`.

## When to Skip

If the session was purely Q&A, informational, or trivial (no code changes,
no decisions made), do not create any records. Say "Nothing to persist."

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
