# Employee & Request Tracking Enhancement - Requirements Document

**Date:** May 30, 2026
**Status:** 📋 Planning Phase
**Priority:** High - Next major feature

---

## Executive Summary

Transform the IFL Workflow application from a request-based system to an **employee-centric journey tracking system** with visual workflow representation.

**Core Concept:** Track everything by Employee Number, visualize complete employee lifecycle, connect all request types under a unified journey view.

---

## Current Status

### ✅ Completed
- Authentication & SSO (Kerberos, SPNs configured)
- Onboarding Module (full 9-stage workflow, all portals live)
- Temporary delegation (DCI Manager / IT HOD)
- Onboarding History (basic list/table view in admin)

### ⏳ Pending
- Employee-centric tracking system
- Visual journey representation
- Cross-request linkage
- Future request types (offboarding, internet, browsing, change)

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
  adAccount: "johndoe",          // created during IT Ops stage
  adCreatedAt: "2026-05-15",
  status: "Active" | "Offboarded" | "Suspended",
  requests: [/* all related requests */]
}
```

---

## 2. Onboarding Workflow — Real 9-Stage Flow

### ⚠️ Correct Stage Names (source of truth: `src/utils/workflowLabels.js`)

The onboarding workflow has **9 stages** in this exact order:

| # | Internal Status | User-Facing Label | Owner |
|---|---|---|---|
| 1 | `Draft` | Draft | HR / IT Requestor |
| 2 | `PendingIT` | Pending IT Operations | IT Operations Team |
| 3 | `PendingHOD` | Pending HOD Approval | Head of Department (employee's HOD) |
| 4 | `PendingDCI` | Pending DCI Configuration | DCI Team |
| 5 | `PendingDCIManager` | Pending Manager Approval | DCI Manager |
| 6 | `PendingITHOD` | Pending IT HOD Approval | IT HOD *(conditional path)* |
| 7 | `PendingDCIImplementation` | Pending Implementation | DCI Implementation Team |
| 8 | `PendingOPSAction` | Pending OPS Verification | IT Operations Team |
| 9 | `Completed` | Closed | — |

**Terminal:** `Rejected` (can occur at HOD, DCI Manager, or IT HOD stages)

### Correct Flow Diagram

```
[Draft]
   │ HR / IT Requestor submits form
   ▼
[Pending IT Operations]
   │ IT Ops configures: AD account, email, printers, file shares, intranet
   ▼
[Pending HOD Approval]
   │ Employee's Head of Department reviews and approves
   ├──── Rejected ──► [Rejected / Closed]
   ▼
[Pending DCI Configuration]
   │ DCI Team gathers and submits DCI requirements form
   ▼
[Pending Manager Approval]   ← DCI Manager
   │ DCI Manager reviews DCI form
   ├──── Rejected ──► [Rejected / Closed]
   ├──── Send back to DCI Team ──► [Pending DCI Configuration]
   ├──── Route to IT HOD ──► [Pending IT HOD Approval]
   │                             │ IT HOD approves/rejects
   │                             ├── Rejected ──► [Rejected]
   │                             └──────────────────────────┐
   ▼                                                        │
[Pending Implementation]   ◄──────────────────────────────┘
   │ DCI Implementation Team executes
   ▼
[Pending OPS Verification]
   │ IT Ops does final physical setup at employee's desk
   ▼
[Closed / Completed]
```

### IT Ops Sub-Tasks (within PendingIT stage — NOT separate workflow stages)

These are action items the IT Ops person performs during the `PendingIT` stage. They are recorded in the form but do not create separate DB status rows:

- Create Active Directory account
- Configure email account
- Configure network/intranet access
- Configure printers
- Configure file shares

### Visual Elements for Onboarding Timeline

- **Node-based or timeline view** — each stage is a visual node
- Lines connecting stages in sequence (with branch for IT HOD path)
- Color-coded status per node:
  - ✅ Green: Completed stage
  - ⏳ Yellow: Currently active stage
  - ❌ Red: Rejected
  - ⬜ Grey: Not yet reached

---

## 3. Employee Journey Tracking (NEW FEATURE)

### Admin Workflow
When admin clicks an employee → Open **Visual Journey Panel**

### Journey Panel Includes

#### A. Onboarding Trail (existing, enhanced)
- Full 9-stage process flow as above
- All stages connected visually with branch for IT HOD path
- Timestamps, approvers, remarks at each stage

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
- Employee AD account is created during the `PendingIT` stage
- Until onboarding reaches `Completed`:
  - ❌ No internet request allowed
  - ❌ No browsing rights trail visible
  - ❌ Cannot create offboarding request

```javascript
// Check before allowing new request
if (requestType === 'internet' || requestType === 'browsing') {
  const onboarding = await getLatestOnboarding(employeeNumber);
  if (!onboarding || onboarding.status !== 'Completed') {
    throw new Error('Employee must complete onboarding before internet/browsing requests');
  }
}
```

### Rule 2: Two Main Tracking Trails

#### Trail A – Employee Lifecycle
- **Onboarding** → Creates AD account, IT setup (9 stages above)
- **Change Requests** → Department, location, role changes
- **Offboarding** → Disable account, remove access

#### Trail B – Network / Internet (AD-dependent)
- **Internet Request** → General internet access
- **Browsing Rights** → Specific website access
- **Firewall Changes** → Related configurations
- **Depends on:** Onboarding must be `Completed` first

### Rule 3: Request Dependencies
```javascript
{
  requestId: "REQ-123",
  employeeNumber: "12345",
  type: "internet",
  dependsOn: ["REQ-100"],         // onboarding request
  relatedTo: ["REQ-125"],         // browsing rights
  children: [],
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
   - Internet Request depends on Onboarding (status must be `Completed`)
   - Browsing Rights depends on Internet Request (approved)

3. **Related Requests**
   - Multiple change requests for same employee
   - Sequential internet access modifications

### Visual Representation
```
Employee #12345 (John Doe)
│
├── [Onboarding] REQ-128793_5 ✅ (2026-01-15)
│   ├── Draft ✅
│   ├── Pending IT Operations ✅
│   ├── Pending HOD Approval ✅
│   ├── Pending DCI Configuration ✅
│   ├── Pending Manager Approval ✅
│   ├── Pending Implementation ✅
│   ├── Pending OPS Verification ✅
│   └── Closed ✅
│
├── [Change Request] REQ-105 ✅ (2026-02-20)
│   └── Department Change: IT → HR ✅
│
├── [Internet Request] REQ-110 ✅ (2026-03-01)
│   ├── Depends on: REQ-128793_5 (Onboarding)
│   ├── IT Approval ✅
│   ├── Firewall Config ✅
│   └── Completed ✅
│
└── [Browsing Rights] REQ-115 ⏳ (2026-05-30)
    ├── Depends on: REQ-110 (Internet)
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

**UI Technology Options:**

Since the app is currently **Node.js / Express / EJS** with no React, two approaches:

| Option | Library | Effort | Notes |
|--------|---------|--------|-------|
| A | **React Flow** (recommended for graphs) | High — adds React to the project | Best for interactive node graphs |
| B | **D3.js** (vanilla JS) | Medium | Works inside EJS without React |
| C | **CSS/SVG custom stepper** | Low | Already partially done (9-stage stepper) |

> ⚠️ **Decision needed:** Should we introduce React to the frontend, or build the graph with D3.js / plain SVG inside the existing EJS stack? This affects all UI sections below.

**UI Structure regardless of library:**
```
Employee = Root Node
    ↓
Request Nodes (one per request type)
    ↓
Stage Sub-nodes (expanded on click, 9 stages for onboarding)
    ↓
Lines connecting everything logically
```

---

## 7. Interaction Behavior

### Employee Click
- Open full journey view in main panel
- Show all requests as nodes
- Display summary stats (total requests, pending, completed)

### Request Node Click
- Expand to show request stages (for onboarding: all 9 stages)
- Highlight in main panel
- Show details in right panel:
  - Request metadata
  - Current status
  - Approver history
  - Remarks/comments

### Stage Click
- Show detailed stage information:
  - Who approved/rejected
  - Timestamp
  - Comments
  - Email notifications sent

### Visual Expand/Collapse
- Click request node → Expand to show all stages
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
  journeyGraph: { nodes, edges }
}

// Get employee requests only
GET /api/employees/:employeeNumber/requests
```

#### Request Relationship APIs
```javascript
// Get related requests
GET /api/requests/:requestId/related
Response: { parent, children, dependencies, related }

// Get request timeline/stages
GET /api/requests/:requestId/timeline
Response: [
  { stage, status, timestamp, owner, remarks },
  ...
]
```

#### Journey Graph API
```javascript
// Get employee journey as graph data
GET /api/employees/:employeeNumber/journey-graph
Response: {
  nodes: [
    { id: 'emp-12345', type: 'employee', data: {...} },
    { id: 'req-100',   type: 'onboarding', data: {...} },
    { id: 'req-110',   type: 'internet', data: {...} },
  ],
  edges: [
    { from: 'emp-12345', to: 'req-100', type: 'owns' },
    { from: 'req-100',   to: 'req-110', type: 'enables' },
  ]
}
```

### Event Tracking Enhancement

Each request stage transition should record (using real status names):

```javascript
{
  requestId: "128793_5",
  stage: "PendingIT",                      // internal status key
  stageLabel: "Pending IT Operations",     // from workflowLabels.js
  status: "Completed",                     // completed / rejected / escalated
  timestamp: "2026-05-15T10:30:00Z",
  owner: "IBRAHIM1_NT\\itops1",
  ownerLabel: "IT Operations",
  remarks: "AD account created, email configured",
  emailSent: true,
  durationHours: 4                         // hours from previous stage
}
```

**Valid stage values (use exactly these — from `workflowLabels.js`):**
- `Draft`, `PendingIT`, `PendingHOD`, `PendingDCI`, `PendingDCIManager`,
  `PendingITHOD`, `PendingDCIImplementation`, `PendingOPSAction`, `Completed`, `Rejected`

---

## 9. Database Schema Changes

### New Table: EmployeeTracker (Optional)
```sql
CREATE TABLE EmployeeTracker (
  employeeNumber VARCHAR(20) PRIMARY KEY,
  name           VARCHAR(100),
  email          VARCHAR(100),
  department     VARCHAR(50),
  location       VARCHAR(50),
  adAccount      VARCHAR(100),   -- set when PendingIT stage completes
  adCreatedAt    DATETIME,
  status         VARCHAR(20),    -- Active, Offboarded, Suspended
  createdAt      DATETIME,
  updatedAt      DATETIME
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
  id                INT PRIMARY KEY AUTO_INCREMENT,
  requestId         VARCHAR(50),
  relatedRequestId  VARCHAR(50),
  relationshipType  VARCHAR(20),  -- parent, child, dependency, related
  createdAt         DATETIME,
  INDEX idx_request (requestId),
  INDEX idx_related (relatedRequestId)
);
```

### New Table: RequestStageEvents
```sql
CREATE TABLE RequestStageEvents (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  requestId     VARCHAR(50),
  requestType   VARCHAR(20),     -- onboarding, internet, browsing, change, offboarding
  stage         VARCHAR(50),     -- PendingIT, PendingHOD, etc. (internal status key)
  stageLabel    VARCHAR(100),    -- Pending IT Operations, etc.
  outcome       VARCHAR(20),     -- completed, rejected, escalated, returned
  timestamp     DATETIME,
  owner         VARCHAR(100),
  ownerLabel    VARCHAR(100),
  remarks       TEXT,
  emailSent     BOOLEAN,
  durationHours INT,
  metadata      JSON,
  INDEX idx_request   (requestId),
  INDEX idx_timestamp (timestamp)
);
```

---

## 10. UI Technology Stack Decision

### ⚠️ Key Decision — Frontend Architecture

Current stack: **Node.js + Express + EJS** (server-rendered, no build step, no React).

| Option | Pros | Cons |
|--------|------|------|
| **React Flow** (React) | Best graph UX, interactive drag/zoom | Requires adding React + Vite/webpack build to project |
| **D3.js** | Works in EJS, no build step, powerful | Complex to write, lower-level |
| **SVG/CSS custom** | Zero dependencies, already consistent with app style | Limited interactivity for complex graphs |

**Recommendation:** Use **D3.js** inside EJS pages — keeps the same server-rendered stack while enabling interactive graph visualizations. React Flow is ideal if we later migrate the admin UI to a SPA.

---

## 11. Key UX Goals

### Admin Should Instantly Understand:

✅ **What requests exist for this employee?**
✅ **Has onboarding completed?** (All 9 stages green)
✅ **Is AD account created?** (Completed `PendingIT` stage)
✅ **Did internet access start?** (Internet request node present)
✅ **What changes were made after onboarding?** (Change request nodes)
✅ **What is currently pending?** (Yellow active-stage node)
✅ **What is the full journey timeline?** (Chronological event list)

---

## 12. Important Design Principles

### This is a Journey Map, NOT Request Tracking

**Journey Map Characteristics:**
- Visually connected (lines between nodes/stages)
- Easy to follow the 9-stage onboarding sequence
- Expandable (click request → see all 9 stages)
- Temporal (timeline view showing all events)
- Employee-centric (everything starts from employee node)

**Avoid:**
- ❌ Plain tables
- ❌ Disconnected lists
- ❌ Using wrong stage names (see Section 2 for correct names)
- ❌ Calling the HOD stage "HR Approval" — HR *initiates*, HOD *approves*

---

## 13. Phased Implementation Plan

### Phase 1: Foundation
1. Enhance onboarding history visualization (timeline/graph with correct 9 stages)
2. Create employee tracking API (employee list, detail, journey graph endpoint)
3. Set up chosen graph library (D3.js or React Flow — decision needed)
4. Build basic graph: employee node → request nodes → stage sub-nodes

### Phase 2: Employee Journey
1. Three-panel admin layout (left: employee list, center: graph, right: details)
2. Add request relationships (DB schema + parent-child linking)
3. Stage expansion on click (show approver, timestamp, remarks)

### Phase 3: Advanced Features
1. Timeline view with date range filter
2. Search and filter (by employee, department, location, status)
3. Analytics dashboard (totals, average completion time, pending counts)

### Phase 4: Future Request Types
1. Change request workflow
2. Offboarding workflow
3. Internet access request workflow
4. Browsing rights workflow

---

## 14. Success Criteria

### Functional
- ✅ Click employee → See full journey graph with correct stage names
- ✅ Click request → Expand to show correct stages (9 for onboarding)
- ✅ Visual status indicators (colors per stage)
- ✅ Request dependencies visible (onboarding → internet dependency line)
- ✅ Search and filter working

### Performance
- ✅ Load employee journey < 2 seconds
- ✅ Handle 1000+ employees, 10,000+ requests

### UX
- ✅ Intuitive navigation
- ✅ Clear visual hierarchy
- ✅ Correct stage labels matching what portals already show

---

## 15. Open Questions / Decisions Needed

### Technical
- [ ] **Frontend tech: D3.js vs React Flow?** (React requires adding a build step)
- [ ] Use existing `OnboardingRequest` table or create unified `Request` table?
- [ ] Store employee data separately or derive from requests?
- [ ] Use Redis for graph data caching?

### Business Logic
- [ ] Can multiple onboarding requests exist for same employee? (e.g., re-hire)
- [ ] How to handle employee number changes?
- [ ] What happens to requests when employee is offboarded?
- [ ] Archive strategy for old requests?

### UI/UX
- [ ] Default layout: Timeline view or Graph view first?
- [ ] Allow admin to customize view?
- [ ] Print/export journey as PDF?

---

## 16. Related Files & Documentation

**Current Implementation:**
- `src/controllers/onboardingController.js` — Onboarding workflow logic
- `src/controllers/portalController.js` — Role portals (IT Ops, DCI, HOD, etc.)
- `src/utils/workflowLabels.js` — **Source of truth for all stage names and labels**
- `src/models/OnboardingRequest.js` — Current data model
- `src/services/escalationService.js` — 48h escalation logic

**Will Need to Create:**
- `src/controllers/employeeController.js` — Employee APIs
- `src/controllers/journeyController.js` — Journey graph APIs
- `src/models/Employee.js` — Employee model
- `src/models/RequestRelationship.js` — Relationship model
- `src/services/journeyGraphService.js` — Graph generation logic
- `src/views/pages/admin_employee_journey.ejs` — Journey view page

---

## 17. Next Steps (When Ready to Implement)

1. **Answer the open questions** (especially: D3.js vs React Flow?)
2. **Confirm future request types priority** (change, offboarding, internet, browsing — which first?)
3. **Design database schema changes** (employee table, relationships, events)
4. **Create wireframes/mockups** for the three-panel layout
5. **Start Phase 1 implementation**

---

**Status:** 📋 Requirements documented — stage names corrected, awaiting decision on open questions  
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
      "position": { "x": 400, "y": 50 },
      "data": { "label": "John Doe", "employeeNumber": "12345", "status": "Active" }
    },
    {
      "id": "req-128793",
      "type": "onboarding",
      "position": { "x": 200, "y": 200 },
      "data": {
        "requestId": "128793_5",
        "type": "Onboarding",
        "status": "Completed",
        "statusLabel": "Closed",
        "createdAt": "2026-01-15",
        "completedAt": "2026-01-20",
        "stages": [
          { "stage": "PendingIT",                "label": "Pending IT Operations",   "outcome": "completed" },
          { "stage": "PendingHOD",               "label": "Pending HOD Approval",    "outcome": "completed" },
          { "stage": "PendingDCI",               "label": "Pending DCI Configuration","outcome": "completed" },
          { "stage": "PendingDCIManager",        "label": "Pending Manager Approval","outcome": "completed" },
          { "stage": "PendingDCIImplementation", "label": "Pending Implementation",  "outcome": "completed" },
          { "stage": "PendingOPSAction",         "label": "Pending OPS Verification","outcome": "completed" }
        ]
      }
    },
    {
      "id": "req-130001",
      "type": "internet",
      "position": { "x": 600, "y": 200 },
      "data": {
        "requestId": "130001_1",
        "type": "Internet Access",
        "status": "In Progress",
        "createdAt": "2026-03-01",
        "dependsOn": ["req-128793"]
      }
    }
  ],
  "edges": [
    { "id": "e1", "source": "emp-12345",  "target": "req-128793", "label": "owns" },
    { "id": "e2", "source": "emp-12345",  "target": "req-130001", "label": "owns" },
    { "id": "e3", "source": "req-128793", "target": "req-130001", "label": "enables",
      "style": { "strokeDasharray": "5,5" } }
  ]
}
```

---

**End of Requirements Document**
