require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./database');
const path = require('path');

const app = express();

// --- CONFIGURACIÓN DE SESIÓN Y PASSPORT ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    // Aquí podrías guardar o actualizar el usuario en la DB si quisieras
    return done(null, profile);
}));

// --- MIDDLEWARES ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'buenos_aires_rp_ultra_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Cambiar a true si usas HTTPS/SSL en producción
}));

app.use(passport.initialize());
app.use(passport.session());

// --- API: VERIFICACIÓN DE CIUDADANO ---
// Esta es la ruta que el frontend consulta para quitar el "Cargando datos..."
app.get('/api/verificar-ciudadano', async (req, res) => {
    // Si no hay sesión de Discord
    if (!req.isAuthenticated()) {
        return res.status(401).json({ 
            registrado: false, 
            error: 'Sesión no iniciada' 
        });
    }

    try {
        // Consulta a la base de datos de Render (la misma que usa el bot)
        const query = 'SELECT * FROM usuarios WHERE discord_id = $1';
        const result = await db.query(query, [req.user.id]);

        if (result.rows.length > 0) {
            // Usuario encontrado: Enviamos sus datos
            return res.status(200).json({
                registrado: true,
                user: {
                    username: req.user.username,
                    avatar: req.user.avatar,
                    id: req.user.id
                },
                datos: result.rows[0]
            });
        } else {
            // Usuario no encontrado en la DB
            return res.status(200).json({
                registrado: false,
                user: {
                    username: req.user.username,
                    id: req.user.id
                },
                mensaje: 'Ciudadano no registrado en el sistema'
            });
        }
    } catch (err) {
        console.error('❌ Error en API /verificar-ciudadano:', err);
        return res.status(500).json({ 
            registrado: false, 
            error: 'Error interno del servidor al consultar la DB' 
        });
    }
});

// --- RUTAS DE AUTENTICACIÓN ---
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/callback', passport.authenticate('discord', {
    failureRedirect: '/error.html'
}), (req, res) => {
    // Redirige a la página donde está el script de "Cargando datos"
    res.redirect('/registro.html'); 
});

app.get('/auth/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// --- SERVIDOR DE ARCHIVOS ESTÁTICOS ---
// IMPORTANTE: Colocar después de las rutas de la API
app.use(express.static(path.join(__dirname, 'public')));

// Manejo de errores 404 para archivos no encontrados
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
    console.log('-------------------------------------------');
    console.log(`🚀 Web Buenos Aires RP ejecutándose en puerto ${PORT}`);
    console.log(`🔗 URL local: http://localhost:${PORT}`);
    console.log('-------------------------------------------');
    
    // Inicializar conexión a DB al arrancar la web
    try {
        await db.initDb();
    } catch (e) {
        console.log('ℹ️ La DB ya fue inicializada por el proceso principal.');
    }
});
