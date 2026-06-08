import Employee from '../models/Employee.js';
import SyncLog from '../models/SyncLog.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';
import WorkflowApproverLocationOverride from '../models/WorkflowApproverLocationOverride.js';
import SystemConfig from '../models/SystemConfig.js';
import OnboardingRequest from '../models/OnboardingRequest.js';
import OffboardingRequest from '../models/OffboardingRequest.js';
import TimelineEvent from '../models/TimelineEvent.js';
import oracleSyncService from '../services/oracleSyncService.js';
import { Op } from 'sequelize';
import sequelize from '../config/database.js';
import { LOCATION_GROUPS } from '../utils/locationGroups.js';
import cronService from '../services/cronService.js';
import * as emailService from '../services/emailService.js';
import RecipientService from '../services/recipientService.js';
import { humanizeAction, humanizeDetails, humanizeDetailsHTML } from '../utils/historyFormatter.js';
import { findUserByEmployeeIdViaSidecar } from '../services/adService.js';
import { resolveStageRecipient } from '../utils/resolveStageRecipient.js';
import { emailsMatch } from '../utils/emailMatch.js';

// Map workflow status -> the role currently responsible
const STATUS_TO_RESEND = {
    PendingIT: { roleKey: 'IT_OPS', type: 'IT_OPS' },
    PendingHOD: { roleKey: 'HOD', type: 'HOD_REVIEW' },
    PendingDCI: { roleKey: 'DCI_TEAM', type: 'DCI_INPUT' },
    PendingDCIManager: { roleKey: 'DCI_MANAGER', type: 'DCI_MANAGER_APPROVAL' },
    PendingITHOD: { roleKey: 'IT_HOD', type: 'IT_HOD_APPROVAL' },
    PendingDCIImplementation: { roleKey: 'DCI_IMPLEMENTER', type: 'DCI_IMPLEMENTATION' },
    // Step 12 routes back to IT_OPS — same group as Step 2 per client requirement.
    PendingOPSAction: { roleKey: 'IT_OPS', type: 'OPS_ACTION' }
};

// Map the current pending OFFBOARDING status → role + email type. Shared by the
// offboarding resend preview + send handlers.
const OFFBOARDING_STAGE_MAP = {
    PendingDCIManager: { roleKey: 'DCI_MANAGER', type: 'DCI_MANAGER_APPROVAL' },
    PendingDCIImplementation: { roleKey: 'DCI_IMPLEMENTER', type: 'DCI_IMPLEMENTER' }
};

// Notification email type → portal entry slug. HOD_REVIEW has no portal.
const EMAIL_TYPE_TO_PORTAL_SLUG = {
    IT_OPS: 'it-ops',
    DCI_INPUT: 'dci-team',
    DCI_MANAGER_APPROVAL: 'dci-manager',
    IT_HOD_APPROVAL: 'it-hod',
    DCI_IMPLEMENTATION: 'dci-implementer',
    OPS_ACTION: 'it-ops',
};

// Delegation roles own a single pending status. When admin reassigns the role,
// all in-flight requests at that status must be rebound immediately so that:
//   (a) the portal dashboard canAct flag is correct for the new delegate, and
//   (b) the old delegate's token is rejected by the form POST guard (live config).
const DELEGATION_ROLE_TO_STATUS = {
    DCI_MANAGER: 'PendingDCIManager',
    IT_HOD: 'PendingITHOD',
};

// Send the stage action email to a specific recipient for an in-flight request.
// Used by the delegation and revert rebind loops so the new (or restored)
// person gets notified immediately without admin having to resend manually.
// Failures are logged but do NOT abort the rebind — a missed email is better
// than a failed save.
//
// `kind` is 'onboarding' (default, preserves legacy behaviour) or
// 'offboarding'. The two flows use different action-link bases and different
// email-type maps.
async function sendDelegationNotification(inflightReq, recipientEmail, kind = 'onboarding') {
    try {
        if (!inflightReq.currentStageToken) return;
        if (kind === 'offboarding') {
            const type = inflightReq.status === 'PendingDCIManager' ? 'DCI_MANAGER_APPROVAL'
                : inflightReq.status === 'PendingDCIImplementation' ? 'DCI_IMPLEMENTER'
                    : null;
            if (!type) return;
            const actionLink = `${process.env.APP_URL}/api/offboarding/handle?token=${inflightReq.currentStageToken}`;
            await emailService.sendOffboardingNotification(recipientEmail, inflightReq, actionLink, type);
            return;
        }
        const map = STATUS_TO_RESEND[inflightReq.status];
        if (!map) return;
        const portalSlug = EMAIL_TYPE_TO_PORTAL_SLUG[map.type];
        const actionLink = portalSlug
            ? `${process.env.APP_URL}/portal/${portalSlug}/enter?action=${inflightReq.currentStageToken}`
            : `${process.env.APP_URL}/api/onboarding/handle?token=${inflightReq.currentStageToken}`;
        await emailService.sendOnboardingNotification(recipientEmail, inflightReq, actionLink, map.type);
    } catch (err) {
        console.error(`[Delegation] Failed to send notification for request #${inflightReq.id} to ${recipientEmail}:`, err.message);
    }
}

// Walk both OnboardingRequests and OffboardingRequests at a given pending
// status; rebind currentStageAssignee* to the new holder, snapshot a
// delegationEvent JSON so escalationService can auto-revert if the delegate
// doesn't act in time, log a TimelineEvent, and re-emit the stage email.
//
// Returns the count of requests rebound across both tables.
async function rebindInFlightToDelegate({
    pendingStatus, prevEmail, newEmail, newUsername, roleLabel, isTemporary, isRevert
}) {
    if (!pendingStatus || !newEmail) return 0;
    let count = 0;

    const ONBOARDING = { model: OnboardingRequest, kind: 'onboarding' };
    const OFFBOARDING = { model: OffboardingRequest, kind: 'offboarding' };

    for (const { model, kind } of [ONBOARDING, OFFBOARDING]) {
        const inFlight = await model.findAll({ where: { status: pendingStatus } });
        for (const r of inFlight) {
            const originalEmail = (r.delegationEvent && r.delegationEvent.originalAssigneeEmail)
                || r.currentStageAssigneeEmail
                || prevEmail
                || null;
            const delegationEvent = isRevert ? null : {
                delegatedAt: new Date().toISOString(),
                delegatedFromEmail: r.currentStageAssigneeEmail || prevEmail || null,
                delegatedToEmail: newEmail,
                originalAssigneeEmail: originalEmail
            };
            await r.update({
                currentStageAssigneeEmail: newEmail,
                currentStageAssigneeUsername: newUsername || null,
                delegationEvent
            });
            const action = isRevert ? 'Admin Delegation Reverted' : 'Admin Delegation Update';
            const details = isRevert
                ? `${roleLabel} restored to original holder ${newEmail}. Temporary delegation ended.`
                : `${roleLabel} reassigned to ${newEmail} (${isTemporary ? 'Temporary Delegation' : 'Permanent Role Change'}). Portal access and action gate updated immediately.`;
            await TimelineEvent.create({
                requestId: r.id,
                action,
                actorRole: 'Admin',
                details,
                timestamp: new Date()
            });
            await sendDelegationNotification(r, newEmail, kind);
            count++;
        }
    }
    return count;
}

// Stage-owner roles (NOT the temporary-delegation roles DCI_MANAGER / IT_HOD) and
// the pending statuses they own. When their approver changes — global config OR a
// per-location override — every in-flight request at these statuses is re-pointed
// to the newly configured person and re-emailed, mirroring the delegation roles.
const REBIND_STAGE_ROLE_TO_STATUSES = {
    IT_OPS:          ['PendingIT', 'PendingOPSAction'],
    DCI_TEAM:        ['PendingDCI'],
    DCI_IMPLEMENTER: ['PendingDCIImplementation'],
};

// Re-resolve the currently configured recipient for every in-flight request owned
// by `roleKey` and, where it changed, update currentStageAssignee*, clear any
// delegationEvent (this is a permanent person change, not a temporary delegation —
// important because PendingDCIImplementation is in DELEGATION_REVERT_STATUSES and a
// stray delegationEvent would auto-revert after the timeout), log a timeline entry,
// and re-send the stage action email. Re-resolving per request makes location scope
// automatic: a global-config change only moves requests whose location has no
// override; an override change only moves that location's requests. Idempotent —
// unchanged requests are skipped, so editing only the secondary slot sends nothing.
// Covers both onboarding and offboarding tables. Returns the count rebound.
async function rebindStageToCurrentRecipient({ roleKey }) {
    const statuses = REBIND_STAGE_ROLE_TO_STATUSES[roleKey];
    if (!statuses) return 0;
    let count = 0;

    const TABLES = [
        { model: OnboardingRequest, kind: 'onboarding' },
        { model: OffboardingRequest, kind: 'offboarding' }
    ];

    for (const status of statuses) {
        for (const { model, kind } of TABLES) {
            const inFlight = await model.findAll({
                where: { status, currentStageToken: { [Op.ne]: null } }
            });
            for (const r of inFlight) {
                const recipient = await resolveStageRecipient(status, r.location);
                if (!recipient || !recipient.email) continue;
                if (emailsMatch(r.currentStageAssigneeEmail, recipient.email)) continue; // unchanged

                await r.update({
                    currentStageAssigneeEmail:    recipient.email,
                    currentStageAssigneeUsername: recipient.username || null,
                    delegationEvent:              null
                });
                await TimelineEvent.create({
                    requestId: r.id,
                    action:    'Stage Reassigned (Approver Changed)',
                    actorRole: 'Admin',
                    details:   `${recipient.role || roleKey} reassigned to ${recipient.email}. Portal access, action gate, and notification updated.`,
                    timestamp: new Date()
                });
                await sendDelegationNotification(r, recipient.email, kind);
                count++;
            }
        }
    }
    return count;
}

// Resolve who should receive a resend for an in-flight stage: the configured
// approver (primary/secondary, location-aware) via resolveStageRecipient, falling
// back to RecipientService.get for config-less roles (HOD = HRMS manager lookup).
async function resolveResendRecipient(status, roleKey, context) {
    const r = await resolveStageRecipient(status, context.location || null);
    if (r && r.email) return { role: r.role, name: r.name || '', email: r.email, username: r.username || null };
    const email = await RecipientService.get(roleKey, context);
    return { role: (r && r.role) || roleKey, name: '', email: email || '', username: null };
}

// Per client policy, only the IT Operations role is split by location.
// All other roles use the global default everywhere. The admin UI hides
// non-location-aware roles from the per-location editor.
const LOCATION_AWARE_ROLES = new Set(['IT_OPS', 'HR_INITIATOR']);

// Map a TimelineEvent actorRole -> approver roleKey, so admin-delete can notify
// every stage owner that touched the request. Uses current configured emails —
// not historical snapshots.
const ACTOR_ROLE_TO_ROLE_KEY = {
    IT:             'IT_OPS',
    HOD:            'HOD',
    DCI:            'DCI_TEAM',
    DCIManager:     'DCI_MANAGER',
    ITHOD:          'IT_HOD',
    DCIImplementer: 'DCI_IMPLEMENTER',
    OPS:            'IT_OPS',
};

// Gather every party to notify when an onboarding request is admin-deleted:
// the requester, the live stage assignee, and the currently-configured approver
// email for each role that has acted on the request (per its timeline).
async function collectNotifyEmails(request) {
    const emails = new Set();

    if (request.requesterEmail) emails.add(request.requesterEmail.toLowerCase().trim());
    if (request.currentStageAssigneeEmail) emails.add(request.currentStageAssigneeEmail.toLowerCase().trim());

    let actorRoles = [];
    try {
        const events = await TimelineEvent.findAll({
            where: { requestId: request.id },
            attributes: ['actorRole']
        });
        actorRoles = [...new Set(events.map(e => e.actorRole).filter(r => r && r !== 'System' && r !== 'Admin' && r !== 'HR'))];
    } catch (err) {
        console.error('[Admin Delete] Could not load timeline actors:', err.message);
    }

    for (const actorRole of actorRoles) {
        const roleKey = ACTOR_ROLE_TO_ROLE_KEY[actorRole];
        if (!roleKey) continue;
        try {
            let cfg = null;
            if (LOCATION_AWARE_ROLES.has(roleKey) && request.location) {
                cfg = await WorkflowApproverLocationOverride.findOne({
                    where: { roleKey, location: request.location, isActive: true }
                });
            }
            if (!cfg) cfg = await WorkflowApproverConfig.findOne({ where: { roleKey, isActive: true } });
            if (cfg && cfg.approverEmail) emails.add(cfg.approverEmail.toLowerCase().trim());
        } catch (err) {
            console.error(`[Admin Delete] Could not resolve email for ${roleKey}:`, err.message);
        }
    }

    return [...emails].filter(Boolean);
}

// State to remember current config (would usually be in DB)
let currentCronConfig = {
    enabled: false,
    expression: '0 2 * * *' // Default Daily at 2 AM
};

class AdminController {
    /**
     * View: Render the HOD Panel EJS Template
     */
    renderHodPanel(req, res) {
        res.render('pages/admin_hod_panel', { activeTab: 'hod' });
    }

    /**
     * View: Render the Offboarding Panel EJS Template
     */
    renderOffboardingPanel(req, res) {
        res.render('pages/admin_offboarding_panel', { activeTab: 'offboarding' });
    }

    /**
     * View: Render the System Settings / Sync Panel EJS Template
     */
    async renderSettingsPanel(req, res) {
        try {
            // Fetch the last 10 sync logs
            const syncLogs = await SyncLog.findAll({
                limit: 10,
                order: [['createdAt', 'DESC']]
            });
            res.render('pages/admin_settings_panel', {
                activeTab: 'settings',
                syncLogs,
                config: currentCronConfig
            });
        } catch (error) {
            console.error('Error fetching sync logs:', error);
            res.render('pages/admin_settings_panel', {
                activeTab: 'settings',
                syncLogs: [],
                config: currentCronConfig
            });
        }
    }

    /**
     * API: Search/List Employees
     */
    async getEmployeeDetails(req, res) {
        try {
            const { id } = req.params;
            const employee = await Employee.findByPk(id);
            if (!employee) {
                return res.status(404).json({ success: false, error: 'Employee not found' });
            }

            let hodName = null;
            let hodEmail = null;
            if (employee.hodId) {
                const hod = await Employee.findByPk(employee.hodId, { attributes: ['name', 'employeeId', 'email'] });
                if (hod) {
                    hodName = hod.name;
                    // Resolve real email from AD sidecar — DB emails are often stale
                    try {
                        const adHod = await findUserByEmployeeIdViaSidecar(hod.employeeId || employee.hodId);
                        if (adHod && adHod.mail) hodEmail = adHod.mail;
                    } catch (_) { }
                    if (!hodEmail) hodEmail = hod.email || null; // fallback to DB
                }
            }

            // Return full data
            res.json({ success: true, data: { ...employee.toJSON(), hodName, hodEmail } });
        } catch (error) {
            console.error('Error fetching employee details:', error);
            res.status(500).json({ success: false, error: 'Failed to fetch employee details' });
        }
    }

    /**
     * API: Update Employee Details
     */
    async updateEmployeeDetails(req, res) {
        try {
            const { id } = req.params;
            const updateData = req.body;

            const employee = await Employee.findByPk(id);
            if (!employee) {
                return res.status(404).json({ success: false, error: 'Employee not found' });
            }

            // Prevent changing the employeeId or security constraints
            delete updateData.employeeId;
            delete updateData.createdAt;
            delete updateData.updatedAt;

            await employee.update(updateData);

            res.json({ success: true, message: 'Employee updated successfully', data: employee });
        } catch (error) {
            console.error('Error updating employee:', error);
            res.status(500).json({ success: false, error: 'Failed to update employee details' });
        }
    }

    /**
     * API: Search/List Employees
     */
    async searchEmployees(req, res) {
        try {
            const { q, page = 1, limit = 10 } = req.query;
            const limitInt = parseInt(limit, 10);
            const pageInt = parseInt(page, 10);
            const offset = (pageInt - 1) * limitInt;

            const whereClause = {};
            if (q) {
                const searchStr = `%${q}%`;
                whereClause[Op.or] = [
                    { employeeId: { [Op.like]: searchStr } },
                    { name: { [Op.like]: searchStr } },
                    { designation: { [Op.like]: searchStr } },
                    { mainDept: { [Op.like]: searchStr } },
                    { email: { [Op.like]: searchStr } }
                ];
            }

            const { count, rows: employees } = await Employee.findAndCountAll({
                where: whereClause,
                limit: limitInt,
                offset: offset,
                order: [['name', 'ASC']],
                attributes: ['employeeId', 'name', 'designation', 'mainDept', 'hodId', 'email', 'location']
            });

            const results = [];
            for (let emp of employees) {
                let hodName = null;
                if (emp.hodId) {
                    const hod = await Employee.findByPk(emp.hodId, { attributes: ['name'] });
                    if (hod) hodName = hod.name;
                }

                results.push({
                    employeeId: emp.employeeId,
                    name: emp.name,
                    designation: emp.designation,
                    department: emp.mainDept,
                    location: emp.location,
                    email: emp.email,
                    hodId: emp.hodId,
                    hodName: hodName
                });
            }

            res.json({
                success: true,
                data: results,
                pagination: {
                    total: count,
                    page: pageInt,
                    limit: limitInt,
                    totalPages: Math.ceil(count / limitInt)
                }
            });
        } catch (error) {
            console.error('Error searching employees:', error);
            res.status(500).json({ success: false, error: 'Failed to search employees' });
        }
    }

    /**
     * API: Assign an HOD to an Employee
     */
    async assignHod(req, res) {
        try {
            const { employeeId, hodId } = req.body;

            if (!employeeId || !hodId) {
                return res.status(400).json({ success: false, error: 'Missing employeeId or hodId' });
            }

            // Prevent self-assignment
            if (employeeId === hodId) {
                return res.status(400).json({ success: false, error: 'An employee cannot be their own HOD' });
            }

            // Verify both exist
            const employee = await Employee.findByPk(employeeId);
            const hod = await Employee.findByPk(hodId);

            if (!employee) return res.status(404).json({ success: false, error: `Employee ${employeeId} not found` });
            if (!hod) return res.status(404).json({ success: false, error: `HOD ${hodId} not found` });

            // Assign
            employee.hodId = hodId;
            await employee.save();

            res.json({ success: true, message: `Successfully assigned ${hod.name} as HOD for ${employee.name}` });
        } catch (error) {
            console.error('Error assigning HOD:', error);
            res.status(500).json({ success: false, error: 'Failed to assign HOD' });
        }
    }

    /**
     * API: Remove an HOD Assignment
     */
    async removeHod(req, res) {
        try {
            const { employeeId } = req.body;

            if (!employeeId) {
                return res.status(400).json({ success: false, error: 'Employee ID is required' });
            }

            const emp = await Employee.findByPk(employeeId);
            if (!emp) {
                return res.status(404).json({ success: false, error: 'Employee not found' });
            }

            emp.hodId = null;
            await emp.save();

            res.json({ success: true, message: `HOD assignment removed successfully for ${emp.name}` });

        } catch (error) {
            console.error('Remove HOD Error:', error);
            res.status(500).json({ success: false, error: 'Failed to remove HOD' });
        }
    }

    /**
     * API: Trigger Manual HRMS Sync
     */
    async triggerManualSync(req, res) {
        try {
            oracleSyncService.runSync('MANUAL').catch(err => {
                console.error('Async sync error:', err);
            });

            res.json({ success: true, message: 'Sync started successfully. Check logs for updates.' });
        } catch (error) {
            console.error('Trigger Sync Error:', error);
            res.status(500).json({ success: false, error: 'Failed to start sync' });
        }
    }

    /**
     * API: Update Cron Schedule Configuration
     */
    async updateSyncConfig(req, res) {
        try {
            const { enabled, expression } = req.body;

            currentCronConfig.enabled = enabled;
            if (expression) {
                currentCronConfig.expression = expression;
            }

            if (currentCronConfig.enabled) {
                cronService.scheduleHrmsSync(currentCronConfig.expression);
            } else {
                cronService.stopHrmsSync();
            }

            res.json({
                success: true,
                message: enabled ? 'Automated Sync Scheduled' : 'Automated Sync Disabled',
                config: currentCronConfig
            });
        } catch (error) {
            console.error('Update Config Error:', error);
            res.status(500).json({ success: false, error: 'Failed to update schedule config' });
        }
    }

    /**
     * API: Get List of Departments with Employee Counts
     */
    async getDepartments(req, res) {
        try {
            // Fetch grouped departments and counts
            const deptStats = await Employee.findAll({
                attributes: [
                    'mainDept',
                    [sequelize.fn('COUNT', sequelize.col('employeeId')), 'employeeCount']
                ],
                group: ['mainDept'],
                order: [['mainDept', 'ASC']],
                raw: true // Required for complex aggregations in Sequelize to avoid model parsing errors
            });

            const results = [];
            for (let stat of deptStats) {
                // When raw: true is used, access properties directly instead of getDataValue
                const deptName = stat.mainDept;
                const count = stat.employeeCount;

                // Skip null/empty departments if you want, or just label them
                const displayDept = deptName || 'Unassigned Department';

                // Find if there is a dominant HOD for this department
                // For simplicity, let's just grab the HOD of the first employee in this dept
                // A better approach would be to check if ALL employees share the same HOD.
                let currentHodName = 'Mixed/None';
                let currentHodId = null;

                const sampleEmp = await Employee.findOne({
                    where: { mainDept: deptName, hodId: { [Op.not]: null } }
                });

                if (sampleEmp) {
                    const hod = await Employee.findByPk(sampleEmp.hodId, { attributes: ['name'] });
                    if (hod) {
                        currentHodName = hod.name;
                        currentHodId = sampleEmp.hodId;
                    }
                }

                results.push({
                    departmentName: displayDept,
                    originalDeptName: deptName,
                    employeeCount: count,
                    currentHodName,
                    currentHodId
                });
            }

            res.json({ success: true, data: results });
        } catch (error) {
            console.error('Error fetching departments:', error.message, error.stack);
            res.status(500).json({ success: false, error: 'Failed to fetch departments', details: error.message });
        }
    }

    /**
     * View: Render Workflow Approvers Panel
     *
     * The page also renders an in-card location dropdown for the IT Operations
     * role (only that role is location-aware per client policy), so we pre-load
     * the list of distinct employee locations alongside the approver rows.
     */
    async renderWorkflowApproversPanel(req, res) {
        try {
            const approvers = await WorkflowApproverConfig.findAll({ order: [['id', 'ASC']] });
            // Per client policy, locations are no longer derived from HRMS —
            // they're fixed groups defined in src/utils/locationGroups.js.
            // The page passes both the group keys (used as <option value>)
            // and a parallel `locationLabels` map for human display.
            const locations = LOCATION_GROUPS.map(g => g.key);
            const locationLabels = Object.fromEntries(LOCATION_GROUPS.map(g => [g.key, g.label]));
            res.render('pages/admin_workflow_approvers', {
                activeTab: 'approvers',
                approvers,
                locations,
                locationLabels
            });
        } catch (error) {
            console.error('Error loading approvers panel:', error);
            res.status(500).send('Failed to load approvers panel');
        }
    }

    /**
     * API: List all workflow approver configs
     */
    async getWorkflowApprovers(req, res) {
        try {
            const approvers = await WorkflowApproverConfig.findAll({ order: [['id', 'ASC']] });
            res.json({ success: true, data: approvers });
        } catch (error) {
            console.error('Error fetching approvers:', error);
            res.status(500).json({ success: false, error: 'Failed to fetch approver configs' });
        }
    }

    /**
     * API: Distinct list of employee locations.
     * Used by the admin Workflow Approvers panel to populate the location
     * picker so admins can configure per-location approvers.
     */
    async getLocations(req, res) {
        try {
            // Fixed location groups — see src/utils/locationGroups.js. We
            // return both the keys (for API consumers) and the human labels.
            return res.json({
                success: true,
                data: LOCATION_GROUPS.map(g => g.key),
                groups: LOCATION_GROUPS
            });
        } catch (error) {
            console.error('Error fetching locations:', error);
            return res.status(500).json({ success: false, error: 'Failed to fetch locations' });
        }
    }

    /**
     * API: Get the merged approver config for a given location.
     *
     * Returns one row per role with the resolved Primary/Secondary for that
     * location: if a per-location override exists, it's used; otherwise the
     * row falls back to the global config and gets isOverride=false so the
     * UI can render a "(default)" badge.
     *
     * Query: ?location=Lahore  (omit or "DEFAULT" to manage the global config)
     */
    async getApproversForLocation(req, res) {
        try {
            const location = (req.query.location || '').trim();
            const isDefault = !location || location.toUpperCase() === 'DEFAULT';

            const globals = await WorkflowApproverConfig.findAll({ order: [['id', 'ASC']] });

            // Default ("All Locations") view → just return the globals.
            // Crucially we include `id` (WorkflowApproverConfig.id) so the
            // re-rendered cards on the client can PUT to /workflow-approvers/:id.
            if (isDefault) {
                const data = globals.map(g => ({
                    id: g.id,
                    roleKey: g.roleKey,
                    label: g.label,
                    description: g.description,
                    workflowStage: g.workflowStage,
                    approverEmail: g.approverEmail,
                    approverName: g.approverName,
                    approverUsername: g.approverUsername,
                    secondaryEmail: g.secondaryEmail,
                    secondaryName: g.secondaryName,
                    secondaryUsername: g.secondaryUsername,
                    primaryExpiredAt: g.primaryExpiredAt,
                    isActive: g.isActive,
                    isOverride: false,
                    overrideId: null,
                    location: null
                }));
                return res.json({ success: true, location: null, data });
            }

            // Specific location selected → only the location-aware roles
            // (currently just IT_OPS) are editable per-location. Other roles
            // are filtered out so the UI only shows the cards that matter.
            const editableGlobals = globals.filter(g => LOCATION_AWARE_ROLES.has(g.roleKey));
            const overrides = await WorkflowApproverLocationOverride.findAll({
                where: { location, roleKey: { [Op.in]: Array.from(LOCATION_AWARE_ROLES) } }
            });
            const overrideByRole = new Map(overrides.map(o => [o.roleKey, o]));

            const data = editableGlobals.map(g => {
                const o = overrideByRole.get(g.roleKey);
                if (o) {
                    return {
                        roleKey: g.roleKey,
                        label: g.label,
                        description: g.description,
                        workflowStage: g.workflowStage,
                        approverEmail: o.approverEmail,
                        approverName: o.approverName,
                        approverUsername: o.approverUsername,
                        secondaryEmail: o.secondaryEmail,
                        secondaryName: o.secondaryName,
                        secondaryUsername: o.secondaryUsername,
                        primaryExpiredAt: o.primaryExpiredAt,
                        isActive: o.isActive,
                        isOverride: true,
                        overrideId: o.id,
                        location
                    };
                }
                return {
                    roleKey: g.roleKey,
                    label: g.label,
                    description: g.description,
                    workflowStage: g.workflowStage,
                    // Show the global value as a "ghost" so admins know what would be used.
                    approverEmail: g.approverEmail,
                    approverName: g.approverName,
                    approverUsername: g.approverUsername,
                    secondaryEmail: g.secondaryEmail,
                    secondaryName: g.secondaryName,
                    secondaryUsername: g.secondaryUsername,
                    primaryExpiredAt: null,
                    isActive: g.isActive,
                    isOverride: false,
                    overrideId: null,
                    location
                };
            });

            return res.json({
                success: true,
                location,
                data,
                locationAwareRoles: Array.from(LOCATION_AWARE_ROLES)
            });
        } catch (error) {
            console.error('Error fetching per-location approvers:', error);
            return res.status(500).json({ success: false, error: 'Failed to fetch approvers' });
        }
    }

    /**
     * API: Upsert a per-(role, location) approver override.
     *
     * Body: { roleKey, location, approverEmail, approverName, secondaryEmail,
     *         secondaryName, isActive }
     * If all four email/name fields are blank AND isActive is true, we DELETE
     * the override row instead — falling back to the global config silently.
     */
    async upsertApproverForLocation(req, res) {
        try {
            const { roleKey, location } = req.body || {};
            if (!roleKey || !location || !location.trim()) {
                return res.status(400).json({ success: false, error: 'roleKey and location are required' });
            }
            // Defense-in-depth: reject overrides for non-location-aware roles
            // even if a stale UI tries to send one. Only IT_OPS is location-split.
            if (!LOCATION_AWARE_ROLES.has(roleKey)) {
                return res.status(400).json({
                    success: false,
                    error: `Role "${roleKey}" is not configured per-location. Only IT Operations supports location-specific overrides.`
                });
            }

            const approverEmail = (req.body.approverEmail || '').trim() || null;
            const approverName = (req.body.approverName || '').trim() || null;
            const secondaryEmail = (req.body.secondaryEmail || '').trim() || null;
            const secondaryName = (req.body.secondaryName || '').trim() || null;
            const isActive = req.body.isActive !== undefined ? Boolean(req.body.isActive) : true;

            const approverUsername = (req.body.approverUsername || '').trim().toLowerCase() || null;
            const secondaryUsername = (req.body.secondaryUsername || '').trim().toLowerCase() || null;

            // Verify the global role exists; we won't accept overrides for
            // unknown roleKeys to keep the data clean.
            const globalCfg = await WorkflowApproverConfig.findOne({ where: { roleKey } });
            if (!globalCfg) {
                return res.status(404).json({ success: false, error: `Unknown roleKey "${roleKey}"` });
            }

            // No useful override content → drop any existing row.
            if (!approverEmail && !approverName && !secondaryEmail && !secondaryName && !approverUsername && !secondaryUsername) {
                const deleted = await WorkflowApproverLocationOverride.destroy({ where: { roleKey, location: location.trim() } });
                // Clearing an override sends this location's in-flight requests back
                // to the global default person — re-point and re-email them.
                const rebound = deleted ? await rebindStageToCurrentRecipient({ roleKey }) : 0;
                return res.json({
                    success: true,
                    message: (deleted
                        ? `Cleared override for "${roleKey}" at "${location}". Will use global default.`
                        : `No override existed for "${roleKey}" at "${location}".`)
                        + (rebound > 0 ? ` ${rebound} in-flight request(s) rebound.` : ''),
                    deleted: !!deleted
                });
            }

            // Guard: one person can only appear in ONE location override per role.
            // Multiple locations for the same person makes routing non-deterministic
            // (resolveHRGroupForEmail / resolveCurrentRecipient return the first DB row,
            // which has no guaranteed order). Check both username and email fields since
            // older rows may lack a username.
            const uniquenessConditions = [];
            if (approverUsername) uniquenessConditions.push({ approverUsername }, { secondaryUsername: approverUsername });
            if (secondaryUsername) uniquenessConditions.push({ approverUsername: secondaryUsername }, { secondaryUsername });
            if (approverEmail) uniquenessConditions.push({ approverEmail }, { secondaryEmail: approverEmail });
            if (secondaryEmail) uniquenessConditions.push({ approverEmail: secondaryEmail }, { secondaryEmail });

            if (uniquenessConditions.length > 0) {
                const conflict = await WorkflowApproverLocationOverride.findOne({
                    where: {
                        roleKey,
                        location: { [Op.ne]: location.trim() },
                        isActive: true,
                        [Op.or]: uniquenessConditions
                    }
                });
                if (conflict) {
                    return res.status(409).json({
                        success: false,
                        error: `This person is already assigned to "${roleKey}" at location "${conflict.location}". ` +
                            `Each person can only be assigned to one location per role — ` +
                            `otherwise request routing becomes non-deterministic.`
                    });
                }
            }

            const fields = { approverEmail, approverName, approverUsername, secondaryEmail, secondaryName, secondaryUsername, isActive, primaryExpiredAt: null };

            const [row, created] = await WorkflowApproverLocationOverride.findOrCreate({
                where: { roleKey, location: location.trim() },
                defaults: fields
            });
            if (!created) {
                await row.update(fields);
            }

            // Re-point + re-email every in-flight request at this location's
            // stage(s) to the newly configured override person.
            const rebound = await rebindStageToCurrentRecipient({ roleKey });

            return res.json({
                success: true,
                message: `${created ? 'Created' : 'Updated'} approver override for "${roleKey}" at "${location}".`
                    + (rebound > 0 ? ` ${rebound} in-flight request(s) rebound.` : ''),
                data: row
            });
        } catch (error) {
            console.error('Error upserting per-location approver:', error);
            return res.status(500).json({ success: false, error: 'Failed to save override', details: error.message });
        }
    }

    /**
     * API: Update a single workflow approver config.
     *
     * For delegation roles (DCI_MANAGER, IT_HOD) the caller may pass
     * delegationType = 'temporary' | 'permanent' (default: 'permanent').
     *
     * temporary  — current primary is snapshotted into previousApprover* so the
     *              original person can still open the portal in read-only mode,
     *              and admin gets a one-click revert button.
     * permanent  — previousApprover* columns are cleared; no revert path kept.
     */
    async updateWorkflowApprover(req, res) {
        try {
            const { id } = req.params;
            const {
                approverEmail, approverName, approverUsername,
                secondaryEmail, secondaryName, secondaryUsername,
                isActive,
                delegationType   // 'temporary' | 'permanent' (delegation roles only)
            } = req.body;

            const config = await WorkflowApproverConfig.findByPk(id);
            if (!config) {
                return res.status(404).json({ success: false, error: 'Approver config not found' });
            }

            const pEmail = approverEmail?.trim() || null;
            const sEmail = secondaryEmail?.trim() || null;
            const pUser = approverUsername?.trim()?.toLowerCase() || null;
            const sUser = secondaryUsername?.trim()?.toLowerCase() || null;

            const isDelegationRole = !!DELEGATION_ROLE_TO_STATUS[config.roleKey];
            const isTemporary = isDelegationRole && delegationType === 'temporary';

            // Snapshot the current primary before overwriting so the original person
            // retains read-only portal access and can be restored in one click.
            const prevEmail = isTemporary ? (config.approverEmail || null) : null;
            const prevName = isTemporary ? (config.approverName || null) : null;
            const prevUser = isTemporary ? (config.approverUsername || null) : null;

            await config.update({
                approverEmail: pEmail,
                approverName: approverName?.trim() || null,
                approverUsername: pUser,
                secondaryEmail: sEmail,
                secondaryName: secondaryName?.trim() || null,
                secondaryUsername: sUser,
                isActive: isActive !== undefined ? Boolean(isActive) : config.isActive,
                primaryExpiredAt: null,
                lastAssignedAt: null,
                isDelegatedTemporarily: isTemporary,
                previousApproverEmail: prevEmail,
                previousApproverName: prevName,
                previousApproverUsername: prevUser,
            });

            // Immediately rebind every in-flight request (both onboarding AND
            // offboarding) at the corresponding stage so the new delegate's
            // portal canAct flag is correct and the old delegate's action
            // gate is updated. Snapshots delegationEvent for auto-revert
            // (escalationService) so emails the delegate hasn't acted on
            // within DELEGATE_TIMEOUT_HOURS re-route back to the original.
            const pendingStatus = DELEGATION_ROLE_TO_STATUS[config.roleKey];
            const rebound = await rebindInFlightToDelegate({
                pendingStatus,
                prevEmail: prevEmail,
                newEmail: pEmail,
                newUsername: pUser,
                roleLabel: config.label,
                isTemporary,
                isRevert: false
            });

            // Non-delegation stage roles (IT Ops, DCI Team, DCI Implementer) re-point
            // and re-email their in-flight requests too — same outcome as the
            // delegation roles above, just resolved per request via live config.
            const stageRebound = REBIND_STAGE_ROLE_TO_STATUSES[config.roleKey]
                ? await rebindStageToCurrentRecipient({ roleKey: config.roleKey })
                : 0;

            const totalRebound = rebound + stageRebound;
            const msg = totalRebound > 0
                ? `Approver "${config.label}" updated. ${totalRebound} in-flight request(s) rebound to the new person.`
                : `Approver "${config.label}" updated successfully`;
            res.json({ success: true, message: msg, data: config });
        } catch (error) {
            console.error('Error updating approver config:', error);
            res.status(500).json({ success: false, error: 'Failed to update approver config' });
        }
    }

    /**
     * API: Revert a temporary delegation back to the original person.
     * PUT /admin/workflow-approvers/:id/revert
     *
     * Restores previousApprover* → approver*, clears temp state, and
     * immediately rebinds all in-flight requests at the matching status.
     */
    async revertDelegation(req, res) {
        try {
            const { id } = req.params;
            const config = await WorkflowApproverConfig.findByPk(id);
            if (!config) {
                return res.status(404).json({ success: false, error: 'Approver config not found' });
            }
            if (!config.isDelegatedTemporarily) {
                return res.status(400).json({ success: false, error: 'This role is not currently temporarily delegated.' });
            }
            if (!config.previousApproverEmail) {
                return res.status(400).json({ success: false, error: 'No previous approver stored — cannot revert.' });
            }

            const restoredEmail = config.previousApproverEmail;
            const restoredName = config.previousApproverName || null;
            const restoredUser = config.previousApproverUsername || null;

            await config.update({
                approverEmail: restoredEmail,
                approverName: restoredName,
                approverUsername: restoredUser,
                isDelegatedTemporarily: false,
                previousApproverEmail: null,
                previousApproverName: null,
                previousApproverUsername: null,
                primaryExpiredAt: null,
                lastAssignedAt: null,
            });

            const pendingStatus = DELEGATION_ROLE_TO_STATUS[config.roleKey];
            const rebound = await rebindInFlightToDelegate({
                pendingStatus,
                prevEmail: null,
                newEmail: restoredEmail,
                newUsername: restoredUser,
                roleLabel: config.label,
                isTemporary: false,
                isRevert: true
            });

            const msg = rebound > 0
                ? `Delegation reverted. ${config.label} restored to ${restoredEmail}. ${rebound} in-flight request(s) rebound.`
                : `Delegation reverted. ${config.label} restored to ${restoredEmail}.`;
            res.json({ success: true, message: msg, data: config });
        } catch (error) {
            console.error('Error reverting delegation:', error);
            res.status(500).json({ success: false, error: 'Failed to revert delegation' });
        }
    }

    /**
     * API: Assign an HOD to all employees in a specific department
     */
    async assignDepartmentHod(req, res) {
        try {
            const { departmentName, hodId } = req.body;

            if (departmentName === undefined || !hodId) {
                return res.status(400).json({ success: false, error: 'Missing departmentName or hodId' });
            }

            // Verify HOD exists
            const hod = await Employee.findByPk(hodId);
            if (!hod) return res.status(404).json({ success: false, error: `HOD ${hodId} not found` });

            // Handle the "Unassigned Department" case where originalDeptName might be null
            const whereClause = departmentName === null ? { mainDept: null } : { mainDept: departmentName };

            // Perform Bulk Update
            const [updatedRows] = await Employee.update(
                { hodId: hodId },
                { where: whereClause }
            );

            res.json({
                success: true,
                message: `Successfully assigned ${hod.name} as HOD for ${updatedRows} employees in ${departmentName || 'Unassigned Department'}.`
            });

        } catch (error) {
            console.error('Error assigning Department HOD:', error);
            res.status(500).json({ success: false, error: 'Failed to assign HOD to department' });
        }
    }

    /**
     * View: Render Onboarding History & Timeline Panel
     */
    renderOnboardingHistoryPanel(req, res) {
        res.render('pages/admin_onboarding_history', { activeTab: 'history' });
    }

    /**
     * API: Get all onboarding requests with summary info
     */
    async getOnboardingRequests(req, res) {
        try {
            const { page = 1, limit = 15, status, search } = req.query;
            const limitInt = parseInt(limit, 10);
            const pageInt = parseInt(page, 10);
            const offset = (pageInt - 1) * limitInt;

            const whereClause = {};
            if (status) whereClause.status = status;
            if (search) {
                const searchStr = `%${search}%`;
                whereClause[Op.or] = [
                    { employeeId: { [Op.like]: searchStr } },
                    { fullName: { [Op.like]: searchStr } },
                    { department: { [Op.like]: searchStr } }
                ];
            }

            const { count, rows } = await OnboardingRequest.findAndCountAll({
                where: whereClause,
                limit: limitInt,
                offset: offset,
                order: [['createdAt', 'DESC']],
                attributes: ['id', 'employeeId', 'fullName', 'department', 'designation', 'status', 'createdAt', 'hodApprovedAt', 'dciImplementedAt', 'opsCompletedAt']
            });

            res.json({
                success: true,
                data: rows,
                pagination: {
                    total: count,
                    page: pageInt,
                    limit: limitInt,
                    totalPages: Math.ceil(count / limitInt)
                }
            });
        } catch (error) {
            console.error('Error fetching onboarding requests:', error);
            res.status(500).json({ success: false, error: 'Failed to fetch onboarding requests' });
        }
    }

    /**
     * API: Get timeline events for a specific onboarding request
     */
    async getOnboardingTimeline(req, res) {
        try {
            const { id } = req.params;

            const request = await OnboardingRequest.findByPk(id, {
                attributes: ['id', 'employeeId', 'fullName', 'department', 'designation', 'status', 'createdAt', 'hodApprovedAt', 'dciImplementedAt', 'opsCompletedAt']
            });

            if (!request) {
                return res.status(404).json({ success: false, error: 'Onboarding request not found' });
            }

            const events = await TimelineEvent.findAll({
                where: { requestId: id },
                order: [['timestamp', 'ASC']],
                attributes: ['eventId', 'action', 'actorRole', 'details', 'timestamp']
            });

            // Pre-format with the shared formatter so the admin modal can render
            // the same way the user-facing /history page does.
            const timeline = events.map(e => {
                const ev = e.toJSON();
                ev.actionLabel = humanizeAction(ev.action);
                ev.detailsText = humanizeDetails(ev.details);
                ev.detailsHTML = humanizeDetailsHTML(ev.details);
                return ev;
            });

            res.json({
                success: true,
                request: request,
                timeline
            });
        } catch (error) {
            console.error('Error fetching onboarding timeline:', error);
            res.status(500).json({ success: false, error: 'Failed to fetch onboarding timeline' });
        }
    }

    /**
     * View: Render the Offboarding History admin panel — mirrors the
     * onboarding-history panel exactly, using offboarding-specific endpoints.
     */
    renderOffboardingHistoryPanel(req, res) {
        res.render('pages/admin_offboarding_history', { activeTab: 'offboarding-history' });
    }

    /**
     * API: List offboarding requests with optional search + status filter.
     * Mirrors getOnboardingRequests.
     */
    async getOffboardingRequests(req, res) {
        try {
            const { page = 1, limit = 15, status, search } = req.query;
            const limitInt = parseInt(limit, 10);
            const pageInt = parseInt(page, 10);
            const offset = (pageInt - 1) * limitInt;

            const whereClause = {};
            if (status) whereClause.status = status;
            if (search) {
                const searchStr = `%${search}%`;
                whereClause[Op.or] = [
                    { employeeId: { [Op.like]: searchStr } },
                    { fullName: { [Op.like]: searchStr } },
                    { department: { [Op.like]: searchStr } }
                ];
            }

            const { count, rows } = await OffboardingRequest.findAndCountAll({
                where: whereClause,
                limit: limitInt,
                offset,
                order: [['createdAt', 'DESC']],
                attributes: [
                    'id', 'employeeId', 'fullName', 'department', 'designation',
                    'status', 'createdAt', 'initiatedAt', 'managerApprovedAt',
                    'dciImplementerCompletedAt', 'completedAt'
                ]
            });

            res.json({
                success: true,
                data: rows,
                pagination: {
                    total: count,
                    page: pageInt,
                    limit: limitInt,
                    totalPages: Math.ceil(count / limitInt)
                }
            });
        } catch (error) {
            console.error('Error fetching offboarding requests:', error);
            res.status(500).json({ success: false, error: 'Failed to fetch offboarding requests' });
        }
    }

    /**
     * API: Get timeline events for a specific offboarding request.
     * Mirrors getOnboardingTimeline.
     */
    async getOffboardingTimeline(req, res) {
        try {
            const { id } = req.params;
            const request = await OffboardingRequest.findByPk(id, {
                attributes: [
                    'id', 'employeeId', 'fullName', 'department', 'designation',
                    'status', 'createdAt', 'initiatedAt', 'managerApprovedAt',
                    'dciImplementerCompletedAt', 'completedAt',
                    'adRevoked', 'smartXRevoked', 'doorAccessRevoked',
                    'dciImplementerName', 'managerRemarks', 'checklistNotes'
                ]
            });
            if (!request) {
                return res.status(404).json({ success: false, error: 'Offboarding request not found' });
            }

            const events = await TimelineEvent.findAll({
                where: { requestId: id },
                order: [['timestamp', 'ASC']],
                attributes: ['eventId', 'action', 'actorRole', 'details', 'timestamp']
            });
            const timeline = events.map(e => {
                const ev = e.toJSON();
                ev.actionLabel = humanizeAction(ev.action);
                ev.detailsText = humanizeDetails(ev.details);
                ev.detailsHTML = humanizeDetailsHTML(ev.details);
                return ev;
            });

            res.json({ success: true, request, timeline });
        } catch (error) {
            console.error('Error fetching offboarding timeline:', error);
            res.status(500).json({ success: false, error: 'Failed to fetch offboarding timeline' });
        }
    }

    /**
     * View: Render System Configuration Admin Panel
     */
    async renderSystemConfigPanel(req, res) {
        try {
            const configs = await SystemConfig.findAll();
            const configMap = {};
            configs.forEach(c => {
                let v = c.value;
                // Defensive: if older data was double-stringified, parse again
                if (typeof v === 'string') {
                    try { v = JSON.parse(v); } catch { /* leave as-is */ }
                }
                configMap[c.key] = v;
            });
            res.render('pages/admin_system_config', { activeTab: 'config', configs: configMap });
        } catch (error) {
            console.error('Error rendering system config panel:', error);
            res.render('pages/admin_system_config', { activeTab: 'config', configs: {} });
        }
    }

    /**
     * API: Re-send the action email for the current stage of a request.
     * Useful when the original recipient deleted or lost the email.
     * Reuses the existing currentStageToken — no new token is issued.
     */
    // GET /admin/onboarding/:id/resend-preview
    // Returns who the resend would go to (the live configured approver), so the
    // History UI can show a confirmation before actually sending. No side effects.
    async resendStagePreview(req, res) {
        try {
            const { id } = req.params;
            const request = await OnboardingRequest.findByPk(id);
            if (!request) return res.status(404).json({ success: false, error: 'Request not found' });
            if (!request.currentStageToken) {
                return res.status(400).json({ success: false, error: `Request is in a closed state (${request.status}); no active stage to resend.` });
            }
            const map = STATUS_TO_RESEND[request.status];
            if (!map) return res.status(400).json({ success: false, error: `No resend handler for status "${request.status}"` });

            const recipient = await resolveResendRecipient(request.status, map.roleKey, { location: request.location, employeeId: request.employeeId });
            if (!recipient.email) {
                return res.status(400).json({ success: false, error: `No approver is configured for this stage (${request.status}). Set one in Workflow Approvers first.` });
            }
            return res.json({ success: true, role: recipient.role, name: recipient.name, email: recipient.email });
        } catch (error) {
            console.error('Error previewing resend recipient:', error);
            return res.status(500).json({ success: false, error: 'Failed to resolve recipient', details: error.message });
        }
    }

    async resendStageEmail(req, res) {
        try {
            const { id } = req.params;
            const request = await OnboardingRequest.findByPk(id);
            if (!request) return res.status(404).json({ success: false, error: 'Request not found' });

            if (!request.currentStageToken) {
                return res.status(400).json({ success: false, error: `Request is in a closed state (${request.status}); no active token to resend.` });
            }

            const map = STATUS_TO_RESEND[request.status];
            if (!map) return res.status(400).json({ success: false, error: `No resend handler for status "${request.status}"` });

            // Resolve the person currently responsible for this stage (primary or
            // secondary, location-aware). No admin-typed override — the configured
            // approver is the single source of truth.
            const recipient = await resolveResendRecipient(request.status, map.roleKey, { location: request.location, employeeId: request.employeeId });
            if (!recipient.email) {
                return res.status(400).json({ success: false, error: `No approver is configured for this stage (${request.status}). Set one in Workflow Approvers first.` });
            }

            // Re-point the request to that person so the portal queue (canAct) and
            // the POST action gate match who actually receives the email.
            await request.update({
                currentStageAssigneeEmail:    recipient.email,
                currentStageAssigneeUsername: recipient.username || null
            });

            const portalSlug = EMAIL_TYPE_TO_PORTAL_SLUG[map.type];
            const actionLink = portalSlug
                ? `${process.env.APP_URL}/portal/${portalSlug}/enter?action=${request.currentStageToken}`
                : `${process.env.APP_URL}/api/onboarding/handle?token=${request.currentStageToken}`;
            await emailService.sendOnboardingNotification(recipient.email, request, actionLink, map.type);

            await TimelineEvent.create({
                requestId: request.id,
                action: 'Email Regenerated',
                actorRole: 'Admin',
                details: `Action email re-sent to ${recipient.email} (${recipient.role}) for stage ${request.status}; stage assignee refreshed. Existing token reused.`,
                timestamp: new Date()
            });

            const who = recipient.name ? `${recipient.name} (${recipient.email})` : recipient.email;
            return res.json({ success: true, message: `Action email re-sent to ${who}` });
        } catch (error) {
            console.error('Error resending stage email:', error);
            return res.status(500).json({ success: false, error: 'Failed to resend stage email', details: error.message });
        }
    }

    /**
     * API: Resend the active stage email for an OFFBOARDING request.
     * Mirrors resendStageEmail but targets OffboardingRequest + the
     * offboarding email types. Reuses the existing currentStageToken so
     * any prior link is still valid. Recipient is always the configured
     * approver (no admin override); the request is re-pointed to them.
     *
     * POST /admin/offboarding/:id/resend-email
     */

    // GET /admin/offboarding/:id/resend-preview — see resendStagePreview.
    async resendOffboardingStagePreview(req, res) {
        try {
            const { id } = req.params;
            const request = await OffboardingRequest.findByPk(id);
            if (!request) return res.status(404).json({ success: false, error: 'Offboarding request not found' });
            if (!request.currentStageToken) {
                return res.status(400).json({ success: false, error: `Request is in a closed state (${request.status}); no active stage to resend.` });
            }
            const map = OFFBOARDING_STAGE_MAP[request.status];
            if (!map) return res.status(400).json({ success: false, error: `No resend handler for status "${request.status}"` });

            const recipient = await resolveResendRecipient(request.status, map.roleKey, { location: request.location, employeeId: request.employeeId });
            if (!recipient.email) {
                return res.status(400).json({ success: false, error: `No approver is configured for this stage (${request.status}). Set one in Workflow Approvers first.` });
            }
            return res.json({ success: true, role: recipient.role, name: recipient.name, email: recipient.email });
        } catch (error) {
            console.error('Error previewing offboarding resend recipient:', error);
            return res.status(500).json({ success: false, error: 'Failed to resolve recipient', details: error.message });
        }
    }

    async resendOffboardingStageEmail(req, res) {
        try {
            const { id } = req.params;
            const request = await OffboardingRequest.findByPk(id);
            if (!request) return res.status(404).json({ success: false, error: 'Offboarding request not found' });

            if (!request.currentStageToken) {
                return res.status(400).json({
                    success: false,
                    error: `Request is in a closed state (${request.status}); no active token to resend.`
                });
            }

            const map = OFFBOARDING_STAGE_MAP[request.status];
            if (!map) return res.status(400).json({ success: false, error: `No resend handler for status "${request.status}"` });

            // Resolve the person currently responsible for this stage (primary or
            // secondary). No admin-typed override.
            const recipient = await resolveResendRecipient(request.status, map.roleKey, { location: request.location, employeeId: request.employeeId });
            if (!recipient.email) {
                return res.status(400).json({ success: false, error: `No approver is configured for this stage (${request.status}). Set one in Workflow Approvers first.` });
            }

            // Re-point so the portal queue + POST guard match who receives the email.
            await request.update({
                currentStageAssigneeEmail:    recipient.email,
                currentStageAssigneeUsername: recipient.username || null
            });

            const actionLink = `${process.env.APP_URL}/api/offboarding/handle?token=${request.currentStageToken}`;
            await emailService.sendOffboardingNotification(recipient.email, request, actionLink, map.type);

            await TimelineEvent.create({
                requestId: request.id,
                action: 'Email Regenerated',
                actorRole: 'Admin',
                details: `Offboarding action email re-sent to ${recipient.email} (${recipient.role}) for stage ${request.status}; stage assignee refreshed. Existing token reused.`,
                timestamp: new Date()
            });

            const who = recipient.name ? `${recipient.name} (${recipient.email})` : recipient.email;
            return res.json({ success: true, message: `Action email re-sent to ${who}` });
        } catch (error) {
            console.error('Error resending offboarding stage email:', error);
            return res.status(500).json({ success: false, error: 'Failed to resend stage email', details: error.message });
        }
    }

    /**
     * API: Update system configuration
     */
    async updateSystemConfig(req, res) {
        try {
            const { key, value } = req.body;
            if (!key) return res.status(400).json({ success: false, error: 'Missing key' });

            const [config] = await SystemConfig.findOrCreate({
                where: { key },
                defaults: { value: {} }
            });

            await config.update({ value });
            res.json({ success: true, message: `${key} updated successfully` });
        } catch (error) {
            console.error('Error updating system config:', error);
            res.status(500).json({ success: false, error: 'Failed to update config' });
        }
    }

    renderEmployeeJourneyPanel(req, res) {
        res.render('pages/admin_employee_journey');
    }

    /**
     * API: Admin-only hard termination of an onboarding request.
     * Soft-deletes the record (status → AdminDeleted), voids the live token so
     * all outstanding action links go dead immediately, records an audit event,
     * and sends a deletion notice to every party that has been involved.
     */
    async adminDeleteRequest(req, res) {
        try {
            const { id } = req.params;
            const reason = (req.body && req.body.reason) ? String(req.body.reason).trim() : '';

            if (!reason) {
                return res.status(400).json({ success: false, error: 'A deletion reason is required.' });
            }

            const request = await OnboardingRequest.findByPk(id);
            if (!request) {
                return res.status(404).json({ success: false, error: 'Onboarding request not found.' });
            }
            if (request.status === 'AdminDeleted') {
                return res.status(409).json({ success: false, error: 'This request has already been deleted.' });
            }

            const deletedBy = req.user && (req.user.displayName || req.user.username || 'Admin');
            const priorStatus = request.status;

            // Collect involved emails BEFORE marking deleted (while assignee fields are still set)
            const notifyEmails = await collectNotifyEmails(request);

            // Soft-delete: invalidate all active links + mark status
            await request.update({
                status: 'AdminDeleted',
                currentStageToken: null,
                currentStageAssigneeEmail: null,
                currentStageAssigneeUsername: null,
            });

            await TimelineEvent.create({
                requestId: request.id,
                action: 'Admin Deleted',
                actorRole: 'Admin',
                details: JSON.stringify({ deletedBy, priorStatus, reason, notifiedEmails: notifyEmails }),
                timestamp: new Date()
            });

            // Notify all involved parties — non-blocking; log failures but don't abort
            const emailsSent = [];
            const emailsFailed = [];
            for (const email of notifyEmails) {
                try {
                    await emailService.sendDeletionNotification(email, request, { deletedBy, reason, priorStatus });
                    emailsSent.push(email);
                } catch (err) {
                    console.error(`[Admin Delete] Notification failed for ${email}:`, err.message);
                    emailsFailed.push(email);
                }
            }

            return res.json({
                success: true,
                message: `Request #${id} has been deleted. ${emailsSent.length} notification(s) sent.`,
                emailsSent,
                emailsFailed,
            });
        } catch (err) {
            console.error('[Admin Delete] Error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    async whoamiAdmin(req, res) {
        // adminApiGuard already gated this — if we got here, the user IS admin.
        res.json({
            success:  true,
            isAdmin:  true,
            username: (req.user && req.user.username) || null,
            email:    (req.user && req.user.email)    || null,
        });
    }

}

export default new AdminController();
