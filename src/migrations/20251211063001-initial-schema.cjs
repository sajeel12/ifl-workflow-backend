'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id: Sequelize.INTEGER });
     */

    // 1. Employees
    await queryInterface.createTable('Employees', {
      employeeId: {
        type: Sequelize.STRING,
        primaryKey: true,
        allowNull: false
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false
      },
      email: {
        type: Sequelize.STRING,
        allowNull: false
      },
      department: {
        type: Sequelize.STRING,
        allowNull: true
      },
      managerEmail: {
        type: Sequelize.STRING,
        allowNull: true
      },
      status: {
        type: Sequelize.ENUM('Active', 'Inactive', 'Onboarding'),
        defaultValue: 'Onboarding'
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('GETDATE') // MSSQL specific or NOW
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('GETDATE')
      }
    });

    // 2. AccessRequests
    await queryInterface.createTable('AccessRequests', {
      requestId: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      employeeId: {
        type: Sequelize.STRING,
        allowNull: false,
        references: {
          model: 'Employees',
          key: 'employeeId'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      requestType: {
        type: Sequelize.STRING,
        allowNull: false
      },
      justification: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      status: {
        type: Sequelize.ENUM('Pending', 'Approved', 'Rejected'),
        defaultValue: 'Pending'
      },
      workflowStage: {
        type: Sequelize.STRING,
        defaultValue: 'Manager Approval'
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });

    // 3. WorkflowApprovals
    await queryInterface.createTable('WorkflowApprovals', {
      approvalId: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      requestId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'AccessRequests',
          key: 'requestId'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      approverEmail: {
        type: Sequelize.STRING,
        allowNull: false
      },
      status: {
        type: Sequelize.ENUM('Pending', 'Approved', 'Rejected'),
        defaultValue: 'Pending'
      },
      decisionDate: {
        type: Sequelize.DATE,
        allowNull: true
      },
      comment: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      actionToken: {
        type: Sequelize.STRING,
        unique: true,
        allowNull: false
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });

    // 4. TimelineEvents
    await queryInterface.createTable('TimelineEvents', {
      eventId: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      employeeId: {
        type: Sequelize.STRING,
        allowedNull: false,
        references: {
          model: 'Employees',
          key: 'employeeId'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      eventType: {
        type: Sequelize.STRING,
        allowNull: false
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      timestamp: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('GETDATE')
      }
    });
  },

  async down(queryInterface, Sequelize) {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */
    await queryInterface.dropTable('TimelineEvents');
    await queryInterface.dropTable('WorkflowApprovals');
    await queryInterface.dropTable('AccessRequests');
    await queryInterface.dropTable('Employees');
  }
};
