import Employee from '../models/Employee.js';
import SyncLog from '../models/SyncLog.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';
import SystemConfig from '../models/SystemConfig.js';
import OnboardingRequest from '../models/OnboardingRequest.js';
import TimelineEvent from '../models/TimelineEvent.js';
import oracleSyncService from '../services/oracleSyncService.js';
import { Op } from 'sequelize';
import sequelize from '../config/database.js';
import cronService from '../services/cronService.js';

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
                attributes: ['employeeId', 'name', 'designation', 'mainDept', 'hodId', 'email']
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
     */
    async renderWorkflowApproversPanel(req, res) {
        try {
            const approvers = await WorkflowApproverConfig.findAll({ order: [['id', 'ASC']] });
            res.render('pages/admin_workflow_approvers', { activeTab: 'approvers', approvers });
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

            res.json({
                success: true,
                request: request,
                timeline: events
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
