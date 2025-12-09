import app from './app.js';
import sequelize from './src/config/database.js';
import logger from './src/utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        // Test DB Connection
        await sequelize.authenticate();
        logger.info('Database connection has been established successfully.');

        // Sync Models (Optional: use migrations in production)
        // await sequelize.sync(); 

        app.listen(PORT, () => {
            logger.info(`Server is running on port ${PORT}`);
        });
    } catch (error) {
        logger.error('Unable to connect to the database:', error);
        process.exit(1);
    }
}

startServer();
