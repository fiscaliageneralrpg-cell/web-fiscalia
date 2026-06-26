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

// Roles válidos del sistema, en orden de jerarquía ascendente
const ROLES_VALIDOS = ['user', 'policial', 'altos_mandos', 'admin'];

// AUTO-REPARACIÓN DE BASE DE DATOS
const inicializarBaseDeDatos = async () => {
  try {
    // 1. Crear tablas si no existen
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (username VARCHAR(100) PRIMARY KEY, password VARCHAR(250) NOT NULL, role VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL);
      CREATE TABLE IF NOT EXISTS buscados (id SERIAL PRIMARY KEY, nombre VARCHAR(250) NOT NULL, peligro VARCHAR(50), descripcion TEXT, recompensa VARCHAR(100), imagen TEXT);
      CREATE TABLE IF NOT EXISTS noticias (id SERIAL PRIMARY KEY, titular VARCHAR(250) NOT NULL, descripcion TEXT, imagen TEXT, fecha VARCHAR(50));
      CREATE TABLE IF NOT EXISTS denuncias (id SERIAL PRIMARY KEY, usuario VARCHAR(100), titulo VARCHAR(250), descripcion TEXT, evidencia TEXT, fecha VARCHAR(50), estado_actual VARCHAR(250) DEFAULT 'Denuncia Enviada');
      CREATE TABLE IF NOT EXISTS estados_denuncias (id SERIAL PRIMARY KEY, denuncia_id INTEGER REFERENCES denuncias(id) ON DELETE CASCADE, mensaje TEXT, fecha VARCHAR(50));
      CREATE TABLE IF NOT EXISTS arrestos (id SERIAL PRIMARY KEY, usuario VARCHAR(100), razon TEXT, delito TEXT, tiempo VARCHAR(100), foto TEXT, arrestado_por VARCHAR(100), fecha VARCHAR(50));
    `);

    // 2. REPARAR: Asegurar que la columna 'estado_actual' exista (por si la tabla se creó antes)
    try {
        await pool.query("ALTER TABLE denuncias ADD COLUMN IF NOT EXISTS estado_actual VARCHAR(250) DEFAULT 'Denuncia Enviada'");
    } catch (e) { /* Ya existe */ }

    // 3. REPARAR: Asegurar que existan las columnas de datos personales del usuario
    try {
        await pool.query(`
          ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nombre_completo VARCHAR(250);
          ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sexo VARCHAR(20);
          ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nacionalidad VARCHAR(100);
          ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS lugar_nacimiento VARCHAR(150);
          ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fecha_nacimiento VARCHAR(50);
          ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS roblox_user VARCHAR(100);
          ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cedula VARCHAR(50);
        `);
    } catch (e) { /* Ya existen */ }

    const adminEmail = 'fiscaliageneralrpg@gmail.com';
    const checkAdmin = await pool.query("SELECT * FROM usuarios WHERE username = $1", [adminEmail]);
    if (checkAdmin.rows.length === 0) {
        const hashedPassword = await bcrypt.hash('Fiscalia2026*', 10);
        await pool.query(
          "INSERT INTO usuarios (username, password, role, status, nombre_completo, sexo, nacionalidad, lugar_nacimiento, fecha_nacimiento, roblox_user, cedula) VALUES ($1, $2, 'admin', 'aceptado', $3, $4, $5, $6, $7, $8, $9)",
          [adminEmail, hashedPassword, 'Administración Fiscalía', 'No especifica', 'Colombia', 'Bogotá', '01/01/2000', 'admin_rp', '0000000000']
        );
    }
    console.log("⚖️ SISTEMA BD: Verificado y Reparado.");
  } catch (err) { console.error("❌ ERROR CRÍTICO BD:", err.message); }
};
inicializarBaseDeDatos();

// --- RUTAS API ---
app.post('/api/register', async (req, res) => {
  try {
    const {
      username, password,
      nombre_completo, sexo, nacionalidad,
      lugar_nacimiento, fecha_nacimiento,
      roblox_user, cedula
    } = req.body;

    if (!username || !password || !nombre_completo || !sexo || !nacionalidad || !lugar_nacimiento || !fecha_nacimiento || !roblox_user || !cedula) {
      return res.status(400).json({ error: "Completa todos los campos." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO usuarios
        (username, password, role, status, nombre_completo, sexo, nacionalidad, lugar_nacimiento, fecha_nacimiento, roblox_user, cedula)
       VALUES ($1, $2, 'user', 'aceptado', $3, $4, $5, $6, $7, $8, $9)`,
      [username, hashedPassword, nombre_completo, sexo, nacionalidad, lugar_nacimiento, fecha_nacimiento, roblox_user, cedula]
    );
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
    res.json({
      success: true,
      user: {
        username: user.username,
        role: user.role,
        nombre_completo: user.nombre_completo,
        sexo: user.sexo,
        nacionalidad: user.nacionalidad,
        lugar_nacimiento: user.lugar_nacimiento,
        fecha_nacimiento: user.fecha_nacimiento,
        roblox_user: user.roblox_user,
        cedula: user.cedula
      }
    });
  } catch (err) { res.status(500).json({ error: "Error en el login." }); }
});

app.post('/api/denuncias/enviar', async (req, res) => {
  try {
    const { usuario, titulo, descripcion, evidencia, fecha } = req.body;
    const result = await pool.query(
      "INSERT INTO denuncias (usuario, titulo, descripcion, evidencia, fecha) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [usuario, titulo, descripcion, evidencia, fecha]
    );
    await pool.query("INSERT INTO estados_denuncias (denuncia_id, mensaje, fecha) VALUES ($1, $2, $3)", [result.rows[0].id, 'Denuncia enviada exitosamente.', fecha]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error al enviar denuncia" }); }
});

app.get('/api/denuncias/mis-denuncias/:usuario', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM denuncias WHERE usuario = $1 ORDER BY id DESC", [req.params.usuario]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Error" }); }
});

app.get('/api/denuncias/estados/:id', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM estados_denuncias WHERE denuncia_id = $1 ORDER BY id ASC", [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Error" }); }
});

// Esta ruta es compartida por admin, altos_mandos y policial (cada panel pinta solo lo que le corresponde)
app.get('/api/admin/data', async (req, res) => {
  try {
    const u = await pool.query('SELECT username, role, nombre_completo, sexo, nacionalidad, lugar_nacimiento, fecha_nacimiento, roblox_user, cedula FROM usuarios');
    const b = await pool.query('SELECT * FROM buscados ORDER BY id DESC');
    const n = await pool.query('SELECT * FROM noticias ORDER BY id DESC');
    const d = await pool.query('SELECT * FROM denuncias ORDER BY id DESC');
    const a = await pool.query('SELECT * FROM arrestos ORDER BY id DESC');
    res.json({ users: u.rows, buscados: b.rows, noticias: n.rows, denuncias: d.rows, arrestos: a.rows });
  } catch (err) {
    console.error("❌ ERROR EN /api/admin/data:", err);
    res.status(500).json({ error: err.message || "Error" });
  }
});

// --- ARRESTOS ---
app.post('/api/admin/add-arresto', async (req, res) => {
  try {
    const { usuario, razon, delito, tiempo, foto, arrestado_por, fecha } = req.body;
    if (!usuario || !razon || !delito || !tiempo) return res.status(400).json({ error: "Completa todos los campos." });
    await pool.query(
      "INSERT INTO arrestos (usuario, razon, delito, tiempo, foto, arrestado_por, fecha) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [usuario, razon, delito, tiempo, foto || '', arrestado_por, fecha]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ ERROR AL REGISTRAR ARRESTO:", err);
    res.status(500).json({ error: err.message || "Error al registrar el arresto" });
  }
});

app.post('/api/admin/delete-arresto', async (req, res) => {
  try {
    await pool.query('DELETE FROM arrestos WHERE id = $1', [req.body.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Error" }); }
});

app.get('/api/arrestos/mis-antecedentes/:usuario', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM arrestos WHERE usuario = $1 ORDER BY id DESC", [req.params.usuario]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Error" }); }
});

app.post('/api/admin/actualizar-estado', async (req, res) => {
  try {
    const { denuncia_id, mensaje, fecha } = req.body;
    if (!denuncia_id || !mensaje) return res.status(400).json({ error: "Faltan datos (ID o Mensaje)" });

    // 1. Actualizar tabla principal
    const updateRes = await pool.query("UPDATE denuncias SET estado_actual = $1 WHERE id = $2", [mensaje, denuncia_id]);
    if (updateRes.rowCount === 0) return res.status(404).json({ error: "No se encontró la denuncia con ese ID" });

    // 2. Insertar en historial
    await pool.query("INSERT INTO estados_denuncias (denuncia_id, mensaje, fecha) VALUES ($1, $2, $3)", [denuncia_id, mensaje, fecha]);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ ERROR ACTUALIZAR ESTADO:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- GESTIÓN DE RANGOS ---
// Ruta genérica de cambio de rango. Usada por:
//   - admin.html  -> puede poner cualquier rango (user/policial/altos_mandos/admin)
//   - altos-mandos.html -> solo puede ascender a 'policial' o bajar a 'user' (nunca dar admin/altos_mandos)
// La validación de "quién puede asignar qué" se hace aquí en el servidor, no solo en el frontend.
app.post('/api/admin/set-role', async (req, res) => {
  try {
    const { username, role, actor_role } = req.body;

    if (!username || !role) return res.status(400).json({ error: "Faltan datos (username o role)" });
    if (!ROLES_VALIDOS.includes(role)) return res.status(400).json({ error: "Rango no válido." });

    // Restricción de seguridad: altos_mandos solo puede mover entre 'user' y 'policial'.
    // Nunca puede otorgar 'altos_mandos' ni 'admin', ni quitarle el rango a un admin/altos_mandos.
    if (actor_role === 'altos_mandos') {
      if (!['user', 'policial'].includes(role)) {
        return res.status(403).json({ error: "Altos Mandos solo puede asignar el rango Policial o Usuario." });
      }
      const target = await pool.query("SELECT role FROM usuarios WHERE username = $1", [username]);
      if (target.rows.length && ['admin', 'altos_mandos'].includes(target.rows[0].role)) {
        return res.status(403).json({ error: "No puedes modificar el rango de un Admin o Alto Mando." });
      }
    }

    await pool.query("UPDATE usuarios SET role = $1 WHERE username = $2", [role, username]);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ ERROR SET-ROLE:", err);
    res.status(500).json({ error: err.message || "Error al actualizar el rango" });
  }
});

// Mantenidas por compatibilidad con paneles/llamadas antiguas
app.post('/api/admin/make-admin', async (req, res) => { await pool.query("UPDATE usuarios SET role = 'admin' WHERE username = $1", [req.body.username]); res.json({ success: true }); });
app.post('/api/admin/delete-user', async (req, res) => { await pool.query('DELETE FROM usuarios WHERE username = $1', [req.body.username]); res.json({ success: true }); });
app.post('/api/admin/add-noticia', async (req, res) => { await pool.query('INSERT INTO noticias (titular, descripcion, imagen, fecha) VALUES ($1, $2, $3, $4)', [req.body.titular, req.body.descripcion, req.body.imagen, req.body.fecha]); res.json({ success: true }); });
app.post('/api/admin/add-buscado', async (req, res) => { await pool.query('INSERT INTO buscados (nombre, peligro, descripcion, recompensa, imagen) VALUES ($1, $2, $3, $4, $5)', [req.body.nombre, req.body.peligro, req.body.hechos, req.body.recompensa, req.body.imagen]); res.json({ success: true }); });
app.post('/api/admin/delete-noticia', async (req, res) => { await pool.query('DELETE FROM noticias WHERE id = $1', [req.body.id]); res.json({ success: true }); });
app.post('/api/admin/delete-buscado', async (req, res) => { await pool.query('DELETE FROM buscados WHERE id = $1', [req.body.id]); res.json({ success: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚖️ Servidor Fiscalía corriendo en el puerto ${PORT}`);
});
