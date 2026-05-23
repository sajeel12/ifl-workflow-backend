import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * Admin delegation rebind audit
 *
 * Business rules under test (updateWorkflowApprover):
 *  - When DCI_MANAGER config is updated, all PendingDCIManager requests have
 *    currentStageAssigneeEmail / currentStageAssigneeUsername updated immediately.
 *  - When IT_HOD config is updated, all PendingITHOD requests are rebound.
 *  - A System timeline event is written for each rebound request.
 *  - Non-delegation roles (IT_OPS, DCI_TEAM, DCI_IMPLEMENTER) do NOT trigger
 *    any request rebinding.
 *  - If the new approverEmail is null/empty, no rebinding happens.
 *
 * resendStageEmail uses the portal entry link (not the generic handle endpoint)
 * for every status that has a portal slug.
 */

afterEach(() => {
    jest.resetModules();
});

// ── shared helpers ─────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
    return {
        id: 1,
        roleKey: 'DCI_MANAGER',
        label: 'DCI Manager',
        approverEmail: 'old.mgr@ifl.com',
        approverUsername: 'old.mgr',
        isActive: true,
        update: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

function makeRequest(overrides = {}) {
    return {
        id: 42,
        status: 'PendingDCIManager',
        currentStageToken: 'tok-mgr',
        currentStageAssigneeEmail: 'old.mgr@ifl.com',
        currentStageAssigneeUsername: 'old.mgr',
        update: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

async function loadController({ config, inFlightRequests = [], allRequests = inFlightRequests }) {
    jest.resetModules();
    process.env.APP_URL = 'http://localhost:3000';

    const timelineCreate = jest.fn().mockResolvedValue(undefined);
    const sendOnboardingNotification = jest.fn().mockResolvedValue(undefined);

    const mockDataTypes = { STRING: 'STRING', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN', DATE: 'DATE', JSON: 'JSON', TEXT: 'TEXT', ARRAY: () => 'ARRAY', FLOAT: 'FLOAT' };

    await jest.unstable_mockModule('sequelize', () => ({
        Op: { or: Symbol('or'), like: Symbol('like'), ne: Symbol('ne'), not: Symbol('not'), in: Symbol('in'), notIn: Symbol('notIn') },
        DataTypes: mockDataTypes,
        default: class Sequelize { static Op = { or: Symbol('or') }; }
    }));
    await jest.unstable_mockModule('../src/config/database.js', () => ({
        default: { fn: jest.fn(), col: jest.fn(), define: jest.fn(), authenticate: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/models/Employee.js', () => ({
        default: { findByPk: jest.fn(), findAll: jest.fn().mockResolvedValue([]), findAndCountAll: jest.fn().mockResolvedValue({ count: 0, rows: [] }), update: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/models/SyncLog.js', () => ({
        default: { findAll: jest.fn().mockResolvedValue([]) }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: { findByPk: jest.fn().mockResolvedValue(config), findAll: jest.fn().mockResolvedValue([]) }
    }));
    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: {
            findAll:   jest.fn().mockResolvedValue(inFlightRequests),
            findByPk:  jest.fn().mockResolvedValue(allRequests[0] || null)
        }
    }));
    await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
        default: { create: timelineCreate, findAll: jest.fn().mockResolvedValue([]) }
    }));
    await jest.unstable_mockModule('../src/services/emailService.js', () => ({
        sendOnboardingNotification
    }));
    await jest.unstable_mockModule('../src/services/recipientService.js', () => ({
        default: { get: jest.fn().mockResolvedValue('new.mgr@ifl.com') }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: { findAll: jest.fn().mockResolvedValue([]) }
    }));
    await jest.unstable_mockModule('../src/models/SystemConfig.js', () => ({
        default: { findAll: jest.fn().mockResolvedValue([]) }
    }));
    await jest.unstable_mockModule('../src/services/oracleSyncService.js', () => ({
        default: { runSync: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/services/cronService.js', () => ({
        default: { scheduleHrmsSync: jest.fn(), stopHrmsSync: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/utils/locationGroups.js', () => ({
        LOCATION_GROUPS: [],
        groupByKey: jest.fn(),
        groupLabel: jest.fn()
    }));
    await jest.unstable_mockModule('../src/utils/historyFormatter.js', () => ({
        humanizeAction: jest.fn(x => x),
        humanizeDetails: jest.fn(x => x),
        humanizeDetailsHTML: jest.fn(x => x)
    }));

    const { default: adminController } = await import('../src/controllers/adminController.js');
    return { adminController, timelineCreate, sendOnboardingNotification };
}

function mockRes() {
    const res = { status: jest.fn(), json: jest.fn(), send: jest.fn(), render: jest.fn(), redirect: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
}

// ── updateWorkflowApprover — delegation rebind ─────────────────────────────────

describe('Admin delegation rebind — updateWorkflowApprover', () => {

    test('updating DCI_MANAGER rebinds all PendingDCIManager in-flight requests', async () => {
        const config = makeConfig({ roleKey: 'DCI_MANAGER', label: 'DCI Manager' });
        const request = makeRequest({ status: 'PendingDCIManager' });
        const { adminController, timelineCreate } = await loadController({
            config, inFlightRequests: [request]
        });

        const req = {
            params: { id: '1' },
            body: { approverEmail: 'new.mgr@ifl.com', approverUsername: 'new.mgr', approverName: 'New Manager', isActive: true }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        // Request row updated to new delegate
        expect(request.update).toHaveBeenCalledWith(
            expect.objectContaining({
                currentStageAssigneeEmail:    'new.mgr@ifl.com',
                currentStageAssigneeUsername: 'new.mgr'
            })
        );
        // Timeline event written for audit trail
        expect(timelineCreate).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'Admin Delegation Update', actorRole: 'Admin' })
        );
        // Response confirms rebound count
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ success: true, message: expect.stringContaining('1 in-flight request(s) rebound') })
        );
    });

    test('updating IT_HOD rebinds all PendingITHOD in-flight requests', async () => {
        const config = makeConfig({ roleKey: 'IT_HOD', label: 'IT Head of Department' });
        const request = makeRequest({ status: 'PendingITHOD', currentStageAssigneeEmail: 'old.hod@ifl.com' });
        const { adminController } = await loadController({
            config, inFlightRequests: [request]
        });

        const req = {
            params: { id: '1' },
            body: { approverEmail: 'new.hod@ifl.com', approverUsername: 'new.hod', approverName: 'New HOD', isActive: true }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        expect(request.update).toHaveBeenCalledWith(
            expect.objectContaining({ currentStageAssigneeEmail: 'new.hod@ifl.com' })
        );
    });

    test('multiple in-flight requests are all rebound and each gets a timeline event', async () => {
        const config = makeConfig({ roleKey: 'DCI_MANAGER', label: 'DCI Manager' });
        const r1 = makeRequest({ id: 10 });
        const r2 = makeRequest({ id: 11 });
        const r3 = makeRequest({ id: 12 });
        const { adminController, timelineCreate } = await loadController({
            config, inFlightRequests: [r1, r2, r3]
        });

        const req = {
            params: { id: '1' },
            body: { approverEmail: 'new.mgr@ifl.com', approverUsername: 'new.mgr', approverName: 'New', isActive: true }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        expect(r1.update).toHaveBeenCalled();
        expect(r2.update).toHaveBeenCalled();
        expect(r3.update).toHaveBeenCalled();
        expect(timelineCreate).toHaveBeenCalledTimes(3);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('3 in-flight request(s) rebound') })
        );
    });

    test('non-delegation role (IT_OPS) does NOT trigger any request rebinding', async () => {
        const config = makeConfig({ roleKey: 'IT_OPS', label: 'IT Operations' });
        const { adminController, timelineCreate } = await loadController({
            config, inFlightRequests: []
        });

        const req = {
            params: { id: '1' },
            body: { approverEmail: 'itops@ifl.com', approverUsername: 'itops', approverName: 'IT Ops', isActive: true }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        expect(timelineCreate).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('updated successfully') })
        );
    });

    test('clearing email (null) on delegation role does NOT rebind requests', async () => {
        const config = makeConfig({ roleKey: 'DCI_MANAGER' });
        const request = makeRequest();
        const { adminController, timelineCreate } = await loadController({
            config, inFlightRequests: [request]
        });

        const req = {
            params: { id: '1' },
            body: { approverEmail: '', approverUsername: '', approverName: '', isActive: true }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        // Email is empty — no rebind, no timeline events
        expect(request.update).not.toHaveBeenCalled();
        expect(timelineCreate).not.toHaveBeenCalled();
    });

    test('when no in-flight requests exist, response message says "updated successfully" (no rebound count)', async () => {
        const config = makeConfig({ roleKey: 'DCI_MANAGER' });
        const { adminController } = await loadController({ config, inFlightRequests: [] });

        const req = {
            params: { id: '1' },
            body: { approverEmail: 'new.mgr@ifl.com', approverUsername: 'new.mgr', approverName: 'New', isActive: true }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('updated successfully') })
        );
    });

});

// ── Temporary delegation — updateWorkflowApprover with delegationType ─────────

describe('Temporary delegation — updateWorkflowApprover', () => {

    test('delegationType=temporary snapshots current primary into previous* columns and sets isDelegatedTemporarily', async () => {
        const config = makeConfig({
            roleKey:          'DCI_MANAGER',
            label:            'DCI Manager',
            approverEmail:    'original.mgr@ifl.com',
            approverName:     'Original Manager',
            approverUsername: 'original.mgr',
        });
        const { adminController } = await loadController({ config, inFlightRequests: [] });

        const req = {
            params: { id: '1' },
            body: {
                approverEmail:    'temp.mgr@ifl.com',
                approverUsername: 'temp.mgr',
                approverName:     'Temp Manager',
                isActive:         true,
                delegationType:   'temporary'
            }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        expect(config.update).toHaveBeenCalledWith(
            expect.objectContaining({
                approverEmail:            'temp.mgr@ifl.com',
                isDelegatedTemporarily:   true,
                previousApproverEmail:    'original.mgr@ifl.com',
                previousApproverName:     'Original Manager',
                previousApproverUsername: 'original.mgr',
            })
        );
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    test('delegationType=permanent clears previous* columns and sets isDelegatedTemporarily=false', async () => {
        const config = makeConfig({
            roleKey:                  'DCI_MANAGER',
            approverEmail:            'current@ifl.com',
            isDelegatedTemporarily:   true,
            previousApproverEmail:    'original@ifl.com',
            previousApproverName:     'Original',
            previousApproverUsername: 'original',
        });
        const { adminController } = await loadController({ config, inFlightRequests: [] });

        const req = {
            params: { id: '1' },
            body: {
                approverEmail:  'new.permanent@ifl.com',
                approverUsername: 'new.permanent',
                approverName:   'New Permanent',
                isActive:       true,
                delegationType: 'permanent'
            }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        expect(config.update).toHaveBeenCalledWith(
            expect.objectContaining({
                isDelegatedTemporarily:   false,
                previousApproverEmail:    null,
                previousApproverName:     null,
                previousApproverUsername: null,
            })
        );
    });

    test('timeline event records the delegation kind (Temporary Delegation) when delegationType=temporary', async () => {
        const config  = makeConfig({ roleKey: 'DCI_MANAGER', approverEmail: 'orig@ifl.com', approverUsername: 'orig' });
        const request = makeRequest({ status: 'PendingDCIManager' });
        const { adminController, timelineCreate } = await loadController({ config, inFlightRequests: [request] });

        const req = {
            params: { id: '1' },
            body: { approverEmail: 'temp@ifl.com', approverUsername: 'temp', approverName: 'Temp', isActive: true, delegationType: 'temporary' }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        expect(timelineCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                action:  'Admin Delegation Update',
                details: expect.stringContaining('Temporary Delegation'),
            })
        );
    });

    test('timeline event records Permanent Role Change when delegationType=permanent', async () => {
        const config  = makeConfig({ roleKey: 'DCI_MANAGER' });
        const request = makeRequest({ status: 'PendingDCIManager' });
        const { adminController, timelineCreate } = await loadController({ config, inFlightRequests: [request] });

        const req = {
            params: { id: '1' },
            body: { approverEmail: 'new@ifl.com', approverUsername: 'new', approverName: 'New', isActive: true, delegationType: 'permanent' }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        expect(timelineCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                details: expect.stringContaining('Permanent Role Change'),
            })
        );
    });

});

// ── revertDelegation ───────────────────────────────────────────────────────────

describe('revertDelegation', () => {

    async function loadForRevert({ config, inFlightRequests = [] }) {
        jest.resetModules();
        process.env.APP_URL = 'http://localhost:3000';

        const timelineCreate = jest.fn().mockResolvedValue(undefined);
        const mockDataTypes = { STRING: 'STRING', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN', DATE: 'DATE', JSON: 'JSON', TEXT: 'TEXT', ARRAY: () => 'ARRAY', FLOAT: 'FLOAT' };

        await jest.unstable_mockModule('sequelize', () => ({
            Op: { or: Symbol('or'), like: Symbol('like'), ne: Symbol('ne'), not: Symbol('not'), in: Symbol('in'), notIn: Symbol('notIn') },
            DataTypes: mockDataTypes,
            default: class Sequelize { static Op = { or: Symbol('or') }; }
        }));
        await jest.unstable_mockModule('../src/config/database.js', () => ({
            default: { fn: jest.fn(), col: jest.fn(), define: jest.fn(), authenticate: jest.fn() }
        }));
        await jest.unstable_mockModule('../src/models/Employee.js', () => ({
            default: { findByPk: jest.fn(), findAll: jest.fn().mockResolvedValue([]), findAndCountAll: jest.fn().mockResolvedValue({ count: 0, rows: [] }), update: jest.fn() }
        }));
        await jest.unstable_mockModule('../src/models/SyncLog.js', () => ({
            default: { findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
            default: { findByPk: jest.fn().mockResolvedValue(config), findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
            default: {
                findAll:  jest.fn().mockResolvedValue(inFlightRequests),
                findByPk: jest.fn().mockResolvedValue(inFlightRequests[0] || null)
            }
        }));
        await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
            default: { create: timelineCreate, findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/services/emailService.js', () => ({
            sendOnboardingNotification: jest.fn().mockResolvedValue(undefined)
        }));
        await jest.unstable_mockModule('../src/services/recipientService.js', () => ({
            default: { get: jest.fn().mockResolvedValue('mgr@ifl.com') }
        }));
        await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
            default: { findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/models/SystemConfig.js', () => ({
            default: { findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/services/oracleSyncService.js', () => ({
            default: { runSync: jest.fn() }
        }));
        await jest.unstable_mockModule('../src/services/cronService.js', () => ({
            default: { scheduleHrmsSync: jest.fn(), stopHrmsSync: jest.fn() }
        }));
        await jest.unstable_mockModule('../src/utils/locationGroups.js', () => ({
            LOCATION_GROUPS: [], groupByKey: jest.fn(), groupLabel: jest.fn()
        }));
        await jest.unstable_mockModule('../src/utils/historyFormatter.js', () => ({
            humanizeAction: jest.fn(x => x), humanizeDetails: jest.fn(x => x), humanizeDetailsHTML: jest.fn(x => x)
        }));

        const { default: adminController } = await import('../src/controllers/adminController.js');
        return { adminController, timelineCreate };
    }

    test('revert swaps previous* back to approver* and clears isDelegatedTemporarily', async () => {
        const config = {
            id: 1,
            roleKey: 'DCI_MANAGER',
            label: 'DCI Manager',
            isDelegatedTemporarily:   true,
            approverEmail:            'temp.mgr@ifl.com',
            approverName:             'Temp Manager',
            approverUsername:         'temp.mgr',
            previousApproverEmail:    'original.mgr@ifl.com',
            previousApproverName:     'Original Manager',
            previousApproverUsername: 'original.mgr',
            update: jest.fn().mockResolvedValue(undefined),
        };
        const { adminController } = await loadForRevert({ config });

        const req = { params: { id: '1' }, body: {} };
        const res = mockRes();
        await adminController.revertDelegation(req, res);

        expect(config.update).toHaveBeenCalledWith(
            expect.objectContaining({
                approverEmail:            'original.mgr@ifl.com',
                approverName:             'Original Manager',
                approverUsername:         'original.mgr',
                isDelegatedTemporarily:   false,
                previousApproverEmail:    null,
                previousApproverName:     null,
                previousApproverUsername: null,
            })
        );
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    test('revert rebinds in-flight requests to the restored original person', async () => {
        const config = {
            id: 1,
            roleKey: 'DCI_MANAGER',
            label: 'DCI Manager',
            isDelegatedTemporarily:   true,
            approverEmail:            'temp@ifl.com',
            approverName:             'Temp',
            approverUsername:         'temp',
            previousApproverEmail:    'original@ifl.com',
            previousApproverName:     'Original',
            previousApproverUsername: 'original',
            update: jest.fn().mockResolvedValue(undefined),
        };
        const r1 = makeRequest({ id: 20, status: 'PendingDCIManager' });
        const r2 = makeRequest({ id: 21, status: 'PendingDCIManager' });
        const { adminController, timelineCreate } = await loadForRevert({ config, inFlightRequests: [r1, r2] });

        const req = { params: { id: '1' }, body: {} };
        const res = mockRes();
        await adminController.revertDelegation(req, res);

        expect(r1.update).toHaveBeenCalledWith(expect.objectContaining({
            currentStageAssigneeEmail:    'original@ifl.com',
            currentStageAssigneeUsername: 'original',
        }));
        expect(r2.update).toHaveBeenCalledWith(expect.objectContaining({
            currentStageAssigneeEmail:    'original@ifl.com',
            currentStageAssigneeUsername: 'original',
        }));
        expect(timelineCreate).toHaveBeenCalledTimes(2);
        expect(timelineCreate).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'Admin Delegation Reverted' })
        );
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('2 in-flight request(s) rebound') })
        );
    });

    test('revert returns 400 when role is not temporarily delegated', async () => {
        const config = {
            id: 1, roleKey: 'DCI_MANAGER', label: 'DCI Manager',
            isDelegatedTemporarily: false,
            update: jest.fn(),
        };
        const { adminController } = await loadForRevert({ config });

        const req = { params: { id: '1' }, body: {} };
        const res = mockRes();
        await adminController.revertDelegation(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(config.update).not.toHaveBeenCalled();
    });

    test('revert returns 400 when previousApproverEmail is missing', async () => {
        const config = {
            id: 1, roleKey: 'DCI_MANAGER', label: 'DCI Manager',
            isDelegatedTemporarily: true,
            previousApproverEmail:  null,
            update: jest.fn(),
        };
        const { adminController } = await loadForRevert({ config });

        const req = { params: { id: '1' }, body: {} };
        const res = mockRes();
        await adminController.revertDelegation(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(config.update).not.toHaveBeenCalled();
    });

});

// ── resendStageEmail — portal link format ──────────────────────────────────────

describe('resendStageEmail portal link format', () => {

    async function loadForResend({ requestOverrides = {} } = {}) {
        jest.resetModules();
        process.env.APP_URL = 'http://localhost:3000';

        const sendNotification = jest.fn().mockResolvedValue(undefined);
        const timelineCreate   = jest.fn().mockResolvedValue(undefined);
        const request = {
            id: 5,
            status: 'PendingDCIManager',
            currentStageToken: 'tok-resend',
            currentStageAssigneeEmail: 'mgr@ifl.com',
            ...requestOverrides
        };

        const mockDataTypes = { STRING: 'STRING', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN', DATE: 'DATE', JSON: 'JSON', TEXT: 'TEXT', ARRAY: () => 'ARRAY', FLOAT: 'FLOAT' };

        await jest.unstable_mockModule('sequelize', () => ({
            Op: { or: Symbol('or'), like: Symbol('like'), ne: Symbol('ne'), not: Symbol('not'), in: Symbol('in'), notIn: Symbol('notIn') },
            DataTypes: mockDataTypes,
            default: class Sequelize { static Op = { or: Symbol('or') }; }
        }));
        await jest.unstable_mockModule('../src/config/database.js', () => ({
            default: { fn: jest.fn(), col: jest.fn(), define: jest.fn(), authenticate: jest.fn() }
        }));
        await jest.unstable_mockModule('../src/models/Employee.js', () => ({
            default: { findByPk: jest.fn(), findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/models/SyncLog.js', () => ({
            default: { findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
            default: { findByPk: jest.fn(), findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
            default: { findByPk: jest.fn().mockResolvedValue(request), findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
            default: { create: timelineCreate, findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/services/emailService.js', () => ({
            sendOnboardingNotification: sendNotification
        }));
        await jest.unstable_mockModule('../src/services/recipientService.js', () => ({
            default: { get: jest.fn().mockResolvedValue('mgr@ifl.com') }
        }));
        await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
            default: { findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/models/SystemConfig.js', () => ({
            default: { findAll: jest.fn().mockResolvedValue([]) }
        }));
        await jest.unstable_mockModule('../src/services/oracleSyncService.js', () => ({
            default: { runSync: jest.fn() }
        }));
        await jest.unstable_mockModule('../src/services/cronService.js', () => ({
            default: { scheduleHrmsSync: jest.fn(), stopHrmsSync: jest.fn() }
        }));
        await jest.unstable_mockModule('../src/utils/locationGroups.js', () => ({
            LOCATION_GROUPS: [], groupByKey: jest.fn(), groupLabel: jest.fn()
        }));
        await jest.unstable_mockModule('../src/utils/historyFormatter.js', () => ({
            humanizeAction: jest.fn(x => x), humanizeDetails: jest.fn(x => x), humanizeDetailsHTML: jest.fn(x => x)
        }));

        const { default: adminController } = await import('../src/controllers/adminController.js');
        return { adminController, sendNotification };
    }

    test('resendStageEmail for PendingDCIManager uses portal dci-manager entry link', async () => {
        const { adminController, sendNotification } = await loadForResend({
            requestOverrides: { status: 'PendingDCIManager', currentStageToken: 'tok-mgr' }
        });

        const req = { params: { id: '5' }, body: {} };
        const res = mockRes();
        await adminController.resendStageEmail(req, res);

        expect(sendNotification).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.stringContaining('/portal/dci-manager/enter?action=tok-mgr'),
            'DCI_MANAGER_APPROVAL'
        );
    });

    test('resendStageEmail for PendingITHOD uses portal it-hod entry link', async () => {
        const { adminController, sendNotification } = await loadForResend({
            requestOverrides: { status: 'PendingITHOD', currentStageToken: 'tok-hod' }
        });

        const req = { params: { id: '5' }, body: {} };
        const res = mockRes();
        await adminController.resendStageEmail(req, res);

        expect(sendNotification).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.stringContaining('/portal/it-hod/enter?action=tok-hod'),
            'IT_HOD_APPROVAL'
        );
    });

    test('resendStageEmail for PendingHOD uses direct handle link (no portal for HOD)', async () => {
        const { adminController, sendNotification } = await loadForResend({
            requestOverrides: { status: 'PendingHOD', currentStageToken: 'tok-hod-direct' }
        });

        const req = { params: { id: '5' }, body: {} };
        const res = mockRes();
        await adminController.resendStageEmail(req, res);

        expect(sendNotification).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.stringContaining('/api/onboarding/handle?token=tok-hod-direct'),
            'HOD_REVIEW'
        );
    });

});
