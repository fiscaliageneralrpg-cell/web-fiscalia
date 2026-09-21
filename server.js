const express = require('express');
const session = require('express-session');
const path = require('path');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3000;

const variablesObligatorias = [
    'SESSION_SECRET',
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'DISCORD_REDIRECT_URI'
];

for (const variable of variablesObligatorias) {
    if (!process.env[variable]) {
        console.error(`[CONFIGURACIÓN] Falta la variable: ${variable}`);
        process.exit(1);
    }
}

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24
    }
} ));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/auth/discord', (req, res) => {
    const parametros = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
        response_type: 'code',
        scope: 'identify'
    });

    const urlDiscord =
        `https://discord.com/oauth2/authorize?${parametros.toString( )}`;

    res.redirect(urlDiscord);
});

app.get('/auth/discord/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        return res.status(400).send(
            `Discord canceló el inicio de sesión: ${error}`
        );
    }

    if (!code) {
        return res.status(400).send(
            'No se recibió el código de autorización de Discord.'
        );
    }

    try {
        const parametrosToken = new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI
        });

        const respuestaToken = await fetch(
            'https://discord.com/api/oauth2/token',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: parametrosToken.toString( )
            }
        );

        const datosToken = await respuestaToken.json();

        if (!respuestaToken.ok || !datosToken.access_token) {
            console.error('[DISCORD TOKEN]', datosToken);

            return res.status(401).send(
                'Discord no pudo validar el inicio de sesión.'
            );
        }

        const respuestaUsuario = await fetch(
            'https://discord.com/api/users/@me',
            {
                headers: {
                    Authorization: `${datosToken.token_type} ${datosToken.access_token}`
                }
            }
         );

        const usuario = await respuestaUsuario.json();

        if (!respuestaUsuario.ok || !usuario.id) {
            console.error('[DISCORD USUARIO]', usuario);

            return res.status(401).send(
                'No se pudo obtener tu usuario de Discord.'
            );
        }

        req.session.usuario = {
            id: usuario.id,
            username: usuario.username,
            nombre: usuario.global_name || usuario.username,
            avatar: usuario.avatar
        };

        console.log(
            `[LOGIN] Usuario conectado: ${usuario.username} (${usuario.id})`
        );

        res.redirect('/dashboard-user.html');
    } catch (error) {
        console.error('[DISCORD OAUTH2]', error);
        res.status(500).send(
            'Ocurrió un error interno durante el inicio de sesión.'
        );
    }
});

app.get('/api/estado', (req, res) => {
    res.json({
        correcto: true,
        mensaje: 'La web está funcionando correctamente'
    });
});

app.get('/api/usuario', (req, res) => {
    if (!req.session.usuario) {
        return res.status(401).json({
            autenticado: false
        });
    }

    res.json({
        autenticado: true,
        usuario: req.session.usuario
    });
});

app.get('/cerrar-sesion', (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            console.error('[SESION]', error);
        }

        res.redirect('/iniciar-seccion.html');
    });
});

app.use((req, res) => {
    res.status(404).send('Página no encontrada');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Web iniciada en el puerto ${PORT}`);
});
