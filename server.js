import app from './app.js';
import sequelize from './src/config/database.js';
import logger from './src/utils/logger.js';

const PORT = process.env.PORT || 3000;

/**
 * Drop all foreign key constraints in the database (MSSQL specific)
 * This is needed when using force:true to avoid constraint errors
 */
async function dropAllForeignKeys() {
    try {
        const query = `
            DECLARE @sql NVARCHAR(MAX) = N'';
            SELECT @sql += 'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + '.' + 
                          QUOTENAME(OBJECT_NAME(parent_object_id)) + 
                          ' DROP CONSTRAINT ' + QUOTENAME(name) + ';'
            FROM sys.foreign_keys;
            EXEC sp_executesql @sql;
        `;
        await sequelize.query(query);
        logger.info('All foreign key constraints dropped.');
    } catch (err) {
        logger.warn(`Could not drop foreign keys: ${err.message}`);
    }
}

async function startServer() {
    try {
        // DB Connection
        await sequelize.authenticate();
        logger.info('Database connected.');

        // Sync Models (Dev only - use Migrations in Prod!)
        // Using force:true in development to avoid ALTER TABLE conflicts
        // WARNING: This drops all tables and recreates them (data loss)
        const isDev = process.env.NODE_ENV !== 'production';

        if (isDev) {
            // Drop all foreign key constraints first to avoid errors
            await dropAllForeignKeys();
        }

        const syncOptions = isDev ? { force: true } : { alter: true };

        await sequelize.sync(syncOptions);
        logger.info(`Database synced (${isDev ? 'force' : 'alter'} mode).`);

        app.listen(PORT, '0.0.0.0', () => {
            logger.info(`Server running on port ${PORT}`);
        });
    } catch (err) {
        logger.error(`Failed to start server: ${err.message}`);
        process.exit(1);
    }
}

startServer();
