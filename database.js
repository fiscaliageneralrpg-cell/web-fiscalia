const { Pool } = require('pg');

// Configuración de la conexión usando la URL interna/externa de Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Requerido para conexiones seguras en Render
    }
});

// Función para ejecutar consultas
const query = (text, params) => pool.query(text, params);

// Inicialización de Tablas: Crea 'usuarios' y 'solicitudes'
const initDb = async () => {
    const createSolicitudesTable = `
        CREATE TABLE IF NOT EXISTS solicitudes (
            id SERIAL PRIMARY KEY,
            discord_id VARCHAR(50) NOT NULL,
            nombres VARCHAR(100),
            apellidos VARCHAR(100),
            roblox_user VARCHAR(100),
            nacimiento VARCHAR(20),
            lugar_nacimiento VARCHAR(100),
            nacionalidad VARCHAR(50),
            genero VARCHAR(10),
            motivo TEXT,
            estado VARCHAR(20) DEFAULT 'PENDIENTE',
            fecha_solicitud TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    const createUsuariosTable = `
        CREATE TABLE IF NOT EXISTS usuarios (
            discord_id VARCHAR(50) PRIMARY KEY,
            nombres VARCHAR(100),
            apellidos VARCHAR(100),
            nuip VARCHAR(20) UNIQUE,
            nacionalidad VARCHAR(50),
            roblox_user VARCHAR(100),
            estado VARCHAR(20) DEFAULT 'VALIDADO',
            fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    try {
        await query(createSolicitudesTable);
        await query(createUsuariosTable);
        console.log("✅ Base de datos sincronizada (Tablas listas)");
    } catch (err) {
        console.error("❌ Error inicializando DB:", err);
    }
};

module.exports = { query, initDb };
