const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();

// Aumentamos el límite de tamaño para poder recibir imágenes en Base64
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
    // 1. Tabla de Usuarios
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        username VARCHAR(100) PRIMARY KEY,
        password VARCHAR(250) NOT NULL,
        role VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL
      );
    `);

    // 2. Tabla de Buscados (Añadimos columnas para que se puedan guardar datos)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS buscados (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(250) NOT NULL,
        peligro VARCHAR(50),
        descripcion TEXT,
        recompensa VARCHAR(100),
        imagen TEXT
      );
    `);

    // 3. Tabla de Noticias (Añadimos columnas para que se puedan guardar datos)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS noticias (
        id SERIAL PRIMARY KEY,
        titular VARCHAR(250) NOT NULL,
        descripcion TEXT,
        imagen TEXT,
        fecha VARCHAR(50)
      );
    `);

    await pool.query("DELETE FROM usuarios WHERE username = 'fiscaliageneralrpg@gmail.com';");
    const hashedPassword = await bcrypt.hash('Fiscalia2026*', 10);
    await pool.query(`
      INSERT INTO usuarios (username, password, role, status) 
      VALUES ('fiscaliageneralrpg@gmail.com', $1, 'admin', 'aceptado');
    `, [hashedPassword]);

    console.log("⚖️ BASE DE DATOS: Tablas configuradas y Administrador actualizado con Bcrypt.");
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

// ==========================================
// 🛠️ API RUTAS
// ==========================================

app.post('/api/register', verificarConexionDB, async (req, res) => {
  const { username, password } = req.body;
  try {
    const userExists = await pool.query('SELECT * FROM usuarios WHERE username = $1', [username]);
    if (userExists.rows.length > 0) return res.status(400).json({ error: "Este usuario ya existe." });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO usuarios (username, password, role, status) VALUES ($1, $2, $3, $4)', [username, hashedPassword, 'user', 'pendiente']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error en el servidor al registrar." }); }
});

app.post('/api/login', verificarConexionDB, async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(400).json({ error: "Usuario o contraseña incorrectos." });
    
    const usuario = result.rows[0];
    const match = await bcrypt.compare(password, usuario.password);
    if (!match) return res.status(400).json({ error: "Usuario o contraseña incorrectos." });
    
    res.json({ success: true, user: usuario });
  } catch (err) { res.status(500).json({ error: "Error en el servidor al iniciar sesión." }); }
});

app.get('/api/admin/data', verificarConexionDB, async (req, res) => {
  try {
    const usuarios = await pool.query('SELECT username, status, role, password FROM usuarios WHERE role != $1 ORDER BY username ASC', ['admin']);
    const buscados = await pool.query('SELECT * FROM buscados ORDER BY id DESC');
    const noticias = await pool.query('SELECT * FROM noticias ORDER BY id DESC');
    res.json({ users: usuarios.rows, buscados: buscados.rows, noticias: noticias.rows });
  } catch (err) { res.status(500).json({ error: "Error en base de datos al obtener info." }); }
});

app.post('/api/admin/accept-user', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('UPDATE usuarios SET status = $1 WHERE username = $2', ['aceptado', req.body.username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al aceptar usuario." }); }
});

app.post('/api/admin/delete-user', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('DELETE FROM usuarios WHERE username = $1', [req.body.username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al eliminar usuario." }); }
});

// AÑADIR BUSCADO (CORREGIDO PARA RECIBIR TODOS LOS CAMPOS)
app.post('/api/admin/add-buscado', verificarConexionDB, async (req, res) => {
  try {
    const { nombre, peligro, hechos, recompensa, imagen } = req.body;
    await pool.query('INSERT INTO buscados (nombre, peligro, descripcion, recompensa, imagen) VALUES ($1, $2, $3, $4, $5)', 
      [nombre, peligro, hechos, recompensa, imagen]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al añadir buscado." }); }
});

app.post('/api/admin/delete-buscado', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('DELETE FROM buscados WHERE id = $1', [req.body.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al eliminar buscado." }); }
});

// AÑADIR NOTICIA (CORREGIDO PARA RECIBIR TODOS LOS CAMPOS)
app.post('/api/admin/add-noticia', verificarConexionDB, async (req, res) => {
  try {
    const { titular, descripcion, imagen, fecha } = req.body;
    await pool.query('INSERT INTO noticias (titular, descripcion, imagen, fecha) VALUES ($1, $2, $3, $4)', 
      [titular, descripcion, imagen, fecha]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al añadir noticia." }); }
});

app.post('/api/admin/delete-noticia', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('DELETE FROM noticias WHERE id = $1', [req.body.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al eliminar noticia." }); }
});

app.get('/api/user-status/:username', verificarConexionDB, async (req, res) => {
  try {
    const result = await pool.query('SELECT status FROM usuarios WHERE username = $1', [req.params.username]);
    res.json({ status: result.rows[0]?.status || 'pendiente' });
  } catch (err) { res.status(500).json({ error: "Error al consultar estado." }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 SERVIDOR ACTIVO EN PORT ${PORT}`);
});
