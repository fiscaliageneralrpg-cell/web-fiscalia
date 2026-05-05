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

// --- CONFIGURACIÓN DE ROLES Y LOGS ---
const ROLES = {
    CIVIL: '1493350442644537464',
    POLICIA: '1493350424714150061',
    ADMIN: '1493345430094876784'
};
const CANAL_LOGS = '1482550071521185926';

// --- CONFIGURACIÓN DEL BOT ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences
    ] 
});

// --- ESTRATEGIA DISCORD (OAuth2) ---
passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify', 'guilds', 'guilds.members.read']
}, (at, rt, profile, done) => done(null, profile)));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.use(session({ 
    secret: 'buenos_aires_rp_secure_key', 
    resave: false, 
    saveUninitialized: false 
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- LÓGICA DE HIDENCLOUD (JSON EXTERNO) ---
const URL_JSON_EXTERNO = "https://tu-hosting-hidencloud.com/data/usuarios.json"; 

async function verificarCedulaHidenCloud(discordId) {
    try {
        const res = await axios.get(URL_JSON_EXTERNO, { headers: { 'Cache-Control': 'no-cache' } });
        return res.data.some(u => u.discord_id === discordId);
    } catch (e) {
        console.error("Error leyendo HidenCloud:", e.message);
        return false;
    }
}

// --- RUTAS DE AUTENTICACIÓN ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { 
    failureRedirect: '/', 
    successRedirect: '/registro.html' 
}));

// --- API DE ESTADO Y ROLES ---
app.get('/api/verificar-estado', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autorizado' });
    
    // 1. Verificamos cédula en el JSON externo
    const tieneCedula = await verificarCedulaHidenCloud(req.user.id);
    
    // 2. Verificamos estado de solicitud en DB local
    const dbRes = await db.query('SELECT estado FROM usuarios WHERE discord_id = $1', [req.user.id]);
    const estado = dbRes.rows.length > 0 ? dbRes.rows[0].estado : 'nuevo';

    // 3. Obtenemos roles (si el bot está en el servidor)
    const misRoles = req.user.guilds ? req.user.guilds : [];

    res.json({ 
        id: req.user.id,
        username: req.user.username,
        tieneCedula, 
        estado,
        roles: misRoles,
        idsRoles: ROLES // Enviamos los IDs para el frontend
    });
});

// --- ENVIAR SOLICITUD A DISCORD CON BOTONES ---
app.post('/api/finalizar-registro', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send('No autorizado');
    
    const { motivo } = req.body;

    // Crear botones de Aceptación/Denegación
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`aprobar_${req.user.id}`)
            .setLabel('Aceptar Ingreso')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`denegar_${req.user.id}`)
            .setLabel('Denegar')
            .setStyle(ButtonStyle.Danger)
    );

    const embed = new EmbedBuilder()
        .setTitle("📢 Nueva Solicitud de Ingreso")
        .setColor("#5865F2")
        .addFields(
            { name: "Usuario", value: `<@${req.user.id}> (${req.user.username})`, inline: true },
            { name: "Discord ID", value: `\`${req.user.id}\``, inline: true },
            { name: "Motivo de Ingreso", value: motivo }
        )
        .setTimestamp();

    try {
        // Guardar en DB de Render
        await db.query(
            'INSERT INTO usuarios (discord_id, username, motivo, estado) VALUES ($1, $2, $3, $4) ON CONFLICT (discord_id) DO UPDATE SET estado = $4, motivo = $3', 
            [req.user.id, req.user.username, motivo, 'pendiente']
        );
        
        // Enviar a canal de logs
        const canal = await client.channels.fetch(CANAL_LOGS);
        await canal.send({ embeds: [embed], components: [row] });
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).send('Error interno');
    }
});

// --- GESTIÓN DE INTERACCIONES (BOTONES) ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const [accion, userId] = interaction.customId.split('_');
    const nuevoEstado = accion === 'aprobar' ? 'aprobado' : 'denegado';

    try {
        // Actualizar base de datos
        await db.query('UPDATE usuarios SET estado = $1 WHERE discord_id = $2', [nuevoEstado, userId]);

        // Editar el mensaje original para quitar botones
        await interaction.update({
            content: `✅ Solicitud **${nuevoEstado.toUpperCase()}** por <@${interaction.user.id}>`,
            components: [],
            embeds: [interaction.message.embeds[0]]
        });
    } catch (err) {
        console.error("Error al procesar botón:", err);
    }
});

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Buenos Aires RP Web activa en puerto ${PORT}`));
