
// Mock HRMS Controller
// This will eventually connect to the external HRMS API

export const getEmployee = async (req, res) => {
    try {
        const { id } = req.params;

        // Mock Data for specific IDs or generic for testing
        // In real implementation, this would be: 
        // const response = await fetch(`${process.env.HRMS_API_URL}/employees/${id}`);
        // const data = await response.json();

        // Simulate API delay
        await new Promise(resolve => setTimeout(resolve, 500));

        if (id === 'ERROR') {
            return res.status(404).json({ error: 'Employee not found' });
        }

        const mockEmployee = {
            id: id,
            fullName: 'Test Employee Name',
            designation: 'Senior Software Engineer',
            department: 'Information Technology',
            projectUnit: 'Head Office', // Assuming 'Project / Unit' field
            joiningDate: '2023-01-15',
            mobile: '0300-1234567',
            officeExtension: '1234'
        };

        // Specific mock for testing
        if (id === '1001') {
            mockEmployee.fullName = 'Ahmed Ali';
            mockEmployee.designation = 'Assistant Manager';
            mockEmployee.department = 'Finance';
        }

        res.json(mockEmployee);
    } catch (error) {
        console.error('HRMS Fetch Error:', error);
        res.status(500).json({ error: 'Failed to fetch employee data' });
    }
};
