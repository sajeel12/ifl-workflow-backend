# File classification & severity reference

How `analyze-merge.ps1` maps changed paths to categories, and how to extend it.

## Categories (first match wins, top to bottom)

| Category | Path patterns | Why it matters |
|---|---|---|
| **ONBOARDING** (highest) | `onboard*`, `recipientService`, `collectNotifyEmails`, `emailService`, `adService`, `adsearch.aspx`, `adlookup.aspx`, `employeeJourney`, `server.js`, `src/migrations/*` | The user owns onboarding. An earlier offboarding merge once **silently dropped onboarding code** (server.js migrations + `collectNotifyEmails`). Any change here is HIGH severity, and a deletion/overwrite is critical. |
| **VIEW** | `*.ejs` | UI/templates. A removed or overwritten view can break a page the controller renders. |
| **LOGIC** | `src/controllers/*`, `src/services/*`, `src/middleware/*`, `src/routes/*`, `src/utils/*`, `*.aspx`, `app.js` | Business logic, routing, auth, AD sidecars. |
| **MODEL** | `src/models/*` | DB schema/ORM models — coordinate with migrations. |
| **TEST** | `tests/*` | Test suites — additive is low risk. |
| **CONFIG** | `*.md`, `.github/*`, `package.json`, `package-lock.json`, `web.config`, `.gitignore`, `*CODEOWNERS*`, `*CONTRIBUTING*`, `*.config.*` | Repo infrastructure. Usually additive/safe to cherry-pick. |
| **OTHER** | anything else | Inspect manually. |

## Severity signals the script computes per file
- **DELETES EXISTING** (`RevertsBase`) — the incoming branch *deletes* a file that still exists on base. This is how a stale branch reverts current work. Always HIGH.
- **CONFLICT-RISK** (`Overlap`) — the same file was changed on *both* branches since they diverged. Real merge-conflict candidate; review the specific lines.

## Verdict logic
- **SAFE — nothing to merge**: branch is already an ancestor of base, or adds no commits.
- **DANGEROUS — stale branch**: branch is ≥30 commits behind base AND would delete ≥5 existing files. Do not merge wholesale; take unique additions file-by-file.
- **REVIEW REQUIRED**: any onboarding-critical file, conflict-risk file, or risky deletion is present.
- **SAFE / ADDITIVE**: no app code (ONBOARDING/VIEW/LOGIC/MODEL) touched — only docs/config/tests. Cherry-pick is safe.

## Extending
- Add new onboarding-critical paths to the `$ONBOARD` regex in `scripts/analyze-merge.ps1`.
- Tune the stale thresholds (`$behind -ge 30`, `riskyDeletes -ge 5`) in the same script if the repo's rhythm changes.
- Keep this list in sync with project memory (`MEMORY.md`) so the onboarding-critical set reflects the latest known-fragile files.
