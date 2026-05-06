require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./database'); 
const path = require('path');

const app = express();

// --- CONFIGURACIÓN DE PASSPORT ---
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
    secret: 'buenos_aires_secret_key',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// --- API DE VERIFICACIÓN (Evita el 'undefined') ---
app.get('/api/verificar-ciudadano', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ registrado: false, sesion: false });
    
    try {
        const result = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [req.user.id]);
        
        if (result.rows.length > 0) {
            const u = result.rows[0];
            res.json({
                registrado: true,
                sesion: true,
                user: { username: req.user.username, avatar: req.user.avatar, id: req.user.id },
                datos: {
                    nombres: u.nombres,
                    apellidos: u.apellidos,
                    nuip: u.nuip,
                    nacionalidad: u.nacionalidad,
                    estado: u.estado || 'ACTIVO'
                }
            });
        } else {
            // Usuario logueado pero NO registrado en el Bot
            res.json({ registrado: false, sesion: true, user: req.user });
        }
    } catch (err) {
        res.status(500).json({ registrado: false, error: "Error de base de datos" });
    }
});

// --- RUTAS DE AUTH ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { failureRedirect: '/', successRedirect: '/registro.html' }));
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Web corriendo en puerto ${PORT}`));
