require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');
const path = require('path');
const db = require('./database');

const app = express();

// --- CONFIGURACIÓN DE ROLES ---
const ROLES = {
    CIVIL: '1493350442644537464',
    POLICIA: '1493350424714150061',
    ADMIN: '1493345430094876784'
};

// --- ESTRATEGIA DE DISCORD ---
passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify', 'guilds', 'guilds.members.read'] // Permiso para ver roles
}, (at, rt, profile, done) => {
    // Buscamos si el usuario tiene alguno de los roles en tu servidor
    const member = profile.guilds.find(g => g.id === 'TU_SERVER_ID'); // Pon el ID de tu servidor de Discord
    profile.isAdmin = member && member.permissions & 0x8; // Ejemplo: Check si es admin
    return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.use(session({ secret: 'buenos_aires_rp', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- FUNCIÓN PARA LEER EL HOSTING EXTERNO ---
// NOTA: Esta URL debe ser el enlace "Directo" o "Raw", no el del panel de edición.
const URL_JSON_EXTERNO = "https://TU_DOMINIO_O_IP_DIRECTA/data/usuarios.json"; 

async function verificarCedulaExterna(discordId) {
    try {
        // Si el panel de HidenCloud requiere API Key, se añade en los headers
        const respuesta = await axios.get(URL_JSON_EXTERNO);
        const usuarios = respuesta.data;
        return usuarios.some(u => u.discord_id === discordId);
    } catch (error) {
        console.error("Error al conectar con HidenCloud:", error.message);
        return false;
    }
}

// --- RUTAS ---

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { 
    failureRedirect: '/', 
    successRedirect: '/registro.html' 
}));

// API para que el frontend sepa el estado y los roles
app.get('/api/verificar-estado', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'No logueado' });
    
    const tieneCedula = await verificarCedulaExterna(req.user.id);
    
    // Aquí verificamos si tiene roles específicos (esto viene del scope guilds.members.read)
    const misRoles = req.user.guilds ? req.user.guilds : []; 
    
    res.json({ 
        username: req.user.username,
        tieneCedula: tieneCedula,
        roles: misRoles
    });
});

app.post('/api/finalizar-registro', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send('No autorizado');
    
    const { motivo } = req.body;
    try {
        await db.query(
            'INSERT INTO usuarios (discord_id, username, motivo, estado) VALUES ($1, $2, $3, $4) ON CONFLICT (discord_id) DO UPDATE SET motivo = $3',
            [req.user.id, req.user.username, motivo, 'pendiente']
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).send('Error en base de datos');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🔥 Web activa en puerto ${PORT}`));
