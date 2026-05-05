require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./database');
const path = require('path');

const app = express();

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
    secret: 'buenos_aires_rp_secure_key',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

// API que verifica si el usuario tiene cédula en la DB compartida
app.get('/api/verificar-ciudadano', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autorizado' });
    
    try {
        // Busca al usuario por su Discord ID en la base de datos de Render
        const result = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [req.user.id]);
        
        if (result.rows.length > 0) {
            res.json({ registrado: true, datos: result.rows[0] });
        } else {
            res.json({ registrado: false }); // Mostrará la pantalla de "Cédula no encontrada"
        }
    } catch (err) {
        res.status(500).json({ error: 'Error en la base de datos' });
    }
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', {
    failureRedirect: '/',
    successRedirect: '/registro.html'
}));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor Web activo en puerto ${PORT}`));
