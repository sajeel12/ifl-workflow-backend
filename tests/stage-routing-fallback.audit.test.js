import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * Stage routing fallback audit
 *
 * Business rules under test:
 *  - Roles with a 2-day primary/secondary model (IT_OPS, DCI_TEAM, DCI_IMPLEMENTER)
 *    must be resolved through RecipientService.getWithFallback at every stage
 *    transition, not just at request creation.
 *  - Delegation-model roles (HOD, DCI_MANAGER, IT_HOD) continue to use get()
 *    — they are NOT tested here (their auth is covered in delegation.audit.test.js).
 *
 * Covered transitions:
 *   HOD Approve     → DCI_TEAM       (handleHODApproval)
 *   DCI Mgr Changes → DCI_TEAM       (handleDCIManagerApproval RequestChanges)
 *   DCI Mgr Approve → DCI_IMPLEMENTER(handleDCIManagerApproval Approve, no email)
 *   IT HOD Approve  → DCI_IMPLEMENTER(handleITHODApproval Approve)
 *   DCI Impl Done   → IT_OPS Step 12 (handleDCIImplementation)
 */

afterEach(() => {
    jest.resetModules();
});

async function loadService({ status, extraRequestFields = {} }) {
    jest.resetModules();

    const getWithFallback = jest.fn().mockResolvedValue({
        email: 'secondary@ifl.com',
        name: 'Secondary User',
        isFallback: true,
        source: 'DB_Secondary_GLOBAL'
    });
    const get = jest.fn().mockResolvedValue('primary@ifl.com');

    const requestUpdate = jest.fn().mockResolvedValue(undefined);
    const mockRequest = {
        id: 30,
        status,
        location: 'KHI',
        employeeId: 'EMP002',
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
        sendWorkOrderPDF: jest.fn().mockResolvedValue(undefined),
        sendRequesterNotification: jest.fn().mockResolvedValue(undefined)
    }));
    await jest.unstable_mockModule('../src/services/pdfService.js', () => ({
        generateOnboardingPDF: jest.fn().mockResolvedValue(undefined)
    }));
    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));
    await jest.unstable_mockModule('../src/services/recipientService.js', () => ({
        default: { get, getWithFallback }
    }));
    // AD computer lookup — the DCI hostname must be FREE (exists:false) for
    // updateDCIDetails to reserve it.
    await jest.unstable_mockModule('../src/services/adService.js', () => ({
        checkComputerExists: jest.fn().mockResolvedValue({ exists: false, match: null })
    }));

    const onboardingService = await import('../src/services/onboardingService.js');

    return { onboardingService, getWithFallback, get, requestUpdate };
}

describe('Stage routing fallback audit', () => {
    test('handleHODApproval routes DCI_TEAM through getWithFallback', async () => {
        const { onboardingService, getWithFallback } = await loadService({
            status: 'PendingHOD'
        });

        await onboardingService.handleHODApproval('tok', 'Approve', 'Looks good');

        expect(getWithFallback).toHaveBeenCalledWith(
            'DCI_TEAM',
            expect.objectContaining({ location: 'KHI', requestId: 30 })
        );
    });

    test('handleDCIManagerApproval (RequestChanges) routes DCI_TEAM through getWithFallback', async () => {
        const { onboardingService, getWithFallback } = await loadService({
            status: 'PendingDCIManager'
        });

        await onboardingService.handleDCIManagerApproval('tok', 'RequestChanges', 'Fix item X');

        expect(getWithFallback).toHaveBeenCalledWith(
            'DCI_TEAM',
            expect.objectContaining({ location: 'KHI', requestId: 30 })
        );
    });

    test('handleDCIManagerApproval (Approve, no email) routes DCI_IMPLEMENTER through getWithFallback', async () => {
        const { onboardingService, getWithFallback } = await loadService({
            status: 'PendingDCIManager',
            extraRequestFields: { emailIncoming: false, emailOutgoing: false }
        });

        await onboardingService.handleDCIManagerApproval('tok', 'Approve', 'All good');

        expect(getWithFallback).toHaveBeenCalledWith(
            'DCI_IMPLEMENTER',
            expect.objectContaining({ location: 'KHI', requestId: 30 })
        );
    });

    test('handleITHODApproval (Approve) routes DCI_IMPLEMENTER through getWithFallback', async () => {
        const { onboardingService, getWithFallback } = await loadService({
            status: 'PendingITHOD'
        });

        await onboardingService.handleITHODApproval('tok', 'Approve', 'Approved');

        expect(getWithFallback).toHaveBeenCalledWith(
            'DCI_IMPLEMENTER',
            expect.objectContaining({ location: 'KHI', requestId: 30 })
        );
    });

    test('handleDCIImplementation routes IT_OPS (Step 12 OPS verification) through getWithFallback', async () => {
        const { onboardingService, getWithFallback } = await loadService({
            status: 'PendingDCIImplementation'
        });

        await onboardingService.handleDCIImplementation('tok', ['proof.pdf'], 'Implementer Name');

        expect(getWithFallback).toHaveBeenCalledWith(
            'IT_OPS',
            expect.objectContaining({ location: 'KHI', requestId: 30 })
        );
    });

    // Delegation roles — still go through getWithFallback so username is preserved
    // for portal auth, but the timer logic is bypassed inside the service.

    test('updateDCIDetails routes DCI_MANAGER through getWithFallback (delegation role — primary only, no timer)', async () => {
        const { onboardingService, getWithFallback } = await loadService({
            status: 'PendingDCI'
        });

        await onboardingService.updateDCIDetails('tok', { machineHostname: 'HOtestAIO' });

        expect(getWithFallback).toHaveBeenCalledWith(
            'DCI_MANAGER',
            expect.objectContaining({ location: 'KHI', requestId: 30 })
        );
    });

    test('handleDCIManagerApproval (Approve, email required) routes IT_HOD through getWithFallback (delegation role — primary only, no timer)', async () => {
        const { onboardingService, getWithFallback } = await loadService({
            status: 'PendingDCIManager',
            extraRequestFields: { emailIncoming: true }
        });

        await onboardingService.handleDCIManagerApproval('tok', 'Approve', 'Approved');

        expect(getWithFallback).toHaveBeenCalledWith(
            'IT_HOD',
            expect.objectContaining({ location: 'KHI', requestId: 30 })
        );
    });
});
