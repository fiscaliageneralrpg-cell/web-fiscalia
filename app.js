require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./database');
const fs = require('fs'); // Necesario para leer el JSON
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

app.use(express.json());
app.use(session({
    secret: 'buenos_aires_rp_sinc_2026',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// --- API DE VERIFICACIÓN (MIGRA DATOS DE JSON A DB) ---
app.get('/api/verificar-ciudadano', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autorizado' });
    
    const discordId = req.user.id;

    try {
        // 1. Primero buscamos en la Base de Datos de Render
        let result = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [discordId]);
        
        // 2. Si NO aparece en la DB, buscamos en usuarios.json
        if (result.rows.length === 0) {
            const jsonPath = path.join(__dirname, 'data', 'usuarios.json');
            
            if (fs.existsSync(jsonPath)) {
                const rawData = fs.readFileSync(jsonPath);
                const usuariosJson = JSON.parse(rawData);
                
                // Buscamos al usuario en el array del JSON
                const usuarioEncontrado = usuariosJson.find(u => u.discord_id === discordId);

                if (usuarioEncontrado) {
                    console.log(`📦 Migrando datos de ${usuarioEncontrado.nombres} a la base de datos...`);
                    
                    // Insertamos los datos del JSON a la base de datos PostgreSQL
                    await db.query(
                        'INSERT INTO usuarios (discord_id, nombres, apellidos, nuip, nacionalidad, roblox_user, estado) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                        [
                            usuarioEncontrado.discord_id,
                            usuarioEncontrado.nombres,
                            usuarioEncontrado.apellidos,
                            usuarioEncontrado.nuip,
                            usuarioEncontrado.nacionalidad,
                            usuarioEncontrado.roblox_user,
                            usuarioEncontrado.estado || 'nuevo'
                        ]
                    );
                    
                    // Volvemos a consultar para enviar los datos recién guardados
                    result = await db.query('SELECT * FROM usuarios WHERE discord_id = $1', [discordId]);
                }
            }
        }

        // 3. Respuesta final
        if (result.rows.length > 0) {
            res.json({ registrado: true, datos: result.rows[0] });
        } else {
            res.json({ registrado: false });
        }

    } catch (err) {
        console.error('❌ Error en verificación:', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', {
    failureRedirect: '/',
    successRedirect: '/registro.html'
}));

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Web sincronizada en puerto ${PORT}`);
    db.initDb().catch(() => {});
});
