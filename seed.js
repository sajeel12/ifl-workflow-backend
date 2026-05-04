import 'dotenv/config';
import sequelize from './src/config/database.js';
import Employee from './src/models/Employee.js';

async function seed() {
    try {
        await sequelize.sync();

        const employees = [
            // ── Head Office Lahore (10) ──────────────────────────────
            { employeeId: '1001', name: 'Fatima Ali',          email: 'fatima.ali@ifl.com',         designation: 'Senior Developer',   mainDept: 'IT Dept',        location: 'Head Office Lahore' },
            { employeeId: '1002', name: 'Usman Tariq',         email: 'usman.tariq@ifl.com',        designation: 'IT Manager',         mainDept: 'IT Dept',        location: 'Head Office Lahore' },
            { employeeId: '1003', name: 'Aisha Khan',          email: 'aisha.khan@ifl.com',         designation: 'HR Executive',       mainDept: 'HR',             location: 'Head Office Lahore' },
            { employeeId: '1004', name: 'Hassan Raza',         email: 'hassan.raza@ifl.com',        designation: 'Finance Manager',    mainDept: 'Finance',        location: 'Head Office Lahore' },
            { employeeId: '1005', name: 'Sana Malik',          email: 'sana.malik@ifl.com',         designation: 'Accountant',         mainDept: 'Finance',        location: 'Head Office Lahore' },
            { employeeId: '1006', name: 'Bilal Ahmed',         email: 'bilal.ahmed@ifl.com',        designation: 'Network Admin',      mainDept: 'IT Dept',        location: 'Head Office Lahore' },
            { employeeId: '1007', name: 'Mehreen Iqbal',       email: 'mehreen.iqbal@ifl.com',      designation: 'HR Director',        mainDept: 'HR',             location: 'Head Office Lahore' },
            { employeeId: '1008', name: 'Zubair Hussain',      email: 'zubair.hussain@ifl.com',     designation: 'Procurement Lead',   mainDept: 'Supply Chain',   location: 'Head Office Lahore' },
            { employeeId: '1009', name: 'Nadia Pervaiz',       email: 'nadia.pervaiz@ifl.com',      designation: 'Admin Officer',      mainDept: 'Administration', location: 'Head Office Lahore' },
            { employeeId: '1010', name: 'Kamran Sheikh',       email: 'kamran.sheikh@ifl.com',      designation: 'Legal Counsel',      mainDept: 'Legal',          location: 'Head Office Lahore' },

            // ── Faisalabad Mill (8) ──────────────────────────────────
            { employeeId: '2001', name: 'Tariq Mehmood',       email: 'tariq.mehmood@ifl.com',      designation: 'Plant Manager',      mainDept: 'Production',     location: 'Faisalabad Mill' },
            { employeeId: '2002', name: 'Farhan Siddiqui',     email: 'farhan.siddiqui@ifl.com',    designation: 'Shift Supervisor',   mainDept: 'Production',     location: 'Faisalabad Mill' },
            { employeeId: '2003', name: 'Rabia Naseer',        email: 'rabia.naseer@ifl.com',       designation: 'Quality Inspector',  mainDept: 'QA',             location: 'Faisalabad Mill' },
            { employeeId: '2004', name: 'Imran Javed',         email: 'imran.javed@ifl.com',        designation: 'Maintenance Head',   mainDept: 'Maintenance',    location: 'Faisalabad Mill' },
            { employeeId: '2005', name: 'Saima Batool',        email: 'saima.batool@ifl.com',       designation: 'Safety Officer',     mainDept: 'HSE',            location: 'Faisalabad Mill' },
            { employeeId: '2006', name: 'Waqas Ali',           email: 'waqas.ali@ifl.com',          designation: 'IT Support',         mainDept: 'IT Dept',        location: 'Faisalabad Mill' },
            { employeeId: '2007', name: 'Amna Zahoor',         email: 'amna.zahoor@ifl.com',        designation: 'HR Coordinator',     mainDept: 'HR',             location: 'Faisalabad Mill' },
            { employeeId: '2008', name: 'Naveed Aslam',        email: 'naveed.aslam@ifl.com',       designation: 'Store Keeper',       mainDept: 'Supply Chain',   location: 'Faisalabad Mill' },

            // ── Karachi Office (6) ───────────────────────────────────
            { employeeId: '3001', name: 'Shahid Afridi',       email: 'shahid.afridi@ifl.com',      designation: 'Sales Director',     mainDept: 'Sales',          location: 'Karachi Office' },
            { employeeId: '3002', name: 'Hira Qureshi',        email: 'hira.qureshi@ifl.com',       designation: 'Marketing Lead',     mainDept: 'Marketing',      location: 'Karachi Office' },
            { employeeId: '3003', name: 'Danish Rehman',       email: 'danish.rehman@ifl.com',      designation: 'Regional Manager',   mainDept: 'Sales',          location: 'Karachi Office' },
            { employeeId: '3004', name: 'Lubna Arif',          email: 'lubna.arif@ifl.com',         designation: 'Customer Support',   mainDept: 'Support',        location: 'Karachi Office' },
            { employeeId: '3005', name: 'Ali Haider',          email: 'ali.haider@ifl.com',         designation: 'Logistics Officer',  mainDept: 'Supply Chain',   location: 'Karachi Office' },
            { employeeId: '3006', name: 'Sidra Jameel',        email: 'sidra.jameel@ifl.com',       designation: 'Accounts Exec',      mainDept: 'Finance',        location: 'Karachi Office' },

            // ── Multan Plant (5) ─────────────────────────────────────
            { employeeId: '4001', name: 'Rizwan Khalid',       email: 'rizwan.khalid@ifl.com',      designation: 'Production Head',    mainDept: 'Production',     location: 'Multan Plant' },
            { employeeId: '4002', name: 'Asma Shaheen',        email: 'asma.shaheen@ifl.com',       designation: 'Lab Technician',     mainDept: 'QA',             location: 'Multan Plant' },
            { employeeId: '4003', name: 'Faisal Nawaz',        email: 'faisal.nawaz@ifl.com',       designation: 'Electrical Eng.',    mainDept: 'Maintenance',    location: 'Multan Plant' },
            { employeeId: '4004', name: 'Tahira Bibi',         email: 'tahira.bibi@ifl.com',        designation: 'HR Officer',         mainDept: 'HR',             location: 'Multan Plant' },
            { employeeId: '4005', name: 'Shoaib Akhtar',       email: 'shoaib.akhtar@ifl.com',      designation: 'Utility Operator',   mainDept: 'Utilities',      location: 'Multan Plant' },

            // ── Islamabad Office (5) ─────────────────────────────────
            { employeeId: '5001', name: 'Omar Farooq',         email: 'omar.farooq@ifl.com',        designation: 'Gov. Relations',     mainDept: 'Legal',          location: 'Islamabad Office' },
            { employeeId: '5002', name: 'Zainab Abbas',        email: 'zainab.abbas@ifl.com',       designation: 'Compliance Officer', mainDept: 'Legal',          location: 'Islamabad Office' },
            { employeeId: '5003', name: 'Adeel Butt',          email: 'adeel.butt@ifl.com',         designation: 'IT Coordinator',     mainDept: 'IT Dept',        location: 'Islamabad Office' },
            { employeeId: '5004', name: 'Maryam Saleem',       email: 'maryam.saleem@ifl.com',      designation: 'Admin Assistant',    mainDept: 'Administration', location: 'Islamabad Office' },

            // ── Existing test user ───────────────────────────────────
            { employeeId: '128793', name: 'Sajeel',            email: 'sajeel.dilshad@perception-it.com', designation: 'Senior Officer', mainDept: 'Data Center', location: 'Head Office Lahore' },
        ];

        await Employee.bulkCreate(employees, {
            updateOnDuplicate: ['name', 'email', 'designation', 'mainDept', 'location']
        });

        console.log(`✅ Seeded ${employees.length} employees across 5 locations successfully.`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Seed error:', err);
        process.exit(1);
    }
}

seed();
