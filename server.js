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
const EMOJI_ESPERA = "<:8810datetime:1538599244678692934>";
const EMOJI_ACEPTADO = "<:1507611843198451915:1538596251879219371>";
const EMOJI_DENEGADO = "<a:1485274567520948324:1549034139456380978>";
const EMOJI_ADMIN = "<a:1334651531206856755:1548832195400040488>";
const EMOJI_FORMULARIO = "<:1543355584793813002:1549408007610302527>";
const EMOJI_FORMULARIO_2 = "<:1543355638636220526:1549408009212403763>";
const NOMBRE_SERVIDOR = "「ME:RP」Medellín RP︱ER:LC";

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

async function enviarEmbedDiscord(canalId, embed, components = []) {
  const respuesta = await fetch(
    `https://discord.com/api/v10/channels/${canalId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "Medellin-RP-Web/1.0",
      },
      body: JSON.stringify({ embeds: [embed], components }),
    },
  );

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(
      `Discord no pudo enviar el mensaje: ${respuesta.status} ${detalle}`,
    );
  }
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
    const { pool } = require("./db");
    const [solicitudesWhitelist] = await pool.execute(
      `SELECT estado
       FROM whitelist_solicitudes
       WHERE discord_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [usuario.id],
    );
    const estadoWhitelist = solicitudesWhitelist[0]?.estado || null;

    req.session.usuario = {
      id: usuario.id,
      username: usuario.username,
      nombre: usuario.global_name || usuario.username,
      avatar: usuario.avatar,
      avatarUrl: obtenerAvatarUrl(usuario),
      roles,
      whitelistAprobada,
      whitelistPendiente,
      estadoWhitelist,
      cedulaRegistrada: Boolean(usuarioRegistrado),
      cedula: usuarioRegistrado,
    };

    console.log(
      `[LOGIN] ${usuario.username} (${usuario.id}) | ` +
        `whitelist=${whitelistAprobada} | cedula=${Boolean(usuarioRegistrado)}`,
    );

    if (whitelistPendiente || estadoWhitelist === "pendiente") {
      console.log(`[LOGIN] ${usuario.id} tiene whitelist pendiente.`);
      return redirigirDespuesDeLogin(req, res, "/whitelist-pendiente.html");
    }

    if (!whitelistAprobada) {
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

    const [resultadoWhitelist] = await pool.execute(
      `INSERT INTO whitelist_solicitudes
                (discord_id, discord_username, respuestas, estado)
             VALUES (?, ?, ?, 'pendiente')`,
      [
        req.session.usuario.id,
        req.session.usuario.username,
        JSON.stringify(respuestas),
      ],
    );

    const camposWhitelist = Object.entries(respuestas).map(
      ([pregunta, respuesta]) => ({
        name: pregunta.replaceAll("_", " ").slice(0, 256),
        value: String(respuesta || "Sin respuesta").slice(0, 1024),
        inline: false,
      }),
    );

    try {
      await enviarEmbedDiscord(
        "1539313915001839616",
        {
          title: `${EMOJI_FORMULARIO} NUEVA SOLICITUD DE WHITELIST`,
          description:
            `${EMOJI_ESPERA} El usuario <@${req.session.usuario.id}> envió una solicitud desde la página web.\n` +
            `**Estado:** Pendiente de revisión`,
          color: 0xffd166,
          thumbnail: req.session.usuario.avatarUrl
            ? { url: req.session.usuario.avatarUrl }
            : undefined,
          fields: [
            {
              name: `${EMOJI_ADMIN} Usuario`,
              value: `<@${req.session.usuario.id}>`,
              inline: true,
            },
            {
              name: `${EMOJI_FORMULARIO_2} Discord ID`,
              value: req.session.usuario.id,
              inline: true,
            },
            ...camposWhitelist,
          ].slice(0, 25),
          footer: { text: `${NOMBRE_SERVIDOR} • Gestión de whitelist` },
          timestamp: new Date().toISOString(),
        },
        [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 3,
                label: "ACEPTAR",
                custom_id: `whitelist:aceptar:${resultadoWhitelist.insertId}:${req.session.usuario.id}`,
              },
              {
                type: 2,
                style: 4,
                label: "DENEGAR",
                custom_id: `whitelist:denegar:${resultadoWhitelist.insertId}:${req.session.usuario.id}`,
              },
            ],
          },
        ],
      );
    } catch (errorDiscord) {
      console.error(
        "[WHITELIST] Se guardó en MySQL, pero no llegó a Discord:",
        errorDiscord.message,
      );
    }

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

app.get("/api/whitelist/status", async (req, res) => {
  if (!exigirSesion(req, res)) return;

  try {
    const { pool } = require("./db");
    const [solicitudes] = await pool.execute(
      `SELECT estado, motivo_denegacion
       FROM whitelist_solicitudes
       WHERE discord_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [req.session.usuario.id],
    );

    const estado = solicitudes[0] || null;
    const roles = await obtenerRolesDelServidor(req.session.usuario.id);
    const aprobadaPorRol = roles.includes(ROL_WHITELIST_APROBADA);
    const cedula = await buscarUsuarioPorDiscord(req.session.usuario.id);

    if (aprobadaPorRol) {
      return res.json({
        estado: "aceptada",
        redirect: cedula ? "/dashboard-user.html" : "/crear-cedula.html",
      });
    }

    if (roles.includes(ROL_WHITELIST_PENDIENTE)) {
      return res.json({ estado: "pendiente" });
    }

    if (estado?.estado === "denegada") {
      return res.json({
        estado: "denegada",
        motivo: estado.motivo_denegacion || "La solicitud fue denegada.",
        redirect: "/whitelist-denegada.html",
      });
    }

    return res.json({ estado: "pendiente" });
  } catch (error) {
    console.error("[WHITELIST STATUS]", error.message);
    return res.status(500).json({
      error: "No se pudo consultar el estado de la whitelist.",
    });
  }
});

app.post("/api/cedula", async (req, res) => {
  if (!exigirSesion(req, res)) return;

  const {
    nombres,
    apellidos,
    sexo,
    nacionalidad,
    lugar_nac,
    fecha_nac,
    roblox,
  } = req.body || {};
  const discordId = req.session.usuario.id;

  if (!String(nombres || "").trim() || !String(apellidos || "").trim()) {
    return res
      .status(400)
      .json({ error: "Nombres y apellidos son obligatorios." });
  }

  if (!["MASCULINO", "FEMENINO"].includes(String(sexo || ""))) {
    return res.status(400).json({ error: "Selecciona un sexo válido." });
  }

  if (!["COLOMBIANA", "EXTRANJERA"].includes(String(nacionalidad || ""))) {
    return res
      .status(400)
      .json({ error: "Selecciona una nacionalidad válida." });
  }

  if (!String(lugar_nac || "").trim() || !String(fecha_nac || "").trim()) {
    return res
      .status(400)
      .json({ error: "Lugar y fecha de nacimiento son obligatorios." });
  }

  if (!String(roblox || "").trim()) {
    return res
      .status(400)
      .json({ error: "El usuario de Roblox es obligatorio." });
  }

  try {
    const { pool } = require("./db");
    const roles = await obtenerRolesDelServidor(discordId);

    if (!roles.includes(ROL_WHITELIST_APROBADA)) {
      return res
        .status(403)
        .json({ error: "Tu whitelist todavía no está aprobada." });
    }

    const conexion = await pool.getConnection();

    try {
      await conexion.beginTransaction();

      const [ultimoResultado] = await conexion.execute(
        `SELECT COALESCE(MAX(CAST(nuip AS UNSIGNED)), 1000) AS ultimo
         FROM usuarios FOR UPDATE`,
      );

      const nuip = String(Number(ultimoResultado[0].ultimo) + 1);
      const nombreCompleto = `${String(nombres).trim()} ${String(apellidos).trim()}`;

      await conexion.execute(
        `INSERT INTO usuarios
          (discord_id, nuip, nombre, nombres, apellidos, sexo,
           fecha_nacimiento, fecha_nac, nacionalidad, lugar_nac, roblox_name)
         VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?)`,
        [
          discordId,
          nuip,
          nombreCompleto,
          String(nombres).trim(),
          String(apellidos).trim(),
          String(sexo),
          String(fecha_nac),
          String(fecha_nac),
          String(nacionalidad),
          String(lugar_nac).trim(),
          String(roblox).trim(),
        ],
      );

      await conexion.commit();
    } catch (error) {
      await conexion.rollback();
      throw error;
    } finally {
      conexion.release();
    }

    const cedula = await buscarUsuarioPorDiscord(discordId);
    req.session.usuario.cedulaRegistrada = true;
    req.session.usuario.cedula = cedula;

    try {
      await enviarEmbedDiscord("1539426748142325780", {
        title: "🪪 NUEVO REGISTRO CIVIL",
        description:
          "Se creó una nueva cédula ciudadana desde la página web de Medellín RP.",
        color: 0x00a876,
        thumbnail: req.session.usuario.avatarUrl
          ? { url: req.session.usuario.avatarUrl }
          : undefined,
        fields: [
          {
            name: "👤 Ciudadano",
            value: `${cedula.nombres || nombres} ${cedula.apellidos || apellidos}`,
            inline: false,
          },
          { name: "🆔 NUIP", value: `CC ${cedula.nuip}`, inline: true },
          { name: "⚧ Sexo", value: String(sexo), inline: true },
          {
            name: "🌎 Nacionalidad",
            value: String(nacionalidad),
            inline: true,
          },
          {
            name: "📍 Lugar de nacimiento",
            value: String(lugar_nac),
            inline: true,
          },
          { name: "🎮 Roblox", value: String(roblox), inline: true },
          { name: "💬 Discord", value: `<@${discordId}>`, inline: true },
        ],
        footer: { text: "Medellín RP • Registro Civil" },
        timestamp: new Date().toISOString(),
      });
    } catch (errorDiscord) {
      console.error(
        "[CEDULA] Se guardó en MySQL, pero no llegó el log a Discord:",
        errorDiscord.message,
      );
    }

    return req.session.save((error) => {
      if (error) {
        console.error("[CEDULA] No se pudo guardar la sesión:", error);
        return res.status(500).json({
          error: "Cédula guardada, pero no se pudo actualizar la sesión.",
        });
      }

      return res.json({ correcto: true, redirect: "/dashboard-user.html" });
    });
  } catch (error) {
    console.error("[CEDULA] No se pudo guardar:", error.message);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: "La cuenta de Discord ya tiene una cédula registrada.",
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

app.get("/api/usuario", async (req, res) => {
  if (!req.session.usuario) {
    return res.status(401).json({ autenticado: false });
  }

  try {
    const cedulaActualizada = await buscarUsuarioPorDiscord(
      req.session.usuario.id,
    );
    const rolesActualizados = await obtenerRolesDelServidor(
      req.session.usuario.id,
    );
    const conservaRolPendiente = rolesActualizados.includes(
      ROL_WHITELIST_PENDIENTE,
    );
    const { pool } = require("./db");
    const [solicitudes] = await pool.execute(
      `SELECT estado
       FROM whitelist_solicitudes
       WHERE discord_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [req.session.usuario.id],
    );
    const tieneWhitelistPendiente =
      conservaRolPendiente || solicitudes[0]?.estado === "pendiente";

    req.session.usuario.cedula = cedulaActualizada;
    req.session.usuario.cedulaRegistrada = Boolean(cedulaActualizada);
    req.session.usuario.roles = rolesActualizados;
    req.session.usuario.whitelistPendiente = tieneWhitelistPendiente;

    return res.json({
      autenticado: true,
      usuario: req.session.usuario,
      redireccion: tieneWhitelistPendiente ? "/whitelist-pendiente.html" : null,
    });
  } catch (error) {
    console.error("[API USUARIO]", error.message);
    return res.status(503).json({
      autenticado: true,
      error: "No se pudo consultar la cédula en MySQL.",
    });
  }
});

app.get("/api/cedula/imagen", async (req, res) => {
  if (!exigirSesion(req, res)) return;

  try {
    const { pool } = require("./db");
    const [filas] = await pool.execute(
      `SELECT cedula_imagen
       FROM usuarios
       WHERE discord_id = ?
       LIMIT 1`,
      [req.session.usuario.id],
    );

    if (!filas[0]?.cedula_imagen) {
      return res.status(404).send("La imagen de la cédula todavía no existe.");
    }

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.send(filas[0].cedula_imagen);
  } catch (error) {
    console.error("[API CEDULA IMAGEN]", error.message);
    return res.status(500).send("No se pudo cargar la imagen.");
  }
});

app.get("/api/nequi", async (req, res) => {
  if (!exigirSesion(req, res)) return;

  try {
    if (!process.env.NEQUI_API_URL || !process.env.NEQUI_API_KEY) {
      return res.status(503).json({
        codigo: "NEQUI_API_NO_CONFIGURADA",
        error: "Render no tiene configurada NEQUI_API_URL o NEQUI_API_KEY.",
      });
    }

    const respuestaBot = await fetch(
      `${process.env.NEQUI_API_URL.replace(/\/$/, "")}/${req.session.usuario.id}`,
      {
        headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY },
        signal: AbortSignal.timeout(8000),
      },
    );
    const datosBot = await respuestaBot.json();
    return res.status(respuestaBot.status).json(datosBot);
  } catch (error) {
    console.error("[API NEQUI]", error.message);
    return res.status(500).json({
      codigo: "NEQUI_API_INACCESIBLE",
      error:
        "Render no puede comunicarse con la API del bot. Revisa la URL pública y el puerto.",
    });
  }
});

app.get("/api/nequi/usuarios", async (req, res) => {
  if (!exigirSesion(req, res)) return;

  try {
    const respuesta = await fetch(
      `https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members?limit=1000`,
      {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          "User-Agent": "Medellin-RP-Web/1.0",
        },
      },
    );

    if (!respuesta.ok)
      throw new Error(`Discord respondió ${respuesta.status}.`);
    const miembros = await respuesta.json();

    return res.json({
      usuarios: miembros
        .filter((miembro) => miembro.user?.id !== req.session.usuario.id)
        .map((miembro) => ({
          id: miembro.user.id,
          nombre:
            miembro.nick || miembro.user.global_name || miembro.user.username,
          username: miembro.user.username,
        }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
    });
  } catch (error) {
    console.error("[API NEQUI USUARIOS]", error.message);
    return res
      .status(500)
      .json({ error: "No se pudieron cargar los usuarios del servidor." });
  }
});

async function moverSaldoNequi(discordId, tipo, monto, destinoId = null) {
  const cantidad = Number(monto);
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    const error = new Error(
      "El monto debe ser un número entero mayor que cero.",
    );
    error.statusCode = 400;
    throw error;
  }

  const conexion = await require("./db").pool.getConnection();
  try {
    await conexion.beginTransaction();
    const [filas] = await conexion.execute(
      `SELECT discord_id, billetera, banco
       FROM saldos
       WHERE discord_id IN (?, ?)
       FOR UPDATE`,
      destinoId ? [discordId, destinoId] : [discordId, discordId],
    );
    const actual = filas.find((fila) => fila.discord_id === discordId);

    if (!actual) {
      const error = new Error("No existe una cuenta Nequi activa.");
      error.statusCode = 404;
      throw error;
    }

    if (tipo === "depositar") {
      if (Number(actual.billetera) < cantidad) {
        const error = new Error(
          "No tienes suficiente dinero en Mano para depositar.",
        );
        error.statusCode = 400;
        throw error;
      }
      await conexion.execute(
        `UPDATE saldos SET billetera = billetera - ?, banco = banco + ? WHERE discord_id = ?`,
        [cantidad, cantidad, discordId],
      );
    } else if (tipo === "retirar") {
      if (Number(actual.banco) < cantidad) {
        const error = new Error(
          "No tienes suficiente dinero en Nequi para retirar.",
        );
        error.statusCode = 400;
        throw error;
      }
      await conexion.execute(
        `UPDATE saldos SET banco = banco - ?, billetera = billetera + ? WHERE discord_id = ?`,
        [cantidad, cantidad, discordId],
      );
    } else if (tipo === "transferir") {
      const destino = filas.find((fila) => fila.discord_id === destinoId);
      if (!destino) {
        const error = new Error(
          "El usuario destinatario no tiene una cuenta Nequi activa.",
        );
        error.statusCode = 404;
        throw error;
      }
      if (destinoId === discordId) {
        const error = new Error("No puedes transferirte dinero a ti mismo.");
        error.statusCode = 400;
        throw error;
      }
      if (Number(actual.banco) < cantidad) {
        const error = new Error(
          "No tienes suficiente dinero en Nequi para transferir.",
        );
        error.statusCode = 400;
        throw error;
      }
      await conexion.execute(
        `UPDATE saldos SET banco = banco - ? WHERE discord_id = ?`,
        [cantidad, discordId],
      );
      await conexion.execute(
        `UPDATE saldos SET banco = banco + ? WHERE discord_id = ?`,
        [cantidad, destinoId],
      );
    } else {
      const error = new Error("Operación no válida.");
      error.statusCode = 400;
      throw error;
    }

    await conexion.commit();
  } catch (error) {
    await conexion.rollback();
    throw error;
  } finally {
    conexion.release();
  }
}

app.post("/api/nequi/operacion", async (req, res) => {
  if (!exigirSesion(req, res)) return;

  const { tipo, monto, destinoId } = req.body || {};
  try {
    if (!process.env.NEQUI_API_URL || !process.env.NEQUI_API_KEY) {
      return res.status(503).json({
        error: "Render no tiene configurada la conexión con la API del bot.",
      });
    }

    const respuestaBot = await fetch(
      `${process.env.NEQUI_API_URL.replace(/\/$/, "")}/${req.session.usuario.id}/operacion`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Nequi-Key": process.env.NEQUI_API_KEY,
        },
        body: JSON.stringify({ tipo, monto, destinoId }),
        signal: AbortSignal.timeout(8000),
      },
    );
    const datosBot = await respuestaBot.json();
    return res.status(respuestaBot.status).json(datosBot);
  } catch (error) {
    console.error("[API NEQUI OPERACION]", error.message);
    return res.status(error.statusCode || 500).json({
      error: error.message || "No se pudo completar la operación.",
    });
  }
});

app.get("/cerrar-sesion", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("[SESION]", error);
    }

    res.clearCookie("connect.sid");
    return res.redirect("/index.html");
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
