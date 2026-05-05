require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./database'); // Usa el mismo database.js que el bot
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

app.use(express.json());
app.use(session({
    secret: 'buenos_aires_rp_session_secret',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

// RUTA CRÍTICA: Verifica si el usuario logueado existe en la DB de Render
app.get('/api/verificar-ciudadano', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
    
    try {
        // Consultamos la tabla que el bot acaba de verificar
        const result = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [req.user.id]);
        
        if (result.rows.length > 0) {
            // Si existe, enviamos sus datos a la web
            res.json({ registrado: true, datos: result.rows[0] });
        } else {
            // Si no existe, la web mostrará el mensaje de error o registro
            res.json({ registrado: false });
        }
    } catch (err) {
        console.error('Error al consultar DB desde la Web:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Rutas de Auth
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', {
    failureRedirect: '/',
    successRedirect: '/registro.html' // Cambia esto a tu página principal
}));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Web de Buenos Aires RP activo en puerto ${PORT}`);
    db.initDb().catch(e => console.log("DB ya conectada"));
});
