require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const path = require('path');
const db = require('./database');

const app = express();

// Bot de Discord
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
client.login(process.env.DISCORD_TOKEN);

// Configuración de IDs
const ROLES = {
    CIVIL: '1493350442644537464',
    POLICIA: '1493350424714150061',
    ADMIN: '1493345430094876784'
};
const CANAL_LOGS = '1482550071521185926';

// Configuración Passport
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify', 'guilds', 'guilds.members.read']
}, (at, rt, profile, done) => done(null, profile)));

app.use(session({ 
    secret: 'atm7_secret_key', 
    resave: false, 
    saveUninitialized: false 
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());

// Middleware de Autenticación
const checkAuth = (req, res, next) => req.isAuthenticated() ? next() : res.redirect('/');

// Rutas
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/registro.html'); 
});

// Guardar datos en Render y avisar por Discord
app.post('/api/solicitar-ingreso', checkAuth, async (req, res) => {
    const { robloxUser, motivo } = req.body;
    try {
        // Guardar en DB
        await db.saveUser(req.user.id, req.user.username, robloxUser, motivo);
        
        // Log a Discord
        const canal = await client.channels.fetch(CANAL_LOGS);
        const embed = new EmbedBuilder()
            .setTitle("📄 Nueva Solicitud de Cédula")
            .setColor("#00FF00")
            .addFields(
                { name: "Usuario", value: `<@${req.user.id}>`, inline: true },
                { name: "Roblox", value: robloxUser, inline: true },
                { name: "Motivo", value: motivo }
            )
            .setTimestamp();

        await canal.send({ embeds: [embed] });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al procesar' });
    }
});

// Info del usuario para el frontend
app.get('/api/user-info', checkAuth, async (req, res) => {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(req.user.id).catch(() => null);
    res.json({
        username: req.user.username,
        avatar: `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`,
        roles: {
            esCivil: member?.roles.cache.has(ROLES.CIVIL),
            esPolicia: member?.roles.cache.has(ROLES.POLICIA),
            esAdmin: member?.roles.cache.has(ROLES.ADMIN)
        }
    });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🔥 Servidor funcionando en http://localhost:${PORT}`);
});