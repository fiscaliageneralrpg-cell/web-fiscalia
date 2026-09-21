const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
});

async function probarConexion() {
    const conexion = await pool.getConnection();

    try {
        await conexion.ping();
        console.log('✅ Web conectada correctamente a MySQL');
    } finally {
        conexion.release();
    }
}

module.exports = {
    pool,
    probarConexion
};
