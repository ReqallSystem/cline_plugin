---
name: reqall-review
description: Interactively review and triage open Reqall records for the current project. Use when the user asks to walk through, update, resolve, or archive open memory.
disable-model-invocation: true
---

# Review Open Records

Walk through open records for the current project and triage them
interactively with the user.

Use Reqall MCP tools `upsert_project`, `list_records`, `get_record`,
`upsert_record`, `upsert_link`, and `list_links`. Call `delete_record`
only if the user explicitly asks.

## Steps

1. **Identify the project** — Use the exact project the Cline plugin
   bound for this session (the `project_name` in injected Reqall
   context). Only without a binding, resolve it with the Project identity
   contract below. Never treat `$HOME`, `ubuntu`, `src`, `workspace`, or a
   bare cwd basename as a project.
   Call `upsert_project` to get the `project_id`.

2. **Fetch open records** — Call `list_records` with `project_id` and
   `status: "open"`. If the user specified a kind filter (e.g. "review my
   issues"), add `kind` accordingly. Otherwise fetch all kinds.
   Follow pagination before claiming every record was reviewed.

3. **Present each record** — For each open record, show its kind, title,
   and status. Call `get_record` for the full body if needed.
   Ask the user:
   - Is this still relevant?
   - Should the status change? (resolve, archive)
   - Does it need more detail or updates?
   - Are there related records to link?

4. **Apply updates** — Based on user responses:
   - `upsert_record` with the record's `id` / `record_id` and only the
     changed fields; pass new relationships inline via `links` on that
     same call
   - `upsert_link` only for a new relationship between two records that
     are otherwise unchanged, or when the host truncates `links[]`
   - `delete_record` only if explicitly requested
   - a status change is not implementation evidence: do not resolve a
     spec or arch record because the user says the work is done — that
     belongs to an outcome record that `implements` it

5. **Verify and summarize** — Check each record and link result
   (`created` / `existing` succeed; `error` is a partial failure to
   repair with `upsert_link`, never by recreating the record). After
   writes, call `list_links` to confirm intended edges. Report what
   changed: records updated, resolved, archived, and links created,
   separately from anything that failed.

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

Keep `upsert_link` only as a fallback when updating an existing
record's links without rewriting the body, or when the host truncates
`links[]`.

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
