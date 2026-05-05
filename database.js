require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Forzamos SSL avanzado
    ssl: {
        rejectUnauthorized: false
    },
    // Parámetros para evitar que la conexión se caiga
    keepAlive: true,
    connectionTimeoutMillis: 10000, // 10 segundos de espera
    idleTimeoutMillis: 30000,
    max: 10
});

const initDb = async () => {
    try {
        const client = await pool.connect();
        console.log('✅ Conexión física con Render establecida correctamente.');
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                discord_id TEXT PRIMARY KEY,
                nombres TEXT,
                apellidos TEXT,
                nuip TEXT,
                nacionalidad TEXT,
                roblox_user TEXT,
                estado TEXT DEFAULT 'nuevo',
                fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        client.release();
        console.log('✅ Tabla "usuarios" verificada en la nube.');
    } catch (err) {
        console.error('❌ ERROR CRÍTICO de Base de Datos:', {
            mensaje: err.message,
            codigo: err.code,
            stack: err.stack ? 'Error de protocolo' : 'Sin stack'
        });
        // Si falla, intentamos reconectar en 5 segundos
        setTimeout(initDb, 5000);
    }
};

module.exports = {
    query: (text, params) => pool.query(text, params),
    initDb,
    pool
};
