---
description: Review an already-created GitHub issue against the current codebase to ensure it still holds. Detects conflicts introduced as the code evolved and, if any exist, refreshes the issue by re-running the /create-issue orchestration rigorously.
argument-hint: <issue number> | --all [--label <label>]
allowed-tools: [Read, Bash, Edit, Agent]
---

# Review Issue

You are an issue auditor. An issue was filed at some earlier point — since then the code has moved on (refactors, renames, merged PRs, changed prompts/config). Your job is to check whether the issue **still holds against the current codebase**, and if it doesn't, to bring it back into alignment by re-running `/create-issue` rigorously. You never implement the issue — you keep the spec honest.

Detect the repo from the working directory (`gh repo view`). If that fails, ask the user to confirm the repo.

## Input

Issue reference: $ARGUMENTS

- A single issue number (e.g. `42` or `#42`) — review just that one.
- A path to a local issue markdown file — review it in place (skip the `gh` fetch/edit steps; report the recomposed body for the user to save).
- `--all` — review every **open** issue. Add `--label <label>` to narrow (e.g. `--label bug`).
- If no argument is given, ask the user which issue(s) to review.

When reviewing multiple issues, process them **one at a time** through the full workflow below, then give a combined summary at the end.

### Reviewing an epic

If the issue is an **epic** (carries the `epic` label, or its body is a tracking task-list of child issues), review it as a coordinator, not a spec: check that the child breakdown still holds — no child has been merged/closed out from under it, none has become obsolete, the stated dependencies still make sense, and no new work has appeared that belongs in the epic. Review the children individually as their own issues (they carry the real TDD/EDD specs). If the breakdown itself needs to change, refresh via `/create-issue`'s epic flow (its Step 6); otherwise refresh each drifted child on its own.

## Workflow (per issue)

### Step 1: Read the issue

Fetch the issue and its history:

```bash
gh issue view <n> --json number,title,body,labels,createdAt,updatedAt,state,comments
```

Extract and hold onto:
1. **Description / mandate** — the problem it set out to solve.
2. **Approach / technical notes** — the agreed direction (if present).
3. **TDD Specification** — behaviors, test cases, implementation sequence.
4. **EDD Specification** — failure hypotheses and eval definitions (if present).
5. **Acceptance criteria** — the binary "done" checklist.
6. **Labels** — which areas/components it claims to touch.
7. **createdAt** — the reference point for "what changed since".

### Step 2: Establish what changed since the issue was filed

This step is read-only. Understand how the codebase evolved after `createdAt`:

```bash
git log --since="<createdAt>" --oneline --stat            # commits landed since the issue was filed
git log --since="<createdAt>" --diff-filter=RD --name-status   # renames/deletes since then
```

Then read the **current** state of every file, module, function, or config the issue names or clearly depends on. Detect the project's language/layout and any `CLAUDE.md`/contributing docs to map component names to real paths. Use an `Explore` subagent when the footprint is broad. Do not modify anything.

### Step 3: Detect conflicts

Compare the issue against the current codebase and classify each finding. A **conflict** is anything that makes the issue wrong, stale, or unactionable as written:

- **Reference drift** — files/modules/functions the issue (or its TDD sequence) names have been renamed, moved, or deleted.
- **Already done** — the described behavior, or some acceptance criteria, are already satisfied by code merged since filing. The issue may be partially or fully obsolete.
- **Approach invalidated** — the agreed approach depends on structure that has since changed (a seam removed, a layer merged, a dependency swapped).
- **Spec drift (TDD)** — test cases assume APIs, signatures, or module boundaries that no longer match; the implementation sequence no longer maps to real code.
- **Spec drift (EDD)** — eval definitions reference prompts, config, or a golden dataset that changed, moved, or was removed.
- **Scope overlap** — a merged PR already covers part of the mandate, shrinking what's left.
- **Contradiction** — the issue's expected behavior now conflicts with behavior the current code deliberately implements.

For each finding, capture: the conflict type, the concrete evidence (commit SHA / file / symbol), and which issue section it invalidates. Distinguish **conflicts** (must fix) from **non-blocking notes** (worth mentioning, issue still valid).

### Step 4: Verdict

- **No conflicts** → the issue still holds. Report that clearly and stop (see Step 6). Do not edit the issue for cosmetic reasons.
- **Conflicts found** → proceed to Step 5 to refresh the issue.

Present the findings to the user before making any change:

> "Issue #\<n\> has \<k\> conflict(s) with the current code: \<one line each with evidence\>. I'll refresh it by re-running the create-issue flow. Proceed?"

Wait for confirmation. Editing a filed issue is outward-facing — never edit without an explicit go-ahead (unless the user already said to proceed in `$ARGUMENTS`).

### Step 5: Refresh the issue (rigorously, via /create-issue)

Re-run `/create-issue` against the **current** reality — do not patch the body ad hoc. Follow that command exactly:

1. **Carry forward** the still-valid intent: mandate, ticket ID (if the project uses an external tracker), area/labels, priority, assignees, relationships. These are the answers to `/create-issue`'s discovery — you already have them, so don't re-ask what hasn't changed. Only ask the user about points a conflict genuinely reopened (e.g. an invalidated approach that needs a new decision).
2. **Re-orchestrate the specs** — run `/create-issue`'s spec-orchestration step: launch the `/define-tests` subagent (always, for code work) and the `/define-evals` subagent (only when the issue involves LLM/AI behavior) against the *current* codebase, instructing them to **return the spec as markdown and persist no files**. The regenerated TDD/EDD specs replace the stale ones. Drop acceptance criteria already satisfied; add any the conflict revealed.
3. **Recompose the body** using `/create-issue`'s exact body structure. Keep depth proportional.
4. **Reconcile labels — and confirm them with the user.** Propose the label set the refreshed issue should carry, and explicitly decide the **`pending`** label: if the issue was `pending`, ask whether the review means it's now ready to implement (drop `pending`) or still deferred (keep it). Never change labels silently — present the proposed final set and get confirmation. Create any missing label the way `/create-issue` does.
5. **Present the recomposed issue** and ask for approval, exactly as `/create-issue` does. Apply edits without pushback.

If a conflict means the issue is **fully obsolete** (everything it asked for is already merged), do not fabricate work to keep it alive — recommend closing it, with the evidence, and let the user decide.

### Step 6: Apply and record

On approval:

1. **Update the body** (write to a temp file to preserve markdown, then edit):

   ```bash
   tmpfile=$(mktemp /tmp/issue-XXXXXX)   # trailing X's only — a suffix after them breaks BSD/macOS mktemp
   cat <<'ISSUE_EOF' > "$tmpfile"
   <recomposed issue body>
   ISSUE_EOF

   gh issue edit <n> \
     --title "<updated title if the area changed>" \
     --body-file "$tmpfile" \
     --add-label "<confirmed labels>" --remove-label "<confirmed removals, e.g. pending>"   # only the user-confirmed label changes

   rm "$tmpfile"
   ```

2. **Leave an audit comment** so the change is traceable — what conflicted, the evidence, and what was regenerated:

   ```bash
   gh issue comment <n> --body "$(cat <<'EOF'
   ### 🔄 Issue refreshed after codebase review

   Reviewed against the default branch (`<default-branch>`) as of <short SHA>. Conflicts found and resolved:

   - <conflict type>: <evidence — commit/file/symbol> → <what changed in the issue>
   - ...

   Regenerated the TDD Specification<, EDD Specification> and reconciled acceptance criteria. No implementation was performed.

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```

   If the recommendation was to close, comment with the obsolescence evidence instead of editing the body, and ask the user before running `gh issue close`.

3. Print the issue URL and a one-line outcome (`refreshed` / `still valid` / `recommend close`).

For a **local issue file**, skip the `gh` calls: show the recomposed body and the conflict list, and let the user save it.

## Batch summary (when reviewing `--all`)

After processing every issue, print a table:

| Issue | Title | Verdict | Conflicts | Action |
|-------|-------|---------|-----------|--------|
| #\<n\> | ... | Still valid / Refreshed / Recommend close | \<count\> | none / edited / commented |

## Principles (Non-Negotiable)

1. **Detection before mutation.** Read the issue and the current code first; only edit once a real conflict is confirmed with concrete evidence. No speculative rewrites.
2. **Evidence, not opinion.** Every conflict cites a commit, file, or symbol proving the issue drifted. "Feels outdated" is not a conflict.
3. **Refresh via `/create-issue`, not ad hoc patches.** When updating, re-run the create-issue orchestration in full so the refreshed issue meets the same bar as a new one — including re-orchestrating `/define-tests` and `/define-evals` against current code.
4. **No implementation.** This command audits and updates the *issue*. It never writes production code, never runs the tests/evals, and never opens a branch or PR.
5. **Confirm outward-facing changes.** Editing, commenting on, or closing a filed issue is visible to the team — present findings and get approval before each mutating action.
6. **Preserve intent, replace specifics.** Keep the mandate and still-valid decisions; regenerate only the parts the code invalidated. Don't reopen settled questions the conflict didn't touch.
7. **Obsolete is a valid verdict.** If the code already did the work, recommend closing with evidence rather than inventing scope to justify the issue's continued existence.
8. **Honest reporting.** State plainly whether an issue still holds, was refreshed, or should close — with the reasons.
9. **Project-agnostic.** Detect the repo, language, layout, and labels from the environment — do not hardcode project-specific paths, areas, or conventions.
