const express = require('express');
const axios = require('axios');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN DE BASE DE DATOS (PostgreSQL) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- MIDDLEWARES ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'buenos-aires-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Cambiar a true si usas HTTPS real en Render
}));

// --- VARIABLES DE CONFIGURACIÓN ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = "https://buenos-aires-rp-web-oficial.onrender.com/auth/callback";
const WEBHOOK_URL = "https://discord.com/api/webhooks/1501382372136976525/7uIl15bVW2WzMoaarAjBZvTwwxM9xQDI-TfIlW02P1E79nYv7TnYKdgd6zTJxZ-eFI94";

// --- RUTAS DE AUTENTICACIÓN (Solución a image_bc759a.png) ---

app.get('/auth/discord', (req, res) => {
    const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('No se proporcionó código de autorización.');

    try {
        const params = new URLSearchParams();
        params.append('client_id', CLIENT_ID);
        params.append('client_secret', CLIENT_SECRET);
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('redirect_uri', REDIRECT_URI);

        const response = await axios.post('https://discord.com/api/oauth2/token', params);
        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${response.data.access_token}` }
        });

        // Guardar sesión del usuario
        req.session.user = userRes.data;
        res.redirect('/registro.html');

    } catch (error) {
        console.error('Error en OAuth:', error.response?.data || error.message);
        res.status(500).send('Error durante el inicio de sesión con Discord.');
    }
});

// --- SISTEMA DE TRÁMITES (RENAPER) ---

app.post('/api/tramite', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'No autorizado' });

    const { nombre, apellido, roblox_user, motivo, edad } = req.body;
    const discord_id = req.session.user.id;
    const discord_tag = `${req.session.user.username}#${req.session.user.discriminator || '0'}`;

    try {
        // 1. Insertar en base de datos
        const query = `
            INSERT INTO solicitudes (nombre, apellido, roblox_user, motivo, edad, discord_id, estado, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, 'pendiente', NOW())
            RETURNING id;
        `;
        const values = [nombre, apellido, roblox_user, motivo, edad, discord_id];
        const dbRes = await pool.query(query, values);
        const tramiteId = dbRes.rows[0].id;

        // 2. Enviar notificación al Staff vía Webhook
        await axios.post(WEBHOOK_URL, {
            content: "📢 **Nueva solicitud de DNI detectada**",
            embeds: [{
                title: "Trámite RENAPER - Buenos Aires RP",
                color: 3447003,
                fields: [
                    { name: "🆔 ID Trámite", value: `#${tramiteId}`, inline: true },
                    { name: "👤 Ciudadano", value: `${nombre} ${apellido}`, inline: true },
                    { name: "🎮 Roblox", value: roblox_user, inline: true },
                    { name: "🎂 Edad In-Game", value: edad, inline: true },
                    { name: "💬 Discord Tag", value: discord_tag, inline: true },
                    { name: "📝 Motivo", value: motivo }
                ],
                footer: { text: "Sistema Automatizado de Identidad" },
                timestamp: new Date()
            }]
        });

        res.json({ success: true, redirect: '/espera.html' });

    } catch (err) {
        console.error('Error al procesar trámite:', err);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// --- CONSULTA DE ESTADO ---

app.get('/api/estado', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Sesión expirada' });

    try {
        const query = 'SELECT estado FROM solicitudes WHERE discord_id = $1 ORDER BY fecha DESC LIMIT 1';
        const result = await pool.query(query, [req.session.user.id]);

        if (result.rows.length === 0) {
            return res.json({ status: 'ninguno' });
        }

        res.json({ status: result.rows[0].estado });
    } catch (err) {
        res.status(500).json({ error: 'Error de conexión con la DB' });
    }
});

// --- CIERRE DE SESIÓN ---
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// --- MANEJO DE ERRORES 404 ---
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.listen(PORT, () => {
    console.log(`--- SERVIDOR ACTIVO EN PUERTO ${PORT} ---`);
    console.log(`URL de Retorno: ${REDIRECT_URI}`);
});
