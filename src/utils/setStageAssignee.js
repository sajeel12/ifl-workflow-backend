/**
 * Always write currentStageAssigneeEmail and currentStageAssigneeUsername
 * together so they never diverge. Pass null/undefined recipient to clear both.
 *
 * @param {object} request  - Sequelize OnboardingRequest instance
 * @param {object|null} recipient - { email, username } or null to clear
 */
export function assigneeFields(recipient) {
    return {
        currentStageAssigneeEmail:    recipient?.email    ?? null,
        currentStageAssigneeUsername: recipient?.username ?? null,
    };
}
