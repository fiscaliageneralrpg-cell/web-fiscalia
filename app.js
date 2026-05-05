require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const path = require('path');
const db = require('./database');

const app = express();

/**
 * CONFIGURACIÓN DE IDENTIDADES Y CANALES
 * Definición de roles y canal de auditoría para el staff
 */
const ROLES = {
    CIVIL: '1493350442644537464',
    POLICIA: '1493350424714150061',
    ADMIN: '1493345430094876784'
};
const CANAL_LOGS = '1482550071521185926';

/**
 * INICIALIZACIÓN DEL BOT DE DISCORD
 * Necesario para enviar los embeds con botones al staff
 */
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers
    ] 
});

/**
 * CONFIGURACIÓN DE PASSPORT (OAuth2)
 * Se solicita permiso para identificar al usuario y leer sus gremios/roles
 */
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

// Middlewares de Express
app.use(session({ 
    secret: 'buenos_aires_rp_session_ultra_secret_2026', 
    resave: false, 
    saveUninitialized: false 
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * LÓGICA DE CONEXIÓN CON HIDENCLOUD
 * Función asíncrona para validar la existencia del usuario en el JSON externo
 */
const URL_HIDENCLOUD = "https://tu-hosting-externo.com/data/usuarios.json"; 

async function consultarHidenCloud(discordId) {
    try {
        const respuesta = await axios.get(URL_HIDENCLOUD, { 
            headers: { 'Cache-Control': 'no-cache' } 
        });
        const lista = respuesta.data;
        return lista.some(u => u.discord_id === discordId);
    } catch (error) {
        console.error("Error crítico al conectar con HidenCloud:", error.message);
        return false;
    }
}

/**
 * RUTAS DE AUTENTICACIÓN
 */
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { 
    failureRedirect: '/', 
    successRedirect: '/registro.html' 
}));

/**
 * ENDPOINT DE VERIFICACIÓN INTEGRADA
 * Cruza datos de HidenCloud, la DB de Render y los roles de Discord
 */
app.get('/api/verificar-estado', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Sesión no iniciada' });
    
    try {
        const tieneCedula = await consultarHidenCloud(req.user.id);
        const consultaDB = await db.query('SELECT estado FROM usuarios WHERE discord_id = $1', [req.user.id]);
        const estadoLocal = consultaDB.rows.length > 0 ? consultaDB.rows[0].estado : 'nuevo';
        
        // Verificación de roles en el servidor de Discord
        const rolesUsuario = req.user.guilds || [];
        
        res.json({ 
            id: req.user.id,
            username: req.user.username,
            tieneCedula: tieneCedula,
            estado: estadoLocal,
            roles: rolesUsuario,
            configRoles: ROLES
        });
    } catch (err) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * ENVÍO DE FORMULARIO Y NOTIFICACIÓN AL STAFF
 */
app.post('/api/finalizar-registro', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send('Acceso denegado');
    
    const { motivo } = req.body;

    // Componentes de Discord (Botones)
    const botones = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`aprobar_${req.user.id}`)
            .setLabel('Aprobar Ciudadano')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`denegar_${req.user.id}`)
            .setLabel('Rechazar')
            .setStyle(ButtonStyle.Danger)
    );

    const embedNotificacion = new EmbedBuilder()
        .setTitle("📑 Nueva Solicitud de Ingreso")
        .setColor("#5865F2")
        .setDescription(`El usuario <@${req.user.id}> ha enviado su solicitud para ingresar al servidor.`)
        .addFields(
            { name: "👤 Usuario", value: `${req.user.username}#${req.user.discriminator}`, inline: true },
            { name: "🆔 Discord ID", value: `\`${req.user.id}\``, inline: true },
            { name: "📝 Motivo", value: motivo }
        )
        .setThumbnail(`https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`)
        .setTimestamp();

    try {
        // Registro en PostgreSQL (Render)
        await db.query(
            'INSERT INTO usuarios (discord_id, username, motivo, estado) VALUES ($1, $2, $3, $4) ON CONFLICT (discord_id) DO UPDATE SET estado = $4, motivo = $3', 
            [req.user.id, req.user.username, motivo, 'pendiente']
        );
        
        const canalAuditoria = await client.channels.fetch(CANAL_LOGS);
        await canalAuditoria.send({ embeds: [embedNotificacion], components: [botones] });
        
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al procesar la solicitud');
    }
});

/**
 * ESCUCHA DE INTERACCIONES (BOTONES DE STAFF)
 */
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const [operacion, idUsuario] = interaction.customId.split('_');
    const resultado = operacion === 'aprobar' ? 'aprobado' : 'denegado';

    try {
        await db.query('UPDATE usuarios SET estado = $1 WHERE discord_id = $2', [resultado, idUsuario]);

        await interaction.update({
            content: `📢 **Solicitud Procesada**: El usuario ha sido **${resultado.toUpperCase()}** por <@${interaction.user.id}>.`,
            components: [],
            embeds: [interaction.message.embeds[0]]
        });
    } catch (err) {
        console.error("Fallo al actualizar estado desde Discord:", err);
    }
});

client.login(process.env.DISCORD_TOKEN);

const SERVER_PORT = process.env.PORT || 3000;
app.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`🚀 BUENOS AIRES RP - WEB SYSTEM ONLINE`);
    console.log(`📡 Puerto de escucha: ${SERVER_PORT}`);
    console.log(`=========================================`);
});
