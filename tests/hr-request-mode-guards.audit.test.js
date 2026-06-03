import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * HR initiator request-mode guard tests
 *
 * Business rules under test:
 *  - Employee with an active (in-flight) request → any POST blocked (409),
 *    regardless of requestMode (New or Change). The workflow must reach
 *    Completed or Rejected before any new submission is allowed.
 *  - Employee with only a Completed record + requestMode='New' → blocked (409).
 *    Only a 'Change / Modification' request is permitted for completed employees.
 *  - Employee with only a Completed record + requestMode='Change' → allowed.
 *  - Brand-new employee (no prior record) + requestMode='New' → allowed.
 *
 * Two OnboardingRequest.findOne calls happen in sequence for New-mode POSTs:
 *   Call 1 — active guard:    WHERE status NOT IN ('Rejected','Completed')
 *   Call 2 — completed guard: WHERE status = 'Completed'
 * Change-mode POSTs skip Call 2 entirely.
 */

afterEach(() => {
    jest.resetModules();
    delete process.env.APP_URL;
});

const HR_USER = {
    email:       'hr.primary@ifl.com',
    username:    'hr.primary',
    displayName: 'HR Primary'
};

const KHI_HR_OVERRIDE = {
    roleKey:           'HR_INITIATOR',
    location:          'KHI',
    isActive:          true,
    approverEmail:     HR_USER.email,
    approverUsername:  HR_USER.username,
    secondaryEmail:    null,
    secondaryUsername: null,
};

/**
 * findOneSequence — ordered return values for successive findOne() calls.
 *   Index 0: active-guard result   (null = no active request)
 *   Index 1: completed-guard result (null = no completed record)
 */
async function loadController(findOneSequence = [null, null], requestMode = 'New') {
    jest.resetModules();
    process.env.APP_URL = 'http://localhost:3000';

    const createRequest = jest.fn().mockResolvedValue({ id: 99 });

    let callIdx = 0;
    const findOneMock = jest.fn().mockImplementation(() =>
        Promise.resolve(findOneSequence[callIdx++] ?? null)
    );

    await jest.unstable_mockModule('../src/services/onboardingService.js', () => ({
        createRequest,
        getFormContext:           jest.fn().mockResolvedValue(null),
        updateITDetails:          jest.fn(),
        handleHODApproval:        jest.fn(),
        updateDCIDetails:         jest.fn(),
        handleDCIManagerApproval: jest.fn(),
        handleITHODApproval:      jest.fn(),
        handleDCIImplementation:  jest.fn(),
        handleOPSAction:          jest.fn()
    }));
    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: {
            findOne:         findOneMock,
            findAll:         jest.fn().mockResolvedValue([]),
            findAndCountAll: jest.fn().mockResolvedValue({ count: 0, rows: [] })
        }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: {
            findAll: jest.fn().mockResolvedValue([KHI_HR_OVERRIDE]),
            findOne: jest.fn().mockResolvedValue(null)
        }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(null), findAll: jest.fn().mockResolvedValue([]) }
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
        humanizeDetails:     jest.fn().mockReturnValue(''),
        humanizeDetailsHTML: jest.fn().mockReturnValue(''),
        humanizeAction:      jest.fn().mockReturnValue(''),
        narrate:             jest.fn().mockReturnValue('')
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
        groupByKey:  jest.fn().mockReturnValue({ key: 'KHI', label: 'Karachi' }),
        groupLabel:  jest.fn().mockReturnValue('Karachi')
    }));
    await jest.unstable_mockModule('sequelize', () => ({ Op: {} }));

    const { handleRequest } = await import('../src/controllers/onboardingController.js');

    const req = {
        method: 'POST',
        query:  {},
        body:   { employeeId: 'EMP001', fullName: 'Test User', requestMode },
        user:   HR_USER
    };
    const res = {
        status: jest.fn().mockReturnThis(),
        render: jest.fn().mockReturnThis()
    };

    return { handleRequest, req, res, createRequest, findOneMock };
}

describe('HR request-mode guards — active in-flight employee', () => {

    test('active employee + requestMode=New → blocked with 409', async () => {
        // Active record returned on first findOne call → any submission refused.
        const { handleRequest, req, res, createRequest } =
            await loadController([{ id: 10 }], 'New');

        await handleRequest(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(createRequest).not.toHaveBeenCalled();
    });

    test('active employee + requestMode=Change → also blocked with 409', async () => {
        // An in-flight request blocks Change submissions too — not just New Hiring.
        // HR must wait for the existing request to reach Completed or Rejected.
        const { handleRequest, req, res, createRequest } =
            await loadController([{ id: 10 }], 'Change');

        await handleRequest(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(createRequest).not.toHaveBeenCalled();
    });

    test('active employee 409 message indicates request is already in progress', async () => {
        const { handleRequest, req, res } =
            await loadController([{ id: 10 }], 'New');

        await handleRequest(req, res);

        const renderArg = res.render.mock.calls[0][1];
        expect(renderArg.message).toMatch(/already (in progress|moving through)/i);
    });

});

describe('HR request-mode guards — completed employee', () => {

    test('completed employee + requestMode=New → blocked with 409', async () => {
        // Active guard returns null (no in-flight), completed guard returns a row.
        const { handleRequest, req, res, createRequest } =
            await loadController([null, { id: 20 }], 'New');

        await handleRequest(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(createRequest).not.toHaveBeenCalled();
    });

    test('completed employee + requestMode=Change → allowed, createRequest called', async () => {
        // Completed guard is skipped when requestMode=Change — only the active
        // guard runs (returns null), so submission proceeds as a change request.
        const { handleRequest, req, res, createRequest } =
            await loadController([null], 'Change');

        await handleRequest(req, res);

        expect(createRequest).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalledWith(409);
    });

    test('completed employee 409 message indicates completed record exists', async () => {
        const { handleRequest, req, res } =
            await loadController([null, { id: 20 }], 'New');

        await handleRequest(req, res);

        const renderArg = res.render.mock.calls[0][1];
        expect(renderArg.message).toMatch(/completed|already onboarded/i);
    });

    test('completed guard is not reached when requestMode=Change (findOne called only once)', async () => {
        // Verify the second findOne (completed check) is skipped for Change mode —
        // it would be wasteful and the logic doesn't require it.
        const { handleRequest, req, res, findOneMock } =
            await loadController([null], 'Change');

        await handleRequest(req, res);

        // Only one findOne call (active guard). The completed guard is inside
        // `if (requestMode !== 'Change')` so it must not execute.
        expect(findOneMock).toHaveBeenCalledTimes(1);
    });

});

describe('HR request-mode guards — new employee (no prior record)', () => {

    test('no prior record + requestMode=New → allowed, createRequest called', async () => {
        // Both guards return null → brand-new employee, proceed as New Hiring.
        const { handleRequest, req, res, createRequest } =
            await loadController([null, null], 'New');

        await handleRequest(req, res);

        expect(createRequest).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalledWith(409);
    });

    test('new employee submission carries the HR location on the created request', async () => {
        // The controller overwrites data.location with the HR user's group key
        // so IT Ops routing lands in the correct location group.
        const { handleRequest, req, res, createRequest } =
            await loadController([null, null], 'New');

        await handleRequest(req, res);

        const submittedData = createRequest.mock.calls[0][0];
        expect(submittedData.location).toBe('KHI');
    });

});
