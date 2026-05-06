const express = require('express');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg'); // Para PostgreSQL en Render
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURACIÓN DE BASE DE DATOS
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// URL DEL WEBHOOK QUE GENERASTE
const WEBHOOK_STAFF = "https://discord.com/api/webhooks/1501382372136976525/7uIl15bVW2WzMoaarAjBZvTwwxM9xQDI-TfIlW02P1E79nYv7TnYKdgd6zTJxZ-eFI94";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Carpeta para tus archivos .html

// --- RUTAS DE AUTENTICACIÓN (Soluciona image_bc8199.png) ---

app.get('/auth/discord', (req, res) => {
    // URL de autorización de tu App en el Developer Portal
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send('No se recibió el código de Discord.');

    try {
        // Intercambiar código por token (Lógica de OAuth2)
        // Aquí obtendrías el ID del usuario de Discord para guardarlo en la DB
        res.redirect('/registro.html'); // Al loguearse lo mandas al formulario
    } catch (error) {
        console.error(error);
        res.status(500).send('Error en la autenticación.');
    }
});

// --- RUTA PARA ENVIAR EL FORMULARIO (RENAPER) ---

app.post('/api/enviar-solicitud', async (req, res) => {
    const { nombre, apellido, roblox_user, motivo } = req.body;

    try {
        // 1. Guardar en PostgreSQL
        await pool.query(
            'INSERT INTO solicitudes (nombre, apellido, roblox_user, motivo, estado) VALUES ($1, $2, $3, $4, $5)',
            [nombre, apellido, roblox_user, motivo, 'pendiente']
        );

        // 2. Enviar al canal de Discord usando tu Webhook
        await axios.post(WEBHOOK_STAFF, {
            embeds: [{
                title: "🆕 Nueva Solicitud de DNI - RENAPER",
                color: 7646431, // Color celeste
                fields: [
                    { name: "Nombre Completo", value: `${nombre} ${apellido}`, inline: true },
                    { name: "Usuario Roblox", value: roblox_user, inline: true },
                    { name: "Motivo", value: motivo }
                ],
                footer: { text: "Buenos Aires RP - Sistema de Identidad" },
                timestamp: new Date()
            }]
        });

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

// --- RUTA PARA CONSULTAR ESTADO (Usada por espera.html) ---

app.get('/api/check-status', async (req, res) => {
    try {
        // Aquí buscarías la última solicitud del usuario logueado
        // Por ahora simulamos que consulta la DB
        const result = await pool.query('SELECT estado FROM solicitudes ORDER BY id DESC LIMIT 1');
        res.json({ status: result.rows[0]?.estado || 'pendiente' });
    } catch (error) {
        res.status(500).json({ error: 'Error de DB' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
