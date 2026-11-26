// server-web-fiscalia.js - CON SISTEMA WHATSAP COMPLETO
// Este archivo incluye:
// - Lógica de roles en /cargando
// - Endpoints WhatsApp para webhook, watcher y estado
// - Tabla whatsapp_mensajes en MySQL

const express = require("express");
const session = require("express-session");
const path = require("node:path");
const fs = require("node:fs");
require("dotenv").config();

const { pool, probarConexion, buscarUsuarioPorDiscord } = require("./db");

const CANAL_PUBLICACION_ENCUESTAS = process.env.CANAL_PUBLICACION_ENCUESTAS || "1507918744645668975";
const CANAL_LOG_TWITTER = process.env.CANAL_LOG_TWITTER || "1539432339413799042";

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

const faltantes = variablesObligatorias.filter((v) => !process.env[v]);
if (faltantes.length > 0) {
  console.error(`[CONFIGURACION] Faltan variables en Render: ${faltantes.join(", ")}`);
  process.exit(1);
}

// ============================================================================
// CONFIGURACIÓN DE ROLES PARA /CARGANDO
// ============================================================================
const ROL_WHITELIST_APROBADA = "1500316176960716940";
const ROL_WHITELIST_PENDIENTE = "1500556631157768242";
const ROL_VERIFICADO = "1561032118962880570";
const ROL_NO_VERIFICADO = "1561032118962880569";
const CANAL_WHITELIST = "1565815040077205674";
const ROL_STAFF_WHITELIST = "1561032119013351437";
const ROL_FUNDACION = "1561032119029989388";
const ROL_STAFF = "1561032119013351437";
const ROLES_POLICIA = new Set([
  "1561032118975598743",
  "1561032118975598744",
  "1561032118975598745",
  "1561032118975598746",
]);

// ============================================================================
// SISTEMA WHATSAPP - TABLA Y ENDPOINTS
// ============================================================================

// Variable para tracking de columnas conocidas
let whatsappColumnasConocidas = null;

// Función para asegurar la tabla whatsapp_mensajes
async function asegurarTablasWhatsApp() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS whatsapp_mensajes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        discord_id VARCHAR(32) NOT NULL,
        nombre_usuario VARCHAR(190) NULL,
        whatsapp_number VARCHAR(20) NOT NULL,
        message_text TEXT NOT NULL,
        message_timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status ENUM('nuevo', 'enviado', 'visto', 'respondido') DEFAULT 'nuevo',
        INDEX idx_usuario (discord_id),
        INDEX idx_numero (whatsapp_number),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    
    const [filas] = await pool.query("SHOW COLUMNS FROM whatsapp_mensajes");
    whatsappColumnasConocidas = new Set(filas.map((fila) => String(fila.Field)));
    console.log(`[WHATSAPP] Tablas listas. Columnas: ${[...whatsappColumnasConocidas].join(", ")}`);
  } catch (error) {
    console.error("[WHATSAPP] Error creando tablas:", error.message);
  }
}

// Verificar si usuario está registrado en la BD
function estaUsuarioRegistrado(discordId) {
  return new Promise((resolve) => {
    pool.query(
      `SELECT id, nombre FROM usuarios WHERE discord_id = ?`,
      [discordId],
      (error, results) => {
        if (error) return resolve(false);
        return resolve(results.length > 0 ? results[0] : false);
      }
    );
  });
}

// Guardar mensaje de WhatsApp en la base de datos
async function guardarMensajeWhatsApp(discordId, whatsappNumber, messageText, nombreUsuario = null) {
  if (!whatsappColumnasConocidas) {
    try {
      const [filas] = await pool.query("SHOW COLUMNS FROM whatsapp_mensajes");
      whatsappColumnasConocidas = new Set(filas.map((fila) => String(fila.Field)));
    } catch {
      whatsappColumnasConocidas = new Set(["discord_id", "whatsapp_number", "message_text", "message_timestamp", "status"]);
    }
  }
  
  const campos = ["discord_id", "whatsapp_number", "message_text", "message_timestamp"];
  const valores = [
    String(discordId),
    String(whatsappNumber),
    String(messageText),
    new Date(),
  ];
  
  if (whatsappColumnasConocidas.has("nombre_usuario")) {
    campos.push("nombre_usuario"); valores.push(nombreUsuario || null);
  }
  if (whatsappColumnasConocidas.has("status")) {
    campos.push("status"); valores.push("nuevo");
  }
  
  const actualizaciones = campos
    .filter((campo) => campo !== "discord_id")
    .map((campo) => `${campo} = VALUES(${campo})`)
    .join(", ");
  
  await pool.execute(
    `INSERT INTO whatsapp_mensajes (${campos.join(", ")}) VALUES (${campos.map(() => "?").join(", ")}) ON DUPLICATE KEY UPDATE ${actualizaciones}`,
    valores
  );
}

// Obtener mensajes pendientes para el watcher
function obtenerMensajesPendientes() {
  return new Promise((resolve) => {
    pool.query(
      `SELECT * FROM whatsapp_mensajes WHERE status = 'nuevo' ORDER BY message_timestamp LIMIT 50`,
      (error, results) => {
        if (error) return resolve([]);
        return resolve(results);
      }
    );
  });
}

// Actualizar estado de un mensaje
function actualizarEstadoMensaje(id, nuevoStatus) {
  return new Promise((resolve) => {
    pool.query(
      `UPDATE whatsapp_mensajes SET status = ? WHERE id = ?`,
      [nuevoStatus, id],
      (error) => {
        if (error) console.error("[WHATSAPP] Error actualizando estado:", error.message);
        resolve();
      }
    );
  });
}

// Función principal: procesar un mensaje entrante de WhatsApp
async function procesarMensajeWhatsAppEntrante(datosMensaje) {
  try {
    // 1. Guardar en base de datos
    await guardarMensajeWhatsApp(
      datosMensaje.discordId || null,
      datosMensaje.whatsappNumber,
      datosMensaje.messageText,
      datosMensaje.nombreUsuario || null
    );
    
    // 2. Buscar si el usuario de Discord está registrado
    const usuarioRegistro = await estaUsuarioRegistrado(datosMensaje.discordId || null);
    
    if (usuarioRegistro) {
      return {
        exitoso: true,
        usuarioDiscord: usuarioRegistro,
        mensaje: datosMensaje,
        accion: "notificar_discord"
      };
    } else {
      return {
        exitoso: true,
        usuarioDiscord: null,
        mensaje: datosMensaje,
        accion: "ignorar_o_solicitar_registro"
      };
    }
  } catch (error) {
    console.error("[WHATSAPP] Error procesando mensaje:", error.message);
    return { exitoso: false, error: error.message };
  }
}

// Watcher para procesar mensajes cada cierto tiempo
function iniciarWatcherWhatsApp() {
  setInterval(async () => {
    try {
      if (!fs.existsSync("data/saldo.json")) return;
      const stat = fs.statSync("data/saldo.json");
      if (stat.mtimeMs === ultimaModificacionSaldos) return;
      ultimaModificacionSaldos = stat.mtimeMs;
      
      if (!whatsappColumnasConocidas) await asegurarTablasWhatsApp();
      
      const mensajes = await obtenerMensajesPendientes();
      
      for (const msg of mensajes) {
        // Si tiene discord_id y está registrado, notificar
        if (msg.discord_id && msg.status === 'nuevo') {
          const usuarioRegistro = await estaUsuarioRegistrado(msg.discord_id);
          if (usuarioRegistro) {
            // Marcar como enviado
            await actualizarEstadoMensaje(msg.id, 'enviado');
            
            // Enviar notificación a Discord DM
            try {
              const usuario = await client.users.fetch(msg.discord_id);
              const dm = await usuario.createDM();
              
              const embed = new EmbedBuilder()
                .setColor(0x167d8d)
                .setTitle(`💬 Nuevo mensaje de WhatsApp`)
                .setDescription(`**De:** +${msg.whatsapp_number}\n\n**Mensaje:**\n${msg.message_text}\n\n⏰ <t:${Math.floor(Date.now() / 1000)}:R>`)
                .setFooter({ text: "Usá /whatsapp visto para marcar como atendido" })
                .setTimestamp();
              
              await dm.send({ embeds: [embed] });
              console.log(`[WHATSAPP] Notificación enviada a Discord ${msg.discord_id}`);
            } catch (error) {
              console.error(`[WHATSAPP] Error enviando DM:`, error.message);
            }
          }
        }
      }
    } catch (error) {
      console.error("[WHATSAPP] Error en watcher:", error.message);
    }
  }, 10000);
}

// ============================================================================
// Resto del código existente (solo los fragmentos esenciales)
// ============================================================================

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

/* ===================== SESIONES EN MYSQL ===================== */
// (código de sesión omitido por brevedad, mantener el existente)

// ... (resto del código del servidor existente) ...

// ===================== RUTA CARGANDO CON LÓGICA DE ROLES =====================

app.get("/cargando", async (req, res) => {
  if (!req.session.usuario) {
    return res.redirect("/iniciar-sesion.html");
  }

  const nombre = req.session.usuario.nombre || req.session.usuario.username;

  // Estados del usuario:
  //   1. Tiene cédula en BD                   -> dashboard
  //   2. Rol No Verificado (1561032118962880569) -> whitelist.html
  //   3. Rol Verificado (1561032118962880570) sin cédula -> crear-cedula.html
  //   4. Sin rol                              -> whitelist.html
  const tieneCedulaDB = Boolean(req.session.usuario.cedulaRegistrada);
  let tieneRolVerificado = Boolean(req.session.usuario.verificadoDiscord);

  // Sincronizacion de roles en Discord
  try {
    const roles = await obtenerRolesDelServidor(req.session.usuario.id);
    const yaTieneVerificadoDiscord = Array.isArray(roles) && roles.includes(ROL_VERIFICADO);
    tieneRolVerificado = yaTieneVerificadoDiscord || tieneRolVerificado;
    await actualizarRolVerificacion(req.session.usuario.id, tieneCedulaDB || yaTieneVerificadoDiscord);
  } catch (error) {
    console.error("[CARGANDO ROLES]", error.message);
  }

  // Destino: prioridad exacta que pediste
  let destino;
  if (tieneCedulaDB) {
    destino = "/dashboard-user.html";
  } else if (Array.isArray(roles) && roles.includes(ROL_NO_VERIFICADO)) {
    destino = "/whitelist.html";
  } else if (tieneRolVerificado) {
    destino = "/crear-cedula.html";
  } else {
    destino = "/whitelist.html";
  }

  // Mensaje segun el estado
  let estadoTexto = "nada";
  if (tieneCedulaDB) {
    estadoTexto = "completo";
  } else if (Array.isArray(roles) && roles.includes(ROL_NO_VERIFICADO)) {
    estadoTexto = "sin_rol";
  } else if (tieneRolVerificado) {
    estadoTexto = "verificado_sin_cedula";
  }

  let html = fs.readFileSync(path.join(__dirname, "public", "cargando.html"), "utf8");
  html = html.replace("{{NOMBRE_USUARIO}}", escapeHtml(nombre));
  html = html.replace("{{VERIFICADO}}", tieneCedulaDB ? "true" : "false");
  html = html.replace("{{ESTADO}}", estadoTexto);
  html = html.replace("{{DESTINO}}", destino);
  res.send(html);
});

// ===================== ENDPOINTS WHATSAPP =====================

// Endpoint para recibir mensajes entrantes de WhatsApp (webhook)
app.post("/api/whatsapp/webhook", async (req, res) => {
  try {
    const { whatsappNumber, messageText, discordId, nombreUsuario } = req.body || {};
    
    if (!whatsappNumber || !messageText) {
      return res.status(400).json({ error: "Datos incompletos" });
    }
    
    // Guardar mensaje en base de datos
    await guardarMensajeWhatsApp(
      discordId || null,
      String(whatsappNumber),
      String(messageText),
      nombreUsuario || null
    );
    
    // Notificar a Discord si el usuario está registrado
    if (discordId) {
      try {
        const usuario = await client.users.fetch(discordId);
        const dm = await usuario.createDM();
        
        const embed = new EmbedBuilder()
          .setColor(0x167d8d)
          .setTitle(`💬 Nuevo mensaje de WhatsApp`)
          .setDescription(`**De:** +${whatsappNumber}\n\n**Mensaje:**\n${messageText}`)
          .setFooter({ text: "Usá /whatsapp visto para marcar como atendido" })
          .setTimestamp();
        
        await dm.send({ embeds: [embed] });
      } catch (error) {
        console.error("[WHATSAPP] Error notificando a Discord:", error.message);
      }
    }
    
    res.json({ correcto: true, mensaje: "Guardado y notificado" });
  } catch (error) {
    console.error("[WHATSAPP] Error en webhook:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para consultar mensajes pendientes
app.get("/api/whatsapp/pendientes", async (req, res) => {
  try {
    const mensajes = await obtenerMensajesPendientes();
    res.json({ correcto: true, mensajes });
  } catch (error) {
    console.error("[WHATSAPP] Error consultando pendientes:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para marcar mensaje como visto
app.post("/api/whatsapp/marcar-visto", async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "ID requerido" });
    
    await actualizarEstadoMensaje(id, 'visto');
    res.json({ correcto: true });
  } catch (error) {
    console.error("[WHATSAPP] Error marcando visto:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Iniciar watcher de WhatsApp al arrancar
asegurarTablasWhatsApp().finally(() => {
  iniciarWatcherWhatsApp();
  console.log("[WHATSAPP] Sistema inicializado - tablas listas y endpoints registrados");
});

// Resto del servidor... (mantener el existente)