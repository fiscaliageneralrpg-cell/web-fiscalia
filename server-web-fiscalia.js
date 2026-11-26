// Modificaciones al server-web-fiscalia.js para sistema WhatsApp
// Este archivo incluye endpoints para recibir y procesar mensajes entrantes

// ... (código existente del servidor) ...

// ============================================================================
// WHATSAPP WEBHOOK ENDPOINTS
// ============================================================================

// Endpoint para recibir mensajes entrantes de WhatsApp (webhook)
app.post("/api/whatsapp/webhook", async (req, res) => {
  try {
    const { whatsappNumber, messageText, discordId, nombreUsuario } = req.body || {};
    
    if (!whatsappNumber || !messageText) {
      return res.status(400).json({ error: "Datos incompletos" });
    }
    
    // Guardar mensaje en base de datos
    const campos = ["discord_id", "whatsapp_number", "message_text", "message_timestamp"];
    const valores = [
      discordId || null,
      String(whatsappNumber),
      String(messageText),
      new Date(),
    ];
    
    // Verificar columnas conocidas
    let whatsappColumnasConocidas = null;
    try {
      const [filas] = await pool.query("SHOW COLUMNS FROM whatsapp_mensajes");
      whatsappColumnasConocidas = new Set(filas.map((fila) => String(fila.Field)));
    } catch {
      whatsappColumnasConocidas = new Set(["discord_id", "whatsapp_number", "message_text", "message_timestamp", "status"]);
    }
    
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

// Endpoint para consultar mensajes pendientes (para el watcher)
app.get("/api/whatsapp/pendientes", async (req, res) => {
  try {
    const mensajes = await new Promise((resolve, reject) => {
      pool.query(
        `SELECT * FROM whatsapp_mensajes WHERE status = 'nuevo' ORDER BY message_timestamp LIMIT 50`,
        (error, results) => {
          if (error) return reject(error);
          return resolve(results);
        }
      );
    });
    
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
    
    await new Promise((resolve, reject) => {
      pool.query(
        `UPDATE whatsapp_mensajes SET status = 'visto' WHERE id = ?`,
        [id],
        (error) => {
          if (error) return reject(error);
          resolve();
        }
      );
    });
    
    res.json({ correcto: true });
  } catch (error) {
    console.error("[WHATSAPP] Error marcando visto:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// SISTEMA DE PROCESAMIENTO DE MENSAJES (inicialización)
// ============================================================================

// Variable para tracking de columnas
let whatsappColumnasConocidas = null;

// Función para asegurar tablas
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

// Función para obtener mensajes pendientes
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

// Función para actualizar estado
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

// ============================================================================
// FINAL DEL ARCHIVO (mantener el cierre del servidor)
// ============================================================================

// Iniciar watcher de WhatsApp al arrancar
asegurarTablasWhatsApp().finally(() => {
  // El watcher se iniciará en la función iniciarWatcherSaldos o se puede iniciar aquí
  console.log("[WHATSAPP] Sistema inicializado - tablas listas y endpoints registrados");
});