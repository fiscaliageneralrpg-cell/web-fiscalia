require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./database');
const fs = require('fs');
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
    secret: 'bsas_rp_2026_secret',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// --- API DE VERIFICACIÓN ADAPTADA A TU JSON ---
app.get('/api/verificar-ciudadano', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ registrado: false });
    
    const discordId = req.user.id; // Ejemplo: "1096198349390090240"

    try {
        // 1. Intentar buscar en PostgreSQL primero
        let result = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [discordId]);
        
        if (result.rows.length === 0) {
            const jsonPath = path.join(__dirname, 'data', 'usuarios.json');
            
            if (fs.existsSync(jsonPath)) {
                const usuariosJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                
                // BUSQUEDA POR CLAVE (Tu formato: "ID": { datos })
                const u = usuariosJson[discordId];

                if (u) {
                    console.log(`✅ Migrando a ${u.nombres} desde JSON por ID.`);
                    // Insertar en DB para persistencia
                    await db.query(
                        'INSERT INTO usuarios (discord_id, nombres, apellidos, nuip, nacionalidad, roblox_user, estado) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                        [discordId, u.nombres, u.apellidos, u.nuip, u.nacionalidad, u.robloxUser, 'ACTIVO']
                    );
                    result = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [discordId]);
                }
            }
        }

        if (result.rows.length > 0) {
            return res.json({ registrado: true, datos: result.rows[0] });
        } else {
            return res.json({ registrado: false });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ registrado: false });
    }
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', {
    successRedirect: '/registro.html',
    failureRedirect: '/'
}));

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Web en puerto ${PORT}`);
    db.initDb().catch(() => {});
});
