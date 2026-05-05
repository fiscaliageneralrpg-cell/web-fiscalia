require('dotenv').config();
const { Pool } = require('pg');

/**
 * Configuración del Pool de conexiones.
 * Se utiliza la variable DATABASE_URL de Render.
 */
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // CRÍTICO: Render requiere SSL con rejectUnauthorized: false 
    // para permitir conexiones desde servidores externos como HidenCloud.
    ssl: {
        rejectUnauthorized: false
    },
    // Ajustes de rendimiento para evitar saturar la DB
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

/**
 * Inicializa la estructura de la base de datos.
 * Crea la tabla 'usuarios' si no existe.
 */
const initDb = async () => {
    const queryText = `
    CREATE TABLE IF NOT EXISTS usuarios (
        discord_id TEXT PRIMARY KEY,
        nombres TEXT,
        apellidos TEXT,
        nuip TEXT,
        nacionalidad TEXT,
        roblox_user TEXT,
        estado TEXT DEFAULT 'nuevo',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`;

    try {
        const client = await pool.connect();
        try {
            await client.query(queryText);
            console.log('✅ Estructura de Base de Datos verificada: Tabla "usuarios" lista.');
        } finally {
            client.release();
        }
    } catch (err) {
        // Log detallado para diagnosticar fallos de conexión en la consola
        console.error('❌ ERROR CRÍTICO de Base de Datos:', {
            mensaje: err.message,
            codigo: err.code,
            detalle: err.detail || 'Sin detalles adicionales'
        });
        throw err; // Lanza el error para que el index.js lo detecte
    }
};

/**
 * Exportación de funciones para uso en index.js y app.js
 */
module.exports = {
    // Función para ejecutar consultas rápidas
    query: (text, params) => pool.query(text, params),
    // Función de inicialización
    initDb,
    // Exportar el pool por si se requiere manejo avanzado
    pool
};
