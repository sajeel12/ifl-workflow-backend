import { jest, describe, test, expect, afterEach } from '@jest/globals';

async function loadRecipientService({ overrideRow, globalRow } = {}) {
    jest.resetModules();

    const originalEmailMode = process.env.EMAIL_MODE;
    process.env.EMAIL_MODE = 'LIVE';

    const overrideFindOne = jest.fn().mockResolvedValue(overrideRow ?? null);
    const configFindOne = jest.fn().mockResolvedValue(globalRow ?? null);

    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/services/hrmsService.js', () => ({
        default: { getManager: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: { findOne: overrideFindOne }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: { findOne: configFindOne }
    }));

    const { default: RecipientService } = await import('../src/services/recipientService.js');

    return {
        RecipientService,
        restoreEnv() {
            if (originalEmailMode === undefined) {
                delete process.env.EMAIL_MODE;
            } else {
                process.env.EMAIL_MODE = originalEmailMode;
            }
        }
    };
}

afterEach(() => {
    jest.resetModules();
    delete process.env.TEST_RECIPIENT_EMAIL;
});

describe('Recipient fallback audit', () => {
    test('new request always routes to primary regardless of stale lastAssignedAt — resets the clock', async () => {
        // Fix for: secondary HR seat initiating → secondary IT Ops receiving email.
        // A new request (requestId provided) must always start at primary,
        // no matter what state a previous escalation left on the config row.
        const update = jest.fn().mockResolvedValue(undefined);
        const staleAssignedAt = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000));

        const { RecipientService, restoreEnv } = await loadRecipientService({
            overrideRow: {
                approverEmail: 'primary@ifl.com',
                approverName: 'Primary User',
                secondaryEmail: 'secondary@ifl.com',
                secondaryName: 'Secondary User',
                lastAssignedAt: staleAssignedAt,
                primaryExpiredAt: null,
                update
            }
        });

        try {
            const resolved = await RecipientService.getWithFallback('IT_OPS', {
                location: 'KHI',
                requestId: 42
            });

            expect(resolved).toEqual({
                email: 'primary@ifl.com',
                name: 'Primary User',
                isFallback: false,
                source: 'DB_Primary_LOC[KHI]',
                username: null
            });
            // Clock must be reset — lastAssignedAt updated, primaryExpiredAt cleared
            expect(update).toHaveBeenCalledWith(
                expect.objectContaining({ lastAssignedAt: expect.any(Date), primaryExpiredAt: null })
            );
        } finally {
            restoreEnv();
        }
    });

    test('routes new onboarding requests through the fallback-aware resolver', async () => {
        jest.resetModules();

        const originalAppUrl = process.env.APP_URL;
        process.env.APP_URL = 'http://localhost:3000';

        const requestUpdate = jest.fn().mockResolvedValue(undefined);
        const requestRow = { id: 7, location: 'KHI', update: requestUpdate };
        const create = jest.fn().mockResolvedValue(requestRow);
        const timelineCreate = jest.fn().mockResolvedValue(undefined);
        const sendOnboardingNotification = jest.fn().mockResolvedValue(undefined);
        const get = jest.fn().mockResolvedValue('primary@ifl.com');
        const getWithFallback = jest.fn().mockResolvedValue({
            email: 'primary@ifl.com',
            name: 'Primary User',
            isFallback: false,
            source: 'DB_Primary_LOC[KHI]'
        });

        await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
            default: { create, findOne: jest.fn() }
        }));
        await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
            default: { create: timelineCreate }
        }));
        await jest.unstable_mockModule('../src/models/SystemConfig.js', () => ({
            default: {}
        }));
        await jest.unstable_mockModule('../src/services/emailService.js', () => ({
            sendOnboardingNotification
        }));
        await jest.unstable_mockModule('../src/services/pdfService.js', () => ({}));
        await jest.unstable_mockModule('../src/utils/logger.js', () => ({
            default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        }));
        await jest.unstable_mockModule('../src/services/recipientService.js', () => ({
            default: { get, getWithFallback }
        }));

        const onboardingService = await import('../src/services/onboardingService.js');

        try {
            await onboardingService.createRequest({
                employeeName: 'Ali Khan',
                requesterName: 'HR User',
                requesterEmail: 'hr@ifl.com',
                location: 'KHI'
            });

            expect(getWithFallback).toHaveBeenCalledWith('IT_OPS', {
                location: 'KHI',
                requestId: 7
            });
        } finally {
            if (originalAppUrl === undefined) {
                delete process.env.APP_URL;
            } else {
                process.env.APP_URL = originalAppUrl;
            }
        }
    });
});
