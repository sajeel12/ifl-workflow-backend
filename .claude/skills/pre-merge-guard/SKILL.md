---
name: pre-merge-guard
description: Read-only pre-merge safety analysis of an incoming git branch (e.g. sajeel) against the current branch (main). Classifies which business logic (controllers/services), which views (.ejs), and which onboarding-critical files a merge would disturb; flags risky deletions, conflict-risk overlaps, and stale branches that would revert current work — so the developer can review and fix BEFORE merging. Use before pulling/merging another developer's branch, or whenever asked "what will this merge break / disturb / affect" or "is it safe to merge <branch>".
---

# Pre-Merge Guard

Analyse what merging an incoming branch into the current work would do **without ever merging**. The goal is to surface, ahead of time, exactly which business logic and which views would change, with special attention to onboarding code that must not be broken or reverted.

## When to use
- Before pulling/merging another developer's branch (default targets: `sajeel`, then `sajeeel`).
- When the user asks "is it safe to merge X", "what will this merge break", "what business logic / views will it disturb".
- Any time you need a risk picture before integrating someone else's push.

## Hard rules
- **This skill is READ-ONLY. Never run `git merge`, `git pull`, `git rebase`, `git cherry-pick`, `git reset`, or any history-changing command as part of it.** It only fetches and inspects.
- Never push anything.
- If a merge looks beneficial, *recommend* the safe path (usually cherry-picking specific additive files) and let the user decide — do not perform it inside this skill.

## Instructions

### Step 1: Run the analyzer
From the repo root, run the analysis script. It fetches all branches and prints a categorized risk report.

```
pwsh -File ".claude/skills/pre-merge-guard/scripts/analyze-merge.ps1" -Branch sajeel -Base main
```
(Run from the repo root. If the skill is installed in your user directory instead, use that absolute path.)

- `-Branch` is optional; if omitted it tries `sajeel` then `sajeeel`. Pass any branch name to analyze a different one (e.g. `-Branch staging`).
- `-Base` defaults to `main`.
- The script resolves `origin/<branch>` automatically, so you analyze what's actually on GitHub, not a stale local copy.

### Step 2: Read the verdict and categories
The script prints, in order:
1. **SUMMARY** — branch vs base, merge-base, incoming commits, how far behind base the branch is, and whether it's already merged or stale.
2. **VERDICT** — `SAFE` / `REVIEW` / `DANGEROUS` with the reasons.
3. **🔴 ONBOARDING-CRITICAL IMPACT** — the files that matter most (onboarding controller/service/views, `server.js`, migrations, `adService`/`adsearch.aspx`, `recipientService`, `emailService`, `employeeJourney`).
4. **BUSINESS LOGIC** affected (controllers / services / middleware / routes / utils / `.aspx`).
5. **VIEWS** affected (`.ejs`).
6. **MODELS / MIGRATIONS**.
7. **RISKY DELETIONS** — files the merge would *remove* that still exist on base (this is how a stale branch silently deletes your work).
8. **CONFLICT-RISK** — files changed on *both* sides since they diverged (real merge-conflict candidates).
9. **SAFE ADDITIVE** — new docs/config/tests that don't touch app code.

### Step 3: Explain the business-logic and view impact in plain language
This is the core deliverable. For every file in the **ONBOARDING-CRITICAL**, **BUSINESS LOGIC**, **VIEWS**, and **CONFLICT-RISK** sections, open the actual diff and explain *what would change and what could break*:

```
git diff main...origin/<branch> -- <path>
```

For each such file, tell the user:
- **What** the incoming change does (the behaviour/logic/view it alters).
- **Why it's risky** — e.g. it overwrites a function you rely on, removes a route, changes an email recipient, alters an onboarding stage transition, or deletes a view your code renders.
- **Whether it overlaps** with your recent work on `main` (conflict candidate) or simply reverts it (stale-branch deletion).

Cross-reference the project memory: onboarding is the user's domain and must not break; an earlier offboarding merge once **silently dropped onboarding code** (server.js migrations, `collectNotifyEmails`). Treat any deletion or overwrite of onboarding logic as HIGH severity.

### Step 4: Recommend the safe correction path — do not merge
Conclude with concrete, careful guidance, for example:
- "These 3 files are purely additive (CI/CODEOWNERS) — safe to **cherry-pick just those files** if you want them."
- "This branch is stale and would delete N files of current code — do **not** merge it; if you need its unique additions, take them file-by-file."
- "File X conflicts with your recent onboarding change — before merging, reconcile these specific lines: …"

Always end by leaving the merge decision to the user. Offer to cherry-pick specific safe files on request, but never merge the branch wholesale from within this skill.

## Notes
- See `references/classification.md` for how paths map to categories and severity, and how to extend the onboarding-critical list as the codebase grows.
- The overlap/conflict detection is git-version tolerant: it always computes the "changed on both sides" heuristic, and additionally uses `git merge-tree` for a precise conflict list when the installed git supports it.
