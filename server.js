require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();

// EVITAR QUE EL PROCESO SE CIERRE POR ERRORES
process.on('uncaughtException', (err) => {
    console.error('❌ ERROR CRÍTICO DETECTADO:', err.message);
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Configuración de Base de Datos
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Probar conexión a DB sin tumbar el servidor
pool.connect((err, client, release) => {
  if (err) {
    console.error('⚠️ ALERTA: No se pudo conectar a la DB (pero el servidor seguirá prendido):', err.message);
  } else {
    console.log('✅ CONEXIÓN A POSTGRES: EXITOSA');
    release();
  }
});

// Ruta para la web
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Puerto fijo para evitar errores de .env
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n*****************************************`);
    console.log(`🚀 DARKCORD ONLINE: http://localhost:${PORT}`);
    console.log(`*****************************************\n`);
});