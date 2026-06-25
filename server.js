const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

app.set('view engine', 'ejs');

app.use(session({
  secret: 'fiscalia_secret_key_rp',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const inicializarBaseDeDatos = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        username VARCHAR(100) PRIMARY KEY, 
        password VARCHAR(250) NOT NULL, 
        role VARCHAR(20) NOT NULL, 
        status VARCHAR(20) NOT NULL
      );
      CREATE TABLE IF NOT EXISTS buscados (
        id SERIAL PRIMARY KEY, 
        nombre VARCHAR(250) NOT NULL,
        peligro VARCHAR(50), 
        descripcion TEXT, 
        recompensa VARCHAR(100), 
        imagen TEXT
      );
      CREATE TABLE IF NOT EXISTS noticias (
        id SERIAL PRIMARY KEY, 
        titular VARCHAR(250) NOT NULL,
        descripcion TEXT, 
        imagen TEXT, 
        fecha VARCHAR(50)
      );
      CREATE TABLE IF NOT EXISTS denuncias (
        id SERIAL PRIMARY KEY,
        usuario VARCHAR(100),
        titulo VARCHAR(250),
        descripcion TEXT,
        evidencia TEXT,
        fecha VARCHAR(50),
        estado VARCHAR(20) DEFAULT 'pendiente'
      );
    `);

    const adminEmail = 'fiscaliageneralrpg@gmail.com';
    const checkAdmin = await pool.query("SELECT * FROM usuarios WHERE username = $1", [adminEmail]);
    if (checkAdmin.rows.length === 0) {
        const hashedPassword = await bcrypt.hash('Fiscalia2026*', 10);
        await pool.query("INSERT INTO usuarios (username, password, role, status) VALUES ($1, $2, 'admin', 'aceptado')", [adminEmail, hashedPassword]);
    }
    console.log("⚖️ BASE DE DATOS: Lista y actualizada.");
  } catch (err) { console.error("❌ ERROR BD:", err.message); }
};
inicializarBaseDeDatos();

// --- RUTAS DE AUTENTICACIÓN ---

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    // Registro automático como 'user' y 'aceptado'
    await pool.query(
      "INSERT INTO usuarios (username, password, role, status) VALUES ($1, $2, 'user', 'aceptado')",
      [username, hashedPassword]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "El usuario ya existe o error en el servidor." });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query("SELECT * FROM usuarios WHERE username = $1", [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: "Usuario no encontrado." });
    
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Contraseña incorrecta." });
    
    req.session.user = { username: user.username, role: user.role };
    res.json({ success: true, user: { username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: "Error en el login." });
  }
});

// --- RUTAS DE DENUNCIAS ---

app.post('/api/denuncias/enviar', async (req, res) => {
  try {
    const { usuario, titulo, descripcion, evidencia, fecha } = req.body;
    await pool.query(
      "INSERT INTO denuncias (usuario, titulo, descripcion, evidencia, fecha) VALUES ($1, $2, $3, $4, $5)",
      [usuario, titulo, descripcion, evidencia, fecha]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Error al enviar denuncia" });
  }
});

// --- RUTAS DE ADMINISTRACIÓN ---

app.get('/api/admin/data', async (req, res) => {
  try {
    const u = await pool.query('SELECT username, status, role, password FROM usuarios');
    const b = await pool.query('SELECT * FROM buscados ORDER BY id DESC');
    const n = await pool.query('SELECT * FROM noticias ORDER BY id DESC');
    const d = await pool.query('SELECT * FROM denuncias ORDER BY id DESC');
    res.json({ users: u.rows, buscados: b.rows, noticias: n.rows, denuncias: d.rows });
  } catch (err) { res.status(500).json({ error: "Error al obtener datos." }); }
});

app.post('/api/admin/make-admin', async (req, res) => {
  try {
    await pool.query("UPDATE usuarios SET role = 'admin' WHERE username = $1", [req.body.username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al ascender usuario" }); }
});

app.post('/api/admin/add-noticia', async (req, res) => {
  try {
    const { titular, descripcion, imagen, fecha } = req.body;
    await pool.query('INSERT INTO noticias (titular, descripcion, imagen, fecha) VALUES ($1, $2, $3, $4)', [titular, descripcion, imagen, fecha]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al guardar noticia" }); }
});

app.post('/api/admin/add-buscado', async (req, res) => {
  try {
    const { nombre, peligro, hechos, recompensa, imagen } = req.body;
    await pool.query(
      'INSERT INTO buscados (nombre, peligro, descripcion, recompensa, imagen) VALUES ($1, $2, $3, $4, $5)', 
      [nombre, peligro, hechos, recompensa, imagen]
    );
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

app.post('/api/admin/delete-user', async (req, res) => {
  await pool.query('DELETE FROM usuarios WHERE username = $1', [req.body.username]);
  res.json({ success: true });
});

app.listen(process.env.PORT || 10000, () => console.log('🚀 SERVIDOR ONLINE'));
