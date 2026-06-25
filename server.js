const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();

// Configuración de límites para imágenes Base64 grandes
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

app.set('view engine', 'ejs');

// Configuración de sesión
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
        estado_actual VARCHAR(250) DEFAULT 'Denuncia Enviada'
      );
      CREATE TABLE IF NOT EXISTS estados_denuncias (
        id SERIAL PRIMARY KEY,
        denuncia_id INTEGER REFERENCES denuncias(id) ON DELETE CASCADE,
        mensaje TEXT,
        fecha VARCHAR(50)
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

// --- AUTENTICACIÓN ---
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query("INSERT INTO usuarios (username, password, role, status) VALUES ($1, $2, 'user', 'aceptado')", [username, hashedPassword]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "El usuario ya existe." }); }
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
  } catch (err) { res.status(500).json({ error: "Error en el login." }); }
});

// --- DENUNCIAS Y ESTADOS ---
app.post('/api/denuncias/enviar', async (req, res) => {
  try {
    const { usuario, titulo, descripcion, evidencia, fecha } = req.body;
    const result = await pool.query(
      "INSERT INTO denuncias (usuario, titulo, descripcion, evidencia, fecha) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [usuario, titulo, descripcion, evidencia, fecha]
    );
    const denunciaId = result.rows[0].id;
    // Insertar el primer estado en el historial
    await pool.query("INSERT INTO estados_denuncias (denuncia_id, mensaje, fecha) VALUES ($1, $2, $3)", [denunciaId, 'Denuncia enviada exitosamente al sistema.', fecha]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al enviar denuncia" }); }
});

app.get('/api/denuncias/mis-denuncias/:usuario', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM denuncias WHERE usuario = $1 ORDER BY id DESC", [req.params.usuario]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Error al obtener denuncias" }); }
});

app.get('/api/denuncias/estados/:id', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM estados_denuncias WHERE denuncia_id = $1 ORDER BY id ASC", [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Error al obtener historial de estados" }); }
});

// --- ADMINISTRACIÓN ---
app.get('/api/admin/data', async (req, res) => {
  try {
    const u = await pool.query('SELECT username, role FROM usuarios');
    const b = await pool.query('SELECT * FROM buscados ORDER BY id DESC');
    const n = await pool.query('SELECT * FROM noticias ORDER BY id DESC');
    const d = await pool.query('SELECT * FROM denuncias ORDER BY id DESC');
    res.json({ users: u.rows, buscados: b.rows, noticias: n.rows, denuncias: d.rows });
  } catch (err) { res.status(500).json({ error: "Error al cargar datos administrativos" }); }
});

app.post('/api/admin/actualizar-estado', async (req, res) => {
  try {
    const { denuncia_id, mensaje, fecha } = req.body;
    if (!denuncia_id || !mensaje) return res.status(400).json({ error: "Faltan datos" });
    
    // Actualizar el estado actual en la tabla principal
    await pool.query("UPDATE denuncias SET estado_actual = $1 WHERE id = $2", [mensaje, denuncia_id]);
    // Insertar el nuevo mensaje en el historial
    await pool.query("INSERT INTO estados_denuncias (denuncia_id, mensaje, fecha) VALUES ($1, $2, $3)", [denuncia_id, mensaje, fecha]);
    
    res.json({ success: true });
  } catch (err) { 
    console.error("Error al actualizar estado:", err);
    res.status(500).json({ error: "Error interno al actualizar estado" }); 
  }
});

app.post('/api/admin/make-admin', async (req, res) => {
  try {
    await pool.query("UPDATE usuarios SET role = 'admin' WHERE username = $1", [req.body.username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al ascender usuario" }); }
});

app.post('/api/admin/delete-user', async (req, res) => {
  try {
    await pool.query('DELETE FROM usuarios WHERE username = $1', [req.body.username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al eliminar usuario" }); }
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

app.listen(process.env.PORT || 10000, () => console.log('🚀 SERVIDOR ONLINE'));
