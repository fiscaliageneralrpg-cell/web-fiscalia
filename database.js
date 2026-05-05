const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Requerido para Render
    }
});

const initDB = async () => {
    const queryText = `
        CREATE TABLE IF NOT EXISTS usuarios (
            discord_id VARCHAR(50) PRIMARY KEY,
            username VARCHAR(100),
            roblox_user VARCHAR(100),
            motivo TEXT,
            estado VARCHAR(20) DEFAULT 'pendiente',
            fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    try {
        const client = await pool.connect();
        await client.query(queryText);
        client.release();
        console.log('✅ Conexión exitosa con Render PostgreSQL');
    } catch (err) {
        console.error('❌ Error de conexión DB:', err.message);
    }
};

initDB();

module.exports = {
    query: (text, params) => pool.query(text, params),
    saveUser: async (discordId, username, robloxUser, motivo) => {
        const query = `
            INSERT INTO usuarios (discord_id, username, roblox_user, motivo)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (discord_id) 
            DO UPDATE SET roblox_user = $3, motivo = $4, estado = 'pendiente';
        `;
        return pool.query(query, [discordId, username, robloxUser, motivo]);
    }
};