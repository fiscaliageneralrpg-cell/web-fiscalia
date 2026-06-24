const { Pool } = require('pg');
require('dotenv').config();

// Conexión a la base de datos usando la URL secreta
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Requerido por Render para conexiones seguras
  }
});

module.exports = pool;