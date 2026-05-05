require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const path = require('path');
const db = require('./database'); // Asegúrate de tener tu archivo database.js configurado

const app = express();

// --- CONFIGURACIÓN DE IDENTIDADES Y CANALES ---
const ROLES = {
    CIVIL: '1493350442644537464',
    POLICIA: '1493350424714150061',
    ADMIN: '1493345430094876784'
};
const CANAL_LOGS = '1482550071521185926'; // Canal donde llegarán las solicitudes

// --- INICIALIZACIÓN DEL BOT DE DISCORD ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ] 
});

// --- CONFIGURACIÓN DE PASSPORT (OAuth2) ---
passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify', 'guilds', 'guilds.members.read']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Middlewares
app.use(session({ 
    secret: 'buenos_aires_rp_2026_secret', 
    resave: false, 
    saveUninitialized: false 
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- URL DE HIDENCLOUD ---
const URL_HIDENCLOUD = "https://tu-hosting-externo.com/data/usuarios.json"; 

// --- RUTAS DE AUTENTICACIÓN ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { 
    failureRedirect: '/', 
    successRedirect: '/registro.html' 
}));

/**
 * ENDPOINT DE VERIFICACIÓN (ESTRUCTURA DE OBJETO)
 * Esta es la parte que corrige el error de "Acceso Denegado"
 */
app.get('/api/verificar-estado', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Sesión no iniciada' });
    
    try {
        // Obtenemos el JSON de HidenCloud
        const respuestaHC = await axios.get(URL_HIDENCLOUD, { headers: { 'Cache-Control': 'no-cache' } });
        const dataHC = respuestaHC.data;
        
        // Accedemos directamente por el ID de Discord (llave del objeto)
        const infoCedula = dataHC[req.user.id]; 
        
        // Consultamos el estado en la base de datos de Render
        const consultaDB = await db.query('SELECT estado FROM usuarios WHERE discord_id = $1', [req.user.id]);
        const estadoLocal = consultaDB.rows.length > 0 ? consultaDB.rows[0].estado : 'nuevo';
        
        res.json({ 
            id: req.user.id,
            username: req.user.username,
            nombreReal: infoCedula ? `${infoCedula.nombres} ${infoCedula.apellidos}` : null,
            tieneCedula: !!infoCedula, // true si existe la llave, false si no
            estado: estadoLocal,
            roles: req.user.guilds || [],
            configRoles: ROLES
        });
    } catch (err) {
        console.error("Error en verificación:", err.message);
        res.status(500).json({ error: 'Error al conectar con el sistema de cédulas' });
    }
});

/**
 * FINALIZAR REGISTRO Y ENVIAR A DISCORD
 */
app.post('/api/finalizar-registro', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send('No autorizado');
    
    const { motivo } = req.body;

    // Botones para el staff en Discord
    const botones = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`aprobar_${req.user.id}`)
            .setLabel('Aprobar')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`denegar_${req.user.id}`)
            .setLabel('Denegar')
            .setStyle(ButtonStyle.Danger)
    );

    const embed = new EmbedBuilder()
        .setTitle("📑 Solicitud de Ingreso Recibida")
        .setColor("#5865F2")
        .addFields(
            { name: "👤 Usuario", value: `<@${req.user.id}>`, inline: true },
            { name: "📝 Motivo", value: motivo }
        )
        .setTimestamp();

    try {
        // Guardamos en PostgreSQL
        await db.query(
            'INSERT INTO usuarios (discord_id, username, motivo, estado) VALUES ($1, $2, $3, $4) ON CONFLICT (discord_id) DO UPDATE SET estado = $4, motivo = $3', 
            [req.user.id, req.user.username, motivo, 'pendiente']
        );
        
        const canal = await client.channels.fetch(CANAL_LOGS);
        await canal.send({ embeds: [embed], components: [botones] });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).send('Error al procesar solicitud');
    }
});

/**
 * MANEJADOR DE INTERACCIONES (BOTONES)
 */
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const [accion, userId] = interaction.customId.split('_');
    const nuevoEstado = accion === 'aprobar' ? 'aprobado' : 'denegado';

    try {
        await db.query('UPDATE usuarios SET estado = $1 WHERE discord_id = $2', [nuevoEstado, userId]);

        await interaction.update({
            content: `✅ La solicitud ha sido **${nuevoEstado.toUpperCase()}** por <@${interaction.user.id}>`,
            components: [],
            embeds: [interaction.message.embeds[0]]
        });
    } catch (err) {
        console.error("Error en botón:", err);
    }
});

// Iniciar Bot y Servidor
client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Sistema Buenos Aires RP listo en puerto ${PORT}`);
});
