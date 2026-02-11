import HRMSService from '../services/hrmsService.js';

export const getEmployee = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ error: 'Employee ID is required' });
        }

        const employee = await HRMSService.getEmployee(id);

        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        res.json(employee);
    } catch (error) {
        console.error('HRMS Controller Error:', error);
        res.status(500).json({ error: 'Failed to fetch employee data' });
    }
};
