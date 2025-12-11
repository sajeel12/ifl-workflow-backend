import app from './app.js';
import sequelize from './src/config/database.js';
import logger from './src/utils/logger.js';

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        // DB Connection
        await sequelize.authenticate();
        logger.info('Database connected.');

        // Sync Models (Dev only - use Migrations in Prod!)
        await sequelize.sync({ alter: true });
        logger.info('Database synced.');

        app.listen(PORT, '0.0.0.0', () => {
            logger.info(`Server running on port ${PORT}`);
        });
    } catch (err) {
        logger.error(`Failed to start server: ${err.message}`);
        process.exit(1);
    }
}

startServer();
