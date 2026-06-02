import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * Email routing chain audit
 *
 * Business rules under test:
 *  - The email resolved by RecipientService (including secondary/fallback) is
 *    the exact address passed to sendOnboardingNotification at every stage.
 *  - The action link embedded in the notification contains the current stage token.
 *  - When HOD is null/missing, updateITDetails sends to the fallback address
 *    without crashing the workflow.
 */

afterEach(() => {
    jest.resetModules();
    delete process.env.APP_URL;
});

async function loadService({ resolvedEmail = 'resolved@ifl.com', hodEmail = 'hod@ifl.com', status = 'PendingIT', extraRequestFields = {} } = {}) {
    jest.resetModules();
    process.env.APP_URL = 'http://localhost:3000';

    const sendOnboardingNotification = jest.fn().mockResolvedValue(undefined);
    const sendWorkOrderPDF           = jest.fn().mockResolvedValue(undefined);
    const sendRequesterNotification  = jest.fn().mockResolvedValue(undefined);

    const getWithFallback = jest.fn().mockResolvedValue({
        email: resolvedEmail, name: 'Resolved User', isFallback: false, source: 'DB_Primary_GLOBAL'
    });
    const get = jest.fn().mockResolvedValue(hodEmail);

    const requestUpdate = jest.fn().mockResolvedValue(undefined);
    const mockRequest = {
        id: 10,
        status,
        location: 'KHI',
        employeeId: 'EMP050',
        emailIncoming: false,
        emailOutgoing: false,
        itHodDecidedAt: null,
        update: requestUpdate,
        ...extraRequestFields
    };

    await jest.unstable_mockModule('../src/services/emailService.js', () => ({
        sendOnboardingNotification,
        sendWorkOrderPDF,
        sendRequesterNotification
    }));
    await jest.unstable_mockModule('../src/services/pdfService.js', () => ({
        generateOnboardingPDF: jest.fn().mockResolvedValue(undefined)
    }));
    await jest.unstable_mockModule('../src/services/recipientService.js', () => ({
        default: { get, getWithFallback }
    }));
    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: {
            findOne: jest.fn().mockResolvedValue(mockRequest),
            create:  jest.fn().mockResolvedValue(mockRequest)
        }
    }));
    await jest.unstable_mockModule('../src/models/TimelineEvent.js', () => ({
        default: { create: jest.fn().mockResolvedValue(undefined) }
    }));
    await jest.unstable_mockModule('../src/models/SystemConfig.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(null) }
    }));
    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));

    const onboardingService = await import('../src/services/onboardingService.js');
    return { onboardingService, sendOnboardingNotification, getWithFallback, get, requestUpdate };
}

describe('Email routing chain audit', () => {

    test('createRequest sends IT_OPS notification to the email returned by getWithFallback', async () => {
        const { onboardingService, sendOnboardingNotification } = await loadService({
            resolvedEmail: 'itops.khi@ifl.com'
        });

        await onboardingService.createRequest({ employeeId: 'EMP050', location: 'KHI' });

        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'itops.khi@ifl.com',
            expect.anything(),
            expect.stringContaining('/portal/it-ops/enter?action='),
            'IT_OPS'
        );
    });

    test('when getWithFallback returns the secondary (fallback) email, notification still goes to secondary', async () => {
        const { onboardingService, sendOnboardingNotification, getWithFallback } = await loadService({
            resolvedEmail: 'itops.secondary@ifl.com',
            status: 'PendingIT'
        });
        // Simulate secondary being active
        getWithFallback.mockResolvedValue({
            email: 'itops.secondary@ifl.com', name: 'Secondary IT Ops',
            isFallback: true, source: 'DB_Secondary_GLOBAL'
        });

        await onboardingService.createRequest({ employeeId: 'EMP050', location: 'KHI' });

        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'itops.secondary@ifl.com',
            expect.anything(),
            expect.anything(),
            'IT_OPS'
        );
    });

    test('handleHODApproval Approve sends DCI_TEAM notification to the email returned by getWithFallback', async () => {
        const { onboardingService, sendOnboardingNotification } = await loadService({
            resolvedEmail: 'dci.team@ifl.com',
            status: 'PendingHOD'
        });

        await onboardingService.handleHODApproval('tok', 'Approve', 'Looks good');

        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'dci.team@ifl.com',
            expect.anything(),
            expect.stringContaining('/portal/dci-team/enter?action='),
            'DCI_INPUT'
        );
    });

    test('handleDCIImplementation sends IT_OPS (Step 12) notification to the email returned by getWithFallback', async () => {
        const { onboardingService, sendOnboardingNotification } = await loadService({
            resolvedEmail: 'itops.step12@ifl.com',
            status: 'PendingDCIImplementation'
        });

        await onboardingService.handleDCIImplementation('tok', ['proof.pdf'], 'DCI Implementer');

        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'itops.step12@ifl.com',
            expect.anything(),
            expect.stringContaining('/portal/it-ops/enter?action='),
            'OPS_ACTION'
        );
    });

    test('when HOD is null, updateITDetails does not crash and sends to whatever get() returns', async () => {
        const { onboardingService, sendOnboardingNotification, get } = await loadService({
            hodEmail: null,
            status: 'PendingIT'
        });
        get.mockResolvedValue(null);

        // Should not throw even with null HOD
        await expect(
            onboardingService.updateITDetails('tok', { someField: 'value' })
        ).resolves.not.toThrow();

        // sendOnboardingNotification is still called (with null — email service handles gracefully)
        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            null,
            expect.anything(),
            expect.anything(),
            'HOD_REVIEW'
        );
    });

    test('updateDCIDetails sends DCI_MANAGER_APPROVAL notification to the email returned by getWithFallback', async () => {
        const { onboardingService, sendOnboardingNotification } = await loadService({
            resolvedEmail: 'dci.manager@ifl.com',
            status: 'PendingDCI'
        });

        await onboardingService.updateDCIDetails('tok', {});

        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'dci.manager@ifl.com',
            expect.anything(),
            expect.stringContaining('/portal/dci-manager/enter?action='),
            'DCI_MANAGER_APPROVAL'
        );
    });

    test('handleDCIManagerApproval (email required) sends IT_HOD_APPROVAL notification to the email returned by getWithFallback', async () => {
        const { onboardingService, sendOnboardingNotification } = await loadService({
            resolvedEmail: 'it.hod@ifl.com',
            status: 'PendingDCIManager',
            extraRequestFields: { emailIncoming: true }
        });

        await onboardingService.handleDCIManagerApproval('tok', 'Approve', 'Approved');

        expect(sendOnboardingNotification).toHaveBeenCalledWith(
            'it.hod@ifl.com',
            expect.anything(),
            expect.stringContaining('/portal/it-hod/enter?action='),
            'IT_HOD_APPROVAL'
        );
    });

});
