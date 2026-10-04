---
name: reqall-sleep
description: Compress Reqall project memory — consolidate, split, compact, skip, crosslink, promote, and discard records. Use when the user asks to sleep, compress, or clean up the knowledge graph.
disable-model-invocation: true
---

# SLEEP — compress project memory

**Goal:** Preserve **knowledge** in a **minimal number of short, non-redundant records**.
User invoked sleep → rewrite and delete are expected. Compression is the point.
Knowledge = decisions, outcomes, constraints, IDs, contracts — not session prose.

Ops: `consolidate` · `split` · `compact` · `skip` · `crosslink` · `promote` · `discard`

Rate-limited ~once per 24h per project. **Modest progress is success**.

Use Reqall MCP tools `upsert_project`, `sleep_candidates`, and `sleep_apply`,
plus `get_record`, `list_records`, `list_links`, `search`, and `upsert_link` for review/verification.

## Decision table

| Signal | Action |
|--------|--------|
| Server cluster of highly similar resolved/archived | **consolidate** → one terse durable record; **sources deleted** |
| Isolated resolved/archived; durable but verbose | **compact** |
| Isolated resolved/archived; pure noise | **skip** |
| Active/open; 2+ clearly separable topics | **split** (original deleted by apply) |
| Active/open; single topic, already clear | leave (no op) |
| Cross-project pair; same concept, discovery-useful | **crosslink** |
| Cross-project pair; superficial token overlap | omit |
| `work_review`: unique durable information after comparison | **promote** → durable kind(s), then work log deleted |
| `work_review`: no unique durable information after comparison | **discard** only after preserving useful relationships |
| Candidate unclear / not obvious | **omit this pass** |

`promote` / `discard` apply only to `kind: work`. Never emit `work` from
consolidate/split. Prefer `info` / `arch` / `todo` / `issue` when promoting.

## WORK review policy

Use host equivalents of the tool names below, and only advertised operations/kinds.
If the required reads or operations are unavailable, omit the candidate this pass.

1. Read each WORK log with `get_record`, paginate incoming/outgoing `list_links`,
   and read linked ARCH/SPEC and other durable records. Use project-scoped `search`
   to find existing intent and knowledge, especially when links are missing.
2. **Alignment is not redundancy.** Preserve unique implementation constraints,
   regression fixes, test evidence, outcomes, and remaining limitations even when
   the work followed its spec. Use `promote` into appropriate durable kinds.
3. **Discard only after comparison shows no unique durable information.** Identify
   the surviving records that cover useful content; a knowledge-free log needs none.
   Preserve useful relationships on durable records before discarding: `discard`
   deletes the log's links too. If coverage or relationship meaning is unclear, omit.
4. Preserve an evidence-backed unresolved deviation as a linked `issue`, separating
   expected behavior, observed behavior, and uncertainty about the cause. The
   implementation or the spec may be wrong. Do not automatically rewrite ARCH/SPEC.
5. **Missing links do not prove new requirements.** Reuse intent found by search.
   Promote a novel fact to `info` (or another fitting durable kind); use `spec` only
   for confirmed requirements, never to turn an unapproved proposal into a decision.
6. **Leave ambiguous cases unchanged.** Preserve historical qualifications: dated
   test results and past PR state are not current deployment/runtime guarantees.
7. Before apply, snapshot source records/links and re-read touched records for drift.
   After apply, inspect every result, read back outputs and surviving links, and
   verify deleted sources return structured not-found. Link a new issue to its
   relevant intent with `upsert_link` if needed, then verify. Repair only confirmed
   missing edges. Never replay a destructive batch after an ambiguous response.

## Steps

1. **Project** — explicit skill argument, else the project the Cline plugin
   bound (Project identity contract below). Call `upsert_project` → `project_id`.
2. **Candidates** — `sleep_candidates` with `project_id`. If rate-limited,
   report next eligible time and stop.
3. **Summary** — counts: consolidate, compact/skip, split, crosslink,
   work_review. Empty → "No eligible candidates this pass."
4. **Select ops** — decision table and WORK review policy above. Bodies: terse, non-redundant.
   - **consolidate** — `kind: "arch"`, `status: "resolved"`; best title; keep knowledge from all members; wording is disposable.
   - **compact** — same id; leaner form.
   - **split** — focused sub-records; kind/status fit each topic (usually match original).
   - **crosslink** — only when useful for discovery.
   - **promote** / **discard** — work logs only. Preserve unique knowledge/evidence;
     discard only after the comparison and relationship checks above.
5. **Apply** — one `sleep_apply` with the batch. No per-op confirmation.
6. **Verify** — inspect every apply result for partial failures; do not
   retry the whole destructive batch after an ambiguous response.
7. **Report** — consolidated / compacted / split / crosslinked / skipped /
   promoted / discarded / errors. If candidates were capped: note to run again later.

## Rules

- Knowledge ≠ wording. Prose is disposable; durable facts are not.
- **consolidate always deletes sources**. **promote** and **discard** delete
  the work log.
- Do not ask whether rewrite/delete is OK — user ran sleep.
- Unclear candidate → omit; do not invent merges or splits.
- Server authorization does not replace client judgment or record/link readback.
- Never persist or rewrite secrets into records.

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
