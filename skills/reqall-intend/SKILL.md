---
name: reqall-intend
description: Record agreed intent (a spec or arch record) and its links in Reqall before starting non-trivial work. Use when the user has agreed an approach and before the first implementation edit.
---

# Record Intent

Write down *what is to be* before doing it. A spec (new behavior) or arch
(structural decision) record created here is the yardstick `reqall-persist`
later measures the session's work against: fulfilled intent gets a
`work` / `todo` / `issue` `--implements-->` intent link; unfulfilled
intent gets a blocking todo.

The Cline plugin reminds you about intent on each prompt, but it cannot detect plan acceptance. Run this skill when the user has agreed an approach — a
plan was accepted, or they asked for a specific non-trivial change — and
before the first implementation edit.

This is deliberately small: at most two write calls, usually one.

## When to Run

Run only when **both** hold:

1. The work introduces new behavior, a contract, or a structural
   decision — not a chore, a typo, a single-file fix, a question, or
   chat.
2. The scope is agreed — a plan was accepted, or the user confirmed an
   approach or asked for a specific change.

If either fails, do nothing and say nothing. Over-recording intent
creates spec inflation, which is worse than a missing record.

Use Reqall MCP tools `upsert_project`, `search`, `get_record`,
`list_records`, `impact`, `upsert_record`, `upsert_link`, and
`list_links`. Never persist secrets.

## Steps

1. **Identify the project** — Use the exact project the Cline plugin
   bound for this session (the `project_name` in injected Reqall
   context). Only without a binding, resolve it with the Project identity
   contract below. Never treat `$HOME`, `ubuntu`, `src`, `workspace`, or a
   bare cwd basename as a project.
   Call `upsert_project` with that exact name and note the `project_id`.

2. **Search first** — Call `search` with a one-sentence description of
   the intended change, `project_name` set when bound, `kind: "spec"`
   or `"arch"` as appropriate (or omit kind). Call `get_record` on the
   best hit if the title alone is ambiguous.

3. **Prefer existing over new**
   - An existing spec/arch already describes this intent → call
     `get_record` on it, then **update it** via `upsert_record` (pass
     its `id` / `record_id`) only if the agreed scope adds something;
     otherwise leave it as is.
   - No match → **create one record**:
     - `kind: "spec"`, `status: "open"` for new or changed behavior.
       Title prefix by area: `SPEC:`, `API:`, `AUTH:`, `DATA:`, `UI:`.
     - `kind: "arch"`, `status: "open"` for a structural decision the
       work will realize. Title prefix `ARCH:`.
     - `body`: what will exist when the work is done, why, the agreed
       approach (the accepted plan summary if there is one), acceptance
       criteria, and explicit non-goals. Write for future semantic
       search, not for this session. Reference the GH issue or ticket
       if any.
     - `links`: pass the relationships from step 4 **inline on this
       same call** when the tool schema offers `links` — one call
       creates the record and its edges. Fall back to `upsert_link`
       only when updating an existing record's links without rewriting
       the body, or when the host truncates `links[]`.

4. **Link** — For each related record found in step 2 (inline via
   `links` where possible, else `upsert_link`):
   - when the new intent is a **sub-spec** of an existing broader spec,
     create an **incoming** `parent` edge from the broader spec → this
     new record (inline `links[]`: `relationship: "parent"`,
     `direction: "incoming"`, `target_id` = the broader spec id).
     Equivalently: broader `--parent-->` narrower. If hierarchy is
     not clear, use `related` instead of guessing parent. Do not make
     the narrower record an outgoing `parent` of the broader one.
   - new spec `implements` an existing arch decision
   - existing open issue/todo is `related` to the intent it motivated
   - if the task changes tracked behavior, call `impact` on the
     existing record and link anything downstream that this work
     touches as `related`

5. **Check the link results** — every inline link reports `created`,
   `existing`, or `error`. An `error` is partial persistence: repair it
   with `upsert_link` between the two existing records; do not
   re-upsert the spec without its `id`, and never create it twice.
   Confirm with `list_links` when the result was ambiguous.

6. **Report in one line** — "Intent: #<id> <kind> <title>
   (created|updated|existing), linked to #a, #b." Then start the work.

## How persist reconciles this later

`reqall-persist` (Phase B) measures outcomes against this record:

- **Fulfilled** — a `work`, `todo`, or `issue` outcome
  `--implements-->` this intent. Leave the spec itself `open` unless
  the user treats specs as tickets to close.
- **Unfulfilled or partial** — an open todo `--blocks-->` this intent,
  naming the gap. Keep the session `work` record `active` if one
  exists.
- **Superseded** — update this record's body to the approach actually
  taken; do not leave a stale spec behind.

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

## Do Not

- Make a separate `upsert_link` call for a link you could have passed
  inline on the `upsert_record` call — the second call is the one that
  gets skipped, and an unlinked spec is invisible to `impact`.
- Create a record for work that has no agreed scope yet — ask, or wait
  for the plan to be accepted.
- Create more than one spec/arch per task. Sub-scopes belong in the
  body.
- Create `work`, `todo`, or `issue` records here — those are outcomes,
  which `reqall-persist` and `reqall-document` handle.
- Duplicate an existing spec because its wording differs. Update or
  link.

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
