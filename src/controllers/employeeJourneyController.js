import Employee from '../models/Employee.js';
import OnboardingRequest from '../models/OnboardingRequest.js';
import OffboardingRequest from '../models/OffboardingRequest.js';
import RequestStageEvent from '../models/RequestStageEvent.js';
import { Op } from 'sequelize';
import { STATUS_LABEL } from '../utils/workflowLabels.js';
import { findUserByEmployeeIdViaSidecar, findUserByEmployeeId, findUserByEmail, getFullADProfile, parseADProfile, searchUsersByName } from '../services/adService.js';

const KNOWN_DOMAINS = ['ifl.net', 'igc.com.pk', 'igcpk.com', 'pp.ifl.net', 'lhr.ifl.net'];

function alternateDomainEmails(email) {
    if (!email || !email.includes('@')) return [];
    const [user, domain] = email.toLowerCase().split('@');
    return KNOWN_DOMAINS.filter(d => d !== domain).map(d => `${user}@${d}`);
}

// ── Employee list ──────────────────────────────────────────────────────────────
export async function listEmployees(req, res) {
    try {
        const {
            search = '',
            status = 'Active',
            department = '',
            location = '',
            limit = 25,
            offset = 0
        } = req.query;

        // Require at least a search term OR an explicit filter to avoid dumping the full table
        if (!search && !department && !location) {
            return res.json({ total: 0, limit: parseInt(limit), offset: 0, employees: [], hint: 'search_required' });
        }

        const where = {};
        if (status) where.status = status;
        if (department) where.mainDept = department;
        if (location)   where.location = location;

        if (search) {
            where[Op.or] = [
                { employeeId: { [Op.like]: `%${search}%` } },
                { name:       { [Op.like]: `%${search}%` } },
                { email:      { [Op.like]: `%${search}%` } },
                { mainDept:   { [Op.like]: `%${search}%` } }
            ];
        }

        const { count, rows: employees } = await Employee.findAndCountAll({
            where,
            limit: Math.min(parseInt(limit), 50),
            offset: parseInt(offset),
            order: [['name', 'ASC']],
            attributes: ['employeeId', 'name', 'email', 'mainDept', 'location', 'status', 'joiningDate']
        });

        res.json({ total: count, limit: parseInt(limit), offset: parseInt(offset), employees });
    } catch (error) {
        console.error('[EJ] listEmployees failed:', error);
        res.status(500).json({ error: 'Failed to fetch employees' });
    }
}

// ── Employee detail + all request types ───────────────────────────────────────
export async function getEmployeeDetail(req, res) {
    try {
        const { employeeNumber } = req.params;

        const employee = await Employee.findOne({ where: { employeeId: employeeNumber } });
        if (!employee) return res.status(404).json({ error: 'Employee not found' });

        // Fetch all request types in parallel
        const [onboardingRows, offboardingRows] = await Promise.all([
            OnboardingRequest.findAll({
                where:      { employeeId: employeeNumber },
                order:      [['createdAt', 'DESC']],
                attributes: ['id', 'status', 'createdAt', 'updatedAt', 'approvalStatus', 'location', 'department']
            }),
            OffboardingRequest.findAll({
                where:      { employeeId: employeeNumber },
                order:      [['createdAt', 'DESC']],
                attributes: ['id', 'status', 'createdAt', 'updatedAt']
            })
        ]);

        const onboarding  = onboardingRows.map(r => ({
            id: r.id, type: 'onboarding',
            status: r.status,
            statusLabel: STATUS_LABEL[r.status] || r.status,
            createdAt: r.createdAt, updatedAt: r.updatedAt,
            approvalStatus: r.approvalStatus,
            location: r.location, department: r.department
        }));

        const offboarding = offboardingRows.map(r => ({
            id: r.id, type: 'offboarding',
            status: r.status,
            statusLabel: offboardingLabel(r.status),
            createdAt: r.createdAt, updatedAt: r.updatedAt,
            location: null, department: null
        }));

        // Merge and sort newest first
        const allRequests = [...onboarding, ...offboarding]
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const isTerminal = s => s === 'Completed' || s === 'Rejected';
        const isPending  = s => !isTerminal(s) && s !== 'Draft';

        const summary = {
            totalRequests:     allRequests.length,
            completedRequests: allRequests.filter(r => r.status === 'Completed').length,
            pendingRequests:   allRequests.filter(r => isPending(r.status)).length,
            draftRequests:     allRequests.filter(r => r.status === 'Draft').length
        };

        res.json({
            employee: {
                employeeId: employee.employeeId,
                name:       employee.name,
                email:      employee.email,
                department: employee.mainDept,
                location:   employee.location,
                status:     employee.status,
                joiningDate: employee.joiningDate
            },
            summary,
            recentRequests: allRequests.slice(0, 20)
        });
    } catch (error) {
        console.error('[EJ] getEmployeeDetail failed:', error);
        res.status(500).json({ error: 'Failed to fetch employee details' });
    }
}

// ── Timeline — handles both onboarding and offboarding ────────────────────────
export async function getRequestTimeline(req, res) {
    try {
        const { requestId } = req.params;
        const { type = 'onboarding' } = req.query;

        // Check new event store first (works for any type)
        const events = await RequestStageEvent.findAll({
            where: { requestId },
            order: [['timestamp', 'ASC']]
        });

        if (events.length > 0) {
            return res.json({
                requestId, type, source: 'events',
                timeline: events.map(e => ({
                    stage: e.stage, stageLabel: e.stageLabel,
                    outcome: e.outcome, owner: e.owner, ownerLabel: e.ownerLabel,
                    remarks: e.remarks, emailSent: e.emailSent,
                    durationHours: e.durationHours, timestamp: e.timestamp
                }))
            });
        }

        // Fallback: derive timeline from timestamp fields
        if (type === 'offboarding') {
            const req_ = await OffboardingRequest.findOne({ where: { id: requestId } });
            if (!req_) return res.status(404).json({ error: 'Request not found' });
            return res.json({
                requestId, type, source: 'legacy',
                timeline: extractOffboardingStages(req_)
            });
        }

        // Default: onboarding
        const req_ = await OnboardingRequest.findOne({ where: { id: requestId } });
        if (!req_) return res.status(404).json({ error: 'Request not found' });
        res.json({
            requestId, type, source: 'legacy',
            timeline: extractOnboardingStages(req_)
        });

    } catch (error) {
        console.error('[EJ] getRequestTimeline failed:', error);
        res.status(500).json({ error: 'Failed to fetch request timeline' });
    }
}

// ── 360° AD profile for a single employee ─────────────────────────────────────
export async function getEmployeeAdProfile(req, res) {
    try {
        const { employeeNumber } = req.params;

        const emp = await Employee.findOne({
            where: { employeeId: employeeNumber },
            attributes: ['email', 'name']
        });

        let raw = null;

        // Strategy 1: sidecar employeeID lookup — the most reliable path.
        // Immune to name/email mismatches. Works as long as AD admin ran the bulk
        // Set-ADUser script (465 accounts updated).
        raw = await findUserByEmployeeIdViaSidecar(employeeNumber);

        // Strategy 2: LDAP lookup by employeeID (works when AD_URL is configured)
        if (!raw) raw = await findUserByEmployeeId(employeeNumber);

        // Strategy 3: sidecar email lookup with all domain variants
        // Covers employees whose employeeID wasn't set in AD yet
        if (!raw && emp?.email) {
            const allEmails = [emp.email, ...alternateDomainEmails(emp.email)];
            for (const email of allEmails) {
                raw = await findUserByEmail(email);
                if (raw?.sAMAccountName) break;
            }
        }

        // Strategy 4: name search + username-part matching (last resort)
        if (!raw && emp?.name) {
            const dbUsername = (emp.email || '').toLowerCase().split('@')[0];
            const results    = await searchUsersByName(emp.name.split(' ')[0]);
            const hit = results.find(u =>
                (u.mail || u.email || '').toLowerCase().split('@')[0] === dbUsername
            );
            if (hit) raw = hit;
        }

        if (!raw) return res.json({ found: false, profile: null });

        // Enrich with full profile (account status, groups, timestamps) when available
        const profile = raw.accountStatus
            ? raw
            : (await getFullADProfile(raw.sAMAccountName)) || parseADProfile(raw);

        res.json({ found: true, profile });
    } catch (err) {
        console.error('[EJ] getEmployeeAdProfile failed:', err);
        res.status(500).json({ error: 'Failed to fetch AD profile' });
    }
}

// ── Unused graph endpoints kept for future use ─────────────────────────────────
export async function getEmployeeJourneyGraph(req, res) {
    res.status(501).json({ error: 'Not implemented — use /timeline per request' });
}

export async function getRelatedRequests(req, res) {
    res.status(501).json({ error: 'Not implemented yet' });
}

// ── Stage extraction helpers ───────────────────────────────────────────────────
function extractOnboardingStages(request) {
    const mapping = [
        { stage: 'Draft',                    field: 'createdAt' },
        { stage: 'PendingIT',                field: 'hrSubmittedAt' },
        { stage: 'PendingHOD',               field: 'itSubmittedAt' },
        { stage: 'PendingDCI',               field: 'hodApprovedAt' },
        { stage: 'PendingDCIManager',        field: 'dciSubmittedAt' },
        { stage: 'PendingITHOD',             field: 'dciManagerDecidedAt' },
        { stage: 'PendingDCIImplementation', field: 'itHodDecidedAt' },
        { stage: 'PendingOPSAction',         field: 'dciImplementedAt' },
        { stage: 'Completed',                field: 'opsCompletedAt' }
    ];

    const stages = [];
    let prevTs = null;
    for (const m of mapping) {
        const ts = request[m.field];
        if (!ts) {
            if (request.status === m.stage) {
                stages.push({ stage: m.stage, stageLabel: STATUS_LABEL[m.stage] || m.stage, outcome: 'active', timestamp: null, durationHours: null });
            }
            if (request.status === m.stage) break;
            continue;
        }
        const dur = prevTs ? Math.round((new Date(ts) - new Date(prevTs)) / 3600000) : null;
        stages.push({
            stage: m.stage, stageLabel: STATUS_LABEL[m.stage] || m.stage,
            outcome: request.approvalStatus === 'Rejected' && request.status === m.stage ? 'rejected' : 'completed',
            timestamp: ts, durationHours: dur
        });
        prevTs = ts;
        if (request.status === m.stage) break;
    }
    return stages;
}

function extractOffboardingStages(request) {
    const mapping = [
        { stage: 'Draft',                  field: 'createdAt',          label: 'Initiated' },
        { stage: 'PendingManagerApproval', field: 'initiatedAt',        label: 'Pending Manager Approval' },
        { stage: 'PendingSystemTeam',      field: 'managerApprovedAt',  label: 'Pending System Team' },
        { stage: 'Completed',              field: 'completedAt',        label: 'Completed' }
    ];

    const stages = [];
    let prevTs = null;
    for (const m of mapping) {
        const ts = request[m.field];
        if (!ts) {
            if (request.status === m.stage) {
                stages.push({ stage: m.stage, stageLabel: m.label, outcome: 'active', timestamp: null, durationHours: null });
            }
            if (request.status === m.stage) break;
            continue;
        }
        const dur = prevTs ? Math.round((new Date(ts) - new Date(prevTs)) / 3600000) : null;
        stages.push({
            stage: m.stage, stageLabel: m.label,
            outcome: request.status === 'Rejected' && request.status === m.stage ? 'rejected' : 'completed',
            timestamp: ts, durationHours: dur
        });
        prevTs = ts;
        if (request.status === m.stage) break;
    }
    return stages;
}

function offboardingLabel(status) {
    const map = {
        Draft:                  'Draft',
        PendingManagerApproval: 'Pending Manager Approval',
        PendingSystemTeam:      'Pending System Team',
        Completed:              'Completed',
        Rejected:               'Rejected'
    };
    return map[status] || status;
}
