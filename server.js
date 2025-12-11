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
        // Using force:true in development to avoid ALTER TABLE conflicts
        // WARNING: This drops all tables and recreates them (data loss)
        const syncOptions = process.env.NODE_ENV === 'production'
            ? { alter: true }
            : { force: true };

        await sequelize.sync(syncOptions);
        logger.info(`Database synced (${process.env.NODE_ENV === 'production' ? 'alter' : 'force'} mode).`);

        app.listen(PORT, '0.0.0.0', () => {
            logger.info(`Server running on port ${PORT}`);
        });
    } catch (err) {
        logger.error(`Failed to start server: ${err.message}`);
        process.exit(1);
    }
}

startServer();
