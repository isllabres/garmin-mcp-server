---
description: Update an existing GitHub issue. Takes the issue's current context, applies the requested changes into a new description, then calls /create-issue with that new description to regenerate the issue rigorously.
argument-hint: <issue number> [-- <what to change>]
allowed-tools: [Read, Bash, Edit, Agent]
---

# Update Issue

You update an existing issue. The flow is deliberately simple: **take the context of the issue → apply the requested updates → call `/create-issue` with the new description.** `/create-issue` does the rigorous work (orchestrating `/define-tests` and `/define-evals`, composing the body, labels, presenting for approval). You never implement the issue.

Detect the repo from the working directory (`gh repo view`). If that fails, ask the user to confirm the repo.

## Input

`$ARGUMENTS` = an issue number (e.g. `42` or `#42`), optionally followed by `--` and the requested changes in prose. A path to a local issue markdown file is also accepted (edit it in place; skip the `gh` calls).

- If no issue number is given, ask which issue to update.
- If no changes are given after `--`, ask: **what should change, and why?**

**Epics:** if the target is an epic (carries the `epic` label, or its body is a tracking task-list of children), updating it usually means changing the child breakdown — adding, removing, resequencing, or rescoping children. Apply the update through `/create-issue`'s epic flow so the parent's task list and any affected children stay consistent. To change a single child's spec, update that child directly instead.

## Step 1: Take the context of the issue

Fetch the current issue — this is the context you are updating:

```bash
gh issue view <n> --json number,title,body,labels,assignees
```

Read every section and the labels/assignees. This is the starting point.

## Step 2: Apply the requested updates

Take the changes from `$ARGUMENTS`; if thin or ambiguous, ask focused follow-ups. Apply them to the issue's context to produce a single **new description** — a synthesized brief that merges what stays with what changes:

- **Keep** everything the update doesn't touch.
- **Apply** the requested changes (revise the mandate/approach, add/remove acceptance criteria, re-target area(s), change priority, etc.).
- Where old and requested genuinely contradict, resolve in favor of the update; if unclear, ask.

Apply only what the user asked for — don't smuggle in extra scope. State the new description explicitly before continuing.

## Step 3: Call /create-issue with the new description

Hand the new description to `/create-issue` and run it rigorously, exactly as if creating fresh — it re-orchestrates `/define-tests` and `/define-evals` against the current codebase, recomposes the full body, reconciles labels, and presents for approval. Carry forward the type, ticket ID (if the project uses an external tracker), area(s), priority, assignees, and relationships from Step 1 as create-issue's discovery answers so it doesn't re-ask what hasn't changed.

**Confirm the labels with the user.** Before editing, present the label set the updated issue should carry and get explicit confirmation — never change labels silently. In particular decide the **`pending`** label: if the issue was `pending` and this update makes it ready to implement, propose removing it; if still deferred, keep it.

Because this is an **update** to issue #\<n\> (not a brand-new issue), apply create-issue's regenerated result to the existing issue rather than filing a new one:

```bash
tmpfile=$(mktemp /tmp/issue-XXXXXX)   # trailing X's only — a suffix after them breaks BSD/macOS mktemp
cat <<'ISSUE_EOF' > "$tmpfile"
<the body /create-issue composed from the new description>
ISSUE_EOF

gh issue edit <n> \
  --title "<updated title if it changed>" \
  --body-file "$tmpfile" \
  --add-label "<confirmed labels>" --remove-label "<confirmed removals, e.g. pending>"   # only the user-confirmed label changes

rm "$tmpfile"
```

Then leave a short changelog comment so the update is traceable:

```bash
gh issue comment <n> --body "$(cat <<'EOF'
### ✏️ Issue updated

Requested change: <one-line summary>

Applied: <old → new highlights; TDD/EDD specs regenerated>. No implementation was performed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

For a **local issue file**, skip the `gh` calls: show the regenerated body and let the user save it. Print the issue URL when done.

## Principles

1. **Simple flow.** Context → apply updates → call `/create-issue`. Don't hand-author specs — delegate to `/create-issue`, which owns the rigor.
2. **Faithful.** Apply exactly the changes requested; keep what the update doesn't touch. Surface implied knock-on edits and confirm.
3. **Update, don't duplicate.** The regenerated content edits the existing issue #\<n\>; it does not file a new one.
4. **No implementation.** Updates the issue only — never production code, a branch, or a PR.
5. **Confirm outward-facing changes.** Present the new version (via create-issue's approval step) before editing, and leave a changelog comment.
6. **Project-agnostic.** Detect the repo, labels, and conventions from the environment — do not hardcode project-specific paths or areas.
