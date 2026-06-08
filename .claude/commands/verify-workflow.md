# Workflow Logic Verifier

You are a workflow logic verification agent for the IFL Onboarding system. Your job is to run a comprehensive consistency audit across the codebase and report any failures or mismatches.

Run every check below in order. Do NOT stop on the first failure — complete all checks and produce one consolidated report at the end.

---

## Step 1 — Run the Full Test Suite

Run `npm test` and capture the output. Record: total suites, total tests, any failures.

---

## Step 2 — Cross-File Consistency Checks

Read the following files and verify the items listed under each:

### 2A. FALLBACK_ELIGIBLE statuses

Read `src/services/escalationService.js`.

The `FALLBACK_ELIGIBLE` map must contain exactly these four entries with these values:

| Status | roleKey | emailType | stageStartField |
|--------|---------|-----------|----------------|
| PendingIT | IT_OPS | IT_OPS | hrSubmittedAt |
| PendingDCI | DCI_TEAM | DCI_INPUT | hodApprovedAt |
| PendingDCIImplementation | DCI_IMPLEMENTER | DCI_IMPLEMENTATION | null (special) |
| PendingOPSAction | IT_OPS | OPS_ACTION | dciImplementedAt |

Check that `getStageStartedAt()` returns `itHodDecidedAt || dciManagerDecidedAt` for `PendingDCIImplementation`.

### 2B. LOCATION_AWARE roles — must be consistent across all four files

Read these files and verify each defines `IT_OPS` and `HR_INITIATOR` (and only those two) as location-aware:
- `src/services/escalationService.js` — `const LOCATION_AWARE = new Set([...])`
- `src/services/recipientService.js` — `LOCATION_AWARE_ROLE_KEYS`
- `src/controllers/adminController.js` — location-aware role check
- `src/controllers/onboardingController.js` (or wherever routing resolves recipient) — location-aware role check

Report any file where the set differs.

### 2C. Role keys seeded in server.js

Read `server.js`. The `DEFAULT_APPROVER_CONFIGS` array must contain exactly these roleKeys (OPS_TEAM was removed — PendingOPSAction is handled by IT_OPS):
`HR_INITIATOR, IT_OPS, DCI_TEAM, DCI_MANAGER, IT_HOD, DCI_IMPLEMENTER`

Also verify server.js actively cleans up any stale `OPS_TEAM` row left from older builds.

Cross-check that every roleKey used in `FALLBACK_ELIGIBLE` (`IT_OPS`, `DCI_TEAM`, `DCI_IMPLEMENTER`) and every roleKey referenced in `recipientService.js` exists in this seed list.

### 2D. Stage transition correctness

Read `src/services/onboardingService.js`. Verify these transitions are set via `request.update({ status: ... })`:

| Function | Expected next status | Token cleared? |
|----------|---------------------|---------------|
| updateITDetails | PendingHOD | No |
| handleHODApproval Approve | PendingDCI | No |
| handleHODApproval Reject | Rejected | Yes (null) |
| handleDCIManagerApproval RequestChanges | PendingDCI | No |
| handleDCIManagerApproval Approve (no email) | PendingDCIImplementation | No |
| handleITHODApproval Approve | PendingDCIImplementation | No |
| handleDCIImplementation | PendingOPSAction | No |
| handleOPSAction | Completed | Yes (null) |

### 2E. Escalation cron wired at startup

Read `server.js`. Verify `cronService.scheduleEscalationCheck()` is called before `app.listen()`.

Read `src/services/cronService.js`. Verify the cron expression is `'0 */2 * * *'` and timezone is `Asia/Karachi`.

### 2F. Three role model classification

Read `src/views/pages/admin_workflow_approvers.ejs`. Verify:
- **2-Day Fallback** (Primary + Secondary, blue badge): `IT_OPS`, `DCI_TEAM`, `DCI_IMPLEMENTER` — these are also the only roles in `FALLBACK_TIMER_ROLES` in `recipientService.js`
- **Delegation** (single assignee, yellow badge): `IT_HOD`, `DCI_MANAGER` — admin reassigns directly; no automatic 2-day expiry or cron escalation applies
- **Parallel Seats** (Seat A + Seat B, green badge): `HR_INITIATOR` — no timer

Also verify `recipientService.js` defines `FALLBACK_TIMER_ROLES = new Set(['IT_OPS', 'DCI_TEAM', 'DCI_IMPLEMENTER'])` and that `getWithFallback` short-circuits for roles NOT in that set (returns primary immediately, no `lastAssignedAt` stamp).

None of these should be in the wrong section.

### 2G. Idempotency guard in escalation

Read `src/services/escalationService.js`. Verify that before sending any email, the code checks `emailsMatch(request.currentStageAssigneeEmail, activeCfg.secondaryEmail)` and `continue`s if they match.

### 2H. Test file coverage alignment

Read `tests/escalation.audit.test.js`. Verify it contains tests for:
- Stale request escalated (>48h)
- `primaryExpiredAt` stamped on config row
- Fresh request NOT escalated (<48h)
- Already-escalated request skipped (idempotent)
- No secondary configured — skipped without crash
- PendingDCI uses `hodApprovedAt`
- PendingDCIImplementation uses `itHodDecidedAt`
- IT_OPS uses per-location override (not global)

Read `tests/fallback-timer.audit.test.js`. Verify it contains tests for:
- DCI_MANAGER bypasses the 2-day timer (returns primary, no `update` call)
- IT_HOD bypasses the 2-day timer (returns primary, no `update` call)

---

## Step 3 — Report

Produce a markdown table in this format:

| Check | Result | Notes |
|-------|--------|-------|
| Test suite | PASS / FAIL (N/N passed) | ... |
| 2A FALLBACK_ELIGIBLE | PASS / FAIL | ... |
| 2B LOCATION_AWARE consistency | PASS / FAIL | ... |
| 2C Role key seed coverage | PASS / FAIL | ... |
| 2D Stage transitions | PASS / FAIL | ... |
| 2E Escalation cron wired | PASS / FAIL | ... |
| 2F Role model classification | PASS / FAIL | ... |
| 2G Idempotency guard | PASS / FAIL | ... |
| 2H Test coverage alignment | PASS / FAIL | ... |

After the table, list every FAIL with the exact file, line range, and what needs to change. If everything passes, say: **All checks passed — workflow logic is consistent.**
