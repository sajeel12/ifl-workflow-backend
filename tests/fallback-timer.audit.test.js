import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * RecipientService 2-day fallback timer audit
 *
 * Business rules under test (RecipientService itself is NOT mocked — only its
 * DB dependencies are):
 *  - First routing stamps lastAssignedAt on the config row and returns primary.
 *  - Primary is still used if lastAssignedAt is < 2 days ago.
 *  - Secondary triggers when lastAssignedAt > 2 days; primaryExpiredAt is stamped.
 *  - When primaryExpiredAt is already set, secondary is returned immediately
 *    with no further timer check.
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

    test('secondary triggered and primaryExpiredAt stamped when lastAssignedAt > 2 days', async () => {
        const cfg = makeCfg({ lastAssignedAt: STALE, primaryExpiredAt: null });
        const svc = await loadService({ cfg });

        const result = await svc.getWithFallback('IT_OPS', { location: 'KHI', requestId: 3 });

        expect(result.email).toBe('secondary@ifl.com');
        expect(result.isFallback).toBe(true);
        expect(cfg.update).toHaveBeenCalledWith(
            expect.objectContaining({ primaryExpiredAt: expect.any(Date) })
        );
    });

    test('when primaryExpiredAt already set, secondary returned immediately without re-stamping', async () => {
        const cfg = makeCfg({ lastAssignedAt: RECENT, primaryExpiredAt: new Date() });
        const svc = await loadService({ cfg });

        const result = await svc.getWithFallback('IT_OPS', { location: 'KHI', requestId: 4 });

        expect(result.email).toBe('secondary@ifl.com');
        expect(result.isFallback).toBe(true);
        // Should NOT call update again — primaryExpiredAt is already recorded
        expect(cfg.update).not.toHaveBeenCalledWith(
            expect.objectContaining({ primaryExpiredAt: expect.any(Date) })
        );
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

    test('DCI_MANAGER uses IT_HOD as cross-backup when its own emails are empty', async () => {
        jest.resetModules();
        process.env.EMAIL_MODE = 'PROD';

        const emptyCfg = makeCfg({ approverEmail: null, approverName: null, secondaryEmail: null, secondaryName: null });
        const itHodCfg = makeCfg({ approverEmail: 'ithod@ifl.com', approverName: 'IT HOD' });

        await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
            default: { findOne: jest.fn().mockResolvedValue(null) }
        }));
        await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
            default: {
                findOne: jest.fn().mockImplementation(({ where }) =>
                    Promise.resolve(where.roleKey === 'DCI_MANAGER' ? emptyCfg : itHodCfg)
                )
            }
        }));
        await jest.unstable_mockModule('../src/services/hrmsService.js', () => ({
            default: { getManager: jest.fn().mockResolvedValue(null) }
        }));
        await jest.unstable_mockModule('../src/utils/logger.js', () => ({
            default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        }));

        const { default: RecipientService } = await import('../src/services/recipientService.js');
        const result = await RecipientService.getWithFallback('DCI_MANAGER', { requestId: 7 });

        expect(result.email).toBe('ithod@ifl.com');
        expect(result.isFallback).toBe(true);
        expect(result.source).toContain('CrossBackup');
    });

});
