import Employee from '../models/Employee.js';
import SyncLog from '../models/SyncLog.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';
import WorkflowApproverLocationOverride from '../models/WorkflowApproverLocationOverride.js';
import SystemConfig from '../models/SystemConfig.js';
import OnboardingRequest from '../models/OnboardingRequest.js';
import TimelineEvent from '../models/TimelineEvent.js';
import oracleSyncService from '../services/oracleSyncService.js';
import { Op } from 'sequelize';
import sequelize from '../config/database.js';
import { LOCATION_GROUPS } from '../utils/locationGroups.js';
import cronService from '../services/cronService.js';
import * as emailService from '../services/emailService.js';
import RecipientService from '../services/recipientService.js';
import { humanizeAction, humanizeDetails, humanizeDetailsHTML } from '../utils/historyFormatter.js';

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

// Per client policy, only the IT Operations role is split by location.
// All other roles use the global default everywhere. The admin UI hides
// non-location-aware roles from the per-location editor.
const LOCATION_AWARE_ROLES = new Set(['IT_OPS', 'HR_INITIATOR']);

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
            if (employee.hodId) {
                const hod = await Employee.findByPk(employee.hodId, { attributes: ['name'] });
                if (hod) hodName = hod.name;
            }

            // Return full data
            res.json({ success: true, data: { ...employee.toJSON(), hodName } });
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
            const locations      = LOCATION_GROUPS.map(g => g.key);
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
                data:   LOCATION_GROUPS.map(g => g.key),
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
                    id:               g.id,
                    roleKey:          g.roleKey,
                    label:            g.label,
                    description:      g.description,
                    workflowStage:    g.workflowStage,
                    approverEmail:    g.approverEmail,
                    approverName:     g.approverName,
                    secondaryEmail:   g.secondaryEmail,
                    secondaryName:    g.secondaryName,
                    primaryExpiredAt: g.primaryExpiredAt,
                    isActive:         g.isActive,
                    isOverride:       false,
                    overrideId:       null,
                    location:         null
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
                        roleKey:          g.roleKey,
                        label:            g.label,
                        description:      g.description,
                        workflowStage:    g.workflowStage,
                        approverEmail:    o.approverEmail,
                        approverName:     o.approverName,
                        secondaryEmail:   o.secondaryEmail,
                        secondaryName:    o.secondaryName,
                        primaryExpiredAt: o.primaryExpiredAt,
                        isActive:         o.isActive,
                        isOverride:       true,
                        overrideId:       o.id,
                        location
                    };
                }
                return {
                    roleKey:          g.roleKey,
                    label:            g.label,
                    description:      g.description,
                    workflowStage:    g.workflowStage,
                    // Show the global value as a "ghost" so admins know what would be used.
                    approverEmail:    g.approverEmail,
                    approverName:     g.approverName,
                    secondaryEmail:   g.secondaryEmail,
                    secondaryName:    g.secondaryName,
                    primaryExpiredAt: null,
                    isActive:         g.isActive,
                    isOverride:       false,
                    overrideId:       null,
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

            const approverEmail  = (req.body.approverEmail  || '').trim() || null;
            const approverName   = (req.body.approverName   || '').trim() || null;
            const secondaryEmail = (req.body.secondaryEmail || '').trim() || null;
            const secondaryName  = (req.body.secondaryName  || '').trim() || null;
            const isActive       = req.body.isActive !== undefined ? Boolean(req.body.isActive) : true;

            // Verify the global role exists; we won't accept overrides for
            // unknown roleKeys to keep the data clean.
            const globalCfg = await WorkflowApproverConfig.findOne({ where: { roleKey } });
            if (!globalCfg) {
                return res.status(404).json({ success: false, error: `Unknown roleKey "${roleKey}"` });
            }

            // No useful override content → drop any existing row.
            if (!approverEmail && !approverName && !secondaryEmail && !secondaryName) {
                const deleted = await WorkflowApproverLocationOverride.destroy({ where: { roleKey, location: location.trim() } });
                return res.json({
                    success: true,
                    message: deleted
                        ? `Cleared override for "${roleKey}" at "${location}". Will use global default.`
                        : `No override existed for "${roleKey}" at "${location}".`,
                    deleted: !!deleted
                });
            }

            const [row, created] = await WorkflowApproverLocationOverride.findOrCreate({
                where: { roleKey, location: location.trim() },
                defaults: { approverEmail, approverName, secondaryEmail, secondaryName, isActive }
            });
            if (!created) {
                await row.update({ approverEmail, approverName, secondaryEmail, secondaryName, isActive });
            }

            return res.json({
                success: true,
                message: `${created ? 'Created' : 'Updated'} approver override for "${roleKey}" at "${location}".`,
                data: row
            });
        } catch (error) {
            console.error('Error upserting per-location approver:', error);
            return res.status(500).json({ success: false, error: 'Failed to save override', details: error.message });
        }
    }

    /**
     * API: Update a single workflow approver config
     */
    async updateWorkflowApprover(req, res) {
        try {
            const { id } = req.params;
            const { approverEmail, approverName, secondaryEmail, secondaryName, isActive } = req.body;

            const config = await WorkflowApproverConfig.findByPk(id);
            if (!config) {
                return res.status(404).json({ success: false, error: 'Approver config not found' });
            }

            await config.update({
                approverEmail:  approverEmail?.trim()  || null,
                approverName:   approverName?.trim()   || null,
                secondaryEmail: secondaryEmail?.trim() || null,
                secondaryName:  secondaryName?.trim()  || null,
                isActive:       isActive !== undefined ? Boolean(isActive) : config.isActive
            });

            res.json({ success: true, message: `Approver "${config.label}" updated successfully`, data: config });
        } catch (error) {
            console.error('Error updating approver config:', error);
            res.status(500).json({ success: false, error: 'Failed to update approver config' });
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
    async resendStageEmail(req, res) {
        try {
            const { id } = req.params;
            const overrideEmail = (req.body && req.body.toEmail) ? String(req.body.toEmail).trim() : null;

            const request = await OnboardingRequest.findByPk(id);
            if (!request) return res.status(404).json({ success: false, error: 'Request not found' });

            if (!request.currentStageToken) {
                return res.status(400).json({ success: false, error: `Request is in a closed state (${request.status}); no active token to resend.` });
            }

            const map = STATUS_TO_RESEND[request.status];
            if (!map) return res.status(400).json({ success: false, error: `No resend handler for status "${request.status}"` });

            const recipientEmail =
                overrideEmail ||
                await RecipientService.get(map.roleKey, { employeeId: request.employeeId });

            if (!recipientEmail) {
                return res.status(400).json({ success: false, error: `No recipient email could be resolved for role ${map.roleKey}` });
            }

            const actionLink = `${process.env.APP_URL}/api/onboarding/handle?token=${request.currentStageToken}`;
            await emailService.sendOnboardingNotification(recipientEmail, request, actionLink, map.type);

            await TimelineEvent.create({
                requestId: request.id,
                action: 'Email Regenerated',
                actorRole: 'Admin',
                details: `Action email re-sent to ${recipientEmail} for stage ${request.status} using existing token.`,
                timestamp: new Date()
            });

            return res.json({ success: true, message: `Action email re-sent to ${recipientEmail}` });
        } catch (error) {
            console.error('Error resending stage email:', error);
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

}

export default new AdminController();
