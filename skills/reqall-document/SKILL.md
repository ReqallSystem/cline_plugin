---
name: reqall-document
description: Document a single meaningful work item by upserting a Reqall record and related links. Use after a substantive edit, decision, or verification — lighter than a full session persist.
---

# Document Work Item

Persist one work item as it happens. This is lighter-weight than
`reqall-persist` — it documents a single action rather than an entire
session.

The Cline plugin tracks edits and mutating commands; it does not document individual items. Call this after meaningful work while details are fresh. Use Reqall MCP tools `upsert_project`, `search`,
`upsert_record`, `upsert_link`, `get_record`, and `list_links`. Never
persist secrets.

## When to Skip

Do **not** create a record if the work was:
- A read-only operation (reading files, searching, listing)
- A trivial or failed command (e.g. `ls`, `pwd`, a no-op edit)
- A test run that produced no new findings
- A formatting-only change with no semantic impact

Only document **meaningful** work: file creation, substantive edits,
build/deploy commands, database migrations, configuration changes, etc.

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
| Trivial / no-op                    | --      | skip     |

Prefer durable kinds. `work` is ephemeral (SLEEP promote/discard).

## Title Conventions

- Issues: `BUG:`, `TASK:`, `BLOCKER:`
- Specs: `ARCH:`, `API:`, `AUTH:`, `DATA:`, `UI:`
- Features: `FEAT:`, `REFACTOR:`
- Notes: `INFO:`, `WORK:`

## Steps

1. **Identify the project** — Use the exact project the Cline plugin
   bound for this session (the `project_name` in injected Reqall
   context). Only without a binding, resolve it with the Project identity
   contract below. Never treat `$HOME`, `ubuntu`, `src`, `workspace`, or a
   bare cwd basename as a project.
   Call `upsert_project` → `project_id`.

2. **Evaluate the work** — Decide whether this is worth documenting.
   If trivial, output "Nothing to document." and stop.

3. **Search for existing records** — Call `search` with a conceptual
   query (not a raw filesystem path). If an existing record covers this
   work, update it via `upsert_record` (pass its `record_id`) rather
   than creating a duplicate.

4. **Upsert the record** — Call `upsert_record` with:
   - `project_id` from step 1
   - `kind` and `status` from the classification table
   - A short, descriptive `title` with the appropriate prefix
   - A `body` summarizing what was done and why. Include file paths,
     command output, or other details useful for future semantic search.
   - `links` (when the tool schema offers it): the relationships from
     step 5, inline on this same call, so the record and its edges land
     together.

5. **Upsert links** — If the search in step 3 found related records,
   connect them — inline via `links` above, or with `upsert_link` when
   updating an existing record's links without rewriting the body, or
   when the host truncates `links[]`:
   - A bug fix `implements` a spec
   - A test `tests` an architecture decision
   - A new task is `related` to or `blocks` an existing record
   - A spec is `parent` of sub-specifications
   - A `work` record `implements` the spec/arch it is progressing
     toward (intent recorded by `reqall-intend`), when one exists

6. **Check results** — Confirm the record result succeeded (an `id`
   returned / no error) and every inline link result is `created` /
   `existing`. An `error` link means partial persistence: repair with
   `upsert_link` between the existing records; never recreate the
   record. Confirm with `list_links` when a result was ambiguous.
   Never tell the user the item was documented if the record write
   failed or a required link errored.

7. **Summarize** — Output a one-line summary of what was documented,
   naming any link that could not be repaired (or "Nothing to document."
   if skipped). Documenting one item does not reconcile the session:
   still run `reqall-persist` before the final answer.

## Inline links and verification

Prefer passing `links` on `upsert_record` (at most 20) over a separate
`upsert_link`-only flow. Each entry names `target_id`, `relationship`,
and, when it matters, `target_table` (`records` or `projects`) and
`direction` (`outgoing`: this record → target, the default; `incoming`:
target → this record).

Check the record result **and every per-link result**: `created` or
`existing` succeeds; `error`, a missing entry, or a count mismatch is
partial failure even though the record saved. After writes, call
`list_links` to confirm intended edges. Repair a missing link with
`upsert_link` (reverse the endpoints for an incoming link) — never
recreate a record that already saved.

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
