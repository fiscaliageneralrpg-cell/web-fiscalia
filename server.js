const express = require("express");
const session = require("express-session");
const path = require("node:path");
const CANAL_PUBLICACION_ENCUESTAS = process.env.CANAL_PUBLICACION_ENCUESTAS || "1507918744645668975";
const CANAL_LOG_TWITTER = process.env.CANAL_LOG_TWITTER || "1539432339413799042";
const { pool, probarConexion, buscarUsuarioPorDiscord } = require("./db");

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
const ROL_STAFF_WHITELIST = "1510018366964891829";
const ROL_FUNDACION = "1508156676350673017";
const ROL_STAFF = "1510018366964891829";
const ROLES_POLICIA = new Set([
  "1500310263960834200",
  "1500310124181323786",
  "1500310980675244112",
  "1500310467254423552",
]);
const EMOJI_ESPERA = "<:8810datetime:1538599244678692934>";
const EMOJI_ACEPTADO = "<:1507611843198451915:1538596251879219371>";
const EMOJI_DENEGADO = "<a:1485274567520948324:1549034139456380978>";
const EMOJI_ADMIN = "<a:1334651531206856755:1548832195400040488>";
const EMOJI_FORMULARIO = "<:1543355584793813002:1549408007610302527>";
const EMOJI_FORMULARIO_2 = "<:1543355638636220526:1549408009212403763>";
const NOMBRE_SERVIDOR = "「ME:RP」Medellín RP︱ER:LC";

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "12mb" }));
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

app.get("/iniciar-sesion.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "iniciar-sesion.html"));
});

app.get("/iniciar-seccion.html", (req, res) => {
  res.redirect("/iniciar-sesion.html");
});

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
    return null;
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

async function agregarRolDiscord(discordId, rolId, motivo) {
  const respuesta = await fetch(
    `https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordId}/roles/${rolId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        "User-Agent": "Medellin-RP-Web/1.0",
        "X-Audit-Log-Reason": motivo || "Rol de whitelist",
      },
    },
  );

  if (!respuesta.ok && respuesta.status !== 204) {
    const detalle = await respuesta.text();
    throw new Error(
      `Discord no pudo agregar el rol ${rolId}: ${respuesta.status} ${detalle}`,
    );
  }
}

async function obtenerMiembrosDelServidor() {
  const miembros = [];
  let after = "0";
  for (let pagina = 0; pagina < 20; pagina += 1) {
    const url = new URL(`https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members`);
    url.searchParams.set("limit", "1000");
    if (after !== "0") url.searchParams.set("after", after);
    const respuesta = await fetch(url, {
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, "User-Agent": "Medellin-RP-Web/1.0" },
    });
    if (!respuesta.ok) throw new Error(`Discord no devolvió los miembros: ${respuesta.status}`);
    const paginaMiembros = await respuesta.json();
    miembros.push(...paginaMiembros.map((miembro) => ({
      id: miembro.user.id,
      username: miembro.user.username,
      nombre: miembro.nick || miembro.user.global_name || miembro.user.username,
      avatar: obtenerAvatarUrl(miembro.user),
    })));
    if (paginaMiembros.length < 1000) break;
    after = paginaMiembros.at(-1)?.user?.id || after;
  }
  return miembros;
}

function obtenerAvatarUrl(usuario) {
  if (!usuario.avatar) {
    return null;
  }

  const extension = usuario.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${usuario.id}/${usuario.avatar}.${extension}?size=256`;
}

async function enviarEmbedDiscord(canalId, embed, components = [], opciones = {}) {
  const respuesta = await fetch(
    `https://discord.com/api/v10/channels/${canalId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "Medellin-RP-Web/1.0",
      },
      body: JSON.stringify({ ...opciones, embeds: [embed], components }),
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

    const rolesDiscord = await obtenerRolesDelServidor(usuario.id);
    const estaEnServidor = Array.isArray(rolesDiscord);
    const roles = rolesDiscord || [];
    const whitelistAprobada = roles.includes(ROL_WHITELIST_APROBADA);

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
      estaEnServidor,
      whitelistAprobada,
      whitelistPendiente: estadoWhitelist === "pendiente",
      estadoWhitelist,
      cedulaRegistrada: Boolean(usuarioRegistrado),
      cedula: usuarioRegistrado,
    };

    console.log(
      `[LOGIN] ${usuario.username} (${usuario.id}) | ` +
        `whitelist=${whitelistAprobada} | cedula=${Boolean(usuarioRegistrado)}`,
    );

    if (!estaEnServidor) {
      console.log(`[LOGIN] ${usuario.id} no pertenece al servidor; acceso rechazado.`);
      return redirigirDespuesDeLogin(req, res, "/no-estas-en-el-servidor.html");
    }

    if (estadoWhitelist === "pendiente") {
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

async function exigirFundacion(req, res) {
  if (!exigirSesion(req, res)) return false;
  try {
    const roles = await obtenerRolesDelServidor(req.session.usuario.id);
    if (roles === null) {
      res.status(403).json({ redirect: "/no-estas-en-el-servidor.html" });
      return false;
    }
    if (!roles?.includes(ROL_FUNDACION) && !roles?.includes(ROL_STAFF)) {
      res.status(403).json({ error: "No tienes el rol autorizado para acceder al panel administrativo." });
      return false;
    }
    req.session.usuario.roles = roles;
    return true;
  } catch (error) {
    console.error("[FUNDACION AUTH]", error.message);
    res.status(503).json({ error: "No se pudo verificar tu rol de Fundación." });
    return false;
  }
}

async function exigirPolicia(req, res) {
  if (!exigirSesion(req, res)) return false;
  try {
    const roles = await obtenerRolesDelServidor(req.session.usuario.id);
    if (!roles?.some((rol) => ROLES_POLICIA.has(String(rol)))) {
      res.status(403).json({ error: "No tienes un rol policial autorizado para usar el PDA." });
      return false;
    }
    req.session.usuario.roles = roles;
    return true;
  } catch (error) {
    console.error("[POLICIA AUTH]", error.message);
    res.status(503).json({ error: "No se pudo verificar tu rol policial." });
    return false;
  }
}

app.post("/api/whitelist", async (req, res) => {
  if (!exigirSesion(req, res)) return;

  const respuestas = req.body?.respuestas;

  if (!respuestas || typeof respuestas !== "object") {
    return res.status(400).json({ error: "Las respuestas son obligatorias." });
  }

  try {
    const { pool } = require("./db");

    const [pendientesExistentes] = await pool.execute(
      `SELECT id
       FROM whitelist_solicitudes
       WHERE discord_id = ? AND estado = 'pendiente'
       ORDER BY id DESC
       LIMIT 1`,
      [req.session.usuario.id],
    );
    if (pendientesExistentes.length) {
      return res.status(409).json({
        error: "Ya tienes una solicitud de whitelist pendiente. Espera la revisión del equipo.",
        redirect: "/whitelist-pendiente.html",
      });
    }

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

    try {
      await agregarRolDiscord(
        req.session.usuario.id,
        ROL_WHITELIST_PENDIENTE,
        "Whitelist enviada desde la web",
      );
    } catch (errorRol) {
      console.error("[WHITELIST] No se pudo agregar el rol pendiente:", errorRol);
      await pool.execute(
        `DELETE FROM whitelist_solicitudes
         WHERE id = ? AND estado = 'pendiente'`,
        [resultadoWhitelist.insertId],
      );
      return res.status(503).json({
        error:
          "No se pudo asignar el rol pendiente en Discord. La solicitud no fue creada.",
      });
    }

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
        {
          content: `<@&${ROL_STAFF_WHITELIST}> **Esta whitelist se envió desde la web.**`,
          allowed_mentions: { roles: [ROL_STAFF_WHITELIST] },
        },
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

    if (estado?.estado === "pendiente") {
      return res.json({ estado: "pendiente" });
    }

    if (estado?.estado === "denegada") {
      return res.json({
        estado: "denegada",
        motivo: estado.motivo_denegacion || "La solicitud fue denegada.",
        redirect: "/whitelist-denegada.html",
      });
    }

    return res.json({ estado: "sin_solicitud", redirect: "/whitelist.html" });
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
  const fechaTexto = String(fecha_nac || "").trim();
  const coincidenciaFecha = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fechaTexto);
  if (!coincidenciaFecha) {
    return res.status(400).json({ error: "La fecha debe tener el formato DD/MM/AAAA, por ejemplo 02/02/2000." });
  }
  const [, dia, mes, anio] = coincidenciaFecha;
  const fechaISO = `${anio}-${mes}-${dia}`;
  const fechaValida = new Date(`${fechaISO}T00:00:00Z`);
  if (fechaValida.getUTCFullYear() !== Number(anio) || fechaValida.getUTCMonth() + 1 !== Number(mes) || fechaValida.getUTCDate() !== Number(dia)) {
    return res.status(400).json({ error: "La fecha de nacimiento no es válida." });
  }

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
          fechaISO,
          fechaTexto,
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
    const rolesDiscord = await obtenerRolesDelServidor(
      req.session.usuario.id,
    );
    const estaEnServidor = Array.isArray(rolesDiscord);
    const rolesActualizados = rolesDiscord || [];
    const { pool } = require("./db");
    const [solicitudes] = await pool.execute(
      `SELECT estado
       FROM whitelist_solicitudes
       WHERE discord_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [req.session.usuario.id],
    );
    const estadoSolicitud = solicitudes[0]?.estado || null;
    const tieneWhitelistPendiente = estadoSolicitud === "pendiente";

    req.session.usuario.cedula = cedulaActualizada;
    req.session.usuario.cedulaRegistrada = Boolean(cedulaActualizada);
    req.session.usuario.roles = rolesActualizados;
    req.session.usuario.estaEnServidor = estaEnServidor;
    req.session.usuario.whitelistPendiente = tieneWhitelistPendiente;

    return res.json({
      autenticado: true,
      usuario: req.session.usuario,
      fundacionAutorizada: rolesActualizados.includes(ROL_FUNDACION),
      staffAutorizado: rolesActualizados.includes(ROL_STAFF),
      policialAutorizado: rolesActualizados.some((rol) => ROLES_POLICIA.has(String(rol))),
      estaEnServidor,
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

app.get("/api/policial/ciudadano/:discordId", async (req, res) => {
  if (!(await exigirPolicia(req, res))) return;
  const discordId = String(req.params.discordId || "").trim();
  if (!/^\d{10,25}$/.test(discordId)) return res.status(400).json({ error: "Discord ID inválido." });
  try {
    const { pool } = require("./db");
    const cedula = await buscarUsuarioPorDiscord(discordId);
    const leer = async (tabla) => {
      const [filas] = await pool.execute(`SELECT payload FROM ${tabla} WHERE discord_id = ? ORDER BY fecha DESC`, [discordId]);
      return filas.map((fila) => typeof fila.payload === "string" ? JSON.parse(fila.payload) : fila.payload);
    };
    const [arrestos, antecedentes, multas] = await Promise.all([
      leer("expediente_arrestos"),
      leer("expediente_antecedentes"),
      leer("expediente_multas"),
    ]);
    return res.json({ correcto: true, ciudadano: cedula, expediente: { arrestos, antecedentes, multas } });
  } catch (error) {
    console.error("[API PDA POLICIAL]", error.message);
    return res.status(500).json({ error: "No se pudo consultar el ciudadano." });
  }
});

app.get("/api/policial/cedula/:nuip", async (req, res) => {
  if (!(await exigirPolicia(req, res))) return;
  const nuip = String(req.params.nuip || "").trim();
  if (!nuip) return res.status(400).json({ error: "Debes escribir el número de cédula." });
  try {
    const { pool } = require("./db");
    const [filas] = await pool.execute("SELECT * FROM usuarios WHERE nuip = ? LIMIT 1", [nuip]);
    if (!filas.length) return res.status(404).json({ error: "La cédula no está registrada o no está vinculada al sistema civil. Indícale al ciudadano que utilice /mostrar-cedula en Discord." });
    const ciudadano = filas[0];
    const discordId = String(ciudadano.discord_id || "");
    if (!discordId) return res.status(404).json({ error: "La cédula existe, pero no está vinculada a un Discord." });
    let expediente = { arrestos: [], antecedentes: [], multas: [] };
    if (process.env.NEQUI_API_URL && process.env.NEQUI_API_KEY) {
      try {
        const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
        const respuestaBot = await fetch(`${baseApi}/api/expediente/${discordId}`, { headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY }, signal: AbortSignal.timeout(8000) });
        if (respuestaBot.ok) {
          const datosBot = await respuestaBot.json();
          expediente = datosBot.expediente || expediente;
        }
      } catch (error) {
        console.warn("[API PDA NUIP] No se pudo leer el expediente del bot:", error.message);
      }
    }
    return res.json({ correcto: true, discordId, ciudadano, expediente });
  } catch (error) {
    console.error("[API PDA NUIP]", error.message);
    return res.status(500).json({ error: "No se pudo consultar la cédula." });
  }
});

app.get("/api/policial/cedula-imagen/:discordId", async (req, res) => {
  if (!(await exigirPolicia(req, res))) return;
  const discordId = String(req.params.discordId || "").trim();
  if (!/^\d{10,25}$/.test(discordId)) return res.status(400).send("Discord ID inválido.");
  try {
    const { pool } = require("./db");
    const [filas] = await pool.execute("SELECT cedula_imagen FROM usuarios WHERE discord_id = ? LIMIT 1", [discordId]);
    if (!filas[0]?.cedula_imagen) return res.status(404).send("La cédula no tiene imagen. El ciudadano debe ejecutar /mostrar-cedula en Discord.");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.send(filas[0].cedula_imagen);
  } catch (error) {
    console.error("[API IMAGEN CÉDULA POLICIAL]", error.message);
    return res.status(500).send("No se pudo cargar la imagen de la cédula.");
  }
});

app.post("/api/policial/arresto", async (req, res) => {
  if (!(await exigirPolicia(req, res))) return;
  const discordId = String(req.body?.discordId || "").trim();
  const delitos = Array.isArray(req.body?.delitos) ? req.body.delitos.map(String).filter(Boolean).slice(0, 25) : [];
  const imagenBase64 = String(req.body?.imagenBase64 || "");
  if (!/^\d{10,25}$/.test(discordId) || !delitos.length || !imagenBase64) {
    return res.status(400).json({ error: "Debes seleccionar ciudadano, antecedentes y una imagen de evidencia." });
  }
  try {
    if (!process.env.NEQUI_API_URL || !process.env.NEQUI_API_KEY) return res.status(503).json({ error: "Render no tiene configurada la conexión con la API del bot." });
    const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
    const respuesta = await fetch(`${baseApi}/api/arrestos/${req.session.usuario.id}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Nequi-Key": process.env.NEQUI_API_KEY }, body: JSON.stringify({ discordId, delitos, imagenBase64, oficialId: req.session.usuario.id, oficial: req.session.usuario.nombre || req.session.usuario.username }), signal: AbortSignal.timeout(30000) });
    const datos = await respuesta.json();
    return res.status(respuesta.status).json(datos);
  } catch (error) {
    console.error("[API PDA ARRESTO]", error.message);
    return res.status(500).json({ error: "No se pudo registrar el arresto. Verifica las tablas del expediente." });
  }
});

app.get("/api/policial/alertas", async (req, res) => {
  if (!(await exigirPolicia(req, res))) return;
  try {
    if (!process.env.NEQUI_API_URL || !process.env.NEQUI_API_KEY) return res.status(503).json({ error: "Render no tiene configurada la conexión con la API del bot." });
    const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
    const respuesta = await fetch(`${baseApi}/api/alertas/${req.session.usuario.id}`, { headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY }, signal: AbortSignal.timeout(8000) });
    const datos = await respuesta.json();
    return res.status(respuesta.status).json(datos);
  } catch (error) {
    console.error("[API PDA ALERTAS]", error.message);
    return res.status(503).json({ error: "No se pudieron cargar las alertas del bot." });
  }
});

app.get("/api/policial/vehiculo/:placa", async (req, res) => {
  if (!(await exigirPolicia(req, res))) return;
  const placa = String(req.params.placa || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,10}$/.test(placa)) return res.status(400).json({ error: "La placa no es válida." });
  try {
    if (!process.env.NEQUI_API_URL || !process.env.NEQUI_API_KEY) return res.status(503).json({ error: "Render no tiene configurada la conexión con la API del bot." });
    const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
    const respuesta = await fetch(`${baseApi}/api/vehiculos/${req.session.usuario.id}?placa=${encodeURIComponent(placa)}`, { headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY }, signal: AbortSignal.timeout(8000) });
    const datos = await respuesta.json();
    return res.status(respuesta.status).json(datos);
  } catch (error) {
    console.error("[API PDA VEHÍCULO]", error.message);
    return res.status(503).json({ error: "No se pudo consultar el vehículo." });
  }
});

app.get("/api/policial/usuarios", async (req, res) => {
  if (!(await exigirPolicia(req, res))) return;
  try {
    return res.json({ correcto: true, usuarios: await obtenerMiembrosDelServidor() });
  } catch (error) {
    console.error("[API PDA USUARIOS]", error.message);
    return res.status(503).json({ error: "No se pudo cargar la lista de ciudadanos." });
  }
});

app.get("/api/policial/imagen/:discordId", async (req, res) => {
  if (!(await exigirPolicia(req, res))) return;
  const discordId = String(req.params.discordId || "").trim();
  if (!/^\d{10,25}$/.test(discordId)) return res.status(400).send("Discord ID inválido.");
  try {
    const { pool } = require("./db");
    const [filas] = await pool.execute("SELECT imagen_png FROM pda_fuerza_publica WHERE discord_id = ? LIMIT 1", [discordId]);
    if (!filas[0]?.imagen_png) return res.status(404).send("El ciudadano todavía no ha generado su PDA.");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.send(filas[0].imagen_png);
  } catch (error) {
    console.error("[API PDA IMAGEN]", error.message);
    return res.status(500).send("No se pudo cargar la imagen PDA.");
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

app.post("/api/multas/:multaId/pagar", async (req, res) => {
  if (!exigirSesion(req, res)) return;
  try {
    if (!process.env.NEQUI_API_URL || !process.env.NEQUI_API_KEY) {
      return res.status(503).json({ error: "Render no tiene configurada la conexión con la API del bot." });
    }
    const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
    const respuesta = await fetch(`${baseApi}/api/multas/${req.session.usuario.id}/pagar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nequi-Key": process.env.NEQUI_API_KEY },
      body: JSON.stringify({ multaId: req.params.multaId }),
      signal: AbortSignal.timeout(10000),
    });
    const datos = await respuesta.json();
    return res.status(respuesta.status).json(datos);
  } catch (error) {
    console.error("[API PAGAR MULTA]", error.message);
    return res.status(500).json({ error: "No se pudo procesar el pago de la multa." });
  }
});

app.get("/api/expediente", async (req, res) => {
  if (!exigirSesion(req, res)) return;

  try {
    const { pool } = require("./db");
    const discordId = req.session.usuario.id;
    const [arrestos, antecedentes, multas] = await Promise.all([
      pool.execute(
        "SELECT payload FROM expediente_arrestos WHERE discord_id = ? ORDER BY fecha DESC",
        [discordId],
      ),
      pool.execute(
        "SELECT payload FROM expediente_antecedentes WHERE discord_id = ? ORDER BY fecha DESC",
        [discordId],
      ),
      pool.execute(
        "SELECT payload FROM expediente_multas WHERE discord_id = ? ORDER BY fecha DESC",
        [discordId],
      ),
    ]);
    const convertir = ([filas]) =>
      filas.map((fila) =>
        typeof fila.payload === "string" ? JSON.parse(fila.payload) : fila.payload,
      );
    const datos = {
      arrestos: convertir(arrestos),
      antecedentes: convertir(antecedentes),
      multas: convertir(multas),
    };
    return res.json({
      correcto: true,
      expediente: {
        ...datos,
        conteos: {
          arrestos: datos.arrestos.length,
          antecedentes: datos.antecedentes.length,
          multas: datos.multas.length,
          ordenes: 0,
        },
      },
    });
  } catch (error) {
    console.error("[API EXPEDIENTE]", error.message);
    return res.status(500).json({
      error: "No se pudo consultar el expediente sincronizado en MySQL.",
    });
  }
});

async function solicitarApiVehiculos(req, metodo = "GET", cuerpo = null, sufijo = "") {
  if (!process.env.NEQUI_API_URL || !process.env.NEQUI_API_KEY) {
    const error = new Error("Render no tiene configurada la conexión con la API del bot.");
    error.statusCode = 503;
    throw error;
  }
  const opciones = {
    method: metodo,
    headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY },
    signal: AbortSignal.timeout(8000),
  };
  if (cuerpo !== null) {
    opciones.headers["Content-Type"] = "application/json";
    opciones.body = JSON.stringify(cuerpo);
  }
  const baseApi = process.env.NEQUI_API_URL
    .replace(/\/$/, "")
    .replace(/\/api\/nequi$/, "");
  const respuesta = await fetch(
    `${baseApi}/api/vehiculos/${req.session.usuario.id}${sufijo}`,
    opciones,
  );
  const datos = await respuesta.json();
  return { estado: respuesta.status, datos };
}

app.get("/api/vehiculos", async (req, res) => {
  if (!exigirSesion(req, res)) return;
  try {
    const resultado = await solicitarApiVehiculos(req, "GET");
    return res.status(resultado.estado).json(resultado.datos);
  } catch (error) {
    console.error("[API VEHICULOS GET]", error.message);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post("/api/vehiculos", async (req, res) => {
  if (!exigirSesion(req, res)) return;
  try {
    const resultado = await solicitarApiVehiculos(req, "POST", req.body);
    return res.status(resultado.estado).json(resultado.datos);
  } catch (error) {
    console.error("[API VEHICULOS POST]", error.message);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.delete("/api/vehiculos/:id", async (req, res) => {
  if (!exigirSesion(req, res)) return;
  try {
    const resultado = await solicitarApiVehiculos(
      req,
      "DELETE",
      null,
      `/${encodeURIComponent(req.params.id)}`,
    );
    return res.status(resultado.estado).json(resultado.datos);
  } catch (error) {
    console.error("[API VEHICULOS DELETE]", error.message);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

async function solicitarApiTienda(req, metodo = "GET", cuerpo = null, sufijo = "") {
  if (!process.env.NEQUI_API_URL || !process.env.NEQUI_API_KEY) {
    const error = new Error("Render no tiene configurada la conexión con la API del bot.");
    error.statusCode = 503;
    throw error;
  }
  const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
  const opciones = { method: metodo, headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY }, signal: AbortSignal.timeout(8000) };
  if (cuerpo !== null) {
    opciones.headers["Content-Type"] = "application/json";
    opciones.body = JSON.stringify(cuerpo);
  }
  const respuesta = await fetch(`${baseApi}/api/tienda/${req.session.usuario.id}${sufijo}`, opciones);
  const datos = await respuesta.json();
  return { estado: respuesta.status, datos };
}

app.get("/api/tienda", async (req, res) => {
  if (!exigirSesion(req, res)) return;
  try {
    const resultado = await solicitarApiTienda(req);
    return res.status(resultado.estado).json(resultado.datos);
  } catch (error) {
    console.error("[API TIENDA GET]", error.message);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post("/api/tienda/:productoId/comprar", async (req, res) => {
  if (!exigirSesion(req, res)) return;
  try {
    const resultado = await solicitarApiTienda(req, "POST", { productoId: req.params.productoId }, "/comprar");
    return res.status(resultado.estado).json(resultado.datos);
  } catch (error) {
    console.error("[API TIENDA COMPRA]", error.message);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get("/api/comportamiento", async (req, res) => {
  if (!exigirSesion(req, res)) return;
  try {
    const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
    const respuesta = await fetch(`${baseApi}/api/comportamiento/${req.session.usuario.id}`, {
      headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    const datos = await respuesta.json();
    return res.status(respuesta.status).json(datos);
  } catch (error) {
    console.error("[API COMPORTAMIENTO]", error.message);
    return res.status(500).json({ error: "No se pudo consultar el comportamiento." });
  }
});

app.post("/api/fundacion", async (req, res) => {
  if (!(await exigirFundacion(req, res))) return;
  if (!process.env.NEQUI_API_URL || !process.env.NEQUI_API_KEY) {
    return res.status(503).json({ error: "Render no tiene configurada la conexión con la API del bot." });
  }
  try {
    const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
    const respuesta = await fetch(`${baseApi}/api/fundacion/${req.session.usuario.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nequi-Key": process.env.NEQUI_API_KEY },
      body: JSON.stringify({ ...req.body, adminId: req.session.usuario.id, adminTag: req.session.usuario.username }),
      signal: AbortSignal.timeout(10000),
    });
    const datos = await respuesta.json();
    return res.status(respuesta.status).json(datos);
  } catch (error) {
    console.error("[API FUNDACION]", error.message);
    return res.status(500).json({ error: "No se pudo completar la operación de Fundación." });
  }
});

app.get("/api/fundacion/catalogo", async (req, res) => {
  if (!(await exigirFundacion(req, res))) return;
  try {
    const resultado = await solicitarApiTienda(req, "GET");
    return res.status(resultado.estado).json({ correcto: resultado.estado >= 200 && resultado.estado < 300, tienda: resultado.datos.tienda || [], inventario: resultado.datos.inventario || [], error: resultado.datos.error });
  } catch (error) {
    console.error("[API FUNDACION CATALOGO]", error.message);
    return res.status(error.statusCode || 500).json({ error: error.message || "No se pudo cargar la tienda." });
  }
});

app.delete("/api/fundacion/catalogo/:productoId", async (req, res) => {
  if (!(await exigirFundacion(req, res))) return;
  try {
    const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
    const respuesta = await fetch(`${baseApi}/api/fundacion/${req.session.usuario.id}/${encodeURIComponent(req.params.productoId)}`, {
      method: "DELETE", headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY }, signal: AbortSignal.timeout(8000),
    });
    return res.status(respuesta.status).json(await respuesta.json());
  } catch (error) { return res.status(500).json({ error: "No se pudo eliminar el objeto." }); }
});

app.get("/api/fundacion/comportamiento/:discordId", async (req, res) => {
  if (!(await exigirFundacion(req, res))) return;
  try {
    const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
    const respuesta = await fetch(`${baseApi}/api/fundacion/${req.session.usuario.id}?vista=comportamiento&discordId=${encodeURIComponent(req.params.discordId)}`, {
      headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY }, signal: AbortSignal.timeout(8000),
    });
    return res.status(respuesta.status).json(await respuesta.json());
  } catch (error) { return res.status(500).json({ error: "No se pudo cargar el comportamiento." }); }
});

app.delete("/api/fundacion/comportamiento/:discordId/:tipo/:indice", async (req, res) => {
  if (!(await exigirFundacion(req, res))) return;
  try {
    const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
    const respuesta = await fetch(`${baseApi}/api/fundacion/${req.session.usuario.id}/comportamiento/${encodeURIComponent(req.params.discordId)}/${encodeURIComponent(req.params.tipo)}/${encodeURIComponent(req.params.indice)}`, {
      method: "DELETE",
      headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    return res.status(respuesta.status).json(await respuesta.json());
  } catch (error) {
    console.error("[API CANCELAR COMPORTAMIENTO]", error.message);
    return res.status(500).json({ error: "No se pudo cancelar el registro." });
  }
});

app.get("/api/fundacion/trabajos", async (req, res) => {
  if (!(await exigirFundacion(req, res))) return;
  try {
    const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
    const respuesta = await fetch(`${baseApi}/api/fundacion/${req.session.usuario.id}?vista=trabajos`, {
      headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    return res.status(respuesta.status).json(await respuesta.json());
  } catch (error) {
    console.error("[API TRABAJOS]", error.message);
    return res.status(500).json({ error: "No se pudieron cargar los trabajos." });
  }
});

app.delete("/api/fundacion/trabajos/:trabajoId", async (req, res) => {
  if (!(await exigirFundacion(req, res))) return;
  try {
    const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
    const respuesta = await fetch(`${baseApi}/api/fundacion/${req.session.usuario.id}/trabajo/${encodeURIComponent(req.params.trabajoId)}`, {
      method: "DELETE",
      headers: { "X-Nequi-Key": process.env.NEQUI_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    return res.status(respuesta.status).json(await respuesta.json());
  } catch (error) {
    console.error("[API ELIMINAR TRABAJO]", error.message);
    return res.status(500).json({ error: "No se pudo eliminar el trabajo." });
  }
});

app.get("/api/fundacion/usuarios", async (req, res) => {
  if (!(await exigirFundacion(req, res))) return;
  try {
    const usuarios = await obtenerMiembrosDelServidor();
    return res.json({ correcto: true, usuarios });
  } catch (error) {
    console.error("[FUNDACION USUARIOS]", error.message);
    return res.status(503).json({ error: "No se pudo cargar la lista de usuarios del servidor." });
  }
});

app.get("/api/fundacion/twitter", async (req, res) => {
  if (!(await exigirFundacion(req, res))) return;
  try {
    let cuentas;
    try {
      [cuentas] = await pool.execute(
        `SELECT id, discord_id, nombre, avatar_url, verificado, creado_en
           FROM twitter_cuentas ORDER BY nombre ASC`,
      );
    } catch (error) {
      if (error.code !== "ER_BAD_FIELD_ERROR") throw error;
      const [sinVerificacion] = await pool.execute(
        `SELECT id, discord_id, nombre, avatar_url, creado_en
           FROM twitter_cuentas ORDER BY nombre ASC`,
      );
      cuentas = sinVerificacion.map((cuenta) => ({ ...cuenta, verificado: 0 }));
    }
    return res.json({ correcto: true, cuentas });
  } catch (error) {
    console.error("[FUNDACION TWITTER]", error.message);
    return res.status(500).json({ error: "No se pudieron cargar las cuentas de Twitter." });
  }
});

app.patch("/api/fundacion/twitter/:discordId", async (req, res) => {
  if (!(await exigirFundacion(req, res))) return;
  const discordId = String(req.params.discordId || "").trim();
  const verificado = req.body?.verificado === true || req.body?.verificado === 1 || req.body?.verificado === "1";
  if (!/^\d{10,25}$/.test(discordId)) return res.status(400).json({ error: "Discord ID inválido." });
  try {
    let resultado;
    try {
      [resultado] = await pool.execute(
        "UPDATE twitter_cuentas SET verificado = ? WHERE discord_id = ?",
        [verificado ? 1 : 0, discordId],
      );
    } catch (error) {
      if (error.code !== "ER_BAD_FIELD_ERROR") throw error;
      await pool.execute("ALTER TABLE twitter_cuentas ADD COLUMN verificado TINYINT(1) NOT NULL DEFAULT 0 AFTER avatar_url");
      [resultado] = await pool.execute(
        "UPDATE twitter_cuentas SET verificado = ? WHERE discord_id = ?",
        [verificado ? 1 : 0, discordId],
      );
    }
    if (!resultado.affectedRows) return res.status(404).json({ error: "La cuenta Twitter no existe." });
    return res.json({ correcto: true, discordId, verificado });
  } catch (error) {
    console.error("[FUNDACION TWITTER VERIFICAR]", error.message);
    return res.status(500).json({ error: "No se pudo actualizar la verificación." });
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

const TWITTER_AVATAR_DEFECTO = "https://cdn.pixabay.com/photo/2023/02/18/11/00/icon-7797704_1280.png";

let twitterSchemaPromise;

async function asegurarEsquemaTwitter() {
  if (!twitterSchemaPromise) {
    twitterSchemaPromise = (async () => {
      try {
        await pool.execute("SELECT verificado FROM twitter_cuentas LIMIT 1");
      } catch (error) {
        if (error.code !== "ER_BAD_FIELD_ERROR") throw error;

        try {
          await pool.execute(
            "ALTER TABLE twitter_cuentas ADD COLUMN verificado TINYINT(1) NOT NULL DEFAULT 0 AFTER avatar_url",
          );
          console.log("[TWITTER] Columna verificado creada automáticamente.");
        } catch (alterError) {
          // Si dos solicitudes intentan preparar el esquema a la vez,
          // la segunda puede recibir el error de columna duplicada.
          if (alterError.code !== "ER_DUP_FIELDNAME") throw alterError;
        }
      }
    })().catch((error) => {
      twitterSchemaPromise = undefined;
      throw error;
    });
  }

  return twitterSchemaPromise;
}

app.use("/api/twitter", async (req, res, next) => {
  try {
    await asegurarEsquemaTwitter();
    return next();
  } catch (error) {
    console.error("[TWITTER ESQUEMA]", error.message);
    return res.status(503).json({
      error: "Twitter no está disponible porque no se pudo preparar la tabla de cuentas.",
    });
  }
});

function textoTwitter(valor, maximo) {
  return String(valor ?? "").trim().slice(0, maximo);
}

function imagenTwitterValida(valor) {
  if (!valor) return true;
  return /^(https?:\/\/|data:image\/)/i.test(String(valor)) && String(valor).length <= 2_500_000;
}

async function obtenerCuentaTwitter(discordId) {
  const [filas] = await pool.execute(
    `SELECT id, discord_id, nombre, avatar_url, verificado, ultimo_cambio_perfil, creado_en, actualizado_en
       FROM twitter_cuentas WHERE discord_id = ? LIMIT 1`,
    [discordId],
  );
  return filas[0] || null;
}

function serializarCuentaTwitter(cuenta) {
  if (!cuenta) return null;
  return {
    ...cuenta,
    avatar_url: cuenta.avatar_url || TWITTER_AVATAR_DEFECTO,
  };
}

async function enviarLogTwitter(titulo, descripcion, campos = [], thumbnail) {
  try {
    const thumbnailHttp = /^https?:\/\//i.test(String(thumbnail || "")) ? thumbnail : undefined;
    await enviarEmbedDiscord(CANAL_LOG_TWITTER, {
      title: titulo,
      description,
      color: 0x22caa0,
      fields: campos,
      thumbnail: thumbnailHttp ? { url: thumbnailHttp } : undefined,
      footer: { text: `${NOMBRE_SERVIDOR} • Twitter ciudadano` },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[TWITTER] No se pudo enviar el log a Discord:", error.message);
  }
}

async function notificarSeguidoresTwitter(autor, publicacion) {
  try {
    const [seguidores] = await pool.execute(
      `SELECT c.discord_id
         FROM twitter_seguidores s INNER JOIN twitter_cuentas c ON c.id = s.seguidor_id
        WHERE s.seguido_id = ?`,
      [autor.id],
    );
    const ids = seguidores.map((fila) => String(fila.discord_id)).filter(Boolean);
    console.log(`[TWITTER NOTIFICACIONES] Publicación de ${autor.discord_id}: ${ids.length} seguidor(es) encontrado(s).`);
    if (!ids.length) return 0;
    if (process.env.NEQUI_API_URL && process.env.NEQUI_API_KEY) {
      const baseApi = process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, "");
      const respuestaBot = await fetch(`${baseApi}/api/twitter/${autor.discord_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nequi-Key": process.env.NEQUI_API_KEY },
        body: JSON.stringify({ followerIds: ids, nombre: publicacion.nombre, descripcion: publicacion.descripcion }),
        signal: AbortSignal.timeout(8000),
      });
      if (respuestaBot.ok) {
        const resultadoBot = await respuestaBot.json().catch(() => ({}));
        console.log(`[TWITTER NOTIFICACIONES] Bot confirmó ${Number(resultadoBot.notificados || ids.length)} notificación(es).`);
        return Number(resultadoBot.notificados || ids.length);
      }
      console.warn(`[TWITTER NOTIFICACIONES] El bot respondió ${respuestaBot.status}; se intentará el respaldo web.`);
    }
    for (const id of ids) {
      await enviarEmbedDiscord(
        CANAL_LOG_TWITTER,
        {
          title: "🐦 Nueva publicación de una cuenta que sigues",
          description: `**<@${autor.discord_id}>** publicó algo nuevo en Twitter ciudadano.\n\n**${publicacion.nombre}**\n${publicacion.descripcion}`,
          color: 0x42d8d0,
          fields: [
            { name: "👤 Cuenta que publicó", value: `<@${autor.discord_id}>`, inline: true },
            { name: "🔔 Notificado", value: `<@${id}> está siguiendo esta cuenta`, inline: true },
          ],
          footer: { text: `${NOMBRE_SERVIDOR} • Notificación Twitter` },
          timestamp: new Date().toISOString(),
        },
        [],
        { content: `<@${id}>`, allowed_mentions: { users: [id] } },
      );
    }
    return ids.length;
  } catch (error) {
    console.error("[TWITTER NOTIFICACIONES]", error.message);
    return 0;
  }
}

async function exigirCuentaTwitter(req, res) {
  if (!exigirSesion(req, res)) return null;
  const cuenta = await obtenerCuentaTwitter(req.session.usuario.id);
  if (!cuenta) {
    res.status(404).json({ error: "Debes crear tu cuenta de Twitter primero.", cuenta: null });
    return null;
  }
  return cuenta;
}

app.get("/api/twitter/me", async (req, res) => {
  if (!exigirSesion(req, res)) return;
  try {
    const cuenta = await obtenerCuentaTwitter(req.session.usuario.id);
    return res.json({ cuenta: serializarCuentaTwitter(cuenta), avatarDefecto: TWITTER_AVATAR_DEFECTO });
  } catch (error) {
    console.error("[TWITTER ME]", error.message);
    return res.status(500).json({ error: "No se pudo cargar tu cuenta de Twitter." });
  }
});

app.post("/api/twitter/cuenta", async (req, res) => {
  if (!exigirSesion(req, res)) return;
  try {
    const discordId = req.session.usuario.id;
    const nombre = textoTwitter(req.body?.nombre, 80);
    const avatarRecibido = textoTwitter(req.body?.avatarUrl, 2_500_000);
    const avatarUrl = /^data:[^;]+;base64,$/i.test(avatarRecibido) ? TWITTER_AVATAR_DEFECTO : (avatarRecibido || TWITTER_AVATAR_DEFECTO);
    if (!nombre) return res.status(400).json({ error: "El nombre de Twitter es obligatorio." });
    if (!imagenTwitterValida(avatarUrl)) return res.status(400).json({ error: "La imagen debe ser una URL válida o una imagen cargada." });
    if (await obtenerCuentaTwitter(discordId)) return res.status(409).json({ error: "Ya tienes una cuenta de Twitter." });

    await pool.execute(
      `INSERT INTO twitter_cuentas (discord_id, nombre, avatar_url, ultimo_cambio_perfil)
       VALUES (?, ?, ?, NOW())`,
      [discordId, nombre, avatarUrl],
    );
    const cuenta = await obtenerCuentaTwitter(discordId);
    await enviarLogTwitter(
      "🐦 Nueva cuenta de Twitter",
      "Se registró una cuenta ciudadana desde la web de Medellín RP.",
      [
        { name: "👤 Usuario", value: `<@${discordId}>`, inline: true },
        { name: "📝 Nombre", value: nombre, inline: true },
      ],
      avatarUrl,
    );
    return res.status(201).json({ correcto: true, cuenta: serializarCuentaTwitter(cuenta) });
  } catch (error) {
    console.error("[TWITTER CUENTA]", error.message);
    return res.status(error.code === "ER_DUP_ENTRY" ? 409 : 500).json({ error: error.code === "ER_DUP_ENTRY" ? "Ya tienes una cuenta de Twitter." : "No se pudo crear la cuenta de Twitter." });
  }
});

app.put("/api/twitter/cuenta", async (req, res) => {
  if (!exigirSesion(req, res)) return;
  try {
    const cuenta = await obtenerCuentaTwitter(req.session.usuario.id);
    if (!cuenta) return res.status(404).json({ error: "Primero debes crear tu cuenta de Twitter." });
    const horasDesdeCambio = (Date.now() - new Date(cuenta.ultimo_cambio_perfil).getTime()) / 3_600_000;
    if (horasDesdeCambio < 240) {
      const diasRestantes = Math.max(1, Math.ceil((240 - horasDesdeCambio) / 24));
      return res.status(429).json({ error: `Solo puedes cambiar tu nombre o foto cada 10 días. Faltan aproximadamente ${diasRestantes} día(s).` });
    }
    const nombre = textoTwitter(req.body?.nombre, 80) || cuenta.nombre;
    const avatarUrl = req.body?.avatarUrl === undefined ? cuenta.avatar_url : (textoTwitter(req.body.avatarUrl, 2_500_000) || TWITTER_AVATAR_DEFECTO);
    if (!imagenTwitterValida(avatarUrl)) return res.status(400).json({ error: "La imagen debe ser una URL válida o una imagen cargada." });
    await pool.execute(
      `UPDATE twitter_cuentas SET nombre = ?, avatar_url = ?, ultimo_cambio_perfil = NOW() WHERE id = ?`,
      [nombre, avatarUrl, cuenta.id],
    );
    return res.json({ correcto: true, cuenta: serializarCuentaTwitter(await obtenerCuentaTwitter(req.session.usuario.id)) });
  } catch (error) {
    console.error("[TWITTER PERFIL]", error.message);
    return res.status(500).json({ error: "No se pudo actualizar el perfil." });
  }
});

async function publicacionesTwitterPara(cuentaId, discordId = null, soloCuentaId = null) {
  const condiciones = [];
  const parametros = [];
  if (soloCuentaId) {
    condiciones.push("p.cuenta_id = ?");
    parametros.push(soloCuentaId);
  }
  const filtro = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";
  const parametrosConsulta = [cuentaId, cuentaId, ...parametros, 10];
  const [filas] = await pool.execute(
    `SELECT p.id, p.cuenta_id, p.nombre, p.descripcion, p.imagen_url, p.creado_en,
            c.nombre AS autor_nombre, c.avatar_url AS autor_avatar, c.discord_id AS autor_discord_id, c.verificado AS autor_verificado,
            IF(p.cuenta_id = ?, 1, 0) AS propia,
            (SELECT COUNT(*) FROM twitter_likes l WHERE l.publicacion_id = p.id) AS likes,
            IF(EXISTS(SELECT 1 FROM twitter_likes l2 WHERE l2.publicacion_id = p.id AND l2.cuenta_id = ?), 1, 0) AS liked,
            (SELECT COUNT(*) FROM twitter_comentarios co WHERE co.publicacion_id = p.id) AS comentarios
       FROM twitter_publicaciones p
       INNER JOIN twitter_cuentas c ON c.id = p.cuenta_id
       ${filtro}
       ORDER BY p.creado_en DESC, p.id DESC LIMIT ?`,
    parametrosConsulta,
  );
  return filas;
}

app.get("/api/twitter/feed", async (req, res) => {
  const cuenta = await exigirCuentaTwitter(req, res);
  if (!cuenta) return;
  try {
    return res.json({ cuenta: serializarCuentaTwitter(cuenta), publicaciones: await publicacionesTwitterPara(cuenta.id) });
  } catch (error) {
    console.error("[TWITTER FEED]", error.message);
    return res.status(500).json({ error: "No se pudo cargar el inicio de Twitter." });
  }
});

app.get("/api/twitter/buscar", async (req, res) => {
  const cuenta = await exigirCuentaTwitter(req, res);
  if (!cuenta) return;
  const q = textoTwitter(req.query?.q, 120);
  if (!q) return res.status(400).json({ error: "Escribe algo para buscar." });
  try {
    const patron = `%${q}%`;
    const [publicaciones] = await pool.execute(
      `SELECT p.id, p.cuenta_id, p.nombre, p.descripcion, p.imagen_url, p.creado_en,
              c.nombre AS autor_nombre, c.avatar_url AS autor_avatar, c.discord_id AS autor_discord_id, c.verificado AS autor_verificado,
              IF(p.cuenta_id = ?, 1, 0) AS propia,
              (SELECT COUNT(*) FROM twitter_likes l WHERE l.publicacion_id = p.id) AS likes,
              IF(EXISTS(SELECT 1 FROM twitter_likes l2 WHERE l2.publicacion_id = p.id AND l2.cuenta_id = ?), 1, 0) AS liked,
              (SELECT COUNT(*) FROM twitter_comentarios co WHERE co.publicacion_id = p.id) AS comentarios
         FROM twitter_publicaciones p
         INNER JOIN twitter_cuentas c ON c.id = p.cuenta_id
        WHERE p.nombre LIKE ? OR p.descripcion LIKE ? OR c.nombre LIKE ?
        ORDER BY p.creado_en DESC, p.id DESC LIMIT 50`,
      [cuenta.id, cuenta.id, patron, patron, patron],
    );
    return res.json({ consulta: q, publicaciones });
  } catch (error) {
    console.error("[TWITTER BUSCAR]", error.message);
    return res.status(500).json({ error: "No se pudieron buscar publicaciones." });
  }
});

app.get("/api/twitter/perfil/:discordId", async (req, res) => {
  const cuenta = await exigirCuentaTwitter(req, res);
  if (!cuenta) return;
  try {
    const [cuentas] = await pool.execute("SELECT id, discord_id, nombre, avatar_url, verificado, creado_en FROM twitter_cuentas WHERE discord_id = ? LIMIT 1", [req.params.discordId]);
    if (!cuentas[0]) return res.status(404).json({ error: "Ese usuario todavía no tiene cuenta de Twitter." });
    const objetivo = cuentas[0];
    const [[estadisticas]] = await pool.execute(
      `SELECT
        (SELECT COUNT(*) FROM twitter_seguidores WHERE seguido_id = ?) AS seguidores,
        (SELECT COUNT(*) FROM twitter_seguidores WHERE seguidor_id = ?) AS siguiendo,
        EXISTS(SELECT 1 FROM twitter_seguidores WHERE seguidor_id = ? AND seguido_id = ?) AS siguiendo_cuenta`,
      [objetivo.id, objetivo.id, cuenta.id, objetivo.id],
    );
    const [seguidoresLista] = await pool.execute(
      `SELECT c.discord_id, c.nombre, c.avatar_url
         FROM twitter_seguidores s INNER JOIN twitter_cuentas c ON c.id = s.seguidor_id
        WHERE s.seguido_id = ? ORDER BY s.creado_en DESC LIMIT 100`,
      [objetivo.id],
    );
    const [siguiendoLista] = await pool.execute(
      `SELECT c.discord_id, c.nombre, c.avatar_url
         FROM twitter_seguidores s INNER JOIN twitter_cuentas c ON c.id = s.seguido_id
        WHERE s.seguidor_id = ? ORDER BY s.creado_en DESC LIMIT 100`,
      [objetivo.id],
    );
    return res.json({
      cuenta: { ...serializarCuentaTwitter(objetivo), seguidores: Number(estadisticas.seguidores || 0), siguiendo: Number(estadisticas.siguiendo || 0), siguiendo_cuenta: Boolean(estadisticas.siguiendo_cuenta), seguidores_lista: seguidoresLista, siguiendo_lista: siguiendoLista },
      publicaciones: await publicacionesTwitterPara(cuenta.id, null, objetivo.id),
    });
  } catch (error) {
    console.error("[TWITTER PERFIL PUBLICO]", error.message);
    return res.status(500).json({ error: "No se pudo cargar el perfil." });
  }
});

app.post("/api/twitter/cuentas/:discordId/seguir", async (req, res) => {
  const cuenta = await exigirCuentaTwitter(req, res);
  if (!cuenta) return;
  try {
    const objetivo = await obtenerCuentaTwitter(req.params.discordId);
    if (!objetivo) return res.status(404).json({ error: "Ese usuario todavía no tiene cuenta de Twitter." });
    if (objetivo.id === cuenta.id) return res.status(400).json({ error: "No puedes seguir tu propia cuenta." });
    const [existente] = await pool.execute("SELECT 1 FROM twitter_seguidores WHERE seguidor_id = ? AND seguido_id = ? LIMIT 1", [cuenta.id, objetivo.id]);
    if (existente.length) {
      await pool.execute("DELETE FROM twitter_seguidores WHERE seguidor_id = ? AND seguido_id = ?", [cuenta.id, objetivo.id]);
    } else {
      await pool.execute("INSERT INTO twitter_seguidores (seguidor_id, seguido_id) VALUES (?, ?)", [cuenta.id, objetivo.id]);
    }
    const [[conteos]] = await pool.execute(
      `SELECT
        (SELECT COUNT(*) FROM twitter_seguidores WHERE seguido_id = ?) AS seguidores,
        (SELECT COUNT(*) FROM twitter_seguidores WHERE seguidor_id = ?) AS siguiendo`,
      [objetivo.id, cuenta.id],
    );
    return res.json({ siguiendo_cuenta: !existente.length, seguidores: Number(conteos.seguidores || 0), siguiendo: Number(conteos.siguiendo || 0) });
  } catch (error) {
    console.error("[TWITTER SEGUIR]", error.message);
    return res.status(500).json({ error: "No se pudo actualizar el seguimiento." });
  }
});

app.post("/api/twitter/publicaciones", async (req, res) => {
  const cuenta = await exigirCuentaTwitter(req, res);
  if (!cuenta) return;
  try {
    const nombre = textoTwitter(req.body?.nombre, 80);
    const descripcion = textoTwitter(req.body?.descripcion, 2000);
    const imagenUrl = textoTwitter(req.body?.imagenUrl, 2_500_000);
    if (!nombre || !descripcion) return res.status(400).json({ error: "El nombre y la descripción son obligatorios." });
    if (!imagenTwitterValida(imagenUrl)) return res.status(400).json({ error: "La imagen debe ser una URL válida o una imagen cargada." });
    const [resultado] = await pool.execute(
      `INSERT INTO twitter_publicaciones (cuenta_id, nombre, descripcion, imagen_url) VALUES (?, ?, ?, ?)`,
      [cuenta.id, nombre, descripcion, imagenUrl || null],
    );
    const notificados = await notificarSeguidoresTwitter(cuenta, { nombre, descripcion });
    return res.status(201).json({ correcto: true, id: resultado.insertId, notificados });
  } catch (error) {
    console.error("[TWITTER PUBLICAR]", error.message);
    return res.status(500).json({ error: "No se pudo publicar el mensaje." });
  }
});

app.delete("/api/twitter/publicaciones/:id", async (req, res) => {
  const cuenta = await exigirCuentaTwitter(req, res);
  if (!cuenta) return;
  const publicacionId = Number(req.params.id);
  if (!Number.isSafeInteger(publicacionId) || publicacionId < 1) {
    return res.status(400).json({ error: "Publicación inválida." });
  }
  try {
    const [resultado] = await pool.execute(
      "DELETE FROM twitter_publicaciones WHERE id = ? AND cuenta_id = ?",
      [publicacionId, cuenta.id],
    );
    if (!resultado.affectedRows) {
      return res.status(403).json({ error: "Solo puedes eliminar tus propias publicaciones." });
    }
    await enviarLogTwitter(
      "🗑️ Publicación eliminada",
      "Una publicación fue eliminada desde Twitter ciudadano.",
      [
        { name: "👤 Usuario", value: `<@${req.session.usuario.id}>`, inline: true },
        { name: "🆔 Publicación", value: String(publicacionId), inline: true },
      ],
      cuenta.avatar_url,
    );
    return res.json({ correcto: true, eliminada: publicacionId });
  } catch (error) {
    console.error("[TWITTER ELIMINAR]", error.message);
    return res.status(500).json({ error: "No se pudo eliminar la publicación." });
  }
});

app.post("/api/twitter/publicaciones/:id/like", async (req, res) => {
  const cuenta = await exigirCuentaTwitter(req, res);
  if (!cuenta) return;
  const publicacionId = Number(req.params.id);
  if (!Number.isSafeInteger(publicacionId) || publicacionId < 1) return res.status(400).json({ error: "Publicación inválida." });
  try {
    const [existentes] = await pool.execute("SELECT 1 FROM twitter_likes WHERE publicacion_id = ? AND cuenta_id = ? LIMIT 1", [publicacionId, cuenta.id]);
    if (existentes.length) {
      await pool.execute("DELETE FROM twitter_likes WHERE publicacion_id = ? AND cuenta_id = ?", [publicacionId, cuenta.id]);
    } else {
      await pool.execute("INSERT INTO twitter_likes (publicacion_id, cuenta_id) VALUES (?, ?)", [publicacionId, cuenta.id]);
    }
    const [total] = await pool.execute("SELECT COUNT(*) AS total FROM twitter_likes WHERE publicacion_id = ?", [publicacionId]);
    return res.json({ liked: !existentes.length, likes: Number(total[0].total || 0) });
  } catch (error) {
    console.error("[TWITTER LIKE]", error.message);
    return res.status(500).json({ error: "No se pudo actualizar el like." });
  }
});

app.get("/api/twitter/publicaciones/:id/comentarios", async (req, res) => {
  const cuenta = await exigirCuentaTwitter(req, res);
  if (!cuenta) return;
  try {
    const [comentarios] = await pool.execute(
      `SELECT co.id, co.cuenta_id, co.texto, co.creado_en, c.nombre, c.avatar_url, c.discord_id
         FROM twitter_comentarios co INNER JOIN twitter_cuentas c ON c.id = co.cuenta_id
        WHERE co.publicacion_id = ? ORDER BY co.creado_en ASC`,
      [Number(req.params.id)],
    );
    return res.json({ comentarios: comentarios.map((x) => ({ ...x, avatar_url: x.avatar_url || TWITTER_AVATAR_DEFECTO })) });
  } catch (error) {
    console.error("[TWITTER COMENTARIOS]", error.message);
    return res.status(500).json({ error: "No se pudieron cargar los comentarios." });
  }
});

app.post("/api/twitter/publicaciones/:id/comentarios", async (req, res) => {
  const cuenta = await exigirCuentaTwitter(req, res);
  if (!cuenta) return;
  const texto = textoTwitter(req.body?.texto, 600);
  const publicacionId = Number(req.params.id);
  if (!texto) return res.status(400).json({ error: "Escribe un comentario." });
  try {
    await pool.execute("INSERT INTO twitter_comentarios (publicacion_id, cuenta_id, texto) VALUES (?, ?, ?)", [publicacionId, cuenta.id, texto]);
    return res.status(201).json({ correcto: true });
  } catch (error) {
    console.error("[TWITTER COMENTAR]", error.message);
    return res.status(500).json({ error: "No se pudo publicar el comentario." });
  }
});

app.delete("/api/twitter/comentarios/:id", async (req, res) => {
  const cuenta = await exigirCuentaTwitter(req, res);
  if (!cuenta) return;
  const comentarioId = Number(req.params.id);
  if (!Number.isSafeInteger(comentarioId) || comentarioId < 1) return res.status(400).json({ error: "Comentario inválido." });
  try {
    const [resultado] = await pool.execute(
      "DELETE FROM twitter_comentarios WHERE id = ? AND cuenta_id = ?",
      [comentarioId, cuenta.id],
    );
    if (!resultado.affectedRows) return res.status(403).json({ error: "Solo puedes eliminar tus propios comentarios." });
    return res.json({ correcto: true, eliminado: comentarioId });
  } catch (error) {
    console.error("[TWITTER ELIMINAR COMENTARIO]", error.message);
    return res.status(500).json({ error: "No se pudo eliminar el comentario." });
  }
});

function montarRutasEncuestas({ app, exigirSesion, exigirFundacion, logger = console } = {}) {
  if (!app || typeof app.get !== "function") {
    throw new TypeError("montarRutasEncuestas requiere la aplicación Express.");
  }
  if (typeof exigirSesion !== "function" || typeof exigirFundacion !== "function") {
    throw new TypeError("Debes proporcionar exigirSesion y exigirFundacion de server.js.");
  }

  const intentos = new Map();

  function configuracionBot() {
    if (!process.env.NEQUI_API_URL || !process.env.NEQUI_API_KEY) {
      const error = new Error("El servidor web no tiene configurada la conexión con la API del bot.");
      error.statusCode = 503;
      throw error;
    }
    return {
      base: process.env.NEQUI_API_URL.replace(/\/$/, "").replace(/\/api\/nequi$/, ""),
      clave: process.env.NEQUI_API_KEY,
    };
  }

  function exigirOrigenMismoSitio(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origen = req.get("origin");
    if (!origen) return next();
    try {
      if (new URL(origen).host !== req.get("host")) {
        return res.status(403).json({ error: "Origen de solicitud no permitido." });
      }
    } catch {
      return res.status(403).json({ error: "Origen de solicitud inválido." });
    }
    return next();
  }

  function limitarRespuestas(req, res, next) {
    const clave = String(req.session?.usuario?.id || req.ip || "desconocido");
    const ahora = Date.now();
    const historial = (intentos.get(clave) || []).filter((marca) => ahora - marca < 60_000);
    if (historial.length >= 10) {
      return res.status(429).json({ error: "Demasiadas solicitudes. Espera un minuto e inténtalo de nuevo." });
    }
    historial.push(ahora);
    intentos.set(clave, historial);
    if (intentos.size > 5000) {
      for (const [id, marcas] of intentos) {
        if (!marcas.some((marca) => ahora - marca < 60_000)) intentos.delete(id);
      }
    }
    return next();
  }

  async function solicitarBot(ruta, { method = "GET", body, timeout = 10_000 } = {}) {
    const { base, clave } = configuracionBot();
    const opciones = {
      method,
      headers: {
        "X-Nequi-Key": clave,
        "User-Agent": "Medellin-RP-Web/1.0",
      },
      signal: AbortSignal.timeout(timeout),
    };
    if (body !== undefined) {
      opciones.headers["Content-Type"] = "application/json";
      opciones.body = JSON.stringify(body);
    }

    const respuesta = await fetch(`${base}${ruta}`, opciones);
    const tipo = respuesta.headers.get("content-type") || "";
    if (!tipo.includes("application/json")) {
      const detalle = (await respuesta.text()).slice(0, 300);
      const error = new Error(`La API del bot devolvió una respuesta inválida (${respuesta.status}): ${detalle}`);
      error.statusCode = 502;
      throw error;
    }
    return { status: respuesta.status, datos: await respuesta.json() };
  }

  function manejarError(res, error, contexto) {
    logger.error(`[${contexto}]`, error.message);
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return res.status(504).json({ error: "La API del bot tardó demasiado en responder." });
    }
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "No se pudo completar la operación de encuestas.",
    });
  }

  app.use("/api/encuestas", exigirOrigenMismoSitio);
  app.use("/api/fundacion/encuestas", exigirOrigenMismoSitio);

  app.get("/api/encuestas", async (req, res) => {
    if (!exigirSesion(req, res)) return;
    try {
      const resultado = await solicitarBot(`/api/encuestas/${req.session.usuario.id}`);
      return res.status(resultado.status).json(resultado.datos);
    } catch (error) {
      return manejarError(res, error, "ENCUESTAS LISTA");
    }
  });

  app.get("/api/encuestas/:encuestaId", async (req, res) => {
    if (!exigirSesion(req, res)) return;
    try {
      const resultado = await solicitarBot(
        `/api/encuestas/${req.session.usuario.id}/${encodeURIComponent(req.params.encuestaId)}`,
      );
      return res.status(resultado.status).json(resultado.datos);
    } catch (error) {
      return manejarError(res, error, "ENCUESTA DETALLE");
    }
  });

  app.post("/api/encuestas/:encuestaId/responder", limitarRespuestas, async (req, res) => {
    if (!exigirSesion(req, res)) return;
    try {
      const resultado = await solicitarBot(
        `/api/encuestas/${req.session.usuario.id}/${encodeURIComponent(req.params.encuestaId)}/responder`,
        { method: "POST", body: { respuestas: req.body?.respuestas }, timeout: 15_000 },
      );
      return res.status(resultado.status).json(resultado.datos);
    } catch (error) {
      return manejarError(res, error, "ENCUESTA RESPUESTA");
    }
  });

  app.get("/api/fundacion/encuestas", async (req, res) => {
    if (!(await exigirFundacion(req, res))) return;
    try {
      const resultado = await solicitarBot(`/api/fundacion/${req.session.usuario.id}/encuestas`);
      return res.status(resultado.status).json(resultado.datos);
    } catch (error) {
      return manejarError(res, error, "FUNDACION ENCUESTAS");
    }
  });

  app.post("/api/fundacion/encuestas", limitarRespuestas, async (req, res) => {
    if (!(await exigirFundacion(req, res))) return;
    try {
      const resultado = await solicitarBot(
        `/api/fundacion/${req.session.usuario.id}/encuestas`,
        {
          method: "POST",
          body: {
            titulo: req.body?.titulo,
            descripcion: req.body?.descripcion,
            fuerza: req.body?.fuerza,
            minimoAprobacion: req.body?.minimoAprobacion,
            fechaCierre: req.body?.fechaCierre,
            preguntas: req.body?.preguntas,
          },
          timeout: 15_000,
        },
      );
      return res.status(resultado.status).json(resultado.datos);
    } catch (error) {
      return manejarError(res, error, "FUNDACION CREAR ENCUESTA");
    }
  });

  app.post("/api/fundacion/encuestas/:encuestaId/publicar", limitarRespuestas, async (req, res) => {
    if (!(await exigirFundacion(req, res))) return;
    try {
      const resultado = await solicitarBot(
        `/api/fundacion/${req.session.usuario.id}/encuestas/${encodeURIComponent(req.params.encuestaId)}/publicar`,
        { method: "POST", body: { fechaCierre: req.body?.fechaCierre }, timeout: 30_000 },
      );
      return res.status(resultado.status).json(resultado.datos);
    } catch (error) {
      return manejarError(res, error, "FUNDACION PUBLICAR ENCUESTA");
    }
  });

  app.put("/api/fundacion/encuestas/:encuestaId", limitarRespuestas, async (req, res) => {
    if (!(await exigirFundacion(req, res))) return;
    try {
      const resultado = await solicitarBot(
        `/api/fundacion/${req.session.usuario.id}/encuestas/${encodeURIComponent(req.params.encuestaId)}`,
        { method: "PUT", body: { titulo: req.body?.titulo, descripcion: req.body?.descripcion, fuerza: req.body?.fuerza, minimoAprobacion: req.body?.minimoAprobacion, preguntas: req.body?.preguntas }, timeout: 15_000 },
      );
      return res.status(resultado.status).json(resultado.datos);
    } catch (error) {
      return manejarError(res, error, "FUNDACION EDITAR ENCUESTA");
    }
  });

  app.delete("/api/fundacion/encuestas/:encuestaId", limitarRespuestas, async (req, res) => {
    if (!(await exigirFundacion(req, res))) return;
    try {
      const resultado = await solicitarBot(
        `/api/fundacion/${req.session.usuario.id}/encuestas/${encodeURIComponent(req.params.encuestaId)}`,
        { method: "DELETE", body: {}, timeout: 15_000 },
      );
      return res.status(resultado.status).json(resultado.datos);
    } catch (error) {
      return manejarError(res, error, "FUNDACION ELIMINAR ENCUESTA");
    }
  });

  app.get("/api/fundacion/encuestas/:encuestaId", async (req, res) => {
    if (!(await exigirFundacion(req, res))) return;
    try {
      const resultado = await solicitarBot(
        `/api/fundacion/${req.session.usuario.id}/encuestas/${encodeURIComponent(req.params.encuestaId)}`,
      );
      return res.status(resultado.status).json(resultado.datos);
    } catch (error) {
      return manejarError(res, error, "FUNDACION DETALLE ENCUESTA");
    }
  });

  app.post("/api/fundacion/encuestas/:encuestaId/calificar", limitarRespuestas, async (req, res) => {
    if (!(await exigirFundacion(req, res))) return;
    try {
      const resultado = await solicitarBot(
        `/api/fundacion/${req.session.usuario.id}/encuestas/${encodeURIComponent(req.params.encuestaId)}/calificar`,
        {
          method: "POST",
          body: {
            usuarioId: req.body?.usuarioId,
            preguntaId: req.body?.preguntaId,
            calificacion: req.body?.calificacion,
            puntuacion: req.body?.puntuacion,
            comentario: req.body?.comentario,
          },
          timeout: 15_000,
        },
      );
      return res.status(resultado.status).json(resultado.datos);
    } catch (error) {
      return manejarError(res, error, "FUNDACION CALIFICAR ENCUESTA");
    }
  });

  app.post("/api/fundacion/encuestas/:encuestaId/cerrar", limitarRespuestas, async (req, res) => {
    if (!(await exigirFundacion(req, res))) return;
    try {
      const resultado = await solicitarBot(
        `/api/fundacion/${req.session.usuario.id}/encuestas/${encodeURIComponent(req.params.encuestaId)}/cerrar`,
        { method: "POST", body: {}, timeout: 30_000 },
      );
      return res.status(resultado.status).json(resultado.datos);
    } catch (error) {
      return manejarError(res, error, "FUNDACION CERRAR ENCUESTA");
    }
  });

  return app;
}


montarRutasEncuestas({ app, exigirSesion, exigirFundacion });

app.get("/cerrar-sesion", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("[SESION]", error);
    }

    res.clearCookie("connect.sid");
    return res.redirect(req.query.automatico === "1" ? "/se-cerro-seccion.html" : "/index.html");
  });
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Ruta API no encontrada." });
  }
  if (req.method === "GET") {
    return res.redirect("/index.html");
  }
  return res.status(404).send("Página no encontrada.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[WEB] Servidor iniciado en el puerto ${PORT}.`);
  probarConexion().catch((error) => {
    console.error("[MYSQL] Error de conexión:", error.message);
  });
});
