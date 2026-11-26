// ============================================================================
// WHATSAPP MESSAGES HANDLER (added for message processing)
// ============================================================================

let whatsappColumnasConocidas = null;

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

async function obtenerMensajesPendientes() {
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

async function actualizarEstadoMensaje(id, nuevoStatus) {
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

// ============================================================================
// WATCHER DE WHATSAPP (added for periodic checking)
// ============================================================================

function iniciarWatcherWhatsApp() {
  setInterval(async () => {
    try {
      if (!fs.existsSync(SALDO_PATH)) return;
      const stat = fs.statSync(SALDO_PATH);
      if (stat.mtimeMs === ultimaModificacionSaldos) return;
      ultimaModificacionSaldos = stat.mtimeMs;
      
      if (!whatsappColumnasConocidas) await asegurarTablasWhatsApp();
      
      const mensajes = await obtenerMensajesPendientes();
      
      for (const msg of mensajes) {
        if (msg.discord_id && msg.status === 'nuevo') {
          const usuarioRegistro = await estaUsuarioRegistrado(msg.discord_id);
          if (usuarioRegistro) {
            await actualizarEstadoMensaje(msg.id, 'enviado');
            
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

// Iniciar watcher de WhatsApp al arrancar (añadir a la función existente)
asegurarTablasSaldos().finally(() => {
  sincronizarSaldosWatcher();
  setInterval(sincronizarSaldosWatcher, INTERVALO_SALDOS_MS);
  console.log("[SALDOS] Watcher iniciado: lee data/saldo.json cada 1s y guarda en MySQL");
  
  // Iniciar también watcher de WhatsApp
  iniciarWatcherWhatsApp();
  console.log("[WHATSAPP] Watcher iniciado: revisa mensajes nuevos cada 10s");
});
// ============================================================================