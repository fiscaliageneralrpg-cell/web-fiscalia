const { Pool } = require('pg');
require('dotenv').config();

// Configuración de la conexión usando la URL de Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Render requiere SSL para conexiones externas a PostgreSQL
    ssl: {
        rejectUnauthorized: false
    }
});

// Función para inicializar las tablas necesarias si no existen
const initDb = async () => {
    const queryText = `
    CREATE TABLE IF NOT EXISTS registros (
        discord_id TEXT PRIMARY KEY,
        nombre_rp TEXT NOT NULL,
        cedula TEXT NOT NULL,
        roblox_user TEXT,
        estado TEXT DEFAULT 'Pendiente',
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`;

    try {
        await pool.query(queryText);
        console.log('✅ Base de datos verificada: Tabla "registros" lista.');
    } catch (err) {
        console.error('❌ Error al inicializar la base de datos:', err);
    }
};

// Exportamos el pool para consultas y la función de inicio
module.exports = {
    query: (text, params) => pool.query(text, params),
    initDb,
    pool
};
