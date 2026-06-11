import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * Stage status transition audit
 *
 * Business rules under test:
 *  - Every service action that moves a request forward must set the correct
 *    next status on request.update().
 *  - Reject paths must set status = 'Rejected' and clear the stage token.
 *  - Completed path must set status = 'Completed' and clear the stage token.
 *
 * Covered transitions:
 *   updateITDetails          → PendingHOD
 *   handleHODApproval Approve→ PendingDCI
 *   handleHODApproval Reject → Rejected  (token cleared)
 *   handleDCIManagerApproval RequestChanges → PendingDCI
 *   handleDCIManagerApproval Approve (no email) → PendingDCIImplementation
 *   handleITHODApproval Approve → PendingDCIImplementation
 *   handleDCIImplementation  → PendingOPSAction
 *   handleOPSAction          → Completed  (token cleared)
 */

afterEach(() => {
    jest.resetModules();
    delete process.env.APP_URL;
});

async function loadService({ status, extraRequestFields = {} }) {
    jest.resetModules();
    process.env.APP_URL = 'http://localhost:3000';

    const requestUpdate = jest.fn().mockResolvedValue(undefined);
    const mockRequest = {
        id: 20,
        status,
        location: 'KHI',
        employeeId: 'EMP099',
        emailIncoming: false,
        emailOutgoing: false,
        itHodDecidedAt: null,
        update: requestUpdate,
        ...extraRequestFields
    };

    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(mockRequest) }
    }));
    await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
        default: { create: jest.fn().mockResolvedValue(undefined) }
    }));
    await jest.unstable_mockModule('../src/models/SystemConfig.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(null) }
    }));
    await jest.unstable_mockModule('../src/services/emailService.js', () => ({
        sendOnboardingNotification: jest.fn().mockResolvedValue(undefined),
        sendRequesterNotification:  jest.fn().mockResolvedValue(undefined)
    }));
    await jest.unstable_mockModule('../src/services/pdfService.js', () => ({
        generateOnboardingPDF: jest.fn().mockResolvedValue(undefined)
    }));
    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/services/recipientService.js', () => ({
        default: {
            get:             jest.fn().mockResolvedValue('next@ifl.com'),
            getWithFallback: jest.fn().mockResolvedValue({ email: 'next@ifl.com', name: 'Next', isFallback: false, source: 'DB' })
        }
    }));
    // AD computer lookup — DCI availability + OPS existence checks. Default to a
    // positive match so the OPS completion path succeeds; individual tests can
    // override if they need the "not found" branch.
    await jest.unstable_mockModule('../src/services/adService.js', () => ({
        checkComputerExists: jest.fn().mockResolvedValue({
            exists: true,
            match: { sAMAccountName: 'HOTESTAIO$', name: 'HOtestAIO' }
        })
    }));

    const onboardingService = await import('../src/services/onboardingService.js');
    return { onboardingService, requestUpdate };
}

describe('Stage status transition audit', () => {

    test('updateITDetails moves request to PendingHOD', async () => {
        const { onboardingService, requestUpdate } = await loadService({ status: 'PendingIT' });

        await onboardingService.updateITDetails('tok', { itField: 'value' });

        expect(requestUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'PendingHOD' })
        );
    });

    test('handleHODApproval Approve moves request to PendingDCI', async () => {
        const { onboardingService, requestUpdate } = await loadService({ status: 'PendingHOD' });

        await onboardingService.handleHODApproval('tok', 'Approve', 'OK');

        expect(requestUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'PendingDCI' })
        );
    });

    test('handleHODApproval Reject sets status Rejected and clears token', async () => {
        const { onboardingService, requestUpdate } = await loadService({ status: 'PendingHOD' });

        await onboardingService.handleHODApproval('tok', 'Reject', 'Not approved');

        expect(requestUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'Rejected', currentStageToken: null })
        );
    });

    test('handleDCIManagerApproval RequestChanges sends back to PendingDCI', async () => {
        const { onboardingService, requestUpdate } = await loadService({ status: 'PendingDCIManager' });

        await onboardingService.handleDCIManagerApproval('tok', 'RequestChanges', 'Fix item X');

        expect(requestUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'PendingDCI' })
        );
    });

    test('handleDCIManagerApproval Approve (no email needed) moves to PendingDCIImplementation', async () => {
        const { onboardingService, requestUpdate } = await loadService({
            status: 'PendingDCIManager',
            extraRequestFields: { emailIncoming: false, emailOutgoing: false }
        });

        await onboardingService.handleDCIManagerApproval('tok', 'Approve', 'All good');

        expect(requestUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'PendingDCIImplementation' })
        );
    });

    test('handleITHODApproval Approve moves to PendingDCIImplementation', async () => {
        const { onboardingService, requestUpdate } = await loadService({ status: 'PendingITHOD' });

        await onboardingService.handleITHODApproval('tok', 'Approve', 'Approved');

        expect(requestUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'PendingDCIImplementation' })
        );
    });

    test('handleDCIImplementation moves to PendingOPSAction', async () => {
        const { onboardingService, requestUpdate } = await loadService({ status: 'PendingDCIImplementation' });

        await onboardingService.handleDCIImplementation('tok', ['proof.pdf'], 'Implementer Name');

        expect(requestUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'PendingOPSAction' })
        );
    });

    test('handleOPSAction sets status Completed and clears token and both assignee fields', async () => {
        const { onboardingService, requestUpdate } = await loadService({
            status: 'PendingOPSAction',
            // OPS verifies the DCI-approved hostname stored on the request.
            extraRequestFields: { machineHostname: 'HOtestAIO' }
        });

        await onboardingService.handleOPSAction(
            'tok',
            [{ item: 'check1', checked: true }],
            'OPS Name',
            { serial: 'SN-123', screenshotPaths: ['uploads/proofs/x.png'] }
        );

        expect(requestUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                status:                      'Completed',
                currentStageToken:           null,
                currentStageAssigneeEmail:    null,
                currentStageAssigneeUsername: null,
                hostnameVerified:             true,
            })
        );
    });

});
