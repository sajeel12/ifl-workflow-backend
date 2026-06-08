import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * Admin delegation rebind audit
 *
 * Business rules under test (updateWorkflowApprover):
 *  - When DCI_MANAGER config is updated, all PendingDCIManager requests have
 *    currentStageAssigneeEmail / currentStageAssigneeUsername updated immediately
 *    (temporary-delegation path: rebindInFlightToDelegate).
 *  - When IT_HOD config is updated, all PendingITHOD requests are rebound.
 *  - A System timeline event is written for each rebound request.
 *  - Non-delegation stage roles (IT_OPS, DCI_TEAM, DCI_IMPLEMENTER) ALSO rebind
 *    their in-flight requests now — re-resolved via resolveStageRecipient and
 *    re-emailed (rebindStageToCurrentRecipient). 'Stage Reassigned (Approver
 *    Changed)' timeline event per request.
 *  - If the new approverEmail is null/empty, the delegation path does no rebind.
 *
 * resendStageEmail/resendOffboardingStageEmail no longer accept a typed override:
 * they resolve the configured approver (resolveStageRecipient), re-point the
 * request (currentStageAssignee*), and use the portal entry link (not the generic
 * handle endpoint) for every status that has a portal slug.
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
    // Offboarding table — rebindInFlightToDelegate + rebindStageToCurrentRecipient
    // walk this too. Empty here so onboarding assertions stay isolated.
    await jest.unstable_mockModule('../src/models/OffboardingRequest.js', () => ({
        default: { findAll: jest.fn().mockResolvedValue([]), findByPk: jest.fn().mockResolvedValue(null) }
    }));
    // Stage recipient resolver — used by the non-delegation-role rebind. Returns a
    // fixed "new" person so rebind assertions are deterministic.
    await jest.unstable_mockModule('../src/utils/resolveStageRecipient.js', () => ({
        resolveStageRecipient: jest.fn().mockResolvedValue({ role: 'IT Operations', name: 'New ITOps', email: 'new.itops@ifl.com', username: 'new.itops' }),
        STATUS_TO_ROLE: {},
        LOCATION_AWARE_ROLE_KEYS: new Set(['IT_OPS', 'HR_INITIATOR'])
    }));
    await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({
        emailsMatch: (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()
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

    test('updating DCI_MANAGER rebinds all PendingDCIManager in-flight requests and emails new delegate', async () => {
        const config = makeConfig({ roleKey: 'DCI_MANAGER', label: 'DCI Manager' });
        const request = makeRequest({ status: 'PendingDCIManager', currentStageToken: 'tok-mgr' });
        const { adminController, timelineCreate, sendOnboardingNotification } = await loadController({
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
        // Action email sent to new delegate
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'new.mgr@ifl.com',
            expect.objectContaining({ id: 42 }),
            expect.stringContaining('/portal/dci-manager/enter?action=tok-mgr'),
            'DCI_MANAGER_APPROVAL'
        );
        // Response confirms rebound count
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ success: true, message: expect.stringContaining('1 in-flight request(s) rebound') })
        );
    });

    test('updating IT_HOD rebinds all PendingITHOD in-flight requests and emails new HOD', async () => {
        const config = makeConfig({ roleKey: 'IT_HOD', label: 'IT Head of Department' });
        const request = makeRequest({ status: 'PendingITHOD', currentStageAssigneeEmail: 'old.hod@ifl.com', currentStageToken: 'tok-hod' });
        const { adminController, sendOnboardingNotification } = await loadController({
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
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'new.hod@ifl.com',
            expect.objectContaining({ status: 'PendingITHOD' }),
            expect.stringContaining('/portal/it-hod/enter?action=tok-hod'),
            'IT_HOD_APPROVAL'
        );
    });

    test('multiple in-flight requests are all rebound, each gets a timeline event and an email', async () => {
        const config = makeConfig({ roleKey: 'DCI_MANAGER', label: 'DCI Manager' });
        const r1 = makeRequest({ id: 10, currentStageToken: 'tok-10' });
        const r2 = makeRequest({ id: 11, currentStageToken: 'tok-11' });
        const r3 = makeRequest({ id: 12, currentStageToken: 'tok-12' });
        const { adminController, timelineCreate, sendOnboardingNotification } = await loadController({
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
        // One action email per rebound request, all sent to the new delegate
        expect(sendOnboardingNotification).toHaveBeenCalledTimes(3);
        expect(sendOnboardingNotification).toHaveBeenCalledWith('new.mgr@ifl.com', expect.objectContaining({ id: 10 }), expect.stringContaining('tok-10'), 'DCI_MANAGER_APPROVAL');
        expect(sendOnboardingNotification).toHaveBeenCalledWith('new.mgr@ifl.com', expect.objectContaining({ id: 11 }), expect.stringContaining('tok-11'), 'DCI_MANAGER_APPROVAL');
        expect(sendOnboardingNotification).toHaveBeenCalledWith('new.mgr@ifl.com', expect.objectContaining({ id: 12 }), expect.stringContaining('tok-12'), 'DCI_MANAGER_APPROVAL');
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('3 in-flight request(s) rebound') })
        );
    });

    test('non-delegation role (IT_OPS) NOW rebinds its in-flight requests to the newly configured person', async () => {
        const config = makeConfig({ roleKey: 'IT_OPS', label: 'IT Operations' });
        const request = makeRequest({ status: 'PendingIT', currentStageToken: 'tok-itops', currentStageAssigneeEmail: 'old.itops@ifl.com' });
        const { adminController, timelineCreate, sendOnboardingNotification } = await loadController({
            config, inFlightRequests: [request]
        });

        const req = {
            params: { id: '1' },
            body: { approverEmail: 'new.itops@ifl.com', approverUsername: 'new.itops', approverName: 'IT Ops', isActive: true }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        // Re-pointed to the resolved current person (from resolveStageRecipient mock)
        expect(request.update).toHaveBeenCalledWith(
            expect.objectContaining({
                currentStageAssigneeEmail:    'new.itops@ifl.com',
                currentStageAssigneeUsername: 'new.itops'
            })
        );
        // Stage-reassignment timeline event + action email (portal it-ops link) to the new person
        expect(timelineCreate).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'Stage Reassigned (Approver Changed)', actorRole: 'Admin' })
        );
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'new.itops@ifl.com',
            expect.objectContaining({ id: 42 }),
            expect.stringContaining('/portal/it-ops/enter?action=tok-itops'),
            'IT_OPS'
        );
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ success: true, message: expect.stringContaining('rebound') })
        );
    });

    test('clearing email (null) on delegation role does NOT rebind requests or send emails', async () => {
        const config = makeConfig({ roleKey: 'DCI_MANAGER' });
        const request = makeRequest();
        const { adminController, timelineCreate, sendOnboardingNotification } = await loadController({
            config, inFlightRequests: [request]
        });

        const req = {
            params: { id: '1' },
            body: { approverEmail: '', approverUsername: '', approverName: '', isActive: true }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        // Email is empty — no rebind, no timeline events, no emails
        expect(request.update).not.toHaveBeenCalled();
        expect(timelineCreate).not.toHaveBeenCalled();
        expect(sendOnboardingNotification).not.toHaveBeenCalled();
    });

    test('when no in-flight requests exist, response says "updated successfully" and no emails sent', async () => {
        const config = makeConfig({ roleKey: 'DCI_MANAGER' });
        const { adminController, sendOnboardingNotification } = await loadController({ config, inFlightRequests: [] });

        const req = {
            params: { id: '1' },
            body: { approverEmail: 'new.mgr@ifl.com', approverUsername: 'new.mgr', approverName: 'New', isActive: true }
        };
        const res = mockRes();
        await adminController.updateWorkflowApprover(req, res);

        expect(sendOnboardingNotification).not.toHaveBeenCalled();
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

    test('delegationType=temporary: timeline says Temporary Delegation and email sent to temp delegate', async () => {
        const config  = makeConfig({ roleKey: 'DCI_MANAGER', approverEmail: 'orig@ifl.com', approverUsername: 'orig' });
        const request = makeRequest({ status: 'PendingDCIManager', currentStageToken: 'tok-temp' });
        const { adminController, timelineCreate, sendOnboardingNotification } = await loadController({ config, inFlightRequests: [request] });

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
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'temp@ifl.com',
            expect.objectContaining({ id: 42 }),
            expect.stringContaining('/portal/dci-manager/enter?action=tok-temp'),
            'DCI_MANAGER_APPROVAL'
        );
    });

    test('delegationType=permanent: timeline says Permanent Role Change and email sent to new person', async () => {
        const config  = makeConfig({ roleKey: 'DCI_MANAGER' });
        const request = makeRequest({ status: 'PendingDCIManager', currentStageToken: 'tok-perm' });
        const { adminController, timelineCreate, sendOnboardingNotification } = await loadController({ config, inFlightRequests: [request] });

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
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'new@ifl.com',
            expect.objectContaining({ id: 42 }),
            expect.stringContaining('/portal/dci-manager/enter?action=tok-perm'),
            'DCI_MANAGER_APPROVAL'
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
        await jest.unstable_mockModule('../src/models/OffboardingRequest.js', () => ({
            default: { findAll: jest.fn().mockResolvedValue([]), findByPk: jest.fn().mockResolvedValue(null) }
        }));
        await jest.unstable_mockModule('../src/utils/resolveStageRecipient.js', () => ({
            resolveStageRecipient: jest.fn().mockResolvedValue({ role: 'DCI Manager', name: 'Resolved', email: 'resolved@ifl.com', username: 'resolved' }),
            STATUS_TO_ROLE: {},
            LOCATION_AWARE_ROLE_KEYS: new Set(['IT_OPS', 'HR_INITIATOR'])
        }));
        await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({
            emailsMatch: (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()
        }));
        await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
            default: { create: timelineCreate, findAll: jest.fn().mockResolvedValue([]) }
        }));
        const sendOnboardingNotification = jest.fn().mockResolvedValue(undefined);
        await jest.unstable_mockModule('../src/services/emailService.js', () => ({
            sendOnboardingNotification
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
        return { adminController, timelineCreate, sendOnboardingNotification };
    }

    test('revert swaps previous* back to approver*, clears isDelegatedTemporarily, sends no email when no in-flight', async () => {
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
        const { adminController, sendOnboardingNotification } = await loadForRevert({ config });

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
        expect(sendOnboardingNotification).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    test('revert rebinds in-flight requests to original person and emails them', async () => {
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
        const r1 = makeRequest({ id: 20, status: 'PendingDCIManager', currentStageToken: 'tok-r1' });
        const r2 = makeRequest({ id: 21, status: 'PendingDCIManager', currentStageToken: 'tok-r2' });
        const { adminController, timelineCreate, sendOnboardingNotification } = await loadForRevert({ config, inFlightRequests: [r1, r2] });

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
        // Original person emailed for each rebound request
        expect(sendOnboardingNotification).toHaveBeenCalledTimes(2);
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'original@ifl.com',
            expect.objectContaining({ id: 20 }),
            expect.stringContaining('/portal/dci-manager/enter?action=tok-r1'),
            'DCI_MANAGER_APPROVAL'
        );
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'original@ifl.com',
            expect.objectContaining({ id: 21 }),
            expect.stringContaining('/portal/dci-manager/enter?action=tok-r2'),
            'DCI_MANAGER_APPROVAL'
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
            update: jest.fn().mockResolvedValue(undefined),
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
        await jest.unstable_mockModule('../src/models/OffboardingRequest.js', () => ({
            default: { findByPk: jest.fn().mockResolvedValue(null), findAll: jest.fn().mockResolvedValue([]) }
        }));
        // Resend resolves the recipient via this util (primary/secondary, location).
        await jest.unstable_mockModule('../src/utils/resolveStageRecipient.js', () => ({
            resolveStageRecipient: jest.fn().mockResolvedValue({ role: 'Stage Owner', name: 'Configured Person', email: 'mgr@ifl.com', username: 'mgr' }),
            STATUS_TO_ROLE: {},
            LOCATION_AWARE_ROLE_KEYS: new Set(['IT_OPS', 'HR_INITIATOR'])
        }));
        await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({
            emailsMatch: (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()
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
