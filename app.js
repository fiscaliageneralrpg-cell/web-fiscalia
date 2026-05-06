require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./database'); // Conexión a PostgreSQL en Render
const fs = require('fs');
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
    secret: 'buenos_aires_rp_ultra_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } 
}));
app.use(passport.initialize());
app.use(passport.session());

// --- API: VERIFICACIÓN DE CIUDADANO ---
app.get('/api/verificar-ciudadano', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ registrado: false });
    
    const discordId = req.user.id;

    try {
        // 1. Intentar buscar en la Base de Datos PostgreSQL (Prioridad)
        let result = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [discordId]);
        
        // 2. Si no está en la DB, buscar en el JSON (Compatibilidad)
        if (result.rows.length === 0) {
            const jsonPath = path.join(__dirname, 'data', 'usuarios.json');
            
            if (fs.existsSync(jsonPath)) {
                const usuariosJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                const u = usuariosJson[discordId]; // Formato ID como clave

                if (u) {
                    console.log(`✅ Usuario ${discordId} detectado en JSON. Sincronizando con DB...`);
                    // Migración automática a PostgreSQL
                    await db.query(
                        'INSERT INTO usuarios (discord_id, nombres, apellidos, nuip, nacionalidad, roblox_user, estado) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
                        [discordId, u.nombres, u.apellidos, u.nuip, u.nacionalidad, u.robloxUser || '', 'ACTIVO']
                    );
                    result = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [discordId]);
                }
            }
        }

        // 3. Respuesta al Frontend (registro.html)
        if (result.rows.length > 0) {
            const data = result.rows[0];
            res.json({
                registrado: true,
                datos: {
                    nombres: data.nombres,
                    apellidos: data.apellidos,
                    nuip: data.nuip,
                    nacionalidad: data.nacionalidad,
                    estado: data.estado
                }
            });
        } else {
            res.json({ registrado: false });
        }
    } catch (err) {
        console.error('❌ Error en API:', err);
        res.status(500).json({ registrado: false });
    }
});

// --- RUTAS DE AUTENTICACIÓN ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', {
    failureRedirect: '/',
    successRedirect: '/registro.html' 
}));

app.get('/auth/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// --- ARCHIVOS ESTÁTICOS ---
app.use(express.static(path.join(__dirname, 'public')));

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Web Buenos Aires RP activa en puerto ${PORT}`);
    db.initDb().catch(() => {}); // Asegura que la tabla exista
});
