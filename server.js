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
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // Sesión activa por 24 horas
}));

// Conexión a Base de Datos (PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Inicialización de Tablas
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
    `);

    // Crear admin por defecto si no existe
    const adminEmail = 'fiscaliageneralrpg@gmail.com';
    const checkAdmin = await pool.query("SELECT * FROM usuarios WHERE username = $1", [adminEmail]);
    if (checkAdmin.rows.length === 0) {
        const hashedPassword = await bcrypt.hash('Fiscalia2026*', 10);
        await pool.query("INSERT INTO usuarios (username, password, role, status) VALUES ($1, $2, 'admin', 'aceptado')", [adminEmail, hashedPassword]);
        console.log("👤 Admin principal creado correctamente.");
    }
    console.log("⚖️ BASE DE DATOS: Lista y actualizada.");
  } catch (err) { console.error("❌ ERROR BD:", err.message); }
};
inicializarBaseDeDatos();

// --- RUTAS DE AUTENTICACIÓN (SIN /auth/ PARA COINCIDIR CON TU FRONTEND) ---

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Datos incompletos" });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO usuarios (username, password, role, status) VALUES ($1, $2, 'user', 'pendiente')",
      [username, hashedPassword]
    );
    res.json({ success: true, message: "Registro exitoso, espera aprobación." });
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
    if (user.status !== 'aceptado') return res.status(403).json({ error: "Tu cuenta aún no ha sido aprobada." });
    
    req.session.user = { username: user.username, role: user.role };
    res.json({ success: true, role: user.role, username: user.username });
  } catch (err) {
    res.status(500).json({ error: "Error en el inicio de sesión." });
  }
});

// --- RUTAS DE ADMINISTRACIÓN ---

app.get('/api/admin/data', async (req, res) => {
  try {
    const u = await pool.query('SELECT username, status, role, password FROM usuarios WHERE role != $1', ['admin']);
    const b = await pool.query('SELECT * FROM buscados ORDER BY id DESC');
    const n = await pool.query('SELECT * FROM noticias ORDER BY id DESC');
    res.json({ users: u.rows, buscados: b.rows, noticias: n.rows });
  } catch (err) { res.status(500).json({ error: "Error al obtener datos." }); }
});

app.post('/api/admin/add-noticia', async (req, res) => {
  try {
    const { titular, descripcion, imagen, fecha } = req.body;
    await pool.query('INSERT INTO noticias (titular, descripcion, imagen, fecha) VALUES ($1, $2, $3, $4)', [titular, descripcion, imagen, fecha]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al guardar noticia" }); }
});

// RUTA CORREGIDA: Sin tilde para evitar errores 404
app.post('/api/admin/add-buscado', async (req, res) => {
  try {
    const { nombre, peligro, hechos, recompensa, imagen } = req.body;
    await pool.query(
      'INSERT INTO buscados (nombre, peligro, descripcion, recompensa, imagen) VALUES ($1, $2, $3, $4, $5)', 
      [nombre, peligro, hechos, recompensa, imagen]
    );
    res.json({ success: true });
  } catch (err) { 
    console.error(err);
    res.status(500).json({ error: "Error al guardar buscado" }); 
  }
});

app.post('/api/admin/delete-noticia', async (req, res) => {
  try {
    await pool.query('DELETE FROM noticias WHERE id = $1', [req.body.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al eliminar noticia" }); }
});

app.post('/api/admin/delete-buscado', async (req, res) => {
  try {
    await pool.query('DELETE FROM buscados WHERE id = $1', [req.body.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al eliminar buscado" }); }
});

app.post('/api/admin/accept-user', async (req, res) => {
  try {
    await pool.query('UPDATE usuarios SET status = $1 WHERE username = $2', ['aceptado', req.body.username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al aceptar usuario" }); }
});

app.post('/api/admin/delete-user', async (req, res) => {
  try {
    await pool.query('DELETE FROM usuarios WHERE username = $1', [req.body.username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al eliminar usuario" }); }
});

// Servidor escuchando
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 SERVIDOR ONLINE EN PUERTO ${PORT}`));
