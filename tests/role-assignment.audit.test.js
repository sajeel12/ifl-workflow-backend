import { jest, describe, test, expect, afterEach } from '@jest/globals';

afterEach(() => {
    jest.resetModules();
});

async function loadHandleRequest({ currentStageAssigneeEmail, signedInEmail }) {
    jest.resetModules();

    const getFormContext = jest.fn().mockResolvedValue({
        role: 'IT',
        request: {
            id: 55,
            currentStageAssigneeEmail,
            status: 'PendingIT'
        }
    });
    const updateITDetails = jest.fn().mockResolvedValue(undefined);
    const timelineCreate = jest.fn().mockResolvedValue(undefined);

    await jest.unstable_mockModule('../src/services/onboardingService.js', () => ({
        getFormContext,
        updateITDetails,
        createRequest: jest.fn(),
        handleHODApproval: jest.fn(),
        updateDCIDetails: jest.fn(),
        handleDCIManagerApproval: jest.fn(),
        handleITHODApproval: jest.fn(),
        handleDCIImplementation: jest.fn(),
        handleOPSAction: jest.fn()
    }));
    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/models/SystemConfig.js', () => ({
        default: { findOne: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: { findByPk: jest.fn(), findOne: jest.fn(), findAndCountAll: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
        default: { create: timelineCreate, findAll: jest.fn() }
    }));
    await jest.unstable_mockModule('sequelize', () => ({ Op: {} }));
    await jest.unstable_mockModule('../src/utils/historyFormatter.js', () => ({
        humanizeDetails: jest.fn(),
        humanizeDetailsHTML: jest.fn(),
        humanizeAction: jest.fn(),
        narrate: jest.fn()
    }));
    await jest.unstable_mockModule('../src/utils/workflowLabels.js', () => ({
        labelFor: jest.fn(),
        ownerFor: jest.fn(),
        colorFor: jest.fn()
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: { findOne: jest.fn(), findAll: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: { findOne: jest.fn(), findAll: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({
        emailsMatch: (left, right) => {
            const normalize = (value) => (value || '').split('@')[0].toLowerCase();
            return normalize(left) === normalize(right);
        }
    }));
    await jest.unstable_mockModule('../src/utils/locationGroups.js', () => ({
        LOCATION_GROUPS: [],
        groupByKey: jest.fn(),
        groupLabel: jest.fn()
    }));

    const { handleRequest } = await import('../src/controllers/onboardingController.js');

    const req = {
        method: 'POST',
        query: { token: 'stage-token' },
        body: { internetAccess: 'on' },
        user: { email: signedInEmail, displayName: 'Signed In User' }
    };
    const res = {
        status: jest.fn().mockReturnThis(),
        render: jest.fn().mockReturnThis()
    };

    return { handleRequest, req, res, updateITDetails };
}

describe('Role reassignment audit', () => {
    test('new requests bind the currently configured recipient email', async () => {
        jest.resetModules();

        const originalAppUrl = process.env.APP_URL;
        process.env.APP_URL = 'http://localhost:3000';

        const requestUpdate = jest.fn().mockResolvedValue(undefined);
        const requestRow = { id: 9, location: 'LHE', update: requestUpdate };

        await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
            default: { create: jest.fn().mockResolvedValue(requestRow), findOne: jest.fn() }
        }));
        await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
            default: { create: jest.fn().mockResolvedValue(undefined) }
        }));
        await jest.unstable_mockModule('../src/models/SystemConfig.js', () => ({ default: {} }));
        await jest.unstable_mockModule('../src/services/emailService.js', () => ({
            sendOnboardingNotification: jest.fn().mockResolvedValue(undefined)
        }));
        await jest.unstable_mockModule('../src/services/pdfService.js', () => ({}));
        await jest.unstable_mockModule('../src/utils/logger.js', () => ({
            default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        }));
        await jest.unstable_mockModule('../src/services/recipientService.js', () => ({
            default: {
                get: jest.fn().mockResolvedValue('new.it.ops@ifl.com'),
                getWithFallback: jest.fn()
            }
        }));

        const onboardingService = await import('../src/services/onboardingService.js');

        try {
            await onboardingService.createRequest({ location: 'LHE', requesterName: 'HR User' });
            expect(requestUpdate).toHaveBeenCalledWith({ currentStageAssigneeEmail: 'new.it.ops@ifl.com' });
        } finally {
            if (originalAppUrl === undefined) {
                delete process.env.APP_URL;
            } else {
                process.env.APP_URL = originalAppUrl;
            }
        }
    });

    test('allows the newly assigned role member to submit an in-flight request', async () => {
        const { handleRequest, req, res, updateITDetails } = await loadHandleRequest({
            currentStageAssigneeEmail: 'old.it.ops@ifl.com',
            signedInEmail: 'new.it.ops@ifl.com'
        });

        await handleRequest(req, res);

        expect(updateITDetails).toHaveBeenCalledWith('stage-token', expect.any(Object));
        expect(res.status).not.toHaveBeenCalledWith(403);
    });
});