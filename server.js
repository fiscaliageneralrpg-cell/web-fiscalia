const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();

// IMPORTANTE: Aumentamos el límite para recibir imágenes Base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

app.set('view engine', 'ejs');

app.use(session({
  secret: 'fiscalia_secret_key_rp',
  resave: false,
  saveUninitialized: false
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const inicializarBaseDeDatos = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (username VARCHAR(100) PRIMARY KEY, password VARCHAR(250) NOT NULL, role VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL);
      CREATE TABLE IF NOT EXISTS buscados (id SERIAL PRIMARY KEY, nombre VARCHAR(250) NOT NULL);
      CREATE TABLE IF NOT EXISTS noticias (id SERIAL PRIMARY KEY, titular VARCHAR(250) NOT NULL);
      
      -- Aseguramos que existan las columnas nuevas sin borrar nada
      ALTER TABLE buscados ADD COLUMN IF NOT EXISTS peligro VARCHAR(50), ADD COLUMN IF NOT EXISTS descripcion TEXT, ADD COLUMN IF NOT EXISTS recompensa VARCHAR(100), ADD COLUMN IF NOT EXISTS imagen TEXT;
      ALTER TABLE noticias ADD COLUMN IF NOT EXISTS descripcion TEXT, ADD COLUMN IF NOT EXISTS imagen TEXT, ADD COLUMN IF NOT EXISTS fecha VARCHAR(50);
    `);

    await pool.query("DELETE FROM usuarios WHERE username = 'fiscaliageneralrpg@gmail.com';");
    const hashedPassword = await bcrypt.hash('Fiscalia2026*', 10);
    await pool.query("INSERT INTO usuarios (username, password, role, status) VALUES ('fiscaliageneralrpg@gmail.com', $1, 'admin', 'aceptado')", [hashedPassword]);

    console.log("⚖️ BASE DE DATOS: Lista y actualizada.");
  } catch (err) { console.error("❌ ERROR BD:", err.message); }
};
inicializarBaseDeDatos();

// --- API RUTAS ---

app.get('/api/admin/data', async (req, res) => {
  try {
    const u = await pool.query('SELECT username, status, role FROM usuarios WHERE role != $1', ['admin']);
    const b = await pool.query('SELECT * FROM buscados ORDER BY id DESC');
    const n = await pool.query('SELECT * FROM noticias ORDER BY id DESC');
    res.json({ users: u.rows, buscados: b.rows, noticias: n.rows });
  } catch (err) { res.status(500).json({ error: "Error al obtener datos." }); }
});

// RUTA CORREGIDA: Recibe todos los campos
app.post('/api/admin/add-noticia', async (req, res) => {
  try {
    const { titular, descripcion, imagen, fecha } = req.body;
    await pool.query('INSERT INTO noticias (titular, descripcion, imagen, fecha) VALUES ($1, $2, $3, $4)', [titular, descripcion, imagen, fecha]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al guardar noticia" }); }
});

// RUTA CORREGIDA: Recibe todos los campos
app.post('/api/admin/add-búscado', async (req, res) => {
  try {
    const { nombre, peligro, hechos, recompensa, imagen } = req.body;
    await pool.query('INSERT INTO buscados (nombre, peligro, descripcion, recompensa, imagen) VALUES ($1, $2, $3, $4, $5)', [nombre, peligro, hechos, recompensa, imagen]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al guardar buscado" }); }
});

app.post('/api/admin/delete-noticia', async (req, res) => {
  await pool.query('DELETE FROM noticias WHERE id = $1', [req.body.id]);
  res.json({ success: true });
});

app.post('/api/admin/delete-buscado', async (req, res) => {
  await pool.query('DELETE FROM buscados WHERE id = $1', [req.body.id]);
  res.json({ success: true });
});

app.post('/api/admin/accept-user', async (req, res) => {
  await pool.query('UPDATE usuarios SET status = $1 WHERE username = $2', ['aceptado', req.body.username]);
  res.json({ success: true });
});

app.post('/api/admin/delete-user', async (req, res) => {
  await pool.query('DELETE FROM usuarios WHERE username = $1', [req.body.username]);
  res.json({ success: true });
});

app.listen(process.env.PORT || 10000, () => console.log('🚀 SERVIDOR ONLINE'));
