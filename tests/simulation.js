
import dotenv from 'dotenv';
import sequelize from '../src/config/database.js';
import AccessRequest from '../src/models/AccessRequest.js';
import WorkflowApproval from '../src/models/WorkflowApproval.js';
import TimelineEvent from '../src/models/TimelineEvent.js';
import Employee from '../src/models/Employee.js'; // Import Employee
import * as workflowService from '../src/services/workflowService.js';
import logger from '../src/utils/logger.js';

dotenv.config();

// Mute logger for cleaner output, or keep it
// logger.transports.forEach((t) => (t.silent = true));

const runSimulation = async () => {
    try {
        console.log('--- Starting Workflow Simulation ---');

        // 1. Sync Database (Non-destructive)
        console.log('Syncing database...');
        await sequelize.sync({ alter: true }); // alter: true updates schema if needed

        // 2. Create Dummy Employee
        console.log('Creating Dummy Employee...');
        const emp = await Employee.create({
            name: 'Simulation User',
            email: `sim_user_${Date.now()}@example.com`,
            department: 'IT Test',
            status: 'Active'
        });
        console.log(`Employee Created: ID ${emp.employeeId}`);

        // 3. Create Dummy Request associated with Employee
        console.log('Creating Access Request...');
        const request = await AccessRequest.create({
            employeeId: emp.employeeId,
            requestType: 'SimulationTest',
            justification: 'Testing the simulation flow',
            status: 'Draft'
        });
        console.log(`Access Request Created: ID ${request.requestId}`);

        // 4. Start Workflow
        const managerEmail = process.argv[2] || process.env.SMTP_FROM || 'test@example.com';
        console.log(`Starting Workflow for Manager: ${managerEmail}`);

        await workflowService.startAccessRequestWorkflow(
            request.requestId,
            request.employeeId,
            managerEmail,
            request.justification
        );
        console.log('Workflow started. Email should have been sent.');

        // 5. Retrieve Token from DB
        const approval = await WorkflowApproval.findOne({
            where: { requestId: request.requestId, status: 'Pending' }
        });

        if (!approval) {
            throw new Error('Approval record not found!');
        }
        console.log(`Approval Record Found: Token = ${approval.actionToken}`);

        // 6. Simulate Manager Action (Approve)
        console.log('Simulating "Approve" Click...');
        const result = await workflowService.handleApprovalAction(
            approval.actionToken,
            'Approve',
            'Approved via Simulation Script'
        );
        console.log('Action Result:', result);

        // 7. Verify Final State
        const updatedRequest = await AccessRequest.findByPk(request.requestId);
        console.log(`Final Request Status: ${updatedRequest.status}`);
        console.log(`Final Workflow Stage: ${updatedRequest.workflowStage}`);

        if (updatedRequest.status === 'Approved') {
            console.log('SUCCESS: Workflow completed successfully.');
        } else {
            console.error('FAILURE: Request status mismatch.');
        }

    } catch (err) {
        console.error('Simulation Failed:', err);
    } finally {
        await sequelize.close();
    }
};

runSimulation();
