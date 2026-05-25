import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * Location-scoped portal audit
 *
 * Business rules under test:
 *  - IT_OPS and HR_INITIATOR portals are location-scoped: each person only
 *    sees requests from their own location group.
 *  - The location is resolved from the user's email by matching it against
 *    approverEmail OR secondaryEmail in the WorkflowApproverLocationOverride table
 *    (both seats have equal visibility — parallel model, not primary/secondary).
 *  - A user not found in any override row (e.g. a global admin account) sees
 *    all requests with no location filter applied.
 *  - HR_INITIATOR rows are never actionable in the portal (read-only tracking).
 *    initiatorName shows who actually started each request.
 */

afterEach(() => {
    jest.resetModules();
});

const KHI_IT_OPS = { roleKey: 'IT_OPS', location: 'KHI', approverEmail: 'itops.khi@ifl.com', secondaryEmail: 'itops.khi2@ifl.com', isActive: true };
const LHE_IT_OPS = { roleKey: 'IT_OPS', location: 'LHE', approverEmail: 'itops.lhe@ifl.com', secondaryEmail: null,               isActive: true };
const KHI_HR     = { roleKey: 'HR_INITIATOR', location: 'KHI', approverEmail: 'hr.khi@ifl.com', secondaryEmail: 'hr.khi2@ifl.com', isActive: true };

function makeMockRequest(overrides = {}) {
    const defaults = {
        id: 77,
        status: 'PendingIT',
        location: 'KHI',
        fullName: 'Ahmed Ali',
        employeeId: 'EMP100',
        department: 'Finance',
        subDepartment: null,
        designation: 'Analyst',
        requesterName: 'HR KHI',
        requesterEmail: 'hr.khi@ifl.com',
        updatedAt: new Date(),
        currentStageToken: 'tok-abc'
    };
    const data = { ...defaults, ...overrides };
    return { toJSON: () => data };
}

async function loadGetRoleQueue({ userEmail, overrideRows, findAllRequests = [] }) {
    jest.resetModules();

    const requestFindAll = jest.fn().mockResolvedValue(findAllRequests);

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
        default: { findAll: requestFindAll, findOne: jest.fn().mockResolvedValue(null) }
    }));
    await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
        default: { findAll: jest.fn().mockResolvedValue([]), create: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/models/SystemConfig.js', () => ({
        default: { findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn() }
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
        LOCATION_GROUPS: [
            { key: 'KHI', label: 'Karachi' },
            { key: 'LHE', label: 'Lahore' }
        ],
        groupByKey: jest.fn(),
        groupLabel: jest.fn()
    }));
    await jest.unstable_mockModule('sequelize', () => ({ Op: {} }));
    await jest.unstable_mockModule('../src/services/onboardingService.js', () => ({
        createRequest: jest.fn(),
        getFormContext: jest.fn(),
        updateITDetails: jest.fn(),
        handleHODApproval: jest.fn(),
        updateDCIDetails: jest.fn(),
        handleDCIManagerApproval: jest.fn(),
        handleITHODApproval: jest.fn(),
        handleDCIImplementation: jest.fn(),
        handleOPSAction: jest.fn()
    }));

    const { getRoleQueue } = await import('../src/controllers/onboardingController.js');

    const req = {
        query: { role: 'IT_OPS', type: 'pending' },
        user: userEmail ? { email: userEmail, displayName: 'Test User' } : null
    };
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
    };

    return { getRoleQueue, req, res, requestFindAll };
}

describe('Location-scoped portal audit', () => {
    test('IT_OPS primary seat (approverEmail) sees only their location\'s requests', async () => {
        const { getRoleQueue, req, res, requestFindAll } = await loadGetRoleQueue({
            userEmail: 'itops.khi@ifl.com',
            overrideRows: [KHI_IT_OPS, LHE_IT_OPS]
        });
        req.query.role = 'IT_OPS';

        await getRoleQueue(req, res);

        const where = requestFindAll.mock.calls[0][0].where;
        expect(where.location).toBe('KHI');
    });

    test('IT_OPS secondary seat (secondaryEmail) also sees only their location\'s requests', async () => {
        const { getRoleQueue, req, res, requestFindAll } = await loadGetRoleQueue({
            userEmail: 'itops.khi2@ifl.com',  // secondaryEmail seat
            overrideRows: [KHI_IT_OPS, LHE_IT_OPS]
        });
        req.query.role = 'IT_OPS';

        await getRoleQueue(req, res);

        const where = requestFindAll.mock.calls[0][0].where;
        expect(where.location).toBe('KHI');
    });

    test('IT_OPS user from LHE sees only LHE requests, not KHI', async () => {
        const { getRoleQueue, req, res, requestFindAll } = await loadGetRoleQueue({
            userEmail: 'itops.lhe@ifl.com',
            overrideRows: [KHI_IT_OPS, LHE_IT_OPS]
        });
        req.query.role = 'IT_OPS';

        await getRoleQueue(req, res);

        const where = requestFindAll.mock.calls[0][0].where;
        expect(where.location).toBe('LHE');
    });

    test('IT_OPS user not in any override sees all requests (global/admin fallback)', async () => {
        const { getRoleQueue, req, res, requestFindAll } = await loadGetRoleQueue({
            userEmail: 'admin@ifl.com',
            overrideRows: [KHI_IT_OPS, LHE_IT_OPS]
        });
        req.query.role = 'IT_OPS';

        await getRoleQueue(req, res);

        const where = requestFindAll.mock.calls[0][0].where;
        expect(where.location).toBeUndefined();
    });

    test('HR_INITIATOR portal filters to user\'s location', async () => {
        const { getRoleQueue, req, res, requestFindAll } = await loadGetRoleQueue({
            userEmail: 'hr.khi@ifl.com',
            overrideRows: [KHI_HR]
        });
        req.query.role = 'HR_INITIATOR';

        await getRoleQueue(req, res);

        const where = requestFindAll.mock.calls[0][0].where;
        expect(where.location).toBe('KHI');
    });

    test('HR_INITIATOR secondary seat also sees only their location', async () => {
        const { getRoleQueue, req, res, requestFindAll } = await loadGetRoleQueue({
            userEmail: 'hr.khi2@ifl.com',  // secondaryEmail seat
            overrideRows: [KHI_HR]
        });
        req.query.role = 'HR_INITIATOR';

        await getRoleQueue(req, res);

        const where = requestFindAll.mock.calls[0][0].where;
        expect(where.location).toBe('KHI');
    });

    test('HR_INITIATOR portal rows are not actionable (read-only tracking)', async () => {
        const { getRoleQueue, req, res } = await loadGetRoleQueue({
            userEmail: 'hr.khi@ifl.com',
            overrideRows: [KHI_HR],
            findAllRequests: [makeMockRequest()]
        });
        req.query.role = 'HR_INITIATOR';

        await getRoleQueue(req, res);

        const response = res.json.mock.calls[0][0];
        expect(response.success).toBe(true);
        expect(response.data[0].actionable).toBe(false);
        // URL should go to history view, not the action form
        expect(response.data[0].url).toContain('/history/');
    });

    test('HR_INITIATOR portal row exposes initiator name who started the request', async () => {
        const { getRoleQueue, req, res } = await loadGetRoleQueue({
            userEmail: 'hr.khi@ifl.com',
            overrideRows: [KHI_HR],
            findAllRequests: [makeMockRequest({ requesterName: 'Fatima Malik', requesterEmail: 'hr.khi2@ifl.com' })]
        });
        req.query.role = 'HR_INITIATOR';

        await getRoleQueue(req, res);

        const row = res.json.mock.calls[0][0].data[0];
        expect(row.initiatorName).toBe('Fatima Malik');
        expect(row.initiatorEmail).toBe('hr.khi2@ifl.com');
    });
});
