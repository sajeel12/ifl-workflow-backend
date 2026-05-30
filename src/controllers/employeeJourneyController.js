import Employee from '../models/Employee.js';
import OnboardingRequest from '../models/OnboardingRequest.js';
import RequestRelationship from '../models/RequestRelationship.js';
import RequestStageEvent from '../models/RequestStageEvent.js';
import { Op } from 'sequelize';
import { STATUS_LABEL } from '../utils/workflowLabels.js';

/**
 * Employee Journey Controller
 *
 * Provides APIs for employee-centric journey tracking and visualization.
 * Part of Phase 3: Employee Journey Visualization enhancement.
 */

/**
 * GET /api/employees
 * List all employees with optional search/filter
 *
 * Query params:
 * - search: Search by employee number, name, email, department
 * - status: Filter by employee status (Active, Terminated, etc.)
 * - department: Filter by department
 * - location: Filter by location
 * - limit: Results per page (default: 50)
 * - offset: Pagination offset (default: 0)
 */
export async function listEmployees(req, res) {
    try {
        const {
            search = '',
            status = 'Active',
            department = '',
            location = '',
            limit = 50,
            offset = 0
        } = req.query;

        const where = {};

        // Default to Active employees unless explicitly searching for others
        if (status) {
            where.status = status;
        }

        // Search across multiple fields
        if (search) {
            where[Op.or] = [
                { employeeId: { [Op.like]: `%${search}%` } },
                { name: { [Op.like]: `%${search}%` } },
                { email: { [Op.like]: `%${search}%` } },
                { mainDept: { [Op.like]: `%${search}%` } }
            ];
        }

        // Department filter
        if (department) {
            where.mainDept = department;
        }

        // Location filter
        if (location) {
            where.location = location;
        }

        const { count, rows: employees } = await Employee.findAndCountAll({
            where,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['name', 'ASC']],
            attributes: ['employeeId', 'name', 'email', 'mainDept', 'location', 'status', 'joiningDate']
        });

        res.json({
            total: count,
            limit: parseInt(limit),
            offset: parseInt(offset),
            employees
        });

    } catch (error) {
        console.error('[EmployeeJourney] List employees failed:', error);
        res.status(500).json({ error: 'Failed to fetch employees' });
    }
}

/**
 * GET /api/employees/:employeeNumber
 * Get employee details with journey summary
 *
 * Returns:
 * - Employee basic info
 * - Total requests count by type
 * - Recent requests (last 10)
 * - Current pending requests
 */
export async function getEmployeeDetail(req, res) {
    try {
        const { employeeNumber } = req.params;

        // Fetch employee
        const employee = await Employee.findOne({
            where: { employeeId: employeeNumber }
        });

        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        // Fetch all onboarding requests for this employee
        const onboardingRequests = await OnboardingRequest.findAll({
            where: { employeeId: employeeNumber },
            order: [['createdAt', 'DESC']],
            attributes: ['id', 'status', 'createdAt', 'updatedAt', 'approvalStatus', 'location', 'department']
        });

        // Calculate journey summary
        const summary = {
            totalRequests: onboardingRequests.length,
            completedRequests: onboardingRequests.filter(r => r.status === 'Completed').length,
            pendingRequests: onboardingRequests.filter(r => r.status !== 'Completed' && r.status !== 'Draft').length,
            draftRequests: onboardingRequests.filter(r => r.status === 'Draft').length
        };

        // Get recent requests (last 10)
        const recentRequests = onboardingRequests.slice(0, 10).map(req => ({
            id: req.id,
            type: 'onboarding',
            status: req.status,
            statusLabel: STATUS_LABEL[req.status] || req.status,
            createdAt: req.createdAt,
            updatedAt: req.updatedAt,
            approvalStatus: req.approvalStatus,
            location: req.location,
            department: req.department
        }));

        res.json({
            employee: {
                employeeId: employee.employeeId,
                name: employee.name,
                email: employee.email,
                department: employee.mainDept,
                location: employee.location,
                status: employee.status,
                joiningDate: employee.joiningDate,
                hodId: employee.hodId
            },
            summary,
            recentRequests
        });

    } catch (error) {
        console.error('[EmployeeJourney] Get employee detail failed:', error);
        res.status(500).json({ error: 'Failed to fetch employee details' });
    }
}

/**
 * GET /api/employees/:employeeNumber/journey-graph
 * Get employee journey data formatted for D3.js visualization
 *
 * Returns graph structure:
 * {
 *   nodes: [
 *     { id: 'emp_12345', type: 'employee', data: {...} },
 *     { id: 'req_128793', type: 'request', requestType: 'onboarding', data: {...} },
 *     { id: 'stage_128793_1', type: 'stage', data: {...} }
 *   ],
 *   links: [
 *     { source: 'emp_12345', target: 'req_128793', type: 'owns' },
 *     { source: 'req_128793', target: 'stage_128793_1', type: 'hasStage' }
 *   ]
 * }
 */
export async function getEmployeeJourneyGraph(req, res) {
    try {
        const { employeeNumber } = req.params;
        const { expanded = 'false' } = req.query; // Whether to expand all stages

        // Fetch employee
        const employee = await Employee.findOne({
            where: { employeeId: employeeNumber }
        });

        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        // Fetch all requests for this employee
        const requests = await OnboardingRequest.findAll({
            where: { employeeId: employeeNumber },
            order: [['createdAt', 'DESC']]
        });

        // Build graph structure
        const nodes = [];
        const links = [];

        // Add employee as root node
        nodes.push({
            id: `emp_${employeeNumber}`,
            type: 'employee',
            data: {
                employeeId: employee.employeeId,
                name: employee.name,
                email: employee.email,
                department: employee.mainDept,
                location: employee.location,
                status: employee.status
            }
        });

        // Add request nodes and stage nodes
        for (const request of requests) {
            const requestNodeId = `req_${request.id}`;

            // Determine status color
            let statusColor = 'gray';
            if (request.status === 'Completed') statusColor = 'green';
            else if (request.status === 'Draft') statusColor = 'blue';
            else if (request.approvalStatus === 'Rejected') statusColor = 'red';
            else statusColor = 'yellow'; // Pending stages

            // Add request node
            nodes.push({
                id: requestNodeId,
                type: 'request',
                requestType: 'onboarding',
                data: {
                    id: request.id,
                    status: request.status,
                    statusLabel: STATUS_LABEL[request.status] || request.status,
                    statusColor,
                    createdAt: request.createdAt,
                    updatedAt: request.updatedAt,
                    location: request.location,
                    department: request.department,
                    designation: request.designation,
                    approvalStatus: request.approvalStatus
                }
            });

            // Link employee → request
            links.push({
                source: `emp_${employeeNumber}`,
                target: requestNodeId,
                type: 'owns'
            });

            // Add stage nodes if expanded or if this is the most recent request
            const shouldExpand = expanded === 'true' || requests.indexOf(request) === 0;

            if (shouldExpand) {
                const stages = extractStagesFromRequest(request);

                for (let i = 0; i < stages.length; i++) {
                    const stage = stages[i];
                    const stageNodeId = `stage_${request.id}_${i}`;

                    nodes.push({
                        id: stageNodeId,
                        type: 'stage',
                        data: {
                            stage: stage.stage,
                            stageLabel: stage.stageLabel,
                            status: stage.status,
                            timestamp: stage.timestamp,
                            owner: stage.owner,
                            durationHours: stage.durationHours
                        }
                    });

                    // Link request → stage
                    links.push({
                        source: requestNodeId,
                        target: stageNodeId,
                        type: 'hasStage',
                        order: i
                    });

                    // Link stage → next stage (sequential flow)
                    if (i > 0) {
                        links.push({
                            source: `stage_${request.id}_${i - 1}`,
                            target: stageNodeId,
                            type: 'nextStage'
                        });
                    }
                }
            }
        }

        res.json({ nodes, links });

    } catch (error) {
        console.error('[EmployeeJourney] Get journey graph failed:', error);
        res.status(500).json({ error: 'Failed to fetch journey graph' });
    }
}

/**
 * Extract stages from OnboardingRequest timestamp fields
 * (Until we migrate to RequestStageEvents table)
 */
function extractStagesFromRequest(request) {
    const stages = [];

    const stageMapping = [
        { stage: 'Draft', field: 'createdAt', label: STATUS_LABEL.Draft },
        { stage: 'PendingIT', field: 'hrSubmittedAt', label: STATUS_LABEL.PendingIT },
        { stage: 'PendingHOD', field: 'itSubmittedAt', label: STATUS_LABEL.PendingHOD },
        { stage: 'PendingDCI', field: 'hodApprovedAt', label: STATUS_LABEL.PendingDCI },
        { stage: 'PendingDCIManager', field: 'dciSubmittedAt', label: STATUS_LABEL.PendingDCIManager },
        { stage: 'PendingITHOD', field: 'dciManagerDecidedAt', label: STATUS_LABEL.PendingITHOD },
        { stage: 'PendingDCIImplementation', field: 'itHodDecidedAt', label: STATUS_LABEL.PendingDCIImplementation },
        { stage: 'PendingOPSAction', field: 'dciImplementedAt', label: STATUS_LABEL.PendingOPSAction },
        { stage: 'Completed', field: 'opsCompletedAt', label: STATUS_LABEL.Completed }
    ];

    let previousTimestamp = null;

    for (const mapping of stageMapping) {
        const timestamp = request[mapping.field];

        if (timestamp) {
            const durationHours = previousTimestamp
                ? Math.round((new Date(timestamp) - new Date(previousTimestamp)) / (1000 * 60 * 60))
                : null;

            stages.push({
                stage: mapping.stage,
                stageLabel: mapping.label,
                status: request.status === mapping.stage ? 'current' : 'completed',
                timestamp,
                owner: null, // Not tracked in current schema
                durationHours
            });

            previousTimestamp = timestamp;
        }

        // Stop if we've reached the current stage
        if (request.status === mapping.stage) {
            break;
        }
    }

    return stages;
}

/**
 * GET /api/requests/:requestId/related
 * Get related requests (parent, children, dependencies)
 */
export async function getRelatedRequests(req, res) {
    try {
        const { requestId } = req.params;

        // Find all relationships for this request
        const relationships = await RequestRelationship.findAll({
            where: {
                [Op.or]: [
                    { requestId },
                    { relatedRequestId: requestId }
                ]
            }
        });

        const relatedIds = new Set();
        const relationshipMap = {};

        for (const rel of relationships) {
            if (rel.requestId === requestId) {
                relatedIds.add(rel.relatedRequestId);
                relationshipMap[rel.relatedRequestId] = rel.relationshipType;
            } else {
                relatedIds.add(rel.requestId);
                // Inverse relationship
                const inverseType = rel.relationshipType === 'parent' ? 'child' :
                                   rel.relationshipType === 'child' ? 'parent' :
                                   rel.relationshipType;
                relationshipMap[rel.requestId] = inverseType;
            }
        }

        // Fetch related request details
        const relatedRequests = await OnboardingRequest.findAll({
            where: {
                id: Array.from(relatedIds)
            },
            attributes: ['id', 'status', 'employeeId', 'fullName', 'createdAt', 'approvalStatus']
        });

        const result = relatedRequests.map(req => ({
            id: req.id,
            type: 'onboarding',
            status: req.status,
            statusLabel: STATUS_LABEL[req.status] || req.status,
            employeeId: req.employeeId,
            employeeName: req.fullName,
            createdAt: req.createdAt,
            relationshipType: relationshipMap[req.id]
        }));

        res.json({ relatedRequests: result });

    } catch (error) {
        console.error('[EmployeeJourney] Get related requests failed:', error);
        res.status(500).json({ error: 'Failed to fetch related requests' });
    }
}

/**
 * GET /api/requests/:requestId/timeline
 * Get detailed timeline/stage events for a request
 */
export async function getRequestTimeline(req, res) {
    try {
        const { requestId } = req.params;

        // First check if we have RequestStageEvents (new system)
        const events = await RequestStageEvent.findAll({
            where: { requestId },
            order: [['timestamp', 'ASC']]
        });

        if (events.length > 0) {
            // Return events from new system
            return res.json({
                requestId,
                source: 'events',
                timeline: events.map(e => ({
                    stage: e.stage,
                    stageLabel: e.stageLabel,
                    outcome: e.outcome,
                    owner: e.owner,
                    ownerLabel: e.ownerLabel,
                    remarks: e.remarks,
                    emailSent: e.emailSent,
                    durationHours: e.durationHours,
                    timestamp: e.timestamp,
                    metadata: e.metadata
                }))
            });
        }

        // Fallback: Extract from OnboardingRequest timestamp fields
        const request = await OnboardingRequest.findOne({
            where: { id: requestId }
        });

        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        const stages = extractStagesFromRequest(request);

        res.json({
            requestId,
            source: 'legacy',
            timeline: stages
        });

    } catch (error) {
        console.error('[EmployeeJourney] Get request timeline failed:', error);
        res.status(500).json({ error: 'Failed to fetch request timeline' });
    }
}
