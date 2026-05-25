import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * Delegation model audit
 *
 * Business rules under test:
 *  - IT HOD and DCI Manager use delegation: admin changes the configured email,
 *    and the live config is the authority — not the stored currentStageAssigneeEmail.
 *  - When a role is delegated to a new person:
 *    GET (email link): old person sees a 403 with the delegate's name at link-open
 *                      time, before they can view any form data.
 *    POST (submit):    old person is blocked; new person can submit.
 *  - The 403 message must name the current delegate so the old person knows
 *    who to contact (Option 1 behaviour).
 */

afterEach(() => {
    jest.resetModules();
    delete process.env.APP_URL;
});

async function loadController({
    method,
    status,
    formRole,
    currentStageAssigneeEmail,
    signedInEmail,
    configuredApprover   // { email, name } | null
}) {
    jest.resetModules();
    process.env.APP_URL = 'http://localhost:3000';

    const handleDCIManagerApproval = jest.fn().mockResolvedValue({
        status: 'PendingDCIImplementation'
    });
    const handleITHODApproval = jest.fn().mockResolvedValue(undefined);

    await jest.unstable_mockModule('../src/services/onboardingService.js', () => ({
        getFormContext: jest.fn().mockResolvedValue({
            role: formRole,
            request: {
                id: 60,
                status,
                currentStageAssigneeEmail,
                location: 'ISB'
            }
        }),
        createRequest: jest.fn(),
        updateITDetails: jest.fn(),
        handleHODApproval: jest.fn(),
        updateDCIDetails: jest.fn(),
        handleDCIManagerApproval,
        handleITHODApproval,
        handleDCIImplementation: jest.fn(),
        handleOPSAction: jest.fn()
    }));

    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: {
            findOne: jest.fn().mockResolvedValue(
                configuredApprover
                    ? {
                        approverEmail: configuredApprover.email,
                        approverName: configuredApprover.name,
                        primaryExpiredAt: null,
                        secondaryEmail: null,
                        secondaryName: null
                    }
                    : null
            ),
            findAll: jest.fn().mockResolvedValue([])
        }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: {
            findOne: jest.fn().mockResolvedValue(null),
            findAll: jest.fn().mockResolvedValue([])
        }
    }));
    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: {
            findOne: jest.fn().mockResolvedValue(null),
            findAll: jest.fn().mockResolvedValue([]),
            findByPk: jest.fn().mockResolvedValue(null)
        }
    }));
    await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
        default: { create: jest.fn().mockResolvedValue(undefined), findAll: jest.fn().mockResolvedValue([]) }
    }));
    await jest.unstable_mockModule('../src/models/SystemConfig.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(null), findAll: jest.fn().mockResolvedValue([]) }
    }));
    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/utils/historyFormatter.js', () => ({
        humanizeDetails: jest.fn().mockReturnValue(''),
        humanizeDetailsHTML: jest.fn().mockReturnValue(''),
        humanizeAction: jest.fn().mockReturnValue(''),
        narrate: jest.fn().mockReturnValue('')
    }));
    await jest.unstable_mockModule('../src/utils/workflowLabels.js', () => ({
        labelFor: jest.fn().mockReturnValue(''),
        ownerFor: jest.fn().mockReturnValue(''),
        colorFor: jest.fn().mockReturnValue('')
    }));
    await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({
        emailsMatch: (a, b) =>
            (a || '').split('@')[0].toLowerCase() === (b || '').split('@')[0].toLowerCase()
    }));
    await jest.unstable_mockModule('../src/utils/locationGroups.js', () => ({
        LOCATION_GROUPS: [],
        groupByKey: jest.fn(),
        groupLabel: jest.fn()
    }));
    await jest.unstable_mockModule('sequelize', () => ({ Op: {} }));

    const { handleRequest } = await import('../src/controllers/onboardingController.js');

    const req = {
        method,
        query: { token: 'stage-token' },
        body: { action: 'Approve', dciRemarks: 'OK', itHodRemarks: 'OK' },
        user: { email: signedInEmail, displayName: 'Test User' }
    };
    const res = {
        status: jest.fn().mockReturnThis(),
        render: jest.fn().mockReturnThis()
    };

    return { handleRequest, req, res, handleDCIManagerApproval, handleITHODApproval };
}

describe('Delegation model audit', () => {
    test('GET: old IT HOD sees 403 at link-open and message names the new delegate', async () => {
        const { handleRequest, req, res } = await loadController({
            method: 'GET',
            status: 'PendingITHOD',
            formRole: 'ITHOD',
            currentStageAssigneeEmail: 'old.ithod@ifl.com',
            signedInEmail: 'old.ithod@ifl.com',
            configuredApprover: { email: 'new.ithod@ifl.com', name: 'New IT HOD' }
        });

        await handleRequest(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        const message = res.render.mock.calls[0][1].message;
        expect(message).toContain('new.ithod@ifl.com');
        expect(message).toContain('New IT HOD');
    });

    test('GET: newly configured IT HOD can view the form without being blocked', async () => {
        const { handleRequest, req, res } = await loadController({
            method: 'GET',
            status: 'PendingITHOD',
            formRole: 'ITHOD',
            currentStageAssigneeEmail: 'old.ithod@ifl.com',
            signedInEmail: 'new.ithod@ifl.com',
            configuredApprover: { email: 'new.ithod@ifl.com', name: 'New IT HOD' }
        });

        await handleRequest(req, res);

        expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('POST: old DCI Manager is blocked with 403 after delegation, message names delegate', async () => {
        const { handleRequest, req, res } = await loadController({
            method: 'POST',
            status: 'PendingDCIManager',
            formRole: 'DCIManager',
            currentStageAssigneeEmail: 'old.dcimgr@ifl.com',
            signedInEmail: 'old.dcimgr@ifl.com',
            configuredApprover: { email: 'new.dcimgr@ifl.com', name: 'New DCI Manager' }
        });

        await handleRequest(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        const message = res.render.mock.calls[0][1].message;
        expect(message).toContain('new.dcimgr@ifl.com');
        expect(message).toContain('New DCI Manager');
    });

    test('POST: newly configured DCI Manager can submit after delegation', async () => {
        const { handleRequest, req, res, handleDCIManagerApproval } = await loadController({
            method: 'POST',
            status: 'PendingDCIManager',
            formRole: 'DCIManager',
            currentStageAssigneeEmail: 'old.dcimgr@ifl.com',
            signedInEmail: 'new.dcimgr@ifl.com',
            configuredApprover: { email: 'new.dcimgr@ifl.com', name: 'New DCI Manager' }
        });

        await handleRequest(req, res);

        expect(handleDCIManagerApproval).toHaveBeenCalledWith(
            'stage-token',
            'Approve',
            'OK'
        );
        expect(res.status).not.toHaveBeenCalledWith(403);
    });
});
