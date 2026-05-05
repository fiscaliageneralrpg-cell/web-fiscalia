require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
    const queryText = `
    CREATE TABLE IF NOT EXISTS usuarios (
        discord_id TEXT PRIMARY KEY,
        nombres TEXT,
        apellidos TEXT,
        nuip TEXT,
        nacionalidad TEXT,
        roblox_user TEXT,
        estado TEXT DEFAULT 'nuevo'
    );`;

    try {
        await pool.query(queryText);
        console.log('✅ Base de datos de Render conectada y sincronizada.');
    } catch (err) {
        console.error('❌ Error al conectar con PostgreSQL:', err.message);
    }
};

module.exports = {
    query: (text, params) => pool.query(text, params),
    initDb,
    pool
};
