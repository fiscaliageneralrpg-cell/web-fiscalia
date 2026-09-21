const express = require("express");
const session = require("express-session");
const path = require("path");
const { probarConexion, buscarUsuarioPorDiscord } = require("./db");

require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const variablesObligatorias = [
  "SESSION_SECRET",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_REDIRECT_URI",
  "DISCORD_GUILD_ID",
  "DISCORD_BOT_TOKEN",
];

const faltantes = variablesObligatorias.filter(
  (variable) => !process.env[variable],
);

if (faltantes.length > 0) {
  console.error(
    `[CONFIGURACION] Faltan variables en Render: ${faltantes.join(", ")}`,
  );
  process.exit(1);
}

const ROL_WHITELIST_APROBADA = "1500316176960716940";
const ROL_WHITELIST_PENDIENTE = "1500556631157768242";

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24,
    },
  }),
);

app.use(express.static(path.join(__dirname, "public")));

function redirigirDespuesDeLogin(req, res, destino) {
  req.session.save((error) => {
    if (error) {
      console.error("[SESION] No se pudo guardar la sesión:", error);
      return res.status(500).send("No se pudo guardar la sesión.");
    }

    return res.redirect(destino);
  });
}

async function obtenerRolesDelServidor(discordId) {
  const url = new URL(
    `https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordId}`,
  );

  const respuesta = await fetch(url, {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      "User-Agent": "Medellin-RP-Web/1.0",
    },
  });

  if (respuesta.status === 404) {
    return [];
  }

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(
      `Discord no devolvió los roles: ${respuesta.status} ${detalle}`,
    );
  }

  const miembro = await respuesta.json();
  return Array.isArray(miembro.roles) ? miembro.roles : [];
}

function obtenerAvatarUrl(usuario) {
  if (!usuario.avatar) {
    return null;
  }

  const extension = usuario.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${usuario.id}/${usuario.avatar}.${extension}?size=256`;
}

app.get("/auth/discord", (req, res) => {
  const parametros = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
  });

  res.redirect(`https://discord.com/oauth2/authorize?${parametros.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code, error, error_description: descripcion } = req.query;

  if (error) {
    return res
      .status(400)
      .send(`Discord canceló el inicio de sesión: ${descripcion || error}`);
  }

  if (!code) {
    return res
      .status(400)
      .send("No se recibió el código de autorización de Discord.");
  }

  try {
    const parametrosToken = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
    });

    const respuestaToken = await fetch(
      "https://discord.com/api/v10/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Medellin-RP-Web/1.0",
        },
        body: parametrosToken.toString(),
      },
    );

    const datosToken = await respuestaToken.json();

    if (!respuestaToken.ok || !datosToken.access_token) {
      console.error("[DISCORD TOKEN]", datosToken);
      return res
        .status(401)
        .send("Discord no pudo validar el inicio de sesión.");
    }

    const respuestaUsuario = await fetch(
      "https://discord.com/api/v10/users/@me",
      {
        headers: {
          Authorization: `${datosToken.token_type} ${datosToken.access_token}`,
          "User-Agent": "Medellin-RP-Web/1.0",
        },
      },
    );

    const usuario = await respuestaUsuario.json();

    if (!respuestaUsuario.ok || !usuario.id) {
      console.error("[DISCORD USUARIO]", usuario);
      return res.status(401).send("No se pudo obtener tu usuario de Discord.");
    }

    const roles = await obtenerRolesDelServidor(usuario.id);
    const whitelistAprobada = roles.includes(ROL_WHITELIST_APROBADA);
    const whitelistPendiente = roles.includes(ROL_WHITELIST_PENDIENTE);

    const usuarioRegistrado = await buscarUsuarioPorDiscord(usuario.id);

    req.session.usuario = {
      id: usuario.id,
      username: usuario.username,
      nombre: usuario.global_name || usuario.username,
      avatar: usuario.avatar,
      avatarUrl: obtenerAvatarUrl(usuario),
      roles,
      whitelistAprobada,
      whitelistPendiente,
      cedulaRegistrada: Boolean(usuarioRegistrado),
      cedula: usuarioRegistrado,
    };

    console.log(
      `[LOGIN] ${usuario.username} (${usuario.id}) | ` +
        `whitelist=${whitelistAprobada} | cedula=${Boolean(usuarioRegistrado)}`,
    );

    if (whitelistPendiente || !whitelistAprobada) {
      return redirigirDespuesDeLogin(req, res, "/whitelist.html");
    }

    if (!usuarioRegistrado) {
      return redirigirDespuesDeLogin(req, res, "/crear-cedula.html");
    }

    return redirigirDespuesDeLogin(req, res, "/dashboard-user.html");
  } catch (error) {
    console.error("[DISCORD OAUTH2]", error);
    return res
      .status(500)
      .send("Ocurrió un error interno durante el inicio de sesión.");
  }
});

function exigirSesion(req, res) {
  if (!req.session.usuario) {
    res.status(401).json({ error: "Debes iniciar sesión con Discord." });
    return false;
  }

  return true;
}

app.post("/api/whitelist", async (req, res) => {
  if (!exigirSesion(req, res)) return;

  const respuestas = req.body?.respuestas;

  if (!respuestas || typeof respuestas !== "object") {
    return res.status(400).json({ error: "Las respuestas son obligatorias." });
  }

  try {
    const { pool } = require("./db");

    await pool.execute(
      `INSERT INTO whitelist_solicitudes
                (discord_id, discord_username, respuestas, estado)
             VALUES (?, ?, ?, 'pendiente')`,
      [
        req.session.usuario.id,
        req.session.usuario.username,
        JSON.stringify(respuestas),
      ],
    );

    return res.json({
      correcto: true,
      redirect: "/whitelist-pendiente.html",
    });
  } catch (error) {
    console.error("[WHITELIST] No se pudo guardar:", error.message);
    return res.status(500).json({
      error:
        "No se pudo guardar la whitelist. Verifica que exista la tabla en MySQL.",
    });
  }
});

app.post("/api/cedula", async (req, res) => {
  if (!exigirSesion(req, res)) return;

  const { nuip, nombre, fecha_nacimiento, nacionalidad } = req.body || {};
  const discordId = req.session.usuario.id;

  if (!/^\d{5,20}$/.test(String(nuip || ""))) {
    return res
      .status(400)
      .json({ error: "El NUIP debe contener entre 5 y 20 números." });
  }

  if (!String(nombre || "").trim()) {
    return res
      .status(400)
      .json({ error: "El nombre completo es obligatorio." });
  }

  try {
    const { pool } = require("./db");
    const roles = await obtenerRolesDelServidor(discordId);

    if (!roles.includes(ROL_WHITELIST_APROBADA)) {
      return res
        .status(403)
        .json({ error: "Tu whitelist todavía no está aprobada." });
    }

    await pool.execute(
      `INSERT INTO usuarios
                (discord_id, nuip, nombre, fecha_nacimiento, nacionalidad)
             VALUES (?, ?, ?, NULLIF(?, ''), ?)`,
      [
        discordId,
        String(nuip),
        String(nombre).trim(),
        fecha_nacimiento || "",
        String(nacionalidad || "Colombiana").trim(),
      ],
    );

    const cedula = await buscarUsuarioPorDiscord(discordId);
    req.session.usuario.cedulaRegistrada = true;
    req.session.usuario.cedula = cedula;

    return req.session.save((error) => {
      if (error) {
        console.error("[CEDULA] No se pudo guardar la sesión:", error);
        return res
          .status(500)
          .json({
            error: "Cédula guardada, pero no se pudo actualizar la sesión.",
          });
      }

      return res.json({ correcto: true, redirect: "/dashboard-user.html" });
    });
  } catch (error) {
    console.error("[CEDULA] No se pudo guardar:", error.message);

    if (error.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({
          error:
            "El NUIP o la cuenta de Discord ya tiene una cédula registrada.",
        });
    }

    return res.status(500).json({ error: "No se pudo guardar la cédula." });
  }
});

app.get("/api/estado", async (req, res) => {
  try {
    await probarConexion();
    return res.json({
      correcto: true,
      mysql: true,
      mensaje: "La web está funcionando correctamente.",
    });
  } catch (error) {
    console.error("[API ESTADO MYSQL]", error.message);
    return res.status(503).json({
      correcto: false,
      mysql: false,
      mensaje: "La web funciona, pero no pudo conectar con MySQL.",
    });
  }
});

app.get("/api/usuario", (req, res) => {
  if (!req.session.usuario) {
    return res.status(401).json({ autenticado: false });
  }

  return res.json({
    autenticado: true,
    usuario: req.session.usuario,
  });
});

app.get("/cerrar-sesion", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("[SESION]", error);
    }

    res.clearCookie("connect.sid");
    return res.redirect("/iniciar-seccion.html");
  });
});

app.use((req, res) => {
  return res.status(404).send("Página no encontrada.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[WEB] Servidor iniciado en el puerto ${PORT}.`);
  probarConexion().catch((error) => {
    console.error("[MYSQL] Error de conexión:", error.message);
  });
});
