import 'dotenv/config';
import sequelize from './src/config/database.js';
import Employee from './src/models/Employee.js';

async function seed() {
    try {
        await sequelize.sync();

        await Employee.bulkCreate([
            { employeeId: '1001', name: 'Fatima Ali', email: 'fatima.ali@ifl.com', designation: 'Senior Developer', mainDept: 'IT Dept' },
            { employeeId: '1002', name: 'Usman Tariq', email: 'sajeel.dilshad@perception-it.com', designation: 'IT Manager', mainDept: 'IT Dept' },
            { employeeId: '1003', name: 'Aisha Khan', email: 'aisha.khan@ifl.com', designation: 'HR Executive', mainDept: 'HR' },
            { employeeId: '128793', name: 'Sajeel', email: 'sajeel.dilshad@perception-it.com', designation: 'Senior Officer', mainDept: 'Data Center' }
        ], { updateOnDuplicate: ['name', 'email', 'designation', 'mainDept'] });

        console.log('Seeded 4 employees successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Seed syntax error:', err);
        process.exit(1);
    }
}

seed();
