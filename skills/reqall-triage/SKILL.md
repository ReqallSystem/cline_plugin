---
name: reqall-triage
description: Classify incoming issues, gather structured details, and create prioritized Reqall records. Use when the user reports a bug, feature request, or support issue that should become a tracked record.
disable-model-invocation: true
---

# Triage Incoming Issue

Interactively classify a new issue or request from the user, gather
structured details, check for duplicates, and create a well-formed
Reqall record with priority.

Use Reqall MCP tools `upsert_project`, `search`, `list_records`,
`upsert_record`, `upsert_link`, `get_record`, and `list_links`. Never
persist secrets.

## Category Table

| Category             | kind  | prefix    | priority hint         |
|----------------------|-------|-----------|-----------------------|
| Bug report           | issue | BUG:      | P0-P2 based on impact |
| Feature request      | spec  | FEAT:     | P2-P4 typically       |
| Account / billing    | issue | ACCOUNT:  | P1-P2 typically       |
| How-to / docs gap    | todo  | DOCS:     | P3-P4 typically       |
| Integration question | issue | INTEG:    | P2-P3 typically       |

## Priority Scale

| Level | Meaning                                                    |
|-------|------------------------------------------------------------|
| P0    | Critical -- system down, data loss, security, no workaround  |
| P1    | High -- major functionality broken, painful workaround       |
| P2    | Medium -- degraded feature, reasonable workaround            |
| P3    | Low -- minor issue, cosmetic, nice-to-have                   |
| P4    | Wishlist -- enhancement idea, future consideration           |

## Steps

1. **Identify the project** — Use the exact project the Cline plugin
   bound for this session (the `project_name` in injected Reqall
   context). Only without a binding, resolve it with the Project identity
   contract below. Never treat `$HOME`, `ubuntu`, `src`, `workspace`, or a
   bare cwd basename as a project.
   Call `upsert_project` with that exact name to get the `project_id`.

2. **Get the initial description** -- Ask the user to describe their issue
   or request in their own words. If they already provided a description
   in the same message that invoked this skill, use that directly.

3. **Classify the category** -- Based on the description, determine the
   category from the Category Table. Tell the user the classification
   and ask them to confirm or correct it.

4. **Gather structured details** -- Based on the confirmed category, ask
   targeted follow-up questions. Ask only what is missing from the
   initial description -- skip questions already answered.

   **Bug report:**
   - Steps to reproduce (numbered)
   - Expected behavior vs actual behavior
   - Environment (OS, browser, runtime version, relevant config)
   - Frequency (always, intermittent, one-time)
   - Error messages or log output
   - Severity self-assessment (blocking work? workaround available?)

   **Feature request:**
   - Use case / user story ("As a ___, I want ___ so that ___")
   - Who benefits and how many users affected
   - Current workaround (if any)
   - Desired behavior in detail
   - Acceptance criteria (how to know it is done)

   **Account / billing:**
   - Account identifier or context
   - Plan or tier
   - Specific charge, feature, or access issue
   - Urgency (blocking work? time-sensitive?)

   **How-to / docs gap:**
   - What they are trying to accomplish
   - What they have tried so far
   - Which documentation they consulted
   - Where the gap or confusion is

   **Integration question:**
   - Which integration, API, or service
   - Version numbers (SDK, API, runtime)
   - Error messages or unexpected responses
   - Code snippet or configuration (if relevant)

5. **Search for duplicates** -- Call `search` with a natural language
   summary of the issue, using the `project_name` parameter. Also call
   `list_records` with `project_id`, `kind` matching the category, and
   `status: "open"` to scan existing open records.

   If potential duplicates are found:
   - Show them to the user with title and body summary
   - Ask: "Is this the same issue, related, or a new issue?"
   - If duplicate: update the existing record with new details via
     `upsert_record` (pass its `record_id`), add a note about the
     additional report, and stop
   - If related: proceed to create a new record and link it in step 8

6. **Determine priority** -- Assess priority using the Priority Scale
   based on these signals:
   - Severity from the user's description and answers
   - Scope of impact (one user vs many, core feature vs edge case)
   - Workaround availability
   - Category default hints from the Category Table

   Present the proposed priority to the user and let them confirm or
   override it.

7. **Create the record** -- Call `upsert_record` with:
   - `project_id` from step 1
   - `kind` from the Category Table
   - `status`: `open`
   - `title`: `{PREFIX} {PRIORITY}: {concise title}`
     Example: `BUG: P1: Login fails silently on Safari 18`
   - `links`: the relationships from step 8, inline
   - `body`: a structured summary including:
     - **Category:** the classification
     - **Priority:** level and justification
     - **Description:** the user's original description
     - **Details:** all gathered structured details
     - **Reporter context:** any relevant user/session context

8. **Link** -- If step 5 found related (non-duplicate) records, pass
   them as inline `links` on the `upsert_record` call in step 7 (one
   call creates the record and its edges). Use `upsert_link` only when
   updating an existing record's links without rewriting the body, or
   when the host truncates `links[]`. Check every link result:
   `created` / `existing` succeed; `error` means the record saved but
   the edge did not -- repair with `upsert_link`, never recreate the
   record. Confirm with `list_links` when a result was ambiguous.
   - Bug that may be caused by an arch decision: `related`
   - Feature request that extends an existing spec: `related`
   - Bug that blocks a todo: `blocks`
   - Duplicate or near-duplicate: `related` with a note

9. **Summarize** -- Report to the user:
   - Record created (title, kind, priority)
   - Any links established
   - Any duplicates noted
   - Suggested next steps (e.g., "This P1 bug should be investigated
     soon" or "This P4 feature request has been queued")
   - Any partial link failure separately from verified writes

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
`upsert_link` (reverse the endpoints for an incoming link) -- never
recreate a record that already saved.

## When to Skip

If the user's description is too vague to classify after one round of
follow-up questions, ask once more for clarification. If still
insufficient, create the record as `kind: issue` with `P3` priority
and a `TRIAGE:` prefix, noting in the body that further clarification
is needed.

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
