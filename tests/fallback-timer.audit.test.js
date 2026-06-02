import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * RecipientService 2-day fallback timer audit
 *
 * Business rules under test (RecipientService itself is NOT mocked — only its
 * DB dependencies are):
 *  - First routing stamps lastAssignedAt on the config row and returns primary.
 *  - Primary is still used if lastAssignedAt is < 2 days ago.
 *  - NEW REQUEST (requestId provided): ALWAYS routes to primary and resets
 *    primaryExpiredAt — no matter what state a previous escalation left behind.
 *    This is the fix for: secondary HR seat initiating → secondary IT Ops routed.
 *  - Display-only resolution (no requestId): stale/expired checks apply so
 *    callers can read current routing state without creating a new assignment.
 *  - When primary is stale but no secondary exists, primary stays (no crash).
 *  - A per-location override row is used in place of the global config; the
 *    fallback timer tracks independently on the override row.
 *  - DCI_MANAGER ↔ IT_HOD cross-backup when both emails are empty.
 *
 * EMAIL_MODE is forced to PROD so _applyTestMode does not intercept results.
 */

afterEach(() => {
    jest.resetModules();
    delete process.env.EMAIL_MODE;
});

const NOW    = new Date();
const RECENT = new Date(NOW - 1 * 24 * 60 * 60 * 1000); // 1 day ago  — still fresh
const STALE  = new Date(NOW - 3 * 24 * 60 * 60 * 1000); // 3 days ago — past 2-day threshold

function makeCfg(overrides = {}) {
    return {
        approverEmail:   'primary@ifl.com',
        approverName:    'Primary User',
        secondaryEmail:  'secondary@ifl.com',
        secondaryName:   'Secondary User',
        primaryExpiredAt: null,
        lastAssignedAt:  null,
        isActive:        true,
        update:          jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

async function loadService({ cfg, overrideCfg = null }) {
    jest.resetModules();
    process.env.EMAIL_MODE = 'PROD';

    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(overrideCfg) }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(cfg) }
    }));
    await jest.unstable_mockModule('../src/services/hrmsService.js', () => ({
        default: { getManager: jest.fn().mockResolvedValue(null) }
    }));
    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));

    const { default: RecipientService } = await import('../src/services/recipientService.js');
    return RecipientService;
}

describe('RecipientService 2-day fallback timer', () => {

    test('first assignment stamps lastAssignedAt and returns primary', async () => {
        const cfg = makeCfg({ lastAssignedAt: null });
        const svc = await loadService({ cfg });

        const result = await svc.getWithFallback('IT_OPS', { location: 'KHI', requestId: 1 });

        expect(result.email).toBe('primary@ifl.com');
        expect(result.isFallback).toBe(false);
        expect(cfg.update).toHaveBeenCalledWith(
            expect.objectContaining({ lastAssignedAt: expect.any(Date), primaryExpiredAt: null })
        );
    });

    test('primary still used when lastAssignedAt is only 1 day ago', async () => {
        const cfg = makeCfg({ lastAssignedAt: RECENT });
        const svc = await loadService({ cfg });

        const result = await svc.getWithFallback('IT_OPS', { location: 'KHI', requestId: 2 });

        expect(result.email).toBe('primary@ifl.com');
        expect(result.isFallback).toBe(false);
        // Must NOT stamp primaryExpiredAt — primary is still fresh
        expect(cfg.update).not.toHaveBeenCalledWith(
            expect.objectContaining({ primaryExpiredAt: expect.any(Date) })
        );
    });

    test('new request (requestId provided) routes to primary even when lastAssignedAt is stale — resets clock', async () => {
        const cfg = makeCfg({ lastAssignedAt: STALE, primaryExpiredAt: null });
        const svc = await loadService({ cfg });

        const result = await svc.getWithFallback('IT_OPS', { location: 'KHI', requestId: 3 });

        // New request always starts with primary — stale lastAssignedAt is ignored
        expect(result.email).toBe('primary@ifl.com');
        expect(result.isFallback).toBe(false);
        expect(cfg.update).toHaveBeenCalledWith(
            expect.objectContaining({ lastAssignedAt: expect.any(Date), primaryExpiredAt: null })
        );
    });

    test('new request (requestId provided) routes to primary even when primaryExpiredAt is set — resets flag', async () => {
        // This is the core fix: secondary HR seat (or any initiator) creating a new
        // request must get primary IT Ops, not secondary, regardless of what a
        // previous escalation left on the config row.
        const cfg = makeCfg({ lastAssignedAt: RECENT, primaryExpiredAt: new Date() });
        const svc = await loadService({ cfg });

        const result = await svc.getWithFallback('IT_OPS', { location: 'KHI', requestId: 4 });

        expect(result.email).toBe('primary@ifl.com');
        expect(result.isFallback).toBe(false);
        // primaryExpiredAt must be cleared so the clock restarts for this new request
        expect(cfg.update).toHaveBeenCalledWith(
            expect.objectContaining({ primaryExpiredAt: null })
        );
    });

    test('display-only resolution (no requestId) still shows secondary when primaryExpiredAt is set', async () => {
        // Without a requestId the call is for display / info — no new assignment.
        // Stale/expired state is preserved so callers can read current routing status.
        const cfg = makeCfg({ lastAssignedAt: RECENT, primaryExpiredAt: new Date() });
        const svc = await loadService({ cfg });

        const result = await svc.getWithFallback('IT_OPS', { location: 'KHI' }); // no requestId

        expect(result.email).toBe('secondary@ifl.com');
        expect(result.isFallback).toBe(true);
    });

    test('when primary is stale but no secondary configured, primary is returned (no crash)', async () => {
        const cfg = makeCfg({ lastAssignedAt: STALE, primaryExpiredAt: null, secondaryEmail: null });
        const svc = await loadService({ cfg });

        const result = await svc.getWithFallback('DCI_TEAM', { requestId: 5 });

        // No secondary available — should not throw; primary stays active
        expect(result.email).toBe('primary@ifl.com');
    });

    test('per-location override row is used instead of global; timer runs on the override row', async () => {
        const globalCfg   = makeCfg({ approverEmail: 'global.itops@ifl.com' });
        const overrideCfg = makeCfg({ approverEmail: 'khi.itops@ifl.com', lastAssignedAt: null });
        const svc = await loadService({ cfg: globalCfg, overrideCfg });

        const result = await svc.getWithFallback('IT_OPS', { location: 'KHI', requestId: 6 });

        expect(result.email).toBe('khi.itops@ifl.com');
        // Timer stamp must be on the override row, NOT the global row
        expect(overrideCfg.update).toHaveBeenCalled();
        expect(globalCfg.update).not.toHaveBeenCalled();
    });

    test('DCI_MANAGER bypasses timer — returns primary directly, never stamps lastAssignedAt', async () => {
        // DCI_MANAGER is a delegation role: admin reassigns via dashboard.
        // Even if lastAssignedAt is STALE the 2-day timer must not fire.
        const cfg = makeCfg({ lastAssignedAt: STALE, primaryExpiredAt: null });
        const svc = await loadService({ cfg });

        const result = await svc.getWithFallback('DCI_MANAGER', { requestId: 8 });

        expect(result.email).toBe('primary@ifl.com');
        expect(result.isFallback).toBe(false);
        // No timer writes allowed on delegation roles
        expect(cfg.update).not.toHaveBeenCalled();
    });

    test('IT_HOD bypasses timer — returns primary directly, never stamps lastAssignedAt', async () => {
        const cfg = makeCfg({ lastAssignedAt: STALE, primaryExpiredAt: null });
        const svc = await loadService({ cfg });

        const result = await svc.getWithFallback('IT_HOD', { requestId: 9 });

        expect(result.email).toBe('primary@ifl.com');
        expect(result.isFallback).toBe(false);
        expect(cfg.update).not.toHaveBeenCalled();
    });

});
