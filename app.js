require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./database');
const path = require('path');
const axios = require('axios'); // Para enviar el Webhook

const app = express();

// --- CONFIGURACIÓN DE DISCORD WEBHOOK ---
const DISCORD_WEBHOOK_URL = "TU_WEBHOOK_URL_AQUÍ"; // Créalo en: Ajustes canal > Integraciones > Webhooks

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify']
}, (at, rt, profile, done) => done(null, profile)));

app.use(express.json());
app.use(session({
    secret: 'buenos_aires_rp_2026',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// --- ENDPOINTS LÓGICOS ---

// 1. Enviar Solicitud + Notificar a Discord
app.post('/api/enviar-solicitud', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "No autorizado" });

    const d = req.body;
    try {
        // Guardar en DB
        await db.query(
            `INSERT INTO solicitudes (discord_id, nombres, apellidos, roblox_user, nacimiento, lugar_nacimiento, nacionalidad, genero, motivo) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [req.user.id, d.nombres, d.apellidos, d.robloxUser, d.nacimiento, d.lugarNacimiento, d.nacionalidad, d.sexo, d.motivo]
        );

        // Enviar notificación al canal 1482550071521185926 vía Webhook
        await axios.post(DISCORD_WEBHOOK_URL, {
            embeds: [{
                title: "📥 NUEVA SOLICITUD DE DNI",
                color: 7646431, // Color azul Argentina
                fields: [
                    { name: "Ciudadano", value: `<@${req.user.id}>`, inline: true },
                    { name: "Roblox", value: d.robloxUser, inline: true },
                    { name: "Nombre IC", value: `${d.nombres} ${d.apellidos}` },
                    { name: "Motivo", value: d.motivo }
                ],
                footer: { text: "ID del sistema: " + req.user.id }
            }]
        });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error en el sistema federal." });
    }
});

// 2. Verificar estado para redirección
app.get('/api/check-status', async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ status: 'login' });

    // Caso 1: ¿Es ya un ciudadano validado?
    const ciudadano = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [req.user.id]);
    if (ciudadano.rows.length > 0) return res.json({ status: 'aceptado' });

    // Caso 2: ¿Tiene solicitud pendiente?
    const solicitud = await db.query('SELECT estado FROM solicitudes WHERE discord_id = $1 ORDER BY fecha_solicitud DESC LIMIT 1', [req.user.id]);
    if (solicitud.rows.length > 0) {
        return res.json({ status: solicitud.rows[0].estado.toLowerCase() }); // 'pendiente' o 'rechazado'
    }

    // Caso 3: No ha hecho nada
    return res.json({ status: 'nuevo' });
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 10000);
