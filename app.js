require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./database');
const path = require('path');

const app = express();

// Configuración de Passport para Discord
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

// Middlewares Globales
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'buenos_aires_rp_ultra_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 60000 * 60 * 24 } // 24 horas
}));
app.use(passport.initialize());
app.use(passport.session());

// --- ENDPOINTS API ---

// 1. Obtener info básica del usuario para el formulario
app.get('/api/user-info', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "Inicia sesión" });
    res.json({
        id: req.user.id,
        username: req.user.username,
        avatar: req.user.avatar,
        global_name: req.user.global_name
    });
});

// 2. Procesar el envío del DNI desde la Web
app.post('/api/enviar-solicitud', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "No autorizado" });

    const { robloxUser, nombres, apellidos, nacimiento, lugarNacimiento, nacionalidad, sexo, motivo } = req.body;

    try {
        // Verificar si ya tiene una solicitud pendiente o es ciudadano
        const check = await db.query('SELECT * FROM solicitudes WHERE discord_id = $1 AND estado = $2', [req.user.id, 'PENDIENTE']);
        if (check.rows.length > 0) {
            return res.status(400).json({ error: "Ya tienes una solicitud en revisión." });
        }

        const sql = `
            INSERT INTO solicitudes (discord_id, nombres, apellidos, roblox_user, nacimiento, lugar_nacimiento, nacionalidad, genero, motivo)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `;
        await db.query(sql, [req.user.id, nombres, apellidos, robloxUser, nacimiento, lugarNacimiento, nacionalidad, sexo, motivo]);
        
        res.json({ success: true, message: "Solicitud enviada al Ministerio." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error al procesar el registro." });
    }
});

// 3. Verificar si el usuario ya es Ciudadano Aceptado
app.get('/api/verificar-ciudadano', async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ registrado: false, auth: false });
    
    try {
        const result = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [req.user.id]);
        if (result.rows.length > 0) {
            res.json({ registrado: true, auth: true, datos: result.rows[0] });
        } else {
            res.json({ registrado: false, auth: true });
        }
    } catch (err) {
        res.status(500).json({ error: "Error de servidor" });
    }
});

// Rutas de Autenticación
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', {
    failureRedirect: '/',
    successRedirect: '/registro.html'
}));
app.get('/auth/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Inicio del Servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`🚀 Servidor Web en puerto ${PORT}`);
    await db.initDb();
});
