require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');

const app = express();

// Configuración de la Base de Datos en Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Verificación y Creación de Tablas al iniciar
const setupDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(50) UNIQUE NOT NULL,
                password TEXT NOT NULL,
                biografia TEXT DEFAULT 'Sin biografía',
                es_premium BOOLEAN DEFAULT false,
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS codigos (
                id SERIAL PRIMARY KEY,
                titulo VARCHAR(100) NOT NULL,
                contenido TEXT NOT NULL,
                lenguaje VARCHAR(50) NOT NULL,
                autor VARCHAR(50),
                usuario_id INTEGER REFERENCES usuarios(id),
                fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("-----------------------------------------");
        console.log("✅ SISTEMA DE BASE DE DATOS CONECTADO");
        console.log("-----------------------------------------");
    } catch (err) {
        console.error("❌ ERROR CRÍTICO DB:", err.message);
    }
};
setupDB();

// Middlewares
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'codepass_ultra_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 } // 1 hora de sesión
}));

// Middleware de Protección de Rutas
const checkAuth = (req, res, next) => {
    if (req.session.userId) return next();
    res.redirect('/login');
};

// --- RUTAS DE NAVEGACIÓN ---

app.get('/', (req, res) => {
    res.render('index', { user: req.session.userName || null });
});

app.get('/registro', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('registro', { error: null });
});

app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('login', { error: null });
});

// --- LÓGICA DE USUARIOS ---

app.post('/auth/register', async (req, res) => {
    const { nombre, password, confirmPassword } = req.body;
    
    if (password !== confirmPassword) {
        return res.render('registro', { error: 'Las contraseñas no coinciden' });
    }

    try {
        const userExists = await pool.query('SELECT * FROM usuarios WHERE nombre = $1', [nombre]);
        if (userExists.rows.length > 0) {
            return res.render('registro', { error: 'El nombre de usuario ya está en uso' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        await pool.query(
            'INSERT INTO usuarios (nombre, password) VALUES ($1, $2)',
            [nombre, hashedPassword]
        );
        res.redirect('/login');
    } catch (err) {
        res.render('registro', { error: 'Error interno del servidor' });
    }
});

app.post('/auth/login', async (req, res) => {
    const { nombre, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE nombre = $1', [nombre]);
        if (result.rows.length === 0) {
            return res.render('login', { error: 'Usuario no encontrado' });
        }

        const validPass = await bcrypt.compare(password, result.rows[0].password);
        if (!validPass) {
            return res.render('login', { error: 'Contraseña incorrecta' });
        }

        req.session.userId = result.rows[0].id;
        req.session.userName = result.rows[0].nombre;
        res.redirect('/');
    } catch (err) {
        res.render('login', { error: 'Error al intentar iniciar sesión' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// --- GESTIÓN DE CÓDIGOS ---

app.get('/publicados', async (req, res) => {
    const result = await pool.query(`
        SELECT codigos.*, usuarios.nombre as creador 
        FROM codigos 
        LEFT JOIN usuarios ON codigos.usuario_id = usuarios.id 
        ORDER BY fecha_creacion DESC
    `);
    res.render('publicados', { lista: result.rows, user: req.session.userName });
});

app.post('/post/save', checkAuth, async (req, res) => {
    const { titulo, contenido, lenguaje } = req.body;
    try {
        await pool.query(
            'INSERT INTO codigos (titulo, contenido, lenguaje, autor, usuario_id) VALUES ($1, $2, $3, $4, $5)',
            [titulo, contenido, lenguaje, req.session.userName, req.session.userId]
        );
        res.redirect('/publicados');
    } catch (err) {
        res.send("Error al guardar el código");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 SERVIDOR ACTIVO EN PORT ${PORT}`);
});