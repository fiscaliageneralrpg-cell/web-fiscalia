/**
 * DEVHUB - BACKEND SERVER v1.0
 * Arquitectura: Node.js + Express + PostgreSQL
 * Descripción: Manejo de autenticación, validaciones y conexión a Render.
 */

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const morgan = require('morgan'); // Para logs de peticiones
const helmet = require('helmet'); // Seguridad de encabezados

const app = express();

// 1. CONFIGURACIÓN DE LA BASE DE DATOS
// Usamos un Pool de conexiones para mejorar el rendimiento
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Requerido para bases de datos externas como Render
    },
    max: 20, // Máximo de conexiones simultáneas
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// 2. MIDDLEWARES DE SEGURIDAD Y PARSEO
app.use(helmet({ contentSecurityPolicy: false })); // Protege contra ataques comunes
app.use(morgan('dev')); // Muestra las peticiones en la consola
app.use(express.json({ limit: '10mb' })); // Permite recibir JSON grandes
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 3. VERIFICADOR DE ESTADO DE BASE DE DATOS (Middleware Crítico)
// Si la base de datos de Render está caída, este código lo detecta antes de fallar
const checkDatabaseStatus = async (req, res, next) => {
    try {
        const client = await pool.connect();
        client.release();
        next();
    } catch (err) {
        console.error("CRITICAL ERROR: Database is unreachable.");
        if (req.path.startsWith('/api')) {
            return res.status(503).json({
                success: false,
                message: "ERROR_DB_OFFLINE: No se pudo detectar la base de datos en Render. Inténtalo más tarde."
            });
        }
        res.status(503).send("El servicio está temporalmente fuera de línea por mantenimiento de base de datos.");
    }
};

// 4. CREACIÓN AUTOMÁTICA DE TABLAS AL INICIAR
const initDatabase = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password TEXT NOT NULL,
            puntos_dev INT DEFAULT 0,
            fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            avatar_url TEXT DEFAULT 'https://i.pravatar.cc/150'
        );
    `;
    try {
        await pool.query(query);
        console.log("------------------------------------------");
        console.log("✅ ESTRUCTURA DE DATOS: Lista y verificada.");
        console.log("------------------------------------------");
    } catch (err) {
        console.error("❌ FALLO AL INICIALIZAR TABLAS:", err);
    }
};

initDatabase();

// 5. RUTAS DE NAVEGACIÓN (Frontend)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/registrar', (req, res) => res.sendFile(path.join(__dirname, 'public', 'registrar.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/foro', (req, res) => res.sendFile(path.join(__dirname, 'public', 'foro.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));

// 6. API DE AUTENTICACIÓN (LOGIN)
app.post('/api/login', checkDatabaseStatus, async (req, res) => {
    const { username, password } = req.body;
    
    // Log de intento de acceso
    console.log(`[LOGIN ATTEMPT]: User ${username} trying to connect...`);

    try {
        const userSearch = await pool.query('SELECT * FROM usuarios WHERE username = $1', [username]);
        
        // Error: Usuario no existe
        if (userSearch.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "LA CUENTA NO EXISTE: El nombre de usuario ingresado no está registrado en DevHub."
            });
        }

        const user = userSearch.rows[0];

        // Error: Contraseña incorrecta
        if (user.password !== password) {
            return res.status(401).json({
                success: false,
                message: "CONTRASEÑA INCORRECTA: La clave no coincide con nuestros registros."
            });
        }

        // Éxito: Sesión iniciada
        res.status(200).json({
            success: true,
            message: "SECCIÓN INICIADA: Autenticación exitosa.",
            user: {
                id: user.id,
                username: user.username,
                email: user.email
            }
        });

    } catch (err) {
        res.status(500).json({ success: false, message: "Error interno del servidor." });
    }
});

// 7. API DE REGISTRO
app.post('/api/registrar', checkDatabaseStatus, async (req, res) => {
    const { username, email, password } = req.body;

    try {
        const insertQuery = `
            INSERT INTO usuarios (username, email, password) 
            VALUES ($1, $2, $3) 
            RETURNING id
        `;
        const result = await pool.query(insertQuery, [username, email, password]);
        
        res.status(201).json({
            success: true,
            message: "REGISTRO COMPLETADO: Bienvenido a DevHub.",
            id: result.rows[0].id
        });

    } catch (err) {
        if (err.code === '23505') { // Código de PostgreSQL para duplicados
            return res.status(400).json({
                success: false,
                message: "ERROR AL CREAR CUENTA: El usuario o el correo ya están registrados."
            });
        }
        res.status(500).json({ success: false, message: "Error al guardar los datos." });
    }
});

// 8. MANEJO DE ERRORES 404
app.use((req, res) => {
    res.status(404).send("Lo sentimos, este recurso no existe en DevHub.");
});

// 9. ARRANQUE DEL SERVIDOR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    =============================================
    🚀 DEVHUB SERVER v1.0 - INICIADO
    🌐 LOCAL: http://localhost:${PORT}
    📡 DB: Conectado a Render PostgreSQL
    =============================================
    `);
});