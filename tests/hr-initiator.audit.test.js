import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * HR Initiator parallel-seat audit
 *
 * Business rules under test:
 *  - Both seats in a location override (approverEmail + secondaryEmail) can
 *    independently initiate a request — no primary/secondary timer, no fallback.
 *  - A person who is not in any HR_INITIATOR config row is blocked with 403.
 *  - Submitting a request for an employee who already has an active workflow
 *    is blocked with 409 (regardless of which seat submits).
 */

afterEach(() => {
    jest.resetModules();
    delete process.env.APP_URL;
});

const KHI_HR_OVERRIDE = {
    roleKey: 'HR_INITIATOR',
    location: 'KHI',
    approverEmail: 'hr.primary@ifl.com',
    secondaryEmail: 'hr.secondary@ifl.com',
    isActive: true
};

async function loadController({ signedInEmail, overrideRows = [KHI_HR_OVERRIDE], existingEmployee = null }) {
    jest.resetModules();
    process.env.APP_URL = 'http://localhost:3000';

    const createRequest = jest.fn().mockResolvedValue({ id: 10 });

    await jest.unstable_mockModule('../src/services/onboardingService.js', () => ({
        createRequest,
        getFormContext: jest.fn().mockResolvedValue(null),
        updateITDetails: jest.fn(),
        handleHODApproval: jest.fn(),
        updateDCIDetails: jest.fn(),
        handleDCIManagerApproval: jest.fn(),
        handleITHODApproval: jest.fn(),
        handleDCIImplementation: jest.fn(),
        handleOPSAction: jest.fn()
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: {
            findAll: jest.fn().mockResolvedValue(overrideRows),
            findOne: jest.fn().mockResolvedValue(null)
        }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(null), findAll: jest.fn().mockResolvedValue([]) }
    }));
    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: {
            findOne: jest.fn().mockResolvedValue(existingEmployee ? { id: existingEmployee } : null),
            findAll: jest.fn().mockResolvedValue([]),
            findAndCountAll: jest.fn().mockResolvedValue({ count: 0, rows: [] })
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
        LOCATION_GROUPS: [{ key: 'KHI', label: 'Karachi' }],
        groupByKey: jest.fn().mockReturnValue({ key: 'KHI', label: 'Karachi' }),
        groupLabel: jest.fn().mockReturnValue('Karachi')
    }));
    await jest.unstable_mockModule('sequelize', () => ({ Op: {} }));

    const { handleRequest } = await import('../src/controllers/onboardingController.js');

    const req = {
        method: 'POST',
        query: {},
        body: { employeeId: 'EMP001', employeeName: 'Test Employee' },
        user: { email: signedInEmail, displayName: 'Test HR User' }
    };
    const res = {
        status: jest.fn().mockReturnThis(),
        render: jest.fn().mockReturnThis()
    };

    return { handleRequest, req, res, createRequest };
}

describe('HR Initiator parallel-seat audit', () => {
    test('primary seat (approverEmail) can initiate a request', async () => {
        const { handleRequest, req, res, createRequest } = await loadController({
            signedInEmail: 'hr.primary@ifl.com'
        });

        await handleRequest(req, res);

        expect(createRequest).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('secondary seat (secondaryEmail) can also initiate from the same location', async () => {
        const { handleRequest, req, res, createRequest } = await loadController({
            signedInEmail: 'hr.secondary@ifl.com'
        });

        await handleRequest(req, res);

        expect(createRequest).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('person not in any HR_INITIATOR override is blocked with 403', async () => {
        const { handleRequest, req, res, createRequest } = await loadController({
            signedInEmail: 'stranger@ifl.com'
        });

        await handleRequest(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(createRequest).not.toHaveBeenCalled();
    });

    test('duplicate employee request is blocked with 409 regardless of which seat submits', async () => {
        const { handleRequest, req, res, createRequest } = await loadController({
            signedInEmail: 'hr.primary@ifl.com',
            existingEmployee: 5
        });

        await handleRequest(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(createRequest).not.toHaveBeenCalled();
    });
});
