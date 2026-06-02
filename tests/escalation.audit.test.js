import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * 48-hour automatic escalation audit
 *
 * Business rules under test:
 *  - A request in a fallback-eligible stage (PendingIT, PendingDCI,
 *    PendingDCIImplementation, PendingOPSAction) whose stage has been open
 *    > 48 hours is automatically escalated to the configured secondary.
 *  - Escalation: (a) stamps primaryExpiredAt on the config row so new
 *    requests also route to secondary; (b) updates currentStageAssigneeEmail
 *    AND currentStageAssigneeUsername on the request; (c) sends an action email to secondary with the SAME
 *    token so they can complete the same form; (d) logs a System timeline event.
 *  - A request fresh (< 48h) is NOT escalated.
 *  - A request already escalated (currentStageAssigneeEmail matches secondary)
 *    is not re-escalated on subsequent cron runs (idempotent).
 *  - A request with no secondary configured is skipped without crashing.
 *  - The correct per-location override config is used for IT_OPS (not global).
 *  - PendingDCIImplementation uses itHodDecidedAt || dciManagerDecidedAt
 *    as the stage-start time.
 */

afterEach(() => {
    jest.resetModules();
    delete process.env.APP_URL;
});

const NOW    = new Date();
const FRESH  = new Date(NOW - 10 * 60 * 60 * 1000);  // 10h ago — within 48h
const STALE  = new Date(NOW - 55 * 60 * 60 * 1000);  // 55h ago — past 48h threshold

function makeRequest(overrides = {}) {
    return {
        id: 1,
        status: 'PendingIT',
        location: 'KHI',
        currentStageToken: 'tok-abc',
        currentStageAssigneeEmail: 'primary@ifl.com',
        hrSubmittedAt: STALE,
        hodApprovedAt: null,
        dciManagerDecidedAt: null,
        itHodDecidedAt: null,
        dciImplementedAt: null,
        update: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

function makeConfig(overrides = {}) {
    return {
        approverEmail:    'primary@ifl.com',
        approverName:     'Primary IT',
        approverUsername: 'primary',
        secondaryEmail:   'secondary@ifl.com',
        secondaryName:    'Secondary IT',
        secondaryUsername:'secondary',
        primaryExpiredAt: null,
        isActive: true,
        update: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

async function loadEscalationService({ requests = [], globalCfg = makeConfig(), overrideCfg = null } = {}) {
    jest.resetModules();
    process.env.APP_URL = 'http://localhost:3000';

    const sendOnboardingNotification = jest.fn().mockResolvedValue(undefined);
    const timelineCreate = jest.fn().mockResolvedValue(undefined);

    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: { findAll: jest.fn().mockResolvedValue(requests) }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(overrideCfg) }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(globalCfg) }
    }));
    await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
        default: { create: timelineCreate }
    }));
    await jest.unstable_mockModule('../src/services/emailService.js', () => ({
        sendOnboardingNotification
    }));
    await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({
        emailsMatch: (a, b) =>
            (a || '').split('@')[0].toLowerCase() === (b || '').split('@')[0].toLowerCase()
    }));
    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));
    await jest.unstable_mockModule('sequelize', () => ({ Op: { in: Symbol('in') } }));

    const { runEscalationCheck } = await import('../src/services/escalationService.js');
    return { runEscalationCheck, sendOnboardingNotification, timelineCreate };
}

describe('48h automatic escalation audit', () => {

    test('stalled PendingIT request (>48h) is escalated to secondary', async () => {
        const request = makeRequest({ status: 'PendingIT', hrSubmittedAt: STALE });
        const { runEscalationCheck, sendOnboardingNotification, timelineCreate } =
            await loadEscalationService({ requests: [request] });

        const result = await runEscalationCheck();

        expect(result.escalated).toBe(1);
        // Secondary receives the action email with the same token
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'secondary@ifl.com',
            expect.anything(),
            expect.stringContaining('tok-abc'),
            'IT_OPS'
        );
        // Request's assignee updated to secondary (both email AND username)
        expect(request.update).toHaveBeenCalledWith(
            expect.objectContaining({
                currentStageAssigneeEmail:    'secondary@ifl.com',
                currentStageAssigneeUsername: 'secondary'
            })
        );
        // Timeline event logged by System
        expect(timelineCreate).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'Auto-Escalated to Secondary', actorRole: 'System' })
        );
    });

    test('primaryExpiredAt is stamped on the config row when escalation fires', async () => {
        const request = makeRequest({ status: 'PendingIT', hrSubmittedAt: STALE });
        const cfg = makeConfig({ primaryExpiredAt: null });
        const { runEscalationCheck } = await loadEscalationService({ requests: [request], globalCfg: cfg });

        await runEscalationCheck();

        expect(cfg.update).toHaveBeenCalledWith(
            expect.objectContaining({ primaryExpiredAt: expect.any(Date) })
        );
    });

    test('fresh PendingIT request (<48h) is NOT escalated', async () => {
        const request = makeRequest({ status: 'PendingIT', hrSubmittedAt: FRESH });
        const { runEscalationCheck, sendOnboardingNotification } =
            await loadEscalationService({ requests: [request] });

        const result = await runEscalationCheck();

        expect(result.escalated).toBe(0);
        expect(sendOnboardingNotification).not.toHaveBeenCalled();
    });

    test('already-escalated request (assignee = secondary) is not re-escalated on next cron run', async () => {
        const request = makeRequest({
            status: 'PendingIT',
            hrSubmittedAt: STALE,
            currentStageAssigneeEmail: 'secondary@ifl.com'  // already escalated
        });
        const { runEscalationCheck, sendOnboardingNotification } =
            await loadEscalationService({ requests: [request] });

        const result = await runEscalationCheck();

        expect(result.escalated).toBe(0);
        expect(sendOnboardingNotification).not.toHaveBeenCalled();
    });

    test('request with no secondary configured is skipped without crashing', async () => {
        const request = makeRequest({ status: 'PendingIT', hrSubmittedAt: STALE });
        const cfg = makeConfig({ secondaryEmail: null, secondaryName: null });
        const { runEscalationCheck, sendOnboardingNotification } =
            await loadEscalationService({ requests: [request], globalCfg: cfg });

        const result = await runEscalationCheck();

        expect(result.escalated).toBe(0);
        expect(sendOnboardingNotification).not.toHaveBeenCalled();
    });

    test('stalled PendingDCI request uses hodApprovedAt as stage-start and escalates', async () => {
        const request = makeRequest({
            status: 'PendingDCI',
            hrSubmittedAt: STALE,
            hodApprovedAt: STALE,
            currentStageAssigneeEmail: 'primary@ifl.com'
        });
        const { runEscalationCheck, sendOnboardingNotification } =
            await loadEscalationService({ requests: [request] });

        const result = await runEscalationCheck();

        expect(result.escalated).toBe(1);
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'secondary@ifl.com',
            expect.anything(),
            expect.anything(),
            'DCI_INPUT'
        );
    });

    test('PendingDCIImplementation uses itHodDecidedAt as stage-start when present', async () => {
        const request = makeRequest({
            status: 'PendingDCIImplementation',
            itHodDecidedAt: STALE,          // email path
            dciManagerDecidedAt: null,
            currentStageAssigneeEmail: 'primary@ifl.com'
        });
        const { runEscalationCheck, sendOnboardingNotification } =
            await loadEscalationService({ requests: [request] });

        const result = await runEscalationCheck();

        expect(result.escalated).toBe(1);
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'secondary@ifl.com',
            expect.anything(),
            expect.anything(),
            'DCI_IMPLEMENTATION'
        );
    });

    test('IT_OPS escalation uses per-location override config, not global', async () => {
        const request = makeRequest({ status: 'PendingIT', hrSubmittedAt: STALE, location: 'KHI' });
        const globalCfg   = makeConfig({ approverEmail: 'global.itops@ifl.com', approverUsername: 'global.primary', secondaryEmail: 'global.secondary@ifl.com', secondaryUsername: 'global.secondary' });
        const overrideCfg = makeConfig({ approverEmail: 'khi.primary@ifl.com',  approverUsername: 'khi.primary',   secondaryEmail: 'khi.secondary@ifl.com',    secondaryUsername: 'khi.secondary'   });
        const { runEscalationCheck, sendOnboardingNotification } =
            await loadEscalationService({ requests: [request], globalCfg, overrideCfg });

        await runEscalationCheck();

        // Must use the location override's secondary, not global secondary
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'khi.secondary@ifl.com',
            expect.anything(),
            expect.anything(),
            'IT_OPS'
        );
        expect(sendOnboardingNotification).not.toHaveBeenCalledWith(
            'global.secondary@ifl.com',
            expect.anything(),
            expect.anything(),
            expect.anything()
        );
        // Username must also be updated from the location override row
        expect(request.update).toHaveBeenCalledWith(
            expect.objectContaining({
                currentStageAssigneeEmail:    'khi.secondary@ifl.com',
                currentStageAssigneeUsername: 'khi.secondary'
            })
        );
    });

});
