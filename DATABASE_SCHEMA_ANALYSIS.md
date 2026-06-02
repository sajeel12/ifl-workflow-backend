# Database Schema Analysis & Required Changes

**Date:** May 30, 2026
**Purpose:** Employee Journey Tracking Enhancement
**Current DB:** SQLite (dev) / MSSQL (production)

---

## Current Schema Overview

### ✅ Existing Tables

#### 1. **Employee** (Oracle ERP Sync)
```javascript
// Primary Key: employeeId (e.g., "12345")
{
  employeeId: STRING (PK),          // Employee Number
  personId: STRING,
  name: STRING,
  email: STRING,
  mobile: STRING,
  designation: STRING,
  mainDept: STRING,                 // Department
  orgElementName: STRING,           // Sub-department
  location: STRING,
  joiningDate: STRING,
  hodId: STRING (FK → Employee),    // Manager's employee ID
  managerName: STRING,
  status: STRING,                   // 'Active', 'Terminated', etc.
  // ... many other HR fields
  createdAt: DATE,
  updatedAt: DATE
}
```

**Status:** ✅ Already exists, synced from Oracle ERP
**Use:** Source of truth for employee master data

---

#### 2. **OnboardingRequest** (Workflow Core)
```javascript
// Primary Key: id (auto-increment)
{
  id: INTEGER (PK, auto),

  // Workflow Status
  status: STRING,                    // Draft, PendingIT, PendingHOD, etc.
  currentStageToken: STRING,         // Single-use action token
  currentStageAssigneeEmail: STRING,
  currentStageAssigneeUsername: STRING,

  // Section 1: Employee Info (from HR form)
  employeeId: STRING,                // ⚠️ Employee Number - KEY FIELD!
  fullName: STRING,
  department: STRING,
  subDepartment: STRING,
  designation: STRING,
  joiningDate: DATE,
  hod: STRING,                       // HOD name (text)
  location: STRING,

  // Section 2: Services Requested
  intranetAccess: BOOLEAN,
  internetAccess: BOOLEAN,
  emailIncoming: BOOLEAN,
  emailOutgoing: BOOLEAN,
  laserPrinter: BOOLEAN,
  // ... other service flags

  // Section 3: IT Operations Configuration
  deptSharePath: STRING,
  homeFolderPath: STRING,
  iflPortalLink: STRING,
  sharepointRole: STRING,

  // Section 4: DCI Configuration
  ntUserName: STRING,                // AD account created
  exchangeDisplayName: STRING,
  smtpAddress: STRING,
  memberOf: STRING,
  groupPolicyLevel: STRING,

  // Approval Timestamps
  hrSubmittedAt: DATE,
  itSubmittedAt: DATE,
  hodApprovedAt: DATE,
  dciSubmittedAt: DATE,
  dciManagerDecidedAt: DATE,
  itHodDecidedAt: DATE,
  dciImplementedAt: DATE,
  opsCompletedAt: DATE,

  // Remarks
  hodRemarks: TEXT,
  dciRemarks: TEXT,
  itHodRemarks: TEXT,

  // Implementation
  dciImplementer: STRING,
  dciProofAttachments: JSON (stored as TEXT),
  opsCompletedBy: STRING,
  opsChecklist: JSON (stored as TEXT),

  createdAt: DATE,
  updatedAt: DATE
}
```

**Status:** ✅ Fully implemented, 50+ requests processed
**Issue:** ❌ No index on `employeeId` (performance issue when querying by employee)

---

#### 3. **TimelineEvent** (Event Tracking)
```javascript
{
  eventId: INTEGER (PK, auto),
  requestId: INTEGER,                // FK → OnboardingRequest.id
  action: STRING,                    // 'Submitted', 'Approved', 'Rejected'
  actorRole: STRING,                 // 'HR', 'IT', 'HOD', 'DCI'
  details: TEXT,                     // Remarks
  timestamp: DATE,
  createdAt: DATE,
  updatedAt: DATE
}
```

**Status:** ✅ Exists
**Issue:** ❌ Not currently being used! (Events are tracked via timestamp fields in OnboardingRequest instead)

---

#### 4. **WorkflowApproverConfig** (Role Configuration)
```javascript
{
  id: INTEGER (PK, auto),
  roleKey: STRING (UNIQUE),          // 'IT_OPS', 'DCI', 'HOD', etc.
  roleLabel: STRING,
  defaultAssigneeEmail: STRING,
  // ... config fields
}
```

**Status:** ✅ Active, used for portal routing

---

#### 5. **WorkflowApproverLocationOverride** (Location-based Routing)
```javascript
{
  id: INTEGER (PK, auto),
  roleKey: STRING,
  location: STRING,
  overrideEmail: STRING,
  // ... override config
}
```

**Status:** ✅ Active, handles location-specific approvers

---

### ❌ Missing Tables (Needed for Employee Journey)

#### 1. **RequestRelationship** (NEW - Critical!)
```sql
CREATE TABLE RequestRelationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Request IDs
  requestId VARCHAR(50) NOT NULL,         -- Source request (e.g., "128793_5")
  relatedRequestId VARCHAR(50) NOT NULL,  -- Related request (e.g., "130001_1")

  -- Relationship Type
  relationshipType VARCHAR(20) NOT NULL,  -- 'parent', 'child', 'dependency', 'related'

  -- Metadata
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- Indexes
  INDEX idx_request (requestId),
  INDEX idx_related (relatedRequestId),
  INDEX idx_type (relationshipType)
);
```

**Purpose:** Track relationships between requests
**Examples:**
- Onboarding (parent) → Internet Request (child)
- Internet Request (dependency) → Browsing Rights Request

---

#### 2. **RequestStageEvent** (NEW - Enhanced Event Tracking)
```sql
CREATE TABLE RequestStageEvents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Request Info
  requestId VARCHAR(50) NOT NULL,         -- e.g., "128793_5"
  requestType VARCHAR(20) NOT NULL,       -- 'onboarding', 'internet', 'change', etc.

  -- Stage Info (from workflowLabels.js)
  stage VARCHAR(50) NOT NULL,             -- 'PendingIT', 'PendingHOD', etc.
  stageLabel VARCHAR(100) NOT NULL,       -- 'Pending IT Operations', etc.

  -- Outcome
  outcome VARCHAR(20) NOT NULL,           -- 'completed', 'rejected', 'escalated', 'returned'

  -- Actor Info
  owner VARCHAR(100),                     -- AD username (e.g., 'IBRAHIM1_NT\\itops1')
  ownerLabel VARCHAR(100),                -- Human-readable (e.g., 'IT Operations Team')

  -- Details
  remarks TEXT,                           -- Comments, reasons
  emailSent BOOLEAN DEFAULT false,
  durationHours INTEGER,                  -- Time from previous stage

  -- Metadata (flexible JSON for additional data)
  metadata TEXT,                          -- JSON string

  -- Timestamps
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- Indexes
  INDEX idx_request (requestId),
  INDEX idx_timestamp (timestamp),
  INDEX idx_stage (stage)
);
```

**Purpose:** Granular event tracking for journey visualization
**Replaces:** TimelineEvent (more detailed)

---

## Required Schema Changes

### Change 1: Add Index to OnboardingRequest
```sql
-- Performance optimization for employee lookups
CREATE INDEX idx_onboarding_employee ON OnboardingRequest(employeeId);
```

**Why:** When querying all requests for an employee, this index speeds up lookups from O(n) to O(log n).

---

### Change 2: Add Employee Tracking Fields to Employee Table (Optional)
```sql
-- Add tracking fields to existing Employee table
ALTER TABLE Employee ADD COLUMN adAccount VARCHAR(100);
ALTER TABLE Employee ADD COLUMN adCreatedAt DATETIME;
ALTER TABLE Employee ADD COLUMN onboardingStatus VARCHAR(20);  -- 'NotStarted', 'InProgress', 'Completed'

-- Index for quick AD account lookups
CREATE INDEX idx_employee_ad ON Employee(adAccount);
```

**Why:** Quick lookup to check if employee has AD account (for dependency rules)

**Alternative:** Query OnboardingRequest.ntUserName instead (current approach)

---

### Change 3: Add Request Metadata to OnboardingRequest (Optional Enhancement)
```sql
-- Add metadata for future flexibility
ALTER TABLE OnboardingRequest ADD COLUMN metadata TEXT;  -- JSON string
ALTER TABLE OnboardingRequest ADD COLUMN tags TEXT;      -- Comma-separated tags
```

**Why:** Future-proofing for additional data without schema changes

---

## Current Data Flow Analysis

### How Requests Are Currently Tracked

#### OnboardingRequest Lifecycle:
```
1. HR creates request → status = 'Draft'
2. HR submits → status = 'PendingIT', hrSubmittedAt = NOW
3. IT Ops completes → status = 'PendingHOD', itSubmittedAt = NOW
4. HOD approves → status = 'PendingDCI', hodApprovedAt = NOW
5. DCI configures → status = 'PendingDCIManager', dciSubmittedAt = NOW
6. DCI Manager approves → status = 'PendingDCIImplementation', dciManagerDecidedAt = NOW
   (or routes to IT HOD → status = 'PendingITHOD', then back to Implementation)
7. DCI implements → status = 'PendingOPSAction', dciImplementedAt = NOW
8. IT Ops verifies → status = 'Completed', opsCompletedAt = NOW
```

**Event Tracking Method:** Timestamp fields in OnboardingRequest
**Issue:** ❌ Can't easily query "all events" or "recent activity across all requests"

---

### How Employee Journey Will Work (After Changes)

#### Query Pattern Example:
```javascript
// Get all requests for employee
const requests = await OnboardingRequest.findAll({
  where: { employeeId: '12345' },
  order: [['createdAt', 'ASC']]
});

// Get request relationships
const relationships = await RequestRelationship.findAll({
  where: {
    [Op.or]: [
      { requestId: '128793_5' },
      { relatedRequestId: '128793_5' }
    ]
  }
});

// Get stage events for timeline
const events = await RequestStageEvent.findAll({
  where: { requestId: '128793_5' },
  order: [['timestamp', 'ASC']]
});
```

---

## Migration Strategy

### Phase 1: Create New Tables (No Breaking Changes)
```sql
-- 1. Create RequestRelationships table
CREATE TABLE IF NOT EXISTS RequestRelationships (...);

-- 2. Create RequestStageEvents table
CREATE TABLE IF NOT EXISTS RequestStageEvents (...);

-- 3. Add indexes to OnboardingRequest
CREATE INDEX IF NOT EXISTS idx_onboarding_employee ON OnboardingRequest(employeeId);
```

**Impact:** ✅ Zero impact on existing functionality

---

### Phase 2: Backfill Event Data (Optional)
```javascript
// Extract events from existing OnboardingRequest timestamp fields
async function backfillEvents() {
  const requests = await OnboardingRequest.findAll();

  for (const req of requests) {
    // Extract events from timestamps
    if (req.hrSubmittedAt) {
      await RequestStageEvent.create({
        requestId: `${req.id}`,
        requestType: 'onboarding',
        stage: 'Draft',
        stageLabel: 'Draft',
        outcome: 'completed',
        timestamp: req.hrSubmittedAt
      });
    }

    if (req.itSubmittedAt) {
      await RequestStageEvent.create({
        requestId: `${req.id}`,
        requestType: 'onboarding',
        stage: 'PendingIT',
        stageLabel: 'Pending IT Operations',
        outcome: 'completed',
        timestamp: req.itSubmittedAt,
        owner: req.currentStageAssigneeUsername  // if available
      });
    }

    // ... repeat for all stages
  }
}
```

**Impact:** ✅ Provides historical data for visualization
**Note:** Can be run in background, non-blocking

---

### Phase 3: Start Using Event Tracking
```javascript
// In onboardingController.js, after stage transition:
await RequestStageEvent.create({
  requestId: request.id.toString(),
  requestType: 'onboarding',
  stage: newStatus,
  stageLabel: getStageLabel(newStatus),
  outcome: 'completed',
  owner: req.user.username,
  ownerLabel: getRoleLabel(req.user.role),
  remarks: req.body.remarks || null,
  emailSent: true,
  timestamp: new Date()
});
```

---

## Data Relationships Diagram

```
Employee (Oracle ERP Sync)
    │
    │ employeeId (primary key)
    │
    ├─────── OnboardingRequest ────────┐
    │        (1 employee → many requests)│
    │        employeeId (FK, indexed)   │
    │                                    │
    │                                    ▼
    │                          RequestStageEvent
    │                          (tracks all stage transitions)
    │                          requestId (FK)
    │
    └─────── OnboardingRequest ────────┐
             (can have future           │
              request types)            │
                                        ▼
                               RequestRelationship
                               (parent-child, dependencies)
                               requestId ↔ relatedRequestId
```

---

## Employee Journey Graph Data Structure

### Example JSON Response for Journey API:
```json
{
  "employee": {
    "employeeId": "12345",
    "name": "John Doe",
    "department": "IT",
    "location": "Head Office",
    "adAccount": "johndoe",        // from OnboardingRequest.ntUserName
    "status": "Active"
  },
  "requests": [
    {
      "id": 150,
      "requestId": "128793_5",
      "type": "onboarding",
      "status": "Completed",
      "statusLabel": "Closed",
      "createdAt": "2026-01-15T08:00:00Z",
      "completedAt": "2026-01-20T16:30:00Z",
      "currentStage": "Completed",
      "stages": [
        {
          "stage": "PendingIT",
          "label": "Pending IT Operations",
          "outcome": "completed",
          "timestamp": "2026-01-15T10:30:00Z",
          "owner": "IT Operations Team",
          "durationHours": 2.5
        },
        {
          "stage": "PendingHOD",
          "label": "Pending HOD Approval",
          "outcome": "completed",
          "timestamp": "2026-01-16T14:00:00Z",
          "owner": "Manager Name",
          "remarks": "Approved for network access",
          "durationHours": 27.5
        },
        // ... all 9 stages
      ]
    }
  ],
  "relationships": [
    {
      "from": "128793_5",
      "to": "130001_1",
      "type": "enables",
      "label": "Onboarding completed → Internet request allowed"
    }
  ]
}
```

---

## Summary of Required Changes

### ✅ Immediate Changes (Phase 1 - Foundation)

1. **Create RequestRelationships table**
   - Tracks parent-child, dependencies between requests
   - SQL migration file needed

2. **Create RequestStageEvents table**
   - Enhanced event tracking for visualization
   - Replaces/enhances TimelineEvent

3. **Add index to OnboardingRequest.employeeId**
   - Performance optimization
   - One-line SQL: `CREATE INDEX ...`

### 🔄 Optional Enhancements (Phase 2)

4. **Backfill RequestStageEvents**
   - Extract events from existing timestamp fields
   - Background script, non-blocking

5. **Add tracking fields to Employee table**
   - adAccount, onboardingStatus
   - OR: Query from OnboardingRequest instead

### 📊 No Changes Needed

- ✅ Employee table (already perfect for master data)
- ✅ OnboardingRequest (has all necessary fields)
- ✅ WorkflowApproverConfig (role routing works)

---

## Database Migration Files Needed

### Migration 001: Create New Tables
```javascript
// migrations/001-create-journey-tables.js
export async function up(queryInterface, Sequelize) {
  // Create RequestRelationships
  await queryInterface.createTable('RequestRelationships', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    requestId: { type: Sequelize.STRING(50), allowNull: false },
    relatedRequestId: { type: Sequelize.STRING(50), allowNull: false },
    relationshipType: { type: Sequelize.STRING(20), allowNull: false },
    createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
    updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW }
  });

  await queryInterface.addIndex('RequestRelationships', ['requestId']);
  await queryInterface.addIndex('RequestRelationships', ['relatedRequestId']);

  // Create RequestStageEvents
  await queryInterface.createTable('RequestStageEvents', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    requestId: { type: Sequelize.STRING(50), allowNull: false },
    requestType: { type: Sequelize.STRING(20), allowNull: false },
    stage: { type: Sequelize.STRING(50), allowNull: false },
    stageLabel: { type: Sequelize.STRING(100), allowNull: false },
    outcome: { type: Sequelize.STRING(20), allowNull: false },
    owner: { type: Sequelize.STRING(100) },
    ownerLabel: { type: Sequelize.STRING(100) },
    remarks: { type: Sequelize.TEXT },
    emailSent: { type: Sequelize.BOOLEAN, defaultValue: false },
    durationHours: { type: Sequelize.INTEGER },
    metadata: { type: Sequelize.TEXT },
    timestamp: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
    createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW }
  });

  await queryInterface.addIndex('RequestStageEvents', ['requestId']);
  await queryInterface.addIndex('RequestStageEvents', ['timestamp']);

  // Add index to OnboardingRequest
  await queryInterface.addIndex('OnboardingRequests', ['employeeId']);
}

export async function down(queryInterface, Sequelize) {
  await queryInterface.dropTable('RequestRelationships');
  await queryInterface.dropTable('RequestStageEvents');
  await queryInterface.removeIndex('OnboardingRequests', ['employeeId']);
}
```

---

## Next Steps

1. ✅ **Review this analysis** - Confirm approach is correct
2. ✅ **Create Sequelize models** - RequestRelationship, RequestStageEvent
3. ✅ **Run migrations** - Create tables in SQLite/MSSQL
4. ✅ **Test with existing data** - Query employee requests
5. ✅ **Build API endpoints** - Employee journey graph
6. 🎨 **Proceed to D3.js** - Visualization layer

---

**Status:** 📋 Schema analysis complete, awaiting approval to proceed
**Next:** Create Sequelize models and migration files
