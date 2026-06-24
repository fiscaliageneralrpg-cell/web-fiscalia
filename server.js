const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Configuración de la conexión a Render Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Obligatorio para Render
});

// ==========================================
// 🚀 AUTO-CREACIÓN DE TABLAS AL INICIAR
// ==========================================
const inicializarBaseDeDatos = async () => {
  try {
    // 1. Crear tabla de usuarios
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        username VARCHAR(100) PRIMARY KEY,
        password VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL
      );
    `);

    // 2. Crear tabla de buscados
    await pool.query(`
      CREATE TABLE IF NOT EXISTS buscados (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(250) NOT NULL
      );
    `);

    // 3. Crear tabla de noticias
    await pool.query(`
      CREATE TABLE IF NOT EXISTS noticias (
        id SERIAL PRIMARY KEY,
        titular VARCHAR(250) NOT NULL
      );
    `);

    // 4. Insertar la cuenta del Administrador Supremo automáticamente si no existe
    await pool.query(`
      INSERT INTO usuarios (username, password, role, status) 
      VALUES ('fiscaliageneralrpg@gmail.com', 'Fiscalia2026*', 'admin', 'aceptado')
      ON CONFLICT (username) DO NOTHING;
    `);

    console.log("✅ Base de datos verificada, tablas listas y cuenta Admin asegurada.");
  } catch (err) {
    console.error("❌ ERROR AL INICIALIZAR LA BASE DE DATOS:", err.message);
  }
};

// Ejecutar la inicialización
inicializarBaseDeDatos();

// Middleware para verificar si la base de datos está caída en tiempo real
const verificarConexionDB = async (req, res, next) => {
  try {
    await pool.query('SELECT 1');
    next();
  } catch (err) {
    console.error("❌ SOLICITUD RECHAZADA: La base de datos está desconectada.");
    return res.status(500).json({ error: "La base de datos no está conectada. Intente de nuevo en unos minutos." });
  }
};

// ==========================================
// 🛠️ RUTAS DE LA API
// ==========================================

// Registro de cuentas
app.post('/api/register', verificarConexionDB, async (req, res) => {
  const { username, password } = req.body;
  try {
    const userExists = await pool.query('SELECT * FROM usuarios WHERE username = $1', [username]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: "Este usuario ya se encuentra registrado." });
    }
    
    await pool.query(
      'INSERT INTO usuarios (username, password, role, status) VALUES ($1, $2, $3, $4)',
      [username, password, 'user', 'pendiente']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Error interno en el servidor al registrar cuenta." });
  }
});

// Inicio de Sesión
app.post('/api/login', verificarConexionDB, async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE username = $1 AND password = $2', [username, password]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Usuario o contraseña incorrectos." });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Error en el servidor al autenticar." });
  }
});

// Obtener datos del Admin (Usuarios, Buscados, Noticias)
app.get('/api/admin/data', verificarConexionDB, async (req, res) => {
  try {
    const usuarios = await pool.query('SELECT username, status, role FROM usuarios WHERE role != $1 ORDER BY username ASC', ['admin']);
    const buscados = await pool.query('SELECT id, nombre FROM buscados ORDER BY id DESC');
    const noticias = await pool.query('SELECT id, titular FROM noticias ORDER BY id DESC');
    res.json({ users: usuarios.rows, buscados: buscados.rows, noticias: noticias.rows });
  } catch (err) {
    res.status(500).json({ error: "Error al extraer datos de administración." });
  }
});

// Aceptar Usuario
app.post('/api/admin/accept-user', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('UPDATE usuarios SET status = $1 WHERE username = $2', ['aceptado', req.body.username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al actualizar usuario." }); }
});

// Eliminar Usuario
app.post('/api/admin/delete-user', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('DELETE FROM usuarios WHERE username = $1', [req.body.username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al borrar usuario." }); }
});

// Añadir Buscado
app.post('/api/admin/add-buscado', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('INSERT INTO buscados (nombre) VALUES ($1)', [req.body.nombre]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al guardar buscado." }); }
});

// Eliminar Buscado
app.post('/api/admin/delete-buscado', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('DELETE FROM buscados WHERE id = $1', [req.body.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al remover requerido." }); }
});

// Añadir Noticia
app.post('/api/admin/add-noticia', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('INSERT INTO noticias (titular) VALUES ($1)', [req.body.titular]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al guardar boletín." }); }
});

// Eliminar Noticia
app.post('/api/admin/delete-noticia', verificarConexionDB, async (req, res) => {
  try {
    await pool.query('DELETE FROM noticias WHERE id = $1', [req.body.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al remover boletín." }); }
});

// Consultar estado en vivo de un usuario común
app.get('/api/user-status/:username', verificarConexionDB, async (req, res) => {
  try {
    const result = await pool.query('SELECT status FROM usuarios WHERE username = $1', [req.params.username]);
    res.json({ status: result.rows[0]?.status || 'pendiente' });
  } catch (err) { res.status(500).json({ error: "Error de consulta." }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚖️ Servidor corriendo en el puerto ${PORT}`);
});