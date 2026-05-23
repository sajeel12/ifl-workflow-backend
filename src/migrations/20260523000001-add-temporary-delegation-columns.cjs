'use strict';

/**
 * Add temporary-delegation columns to WorkflowApproverConfigs.
 *
 * isDelegatedTemporarily  — true while a cover is active for DCI_MANAGER / IT_HOD
 * previousApprover*       — snapshot of the original holder so they can:
 *                           (a) view the portal in read-only mode, and
 *                           (b) be restored with a single admin revert action.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('WorkflowApproverConfigs', 'isDelegatedTemporarily', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('WorkflowApproverConfigs', 'previousApproverEmail', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('WorkflowApproverConfigs', 'previousApproverName', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('WorkflowApproverConfigs', 'previousApproverUsername', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('WorkflowApproverConfigs', 'isDelegatedTemporarily');
    await queryInterface.removeColumn('WorkflowApproverConfigs', 'previousApproverEmail');
    await queryInterface.removeColumn('WorkflowApproverConfigs', 'previousApproverName');
    await queryInterface.removeColumn('WorkflowApproverConfigs', 'previousApproverUsername');
  },
};
