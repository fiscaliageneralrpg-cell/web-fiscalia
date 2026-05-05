require('dotenv').config();
const { Pool } = require('pg');

// Configuración para PostgreSQL en Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Obligatorio para Render
});

// Crea la tabla de ciudadanos automáticamente si no existe
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
        console.log('✅ Base de datos sincronizada: Tabla "usuarios" lista.');
    } catch (err) {
        console.error('❌ Error al inicializar DB:', err);
    }
};

module.exports = {
    query: (text, params) => pool.query(text, params),
    initDb,
    pool
};
