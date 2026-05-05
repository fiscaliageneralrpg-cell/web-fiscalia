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
const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] 
});
client.login(process.env.DISCORD_TOKEN);

const ROLES = {
    CIVIL: '1493350442644537464',
    POLICIA: '1493350424714150061',
    ADMIN: '1493345430094876784'
};
const CANAL_LOGS = '1482550071521185926';

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify', 'guilds', 'guilds.members.read']
}, (at, rt, profile, done) => {
    process.nextTick(() => done(null, profile));
}));

app.use(session({ 
    secret: 'buenos_aires_rp_secret', 
    resave: false, 
    saveUninitialized: false 
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());

// Rutas de Auth
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { 
    failureRedirect: '/',
    successRedirect: '/registro.html' 
}));

// API para guardar registro
app.post('/api/solicitar-ingreso', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send('No autorizado');
    
    const { robloxUser, motivo } = req.body;
    try {
        await db.saveUser(req.user.id, req.user.username, robloxUser, motivo);
        
        const canal = await client.channels.fetch(CANAL_LOGS);
        const embed = new EmbedBuilder()
            .setTitle("Nuevo Registro de Cédula")
            .setColor("#00ff00")
            .addFields(
                { name: "Usuario", value: `<@${req.user.id}>` },
                { name: "Roblox", value: robloxUser },
                { name: "Motivo", value: motivo }
            );
        
        await canal.send({ embeds: [embed] });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error interno');
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// IMPORTANTE: Configuración de puerto para Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 Servidor activo en puerto ${PORT}`);
});
