const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const bcrypt = require('bcrypt'); // Aseguramos el uso de bcrypt para comparar contraseñas cifradas
require('dotenv').config();

const app = express();

app.set('view engine', 'ejs');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

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
      CREATE TABLE IF NOT EXISTS usuarios (
        username VARCHAR(100) PRIMARY KEY,
        password VARCHAR(250) NOT NULL,
        role VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS buscados (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(250) NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS noticias (
        id SERIAL PRIMARY KEY,
        titular VARCHAR(250) NOT NULL
      );
    `);

    // Cuenta administradora por defecto (creada con contraseña cifrada si no existe)
    const adminExists = await pool.query('SELECT * FROM usuarios WHERE username = $1', ['fiscaliageneralrpg@gmail.com']);
    if (adminExists.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('Fiscalia2026*', 10);
      await pool.query(`
        INSERT INTO usuarios (username, password, role, status) 
        VALUES ('fiscaliageneralrpg@gmail.com', $1, 'admin', 'aceptado');
      `, [hashedPassword]);
    }

    console.log("⚖️ BASE DE DATOS: Tablas configuradas correctamente con Bcrypt.");
  } catch (err) {
    console.error("❌ ERROR CRÍTICO AL CREAR TABLAS:", err.message);
  }
};

inicializarBaseDeDatos();

const verificarConexionDB = async (req, res, next) => {
  try {
    await pool.query('SELECT 1');
    next();
  } catch (err) {
    console.error("❌ DB CAÍDA:", err.message);
    return res.status(500).json({ error: "La base de datos no está conectada." });
  }
};

app.post('/api/register', verificarConexionDB, async (req, res) => {
  const { username, password } = req.body;
  try {
    const userExists = await pool.query('SELECT * FROM usuarios WHERE username = $1', [username]);
    if (userExists.rows.length > 0) return res.status(400).json({ error: "Este usuario ya existe." });
    
    // Ciframos la contraseña al registrar por seguridad
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO usuarios (username, password, role, status) VALUES ($1, $2, $3, $4)', [username, hashedPassword, 'user', 'pendiente']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error en el servidor." }); }
});

// 🔑 LOGIN CORREGIDO COMPATIBLE CON CONTRASEÑAS CIFRADAS
app.post('/api/login', verificarConexionDB, async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(400).json({ error: "Usuario o contraseña incorrectos." });
    
    const usuario = result.rows[0];
    
    // Comparamos la contraseña ingresada con el hash guardado en la base de datos
    const match = await bcrypt.compare(password, usuario.password);
    if (!match) return res.status(400).json({ error: "Usuario o contraseña incorrectos." });
    
    res.json({ success: true, user: usuario });
  } catch (err) { res.status(500).json({ error: "Error en el servidor." }); }
});

app.get('/api/admin/data', verificarConexionDB, async (req, res) => {
  try {
    const usuarios = await pool.query('SELECT username, status, role, password FROM usuarios WHERE role != $1 ORDER BY username ASC', ['admin']);
    const buscados = await pool.query('SELECT id, nombre FROM buscados ORDER BY id DESC');
    const noticias = await pool.query('SELECT id, titular FROM noticias ORDER BY id DESC');
    res.json({ users: usuarios.rows, buscados: buscados.rows, noticias: noticias.rows });
  } catch (err) { res.status(500).json({ error: "Error en base de datos." }); }
});

app.post('/api/admin/accept-user', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('UPDATE usuarios SET status = $1 WHERE username = $2', ['aceptado', req.body.username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error." }); }
});

app.post('/api/admin/delete-user', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('DELETE FROM usuarios WHERE username = $1', [req.body.username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error." }); }
});

app.post('/api/admin/add-buscado', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('INSERT INTO buscados (nombre) VALUES ($1)', [req.body.nombre]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error." }); }
});

app.post('/api/admin/delete-buscado', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('DELETE FROM buscados WHERE id = $1', [req.body.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error." }); }
});

app.post('/api/admin/add-noticia', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('INSERT INTO noticias (titular) VALUES ($1)', [req.body.titular]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error." }); }
});

app.post('/api/admin/delete-noticia', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('DELETE FROM noticias WHERE id = $1', [req.body.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error." }); }
});

app.get('/api/user-status/:username', verificarConexionDB, async (req, res) => {
  try {
    const result = await pool.query('SELECT status FROM usuarios WHERE username = $1', [username]);
    res.json({ status: result.rows[0]?.status || 'pendiente' });
  } catch (err) { res.status(500).json({ error: "Error" }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 SERVIDOR ACTIVO EN PORT ${PORT}`);
});
