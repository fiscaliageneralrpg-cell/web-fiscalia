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
// Usa los IDs que me pasaste anteriormente
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
    scope: ['identify', 'guilds', 'guilds.members.read'] 
}, (at, rt, profile, done) => {
    return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.use(session({ 
    secret: 'buenos_aires_rp_secret', 
    resave: false, 
    saveUninitialized: false 
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- LÓGICA DE CONEXIÓN CON EL OTRO HOSTING ---
// IMPORTANTE: Como HidenCloud es privado, necesitas la URL de la API o un link público.
const URL_JSON_HIDENCLOUD = "https://TU_URL_DIRECTA_AL_JSON"; 

async function obtenerUsuariosActualizados(discordId) {
    try {
        // Axios hace la petición al otro hosting en tiempo real
        const respuesta = await axios.get(URL_JSON_HIDENCLOUD, {
            // Si el panel pide autenticación, se pondría aquí
            headers: { 'Cache-Control': 'no-cache' } 
        });
        const usuarios = respuesta.data;
        return usuarios.some(u => u.discord_id === discordId);
    } catch (error) {
        console.error("Error al leer usuarios.json de HidenCloud:", error.message);
        return false;
    }
}

// --- RUTAS ---

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { 
    failureRedirect: '/', 
    successRedirect: '/registro.html' 
}));

app.get('/api/verificar-estado', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autorizado' });
    
    // Verificamos el JSON externo en tiempo real
    const tieneCedula = await obtenerUsuariosActualizados(req.user.id);
    
    // Verificamos roles (esto requiere que el bot esté en el server)
    const misRoles = req.user.guilds || [];
    
    res.json({ 
        id: req.user.id,
        username: req.user.username,
        tieneCedula: tieneCedula,
        roles: misRoles
    });
});

app.post('/api/finalizar-registro', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send('No autorizado');
    
    const { motivo } = req.body;
    try {
        // Guardamos en la DB de Render para el sistema de logs/admin
        await db.query(
            'INSERT INTO usuarios (discord_id, username, motivo, estado) VALUES ($1, $2, $3, $4) ON CONFLICT (discord_id) DO UPDATE SET motivo = $3',
            [req.user.id, req.user.username, motivo, 'pendiente']
        );
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error al guardar registro');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 Sistema online en puerto ${PORT}`);
});
