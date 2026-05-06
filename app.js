require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./database'); // Tu conexión a PostgreSQL
const path = require('path');

const app = express();

// --- CONFIGURACIÓN DE IDENTIDAD (Discord) ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify']
}, (at, rt, profile, done) => done(null, profile)));

// --- MIDDLEWARES ---
app.use(express.json());
app.use(session({
    secret: 'buenos_aires_rp_key_2026',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// --- ENDPOINTS DE LA WEB ---

// Obtener info del usuario logueado para el saludo inicial
app.get('/api/user-info', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "No logueado" });
    res.json({
        id: req.user.id,
        username: req.user.username,
        avatar: req.user.avatar
    });
});

// Enviar solicitud de ciudadanía al canal de Staff y DB
app.post('/api/enviar-solicitud', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send("No autorizado");

    const d = req.body;
    try {
        // Insertar en tabla de solicitudes (Estado PENDIENTE)
        await db.query(
            `INSERT INTO solicitudes (discord_id, nombres, apellidos, roblox_user, nacimiento, lugar_nacimiento, nacionalidad, genero, motivo, estado, fecha_solicitud) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_DATE)`,
            [req.user.id, d.nombres, d.apellidos, d.robloxUser, d.nacimiento, d.lugarNacimiento, d.nacionalidad, d.sexo, d.motivo, 'PENDIENTE']
        );
        
        // Aquí podrías añadir una llamada a un Webhook de Discord para avisar al Staff
        res.sendStatus(200);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error al guardar solicitud");
    }
});

// Ver estado para mostrar en la web si ya fue aceptado
app.get('/api/verificar-ciudadano', async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ registrado: false });
    
    const result = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [req.user.id]);
    if (result.rows.length > 0) {
        res.json({ registrado: true, datos: result.rows[0] });
    } else {
        res.json({ registrado: false });
    }
});

// --- RUTAS DE AUTENTICACIÓN ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { failureRedirect: '/', successRedirect: '/registro.html' }));
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(process.env.PORT || 10000, () => console.log("🚀 Web Server Ready"));
