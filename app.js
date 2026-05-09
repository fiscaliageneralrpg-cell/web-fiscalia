const express = require('express');
const axios = require('axios');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURACIÓN DE BASE DE DATOS
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// MIDDLEWARES ESSENCIALES
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'ba_rp_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 } // 1 hora de sesión
}));

// CONFIGURACIÓN DE DISCORD (Solución a image_bc759a.png)
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = "https://buenos-aires-rp-web-oficial.onrender.com/auth/callback";
const WEBHOOK_STAFF = "https://discord.com/api/webhooks/1501382372136976525/7uIl15bVW2WzMoaarAjBZvTwwxM9xQDI-TfIlW02P1E79nYv7TnYKdgd6zTJxZ-eFI94";

// --- RUTAS DE AUTENTICACIÓN ---

app.get('/auth/discord', (req, res) => {
    const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/?error=no_code');

    try {
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
        });

        // Guardamos los datos para el registro
        req.session.user = {
            id: userRes.data.id,
            username: userRes.data.username,
            display_name: userRes.data.global_name || userRes.data.username,
            avatar: userRes.data.avatar 
                ? `https://cdn.discordapp.com/avatars/${userRes.data.id}/${userRes.data.avatar}.png` 
                : 'https://discord.com/assets/embed/avatars/0.png'
        };
        res.redirect('/registro.html');
    } catch (err) {
        console.error("Error Auth:", err.message);
        res.status(500).send("Error de autenticación.");
    }
});

// API para que el HTML cargue los datos del usuario
app.get('/api/user-info', (req, res) => {
    if (req.session.user) return res.json(req.session.user);
    res.status(401).json({ error: "No logueado" });
});

// --- PROCESO DE TRÁMITE RENAPER ---

app.post('/api/submit-dni', async (req, res) => {
    if (!req.session.user) return res.status(401).send("Debes iniciar sesión");

    const { nombre, apellido, edad, motivo, roblox } = req.body;

    try {
        // 1. Guardar en PostgreSQL
        const dbQuery = 'INSERT INTO solicitudes (discord_id, nombre, apellido, edad, motivo, roblox, estado) VALUES ($1, $2, $3, $4, $5, $6, $7)';
        await pool.query(dbQuery, [req.session.user.id, nombre, apellido, edad, motivo, roblox, 'pendiente']);

        // 2. Enviar al Staff vía Webhook
        await axios.post(WEBHOOK_STAFF, {
            embeds: [{
                title: "🇦🇷 NUEVO TRÁMITE DE DNI - RENAPER",
                color: 15844367, // Dorado/Amarillo
                thumbnail: { url: req.session.user.avatar },
                fields: [
                    { name: "👤 Solicitante", value: `${nombre} ${apellido}`, inline: true },
                    { name: "🎮 Roblox", value: roblox, inline: true },
                    { name: "🎂 Edad", value: edad, inline: true },
                    { name: "💬 Discord ID", value: req.session.user.id, inline: true },
                    { name: "📝 Motivo", value: motivo }
                ],
                footer: { text: "Buenos Aires RP - Sistema de Identidad" },
                timestamp: new Date()
            }]
        });

        res.json({ success: true });
    } catch (err) {
        console.error("Error Trámite:", err.message);
        res.status(500).json({ success: false });
    }
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
