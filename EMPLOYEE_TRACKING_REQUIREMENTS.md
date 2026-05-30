# Employee & Request Tracking Enhancement - Requirements Document

**Date:** May 30, 2026
**Status:** 📋 Planning Phase
**Priority:** High - Next major feature after SSO resolution

---

## Executive Summary

Transform the IFL Workflow application from a request-based system to an **employee-centric journey tracking system** with visual workflow representation.

**Core Concept:** Track everything by Employee Number, visualize complete employee lifecycle, connect all request types under a unified journey view.

---

## Current Status

### ✅ Completed
- Authentication & SSO (Kerberos, SPNs configured)
- Onboarding Module (full workflow)
- Onboarding History (basic list/table view)

### ⏳ Pending
- Employee-centric tracking system
- Visual journey representation
- Cross-request linkage
- Request relationship management

---

## Objective

Build a **visual Employee-based tracking system** that:
1. Uses **Employee Number** as the master key
2. Shows **complete employee journey visually** (not tables!)
3. Connects all request types under one employee view
4. Supports future request types (offboarding, change requests, internet access, etc.)

---

## 1. Employee as Core Entity

### Requirements
- **Employee Number** is the primary identifier
- Every request MUST link to an employee
- System shows **full history of all requests per employee**
- Support employee search by:
  - Employee Number
  - Name
  - Department
  - Location

### Data Model Changes
```javascript
// Employee entity (may need new table or extend existing)
{
  employeeNumber: "12345",
  name: "John Doe",
  department: "IT",
  location: "Head Office",
  email: "john.doe@ifl.com.pk",
  adAccount: "johndoe", // created by onboarding
  adCreatedAt: "2026-05-15",
  status: "Active" | "Offboarded" | "Suspended",
  requests: [/* all related requests */]
}
```

---

## 2. Improve Existing Onboarding History

### Current State
- Onboarding history exists in database
- Displayed as plain list/table
- Shows basic steps

### Enhancement Required

**Replace with visual step-by-step workflow:**

#### Visual Elements
- **Timeline view** or **Node-based graph**
- Each step is a visual node
- Lines connecting steps in sequence
- Color-coded status indicators

#### Steps to Show
1. Request Created
2. IT Ops Review
3. DCI Approval
4. HR Approval
5. AD Account Creation
6. Email Sent
7. Portal Access Configured
8. File Server Access
9. Printer Access
10. Completion

#### Visual Representation
```
[Request Created] → [IT Ops Review] → [DCI Approved] → [HR Approved]
                                          ↓
[Completed] ← [Portal Access] ← [Email Sent] ← [AD Created]
```

**Status Colors:**
- Green: Completed ✅
- Yellow: In Progress ⏳
- Red: Failed/Rejected ❌
- Blue: Created/Info ℹ️

---

## 3. Employee Journey Tracking (NEW FEATURE)

### Admin Workflow
When admin clicks an employee → Open **Visual Journey Panel**

### Journey Panel Includes

#### A. Onboarding Trail (already available, enhanced)
- Full onboarding process flow
- All steps connected visually
- Timestamps, approvers, remarks

#### B. Future Request Trails (to support)
1. **Offboarding Trail**
   - Disable AD account
   - Remove access
   - Archive data

2. **Change Request Trail**
   - Department change
   - Location change
   - Access modifications

3. **Internet Request Trail**
   - Internet access request
   - Firewall configuration
   - Approval workflow

4. **Browsing Rights Trail**
   - Specific website access
   - Firewall rules
   - IT approval

---

## 4. Business Logic & Rules

### Rule 1: Onboarding First (CRITICAL)
- Employee MUST be created in Active Directory first
- Until AD account exists:
  - ❌ No internet request allowed
  - ❌ No browsing rights trail visible
  - ❌ Cannot create offboarding request

**Implementation:**
```javascript
// Check before allowing new request
if (requestType === 'internet' || requestType === 'browsing') {
  const employee = await getEmployee(employeeNumber);
  if (!employee.adAccount || !employee.adCreatedAt) {
    throw new Error('Employee must be onboarded before internet/browsing requests');
  }
}
```

### Rule 2: Two Main Tracking Trails

#### Trail A – Employee Lifecycle
- **Onboarding** → Creates AD account, initial setup
- **Setup Changes** → Printer, file server, portal modifications
- **Change Requests** → Department, location, role changes
- **Offboarding** → Disable account, remove access

#### Trail B – Internet / Browsing (AD-dependent)
- **Internet Request** → General internet access
- **Browsing Rights** → Specific website access
- **Firewall Changes** → Related configurations
- **Depends on:** AD account from onboarding

### Rule 3: Request Dependencies
```javascript
// Request relationship structure
{
  requestId: "REQ-123",
  employeeNumber: "12345",
  type: "internet",
  dependsOn: ["REQ-100"], // onboarding request
  relatedTo: ["REQ-125", "REQ-130"], // browsing rights requests
  children: [], // requests created from this one
  parent: "REQ-100"
}
```

---

## 5. Request Relationship Logic

### Relationship Types

1. **Parent-Child**
   - Onboarding (parent) → Change Request (child)
   - Internet Request (parent) → Browsing Rights (child)

2. **Dependencies**
   - Internet Request depends on Onboarding (AD account)
   - Browsing Rights depends on Internet Request

3. **Related Requests**
   - Multiple change requests for same employee
   - Sequential internet access modifications

### Visual Representation
```
Employee #12345 (John Doe)
│
├── [Onboarding] REQ-100 ✅ (2026-01-15)
│   ├── IT Ops Review ✅
│   ├── DCI Approval ✅
│   ├── HR Approval ✅
│   ├── AD Created ✅
│   └── Completed ✅
│
├── [Change Request] REQ-105 ✅ (2026-02-20)
│   └── Department Change: IT → HR ✅
│
├── [Internet Request] REQ-110 ✅ (2026-03-01)
│   ├── Depends on: REQ-100
│   ├── IT Approval ✅
│   ├── Firewall Config ✅
│   └── Completed ✅
│
└── [Browsing Rights] REQ-115 ⏳ (2026-05-30)
    ├── Depends on: REQ-110
    ├── IT Review ⏳
    └── Pending approval
```

---

## 6. UI Requirements (CRITICAL)

### Main Layout

**Three-panel layout:**

```
┌─────────────────────────────────────────────────────────┐
│  Left Panel        │  Main Panel           │  Right Panel│
│  (Employee List)   │  (Journey Graph)      │  (Details)  │
│                    │                       │             │
│  🔍 Search         │  ┌─────────────────┐  │  Request    │
│  📋 Filters        │  │  Employee Node  │  │  Details    │
│                    │  │                 │  │             │
│  Employee #12345   │  │  ┌──────────┐   │  │  Timestamps │
│  ├─ John Doe       │  │  │Onboarding│   │  │  Approvers  │
│  │  IT Dept        │  │  └────┬─────┘   │  │  Remarks    │
│  │  5 requests     │  │       │         │  │             │
│                    │  │  ┌────▼─────┐   │  │  Step       │
│  Employee #12346   │  │  │Internet  │   │  │  History    │
│  └─ Jane Smith     │  │  └──────────┘   │  │             │
│     HR Dept        │  │                 │  │             │
│                    │  └─────────────────┘  │             │
└─────────────────────────────────────────────────────────┘
```

### Visual Representation (DO NOT USE TABLES!)

**Required UI Library:**
- ✅ **React Flow** (recommended) - Interactive node-based graphs
- Alternative: D3.js (if complex custom control needed)

**UI Structure:**
```
Employee = Root Node (center)
    ↓
Requests = Child Nodes (radial or vertical)
    ↓
Steps = Expanded Sub-nodes (on click)
    ↓
Lines connecting everything logically
```

### Example Graph View
```
                    [Employee #12345]
                    John Doe - IT Dept
                           |
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   [Onboarding]       [Internet]         [Change Req]
    REQ-100 ✅         REQ-110 ✅          REQ-105 ✅
        │                  │
    (expand)           (expand)
        │                  │
    ┌───┴───┐          ┌───┴───┐
   IT Ops  DCI        IT Appr Firewall
    ✅      ✅          ✅      ✅
```

---

## 7. Interaction Behavior

### Employee Click
- Open full journey view in main panel
- Show all requests as nodes
- Display summary stats (total requests, pending, completed)

### Request Node Click
- Expand to show request steps
- Highlight in main panel
- Show details in right panel:
  - Request metadata
  - Current status
  - Approver history
  - Remarks/comments
  - Attachments (if any)

### Step Click
- Show detailed step information
- Who approved/rejected
- Timestamp
- Comments
- Email notifications sent

### Visual Expand/Collapse
- Click request node → Expand to show all steps
- Click again → Collapse to summary
- Hover → Show quick tooltip

---

## 8. Backend Changes (Node.js)

### New APIs Required

#### Employee APIs
```javascript
// Get all employees
GET /api/employees
Query: { search, department, location, status }

// Get single employee with full journey
GET /api/employees/:employeeNumber
Response: {
  employee: {...},
  requests: [...],
  journeyGraph: {nodes, edges}
}

// Get employee requests only
GET /api/employees/:employeeNumber/requests
```

#### Request Relationship APIs
```javascript
// Get related requests
GET /api/requests/:requestId/related
Response: {
  parent: {...},
  children: [...],
  dependencies: [...],
  related: [...]
}

// Get request timeline/steps
GET /api/requests/:requestId/timeline
Response: [
  {step, status, timestamp, owner, remarks},
  ...
]
```

#### Journey Graph API (IMPORTANT)
```javascript
// Get employee journey as graph data
GET /api/employees/:employeeNumber/journey-graph
Response: {
  nodes: [
    {id: 'emp-12345', type: 'employee', data: {...}},
    {id: 'req-100', type: 'onboarding', data: {...}},
    {id: 'req-110', type: 'internet', data: {...}},
  ],
  edges: [
    {from: 'emp-12345', to: 'req-100', type: 'owns'},
    {from: 'req-100', to: 'req-110', type: 'depends'},
  ]
}
```

### Event Tracking Enhancement

Each request step should store:
```javascript
{
  requestId: "REQ-100",
  step: "DCI_APPROVAL",
  status: "APPROVED",
  timestamp: "2026-05-15T10:30:00Z",
  owner: "IBRAHIM1_NT\\dciadmin",
  team: "DCI",
  remarks: "Approved for network access",
  emailSent: true,
  duration: 120 // seconds from previous step
}
```

---

## 9. Database Schema Changes

### New Table: EmployeeTracker (Optional)
```sql
CREATE TABLE EmployeeTracker (
  employeeNumber VARCHAR(20) PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(100),
  department VARCHAR(50),
  location VARCHAR(50),
  adAccount VARCHAR(100),
  adCreatedAt DATETIME,
  status VARCHAR(20), -- Active, Offboarded, Suspended
  createdAt DATETIME,
  updatedAt DATETIME
);
```

### Extend OnboardingRequest Table
```sql
ALTER TABLE OnboardingRequest
ADD COLUMN employeeNumber VARCHAR(20),
ADD INDEX idx_employee (employeeNumber);
```

### New Table: RequestRelationships
```sql
CREATE TABLE RequestRelationships (
  id INT PRIMARY KEY AUTO_INCREMENT,
  requestId VARCHAR(50),
  relatedRequestId VARCHAR(50),
  relationshipType VARCHAR(20), -- parent, child, dependency, related
  createdAt DATETIME,
  INDEX idx_request (requestId),
  INDEX idx_related (relatedRequestId)
);
```

### Extend RequestEvents Table
```sql
CREATE TABLE RequestEvents (
  id INT PRIMARY KEY AUTO_INCREMENT,
  requestId VARCHAR(50),
  requestType VARCHAR(20), -- onboarding, internet, browsing, change, offboarding
  step VARCHAR(50),
  status VARCHAR(20),
  timestamp DATETIME,
  owner VARCHAR(100),
  team VARCHAR(50),
  remarks TEXT,
  emailSent BOOLEAN,
  duration INT, -- seconds
  metadata JSON, -- flexible additional data
  INDEX idx_request (requestId),
  INDEX idx_timestamp (timestamp)
);
```

---

## 10. UI Technology Stack

### Recommended: React Flow

**Why React Flow:**
- ✅ Built for React
- ✅ Interactive node-based graphs
- ✅ Drag, zoom, pan out of the box
- ✅ Custom node rendering
- ✅ Auto-layout support
- ✅ Connection lines between nodes
- ✅ Good documentation

**Installation:**
```bash
npm install reactflow
```

**Basic Implementation:**
```jsx
import ReactFlow, { Background, Controls } from 'reactflow';
import 'reactflow/dist/style.css';

function EmployeeJourney({ employeeNumber }) {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);

  useEffect(() => {
    // Fetch journey data
    fetch(`/api/employees/${employeeNumber}/journey-graph`)
      .then(res => res.json())
      .then(data => {
        setNodes(data.nodes);
        setEdges(data.edges);
      });
  }, [employeeNumber]);

  return (
    <ReactFlow nodes={nodes} edges={edges}>
      <Background />
      <Controls />
    </ReactFlow>
  );
}
```

**Custom Node Example:**
```jsx
const RequestNode = ({ data }) => {
  return (
    <div className={`request-node ${data.status}`}>
      <div className="node-header">{data.type}</div>
      <div className="node-id">{data.requestId}</div>
      <div className="node-status">{data.status}</div>
      <div className="node-date">{data.createdAt}</div>
    </div>
  );
};
```

---

## 11. Key UX Goals

### Admin Should Instantly Understand:

✅ **What requests exist for this employee?**
- Visual count and list of all request types

✅ **Has onboarding completed?**
- Green checkmark on onboarding node

✅ **Is AD account created?**
- Show adAccount field, timestamp

✅ **Did internet access start?**
- Show internet request node with status

✅ **What changes were made after onboarding?**
- Change request nodes with details

✅ **What is currently pending?**
- Yellow nodes show in-progress requests

✅ **What is the full journey timeline?**
- Chronological view available
- Timeline slider showing all events

---

## 12. Important Design Principles

### This is a Journey Map, NOT Request Tracking

**Journey Map Characteristics:**
- Visually connected (lines between nodes)
- Easy to follow (logical flow)
- Logically grouped (by type, by time)
- Expandable (click to see details)
- Temporal (timeline view available)
- Employee-centric (everything starts from employee)

**Avoid:**
- ❌ Plain tables
- ❌ Disconnected lists
- ❌ Request-centric views
- ❌ Static displays

**Embrace:**
- ✅ Interactive graphs
- ✅ Visual connections
- ✅ Animated transitions
- ✅ Color-coded status
- ✅ Expandable details

---

## 13. Phased Implementation Plan

### Phase 1: Foundation (Week 1-2)
1. ✅ Improve onboarding history visualization
   - Convert to timeline or graph view
   - Add color-coded status
   - Show all steps visually

2. ✅ Create employee tracking API
   - Employee list endpoint
   - Employee detail with requests
   - Journey graph data endpoint

3. ✅ Build basic React Flow integration
   - Set up library
   - Create employee node
   - Create request nodes
   - Connect with lines

### Phase 2: Employee Journey (Week 3-4)
1. ✅ Implement employee-centric view
   - Left panel: Employee list with search
   - Main panel: Journey graph
   - Right panel: Request details

2. ✅ Add request relationships
   - Database schema for relationships
   - Parent-child linking
   - Dependency tracking

3. ✅ Build request node expansion
   - Click to expand steps
   - Show approval history
   - Display timestamps

### Phase 3: Advanced Features (Week 5-6)
1. ✅ Add timeline view
   - Chronological slider
   - Date range filtering
   - Event markers

2. ✅ Implement search and filters
   - Search by employee number/name
   - Filter by department, location
   - Filter by request type, status

3. ✅ Add analytics dashboard
   - Total employees tracked
   - Requests by type
   - Average completion time
   - Pending requests count

### Phase 4: Future Request Types (Week 7+)
1. ✅ Offboarding workflow
2. ✅ Change request workflow
3. ✅ Internet access workflow
4. ✅ Browsing rights workflow

---

## 14. Success Criteria

### Functional Requirements
- ✅ Click employee → See full journey graph
- ✅ Click request → Expand to show steps
- ✅ Visual status indicators (colors)
- ✅ Request relationships visible (lines)
- ✅ Search and filter working
- ✅ Timeline view functional

### Performance Requirements
- ✅ Load employee journey in < 2 seconds
- ✅ Smooth graph interactions (60 FPS)
- ✅ Handle 1000+ employees
- ✅ Handle 10,000+ requests

### UX Requirements
- ✅ Intuitive navigation
- ✅ No confusing tables
- ✅ Clear visual hierarchy
- ✅ Helpful tooltips
- ✅ Responsive design (works on tablets)

---

## 15. Open Questions / Decisions Needed

### Technical Decisions
- [ ] Use existing OnboardingRequest table or create unified Request table?
- [ ] Store employee data separately or derive from requests?
- [ ] Use Redis for graph data caching?
- [ ] Implement real-time updates (WebSocket)?

### Business Logic
- [ ] Can multiple onboarding requests exist for same employee?
- [ ] How to handle employee number changes?
- [ ] What happens to requests when employee is offboarded?
- [ ] Archive strategy for old requests?

### UI/UX
- [ ] Default layout: Timeline or Graph?
- [ ] Allow admin to customize view?
- [ ] Print/export journey as PDF?
- [ ] Mobile app needed?

---

## 16. Related Files & Documentation

**Current Implementation:**
- `src/controllers/onboardingController.js` - Onboarding logic
- `src/controllers/portalController.js` - Portal dashboards
- `src/models/OnboardingRequest.js` - Current data model
- `src/routes/api.js` - API endpoints

**Will Need to Create:**
- `src/controllers/employeeController.js` - Employee APIs
- `src/controllers/journeyController.js` - Journey graph APIs
- `src/models/Employee.js` - Employee model
- `src/models/RequestRelationship.js` - Relationship model
- `src/services/journeyGraphService.js` - Graph generation logic
- `client/src/components/EmployeeJourney.jsx` - Main journey component
- `client/src/components/RequestNode.jsx` - Request node component

---

## 17. Next Steps (When Ready to Implement)

1. **Review and approve this requirements document**
2. **Create detailed technical design document**
3. **Set up React Flow library**
4. **Design database schema changes**
5. **Create wireframes/mockups**
6. **Start Phase 1 implementation**

---

**Status:** 📋 Requirements documented, awaiting approval to proceed
**Owner:** Development Team
**Last Updated:** May 30, 2026

---

## Appendix: Sample Data Structure

### Employee Journey Graph (JSON)
```json
{
  "employee": {
    "number": "12345",
    "name": "John Doe",
    "department": "IT",
    "location": "Head Office",
    "adAccount": "johndoe",
    "status": "Active"
  },
  "nodes": [
    {
      "id": "emp-12345",
      "type": "employee",
      "position": { "x": 400, "y": 100 },
      "data": {
        "label": "John Doe",
        "employeeNumber": "12345",
        "department": "IT",
        "status": "Active"
      }
    },
    {
      "id": "req-100",
      "type": "onboarding",
      "position": { "x": 200, "y": 300 },
      "data": {
        "requestId": "128793_5",
        "type": "Onboarding",
        "status": "Completed",
        "createdAt": "2026-01-15",
        "completedAt": "2026-01-20"
      }
    },
    {
      "id": "req-110",
      "type": "internet",
      "position": { "x": 600, "y": 300 },
      "data": {
        "requestId": "130001_1",
        "type": "Internet Access",
        "status": "In Progress",
        "createdAt": "2026-03-01",
        "dependsOn": ["req-100"]
      }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": "emp-12345",
      "target": "req-100",
      "type": "smoothstep",
      "label": "owns"
    },
    {
      "id": "e2",
      "source": "emp-12345",
      "target": "req-110",
      "type": "smoothstep",
      "label": "owns"
    },
    {
      "id": "e3",
      "source": "req-100",
      "target": "req-110",
      "type": "smoothstep",
      "label": "enables",
      "style": { "stroke": "#999", "strokeDasharray": "5,5" }
    }
  ]
}
```

---

**End of Requirements Document**
