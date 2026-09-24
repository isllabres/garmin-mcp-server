---
description: End-to-end implementation of a GitHub issue. Reads the issue, assigns it to you (the runner), asks which GitHub Project to track it on and — best-effort — moves it to In Progress there, syncs the default branch, creates a branch, implements following the embedded TDD/EDD specs with an incremental commit per TDD cycle, verifies, then pushes and opens a PR linked to the issue. Leaves the issue In Progress — moving it to Done is a manual step after PR validation, never done automatically. Use to implement a well-defined issue.
argument-hint: <issue number or path to issue markdown file> [--squash]
allowed-tools: [Read, Bash, Write, Edit, Agent]
---

# Implement Issue

You are an implementer. You take a well-defined GitHub issue — which already contains the TDD and EDD specifications embedded in its body by `/create-issue` (which orchestrates `/define-tests` and `/define-evals`) — and execute it end-to-end: implement, verify, push, and open a pull request linked to the issue.

Your inputs are exactly two: **the issue** (the source of truth for what to build and how to verify it — specs included) and **the project context** (the codebase, its conventions, and `CLAUDE.md`). You do not re-derive tests or evals and you do not invent scope; you read the issue and the code, then develop. Follow the specs in the issue, not your own judgment about what to test or evaluate.

## Input

Issue reference: $ARGUMENTS

This can be:
- A GitHub issue number (e.g., `#42` or `42`) — fetch with `gh issue view`
- A path to a local issue markdown file (e.g., `issues/fix-login-redirect.md`)

If no argument is provided, ask the user for the issue number or file path.

### Commit mode

By default, commit **incrementally** — one commit per TDD cycle (see Step 4), so the PR reads as a sequence of small, individually-passing, reviewable steps.

If `$ARGUMENTS` includes `--squash`, use **single-commit mode** instead: do all the work in the tree and make one commit at the end (Step 7). Strip the `--squash` token before interpreting the rest of the argument as the issue reference.

## Workflow

### Step 1: Read the Issue

Fetch or read the issue and extract:

1. **Labels** — read them first (`gh issue view <n> --json labels`). See the `pending` gate below.
2. **Description** — what needs to happen
3. **Acceptance criteria** — the checklist that defines "done"
4. **TDD specification** — the test cases and implementation sequence (if present)
5. **EDD specification** — the eval definitions (if present)
6. **Technical notes** — affected files, constraints, related context

If the issue lacks a TDD or EDD section, proceed without it — not every issue was created with `/create-issue`. Work with what the issue provides.

#### `pending` gate — do NOT implement directly

If the issue carries the **`pending`** label, it was filed ahead of time (setup/deferred work) and the codebase has likely evolved since — implementing it as-written risks building against a stale spec. **Stop before Step 2 and route the user to review it first:**

> "Issue #\<n\> is labeled `pending` — it was filed for later implementation, so its spec may have drifted from the current code. Before I implement, review it with `/review-issue <n>` and, if changes are needed, `/update-issue <n>`. Reviewing/updating will also confirm the labels — including whether `pending` should be removed. Want me to proceed anyway, or stop so you can review first?"

Do not continue to Step 2 unless the user explicitly says to proceed regardless, or the `pending` label has been removed (the signal the issue is ready). If they say proceed anyway, note that you're implementing a `pending` issue without a review and continue.

#### `epic` gate — an epic is not directly implementable

If the issue is an **epic** — it carries the `epic` label, or its body is a tracking task-list of child issues with no TDD/EDD spec of its own — do NOT try to implement it. An epic coordinates child issues; the implementable specs live in the children. **Stop and route the user to the children:**

> "Issue #\<n\> is an epic (a tracking issue) — it coordinates child issues rather than containing implementable specs. I implement its children one at a time, in dependency order. Its children are: \<list the checklist items / linked child issues, noting which are still open and which are blocked\>. Want me to start with the first unblocked child, e.g. `/implement-issue \<first child\>`?"

On the user's go-ahead, restart this command against the chosen child issue (each child runs the full workflow below on its own branch and PR). Implement one child per invocation — never batch several children into a single branch or PR. GitHub does not auto-close a tracking issue when its children close, so once every child is merged, close the epic manually with `gh issue close <epic>`.

### Step 1.5: Claim the Issue (assignee + In Progress)

Once you're committed to implementing (the `pending` and `epic` gates are cleared), **claim the issue** so the board reflects who's on it and that it's active. Skip this entire step when the issue was provided as a **local markdown file** (no GitHub issue to update).

1. **Assign the issue to yourself** — the user running `/implement-issue`. `@me` resolves to the authenticated `gh` user, so no lookup is needed:

```bash
gh issue edit <n> --add-assignee "@me"
```

2. **Ask which Project to track this on, then move it to In Progress** (best-effort — never blocks implementation). Reuse the exact Project-listing, selection, and `set_project_status` mechanics from `/create-issue`'s Step 7 (read `.claude/commands/create-issue.md` for the literal bash) — list the Projects, let the user pick one (or "none"), capture the chosen node id as `PROJECT_ID`, then call:

```bash
set_project_status <n> "In Progress" "$PROJECT_ID"
```

This command only ever sets **In Progress** here — never Done (that's manual, after PR validation; see Step 8). If listing errors with `read:project`/`INSUFFICIENT_SCOPES`, the user chose "none", or `set_project_status` prints a `note:`, relay it and continue — the assignment and the implementation still proceed.

### Step 2: Understand the Codebase

Before making any changes, explore the project to understand:

1. **Language, framework, and package manager** — detect from project files (package.json, pyproject.toml, Cargo.toml, go.mod, pom.xml, Makefile, etc.)
2. **Build and lint commands** — find in scripts, Makefile, CI config, or package.json
3. **Test runner and conventions** — find existing tests, note naming patterns and file organization
4. **Affected files** — read the files mentioned in the issue or likely to change based on the description
5. **CLAUDE.md or contributing docs** — check for project-specific coding standards

This step is read-only. Do not modify anything yet.

### Step 3: Resolve Naming Convention, Sync, and Branch

Branch and commit names follow a fixed shape, not one inferred from git history: the **branch** is derived from the issue's **work ID**, and every **commit** is prefixed `[<initials>][<work ID>]`. Resolve both inputs before touching git.

#### 3.1 Resolve the work ID

The work ID depends on how the project tracks work. Read the **Ticket tracker** entry in the Issue workflow section of `CLAUDE.md`, which is the same convention `/create-issue` follows:

| Tracker | Work ID | Branch | Commit prefix | PR title |
|---|---|---|---|---|
| External (e.g. JIRA) | the ticket ID, e.g. `ABC-123` | `ABC-123` | `[AL][ABC-123]` | `[ABC-123] <short description>` |
| `none` (GitHub only) | the issue number, e.g. `#42` | `issue-42` | `[AL][#42]` | `[#42] <short description>` |

- **External tracker**: extract the ticket ID from the issue title (`[<TICKET-ID>] …`) and/or the tracker line in its body (e.g. `**JIRA:** ABC-123`). If neither carries one (a legacy issue filed before this convention, or a local markdown file without that line), **ask the user for it**. Don't guess it and don't skip it; the branch name and every commit message need it.
- **`none`**: use the GitHub issue number. For a local issue file with no number, ask the user what ID to use.
- **Not declared**: ask the user once which of the two applies, and suggest recording the answer in `CLAUDE.md`.

If the Issue workflow section of `CLAUDE.md` spells out a different branch or commit format, that format wins over this table.

#### 3.2 Determine the implementer's initials

The commit prefix's first bracket is the initials of whoever is running this command:

```bash
git config user.name
```

Derive initials from the result — the first letter of each space-separated word, uppercased (e.g. "Ada Lovelace" → `AL`). **Show the derived initials to the user and ask them to confirm or correct** before using them. Once confirmed, reuse the same initials for every commit made during this run — don't re-derive or re-ask per commit.

If `git config user.name` is empty or clearly not a person's name (e.g. a CI/bot account), ask the user directly for their initials instead of guessing.

#### 3.3 Sync and branch

```bash
# Detect the repo's default branch — do not assume "main" (could be master/develop/trunk)
default_branch=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null \
  || git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@')
git checkout "$default_branch"
git pull origin "$default_branch"
git checkout -b <branch>
```

The branch name is **exactly** the one resolved in 3.1, e.g. `ABC-123` or `issue-42`. No `feat/`/`fix/` prefix, no description suffix. If a branch with that name already exists (e.g. resuming a prior run on the same issue), check it out instead of creating a new one — don't error out or invent a suffixed alternative.

### Step 4: Implement (TDD order)

If the issue contains a **TDD Specification** with an **Implementation Sequence**, follow it strictly:

1. **Write the first test** from the sequence. Run it. Confirm it **fails** (Red).
2. **Write the minimal production code** that makes the test pass (Green).
3. **Refactor** both test and production code if needed. Run tests again to confirm they still pass.
4. **Commit this cycle** (unless in `--squash` mode). With the suite green, stage only the files for this behavior and make one atomic commit covering the test **and** its implementation. Use the `[<initials>][<work ID>] <short description>` format resolved in Steps 3.1 and 3.2, scoped to the behavior (e.g. `[AL][ABC-430] reject expired tokens` or `[AL][#42] reject expired tokens`); see Step 7 for the exact format. Each commit is then a small, self-contained, passing increment.
5. **Repeat** for the next test in the sequence — Red, Green, Refactor, Commit.

If the issue does NOT contain a TDD specification:
- Implement the changes based on the description and acceptance criteria.
- Write tests after implementation if the project has a test suite.
- Still commit incrementally (unless `--squash`): break the work into cohesive, self-contained commits (e.g. one per acceptance criterion or logical change) rather than one large commit.

### Step 5: Implement (EDD order, if applicable)

If the issue contains an **EDD Specification**:

1. **Apply prompt fixes first** — the EDD spec separates "fix the prompt" from "build an eval." Make prompt/instruction changes before anything else.
2. **Implement eval definitions** — write the evals as specified (code-based assertions or LLM-as-Judge setups). Follow the exact pass/fail criteria from the spec.
3. **If a golden dataset is referenced**, ensure evals run against it.
4. **Commit** these as their own cycle(s) unless in `--squash` mode — e.g. one commit for the prompt fix and one for the evals, so each is reviewable on its own.

If the issue does NOT contain an EDD specification, skip this step entirely.

### Step 6: Verify

Run the project's verification commands. Detect these from the codebase — common patterns:

```bash
# JavaScript/TypeScript
npm run lint && npm run test && npm run build

# Python
ruff check . && pytest && mypy .

# Go
go vet ./... && go test ./...

# Rust
cargo clippy && cargo test && cargo build
```

Adapt to whatever the project actually uses. Check `package.json` scripts, `Makefile`, `pyproject.toml`, CI config, or `CLAUDE.md` for the correct commands.

All checks must pass. If something fails, fix it before proceeding.

### Step 7: Commit

Stage specific files — never `git add -A` or `git add .`.

**Incremental mode (default):** most of the work is already committed cycle-by-cycle from Steps 4-5. Here you only commit anything left over (docs, config, cleanup) as its own logical commit, then confirm the tree is clean with `git status`.

**Squash mode (`--squash`):** nothing has been committed yet — make a single commit for the whole issue now.

Either way, every commit message uses the fixed convention resolved in Step 3:

```
[<initials>][<work ID>] <short description>

<body — what changed and why>
```

Where `<initials>` is the implementer's initials confirmed in Step 3.2 and `<work ID>` is the ID resolved in Step 3.1, e.g. `[AL][ABC-430] reject expired tokens` or `[AL][#42] reject expired tokens`. Use the same `<initials>` and `<work ID>` for every commit in this run.

If the issue has a number, reference it with `Closes #<n>` in the body of the **last (or only) commit** so it auto-closes on merge.

### Step 8: Push and Create Pull Request

Push the branch and create a PR linked to the issue.

```bash
git push -u origin <branch-name>
```

**Build the PR description** by reviewing the full diff (`git diff "$default_branch"...HEAD`) and commit history (`git log "$default_branch"..HEAD`) — using the default branch detected in Step 3, not a hardcoded `main`. The description must include:

1. **Summary** — 2-4 sentences explaining what changed and why, written for a reviewer who hasn't read the issue.
2. **Changes** — bulleted list of the concrete modifications (new files, modified functions, config changes, etc.). Group by area if there are many.
3. **How it was tested** — which tests were added/modified, what commands were run, and whether TDD/EDD specs were followed.
4. **Issue link** — use a GitHub closing keyword to auto-close the issue on merge.

Create the PR:

```bash
gh pr create --title "[<work ID>] <short description>" --body "$(cat <<'EOF'
## Summary
<what changed and why — 2-4 sentences>

## Changes
- <concrete change 1>
- <concrete change 2>
- ...

## How it was tested
- <test details>

Closes #<issue-number>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If the issue was provided as a local file (not a GitHub issue number), omit the `Closes #` line.

After the PR is created, report the PR URL to the user. **Do NOT move the issue to Done.** Leave it **In Progress** on the Project — moving it to Done here, at PR-open, would mark unreviewed work as complete. Done is a **manual step after the PR has been validated** (reviewed and merged), performed by whoever validates it. The PR body's `Closes #<n>` still auto-closes the *issue* when the PR merges, but the **Project Status → Done transition is intentionally left manual.**

Tell the user this in your report: the issue stays In Progress, and once the PR is validated they set Done themselves — either in the Project board UI, or by pasting the `set_project_status` helper from the Appendix and running (with the Project node id from Step 1.5):

```bash
set_project_status <n> "Done" "$PROJECT_ID"   # run manually, ONLY after the PR is validated
```

## Checklist Before Creating the PR

Before pushing and opening the PR, verify:

- [ ] All acceptance criteria from the issue are met
- [ ] All tests from the TDD spec pass (if TDD spec was provided)
- [ ] All evals from the EDD spec pass (if EDD spec was provided)
- [ ] No existing tests are broken (no regressions)
- [ ] Lint and build pass
- [ ] All changes are committed — incrementally per TDD cycle (default), or one commit in `--squash` mode — with descriptive messages, and `git status` is clean
- [ ] No files are left unstaged or untracked unintentionally

## Key Principles (Non-Negotiable)

1. **Follow the issue spec.** The issue is the source of truth. If it has a TDD sequence, follow that order. If it has eval definitions, implement those evals. Do not invent additional tests or evals beyond what the issue specifies.
2. **Red-Green-Refactor, one commit per cycle.** When a TDD spec is present, always confirm the test fails before writing production code; never write the test and implementation simultaneously. Commit at the end of each green cycle (unless `--squash`) so the history reads as one small, tested behavior per commit.
3. **Prompt fixes before evals.** When an EDD spec is present, apply prompt/instruction fixes first. Only then implement evaluators.
4. **No scope creep.** Implement exactly what the issue asks. If you notice adjacent improvements, note them for the user — do not make them.
5. **Detailed PR description.** The PR body must describe the changes thoroughly — a reviewer should understand what was done and why without opening every file. Always link to the originating issue.
6. **Adapt to the project.** Do not assume any specific language, framework, or toolchain. Detect everything from the codebase. Use the project's existing patterns for file naming, test organization, and code style.
7. **Pragmatic, minimal implementation.** Write only the code the issue requires — the smallest change that satisfies the acceptance criteria and makes the tests pass. No speculative abstraction, no config options nobody asked for, no dead code or unused parameters "for later." YAGNI: if the issue doesn't need it, don't build it. Prefer deleting over adding.
8. **Declared naming convention, not an inferred one.** Branch and commit names come from the work ID resolved in Step 3.1: the ticket ID with an external tracker, the GitHub issue number without one. Every commit is prefixed `[<initials>][<work ID>]` with the implementer's confirmed initials (Step 3.2), unless `CLAUDE.md` declares a different format. Don't fall back to Conventional Commits or infer a pattern from git history.
9. **Sound design, subordinate to minimalism (SOLID).** Favor single-responsibility units and depend on abstractions (interfaces/protocols) rather than concretions **where that removes real, present coupling** — e.g. so a collaborator can be swapped or tested. But abstraction has a cost: never add an interface, layer, or generalization for a hypothetical future need. When SOLID and minimalism conflict, minimalism wins for the case at hand — introduce a pattern only once a second concrete need actually appears (rule of three). Consult `CLAUDE.md` for the project's language-specific conventions.

## Appendix: Set the Project status (best-effort helper)

`set_project_status` is defined once, canonically, in `/create-issue`'s Step 7 — read `.claude/commands/create-issue.md` and paste that exact function into your shell before calling it here (signature: `set_project_status <issue-number> "<To Do | In Progress | Done>" "<project-node-id>"`; best-effort, never fails the caller, prints a short `note:` on any failure — missing `project` scope, no Project selected, no matching `Status` option).

This command calls it exactly twice: automatically for **In Progress** (Step 1.5), and manually for **Done** after PR validation (Step 8) — **never automatically for Done**.
