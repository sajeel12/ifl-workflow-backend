// Quick script to drop the two new tables with bad indexes
import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./database.sqlite');

console.log('Dropping RequestRelationships...');
db.run('DROP TABLE IF EXISTS RequestRelationships', (err) => {
    if (err) {
        console.error('Error dropping RequestRelationships:', err.message);
    } else {
        console.log('✓ RequestRelationships dropped');
    }

    console.log('Dropping RequestStageEvents...');
    db.run('DROP TABLE IF EXISTS RequestStageEvents', (err2) => {
        if (err2) {
            console.error('Error dropping RequestStageEvents:', err2.message);
        } else {
            console.log('✓ RequestStageEvents dropped');
        }

        console.log('\nSuccess! Tables dropped. Now run: node server.js');
        db.close();
    });
});
