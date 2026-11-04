require("dotenv").config();
const DISCORD_TOKEN = String(process.env.TOKEN || process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || "").trim();
const DISCORD_CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;
const {
  Client,
  GatewayIntentBits,
  Collection,
  REST,
  Routes,
  Events,
  ActivityType,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { sincronizarExpedienteConWeb } = require("./database/sincronizar-expediente");
const { crearTablaVehiculos, sincronizarVehiculosConWeb } = require("./database/sincronizar-vehiculos");
const { sincronizarInventarioConWeb } = require("./database/sincronizar-inventario");
const { pool, probarConexionMySQL } = require("./database/mysql");
const { sincronizarTiendaInicial: sincronizarTiendaArchivo } = require("./database/sincronizar-tienda");
const {
  sincronizarComportamientoInicial: sincronizarComportamientoArchivo,
  sincronizarComportamientoConWeb,
  listasComportamiento,
} = require("./database/sincronizar-comportamiento");

process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled Rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("⚠️ Uncaught Exception:", error);
});
process.on("SIGTERM", () => console.error("🛑 Pterodactyl envió SIGTERM: el contenedor está deteniendo el proceso."));
process.on("SIGINT", () => console.error("🛑 El proceso recibió SIGINT."));

const encuestasFs = require("fs");
const encuestasPath = require("path");
const crypto = require("crypto");
const { EmbedBuilder: EncuestasEmbedBuilder } = require("discord.js");

const CANAL_RESULTADOS = "1507919094169473116";
const ROL_MENCION_ENCUESTAS = "1500316176960716940";
const URL_WEB_ENCUESTAS = "https://medellin-rp.duckdns.org/";
const INVITACIONES_FUERZA = Object.freeze({
  copes: "https://discord.gg/sgAezjnymr",
  policia_nacional: "https://discord.com",
  ejercito: "https://discord.com",
  fiscalia: "https://discord.com",
});
const ROL_ANTECEDENTES = "1508701842861985883";
const ROL_FUNDACION = "1508156676350673017";
const ROL_STAFF = "1510018366964891829";
const MINIMO_GLOBAL = 67;
const INTERVALO_CIERRE_MS = 60 * 1000;

const FUERZAS = Object.freeze({
  policia_nacional: Object.freeze({
    nombre: "Policía Nacional",
    rolId: "1500310263960834200",
  }),
  copes: Object.freeze({
    nombre: "COPES",
    rolId: "1500310124181323786",
  }),
  ejercito: Object.freeze({
    nombre: "Ejército",
    rolId: "1500310467254423552",
  }),
  fiscalia: Object.freeze({
    nombre: "Fiscalía",
    rolId: "1500310980675244112",
  }),
});

function crearError(mensaje, statusCode = 400) {
  return Object.assign(new Error(mensaje), { statusCode });
}

function esDiscordId(valor) {
  return /^\d{10,25}$/.test(String(valor || ""));
}

function texto(valor, maximo) {
  return String(valor ?? "").trim().slice(0, maximo);
}

function normalizarOpcion(valor) {
  return String(valor ?? "").trim().toLocaleLowerCase("es-CO");
}

function fechaValida(valor) {
  const textoFecha = typeof valor === "string" ? valor.trim() : "";
  const esFechaLocalColombia = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(textoFecha);
  // El input datetime-local no trae zona: el sufijo -05:00 fija America/Bogota.
  const fecha = new Date(esFechaLocalColombia
    ? `${textoFecha.length === 16 ? `${textoFecha}:00` : textoFecha}-05:00`
    : valor);
  return Number.isFinite(fecha.getTime()) ? fecha : null;
}

function dividirLineas(lineas, maximo = 3600) {
  const bloques = [];
  let actual = "";
  for (const lineaOriginal of lineas) {
    const linea = String(lineaOriginal).slice(0, maximo);
    if (actual && actual.length + linea.length + 1 > maximo) {
      bloques.push(actual);
      actual = "";
    }
    actual += `${actual ? "\n" : ""}${linea}`;
  }
  if (actual) bloques.push(actual);
  return bloques.length ? bloques : ["No hubo respuestas."];
}

async function publicarAnuncioEncuestaDiscord(client, encuesta, logger = console) {
  const canal = await client.channels.fetch(CANAL_RESULTADOS);
  if (!canal?.isTextBased?.()) throw new Error(`El canal ${CANAL_RESULTADOS} no es un canal de texto.`);
  const inicio = Math.floor(new Date(encuesta.publicadaEn || Date.now()).getTime() / 1000);
  const cierre = Math.floor(new Date(encuesta.fechaCierre).getTime() / 1000);
  const embed = new EncuestasEmbedBuilder()
    .setColor(0x167d8d)
    .setTitle(`🇨🇴 「ME:RP」Medellín RP︱ER:LC | Formulario de Ingreso - ${encuesta.fuerzaNombre}`)
    .setDescription(`📅 **Postulaciones abiertas:** desde <t:${inicio}:F> hasta <t:${cierre}:F> *(America/Bogota)*\n\n🔹 **Requisitos**\n• No tener @Antecedentes Penales o ser @・Miembro Criminal.\n• Mostrar respeto y compromiso con la ley.\n• Tener disponibilidad y ser activo.\n• Superar el proceso de selección.\n• No pertenecer a otro departamento de ley.\n\n📋 **Pasos para responder**\n1. Entra a la web e inicia sesión.\n2. Ve al dashboard de Civil.\n3. Pulsa **Encuestas activas**.\n4. Selecciona la encuesta de **${encuesta.fuerzaNombre}**.\n5. Responde todas las preguntas y envía el formulario.`)
    .addFields(
      { name: "🎯 Puntaje mínimo", value: `**${encuesta.minimoAprobacion}%** de aprobación`, inline: true },
    )
    .setFooter({ text: "⚠️ Importante: responde con sinceridad y responsabilidad. La calidad humana y el compromiso son lo más importante para ser parte de nuestra institución." })
    .setTimestamp(new Date(encuesta.publicadaEn || Date.now()));
  const mensaje = await canal.send({
    content: `<@&${ROL_MENCION_ENCUESTAS}>`,
    embeds: [embed],
    components: [{ type: 1, components: [
      { type: 2, style: 5, label: "🌐 Ir a la web", url: URL_WEB_ENCUESTAS },
    ] }],
    allowedMentions: { roles: [ROL_MENCION_ENCUESTAS] },
  });
  logger.log(`[ENCUESTAS] Anuncio publicado en ${CANAL_RESULTADOS}: ${mensaje.id}`);
  return mensaje.id;
}

function crearSistemaEncuestas({
  client,
  dataPath = encuestasPath.join(__dirname, "data", "encuestas.json"),
  canalResultadosId = CANAL_RESULTADOS,
  intervaloMs = INTERVALO_CIERRE_MS,
  logger = console,
} = {}) {
  if (!client) throw new TypeError("crearSistemaEncuestas requiere el cliente de Discord.");

  let colaEscritura = Promise.resolve();
  let temporizador = null;
  let procesandoCierres = false;

  function datosIniciales() {
    return { version: 1, encuestas: [] };
  }

  function asegurarArchivo() {
    encuestasFs.mkdirSync(encuestasPath.dirname(dataPath), { recursive: true });
    if (!encuestasFs.existsSync(dataPath) || !encuestasFs.readFileSync(dataPath, "utf8").trim()) {
      escribirDatos(datosIniciales());
      return;
    }
    const datos = JSON.parse(encuestasFs.readFileSync(dataPath, "utf8"));
    if (!Array.isArray(datos.encuestas)) return;
    const unicas = new Map();
    for (const encuesta of datos.encuestas) {
      const anterior = unicas.get(encuesta.fuerza);
      const fechaActual = new Date(encuesta.actualizadaEn || encuesta.creadaEn || 0).getTime();
      const fechaAnterior = anterior ? new Date(anterior.actualizadaEn || anterior.creadaEn || 0).getTime() : -1;
      if (!anterior || fechaActual >= fechaAnterior) unicas.set(encuesta.fuerza, encuesta);
    }
    if (unicas.size !== datos.encuestas.length) escribirDatos({ ...datos, encuestas: [...unicas.values()] });
  }

  function leerDatos() {
    asegurarArchivo();
    let datos;
    try {
      datos = JSON.parse(encuestasFs.readFileSync(dataPath, "utf8"));
    } catch (error) {
      throw crearError(`No se pudo leer data/encuestas.json: ${error.message}`, 500);
    }
    if (!datos || typeof datos !== "object" || !Array.isArray(datos.encuestas)) {
      throw crearError("data/encuestas.json no tiene el formato esperado.", 500);
    }
    return datos;
  }

  function escribirDatos(datos) {
    encuestasFs.mkdirSync(encuestasPath.dirname(dataPath), { recursive: true });
    const temporal = `${dataPath}.${process.pid}.${Date.now()}.tmp`;
    encuestasFs.writeFileSync(temporal, `${JSON.stringify(datos, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    encuestasFs.renameSync(temporal, dataPath);
  }

  function enCola(trabajo) {
    const siguiente = colaEscritura.then(trabajo, trabajo);
    colaEscritura = siguiente.catch(() => {});
    return siguiente;
  }

  async function obtenerMiembro(discordId) {
    if (!esDiscordId(discordId)) throw crearError("Discord ID inválido.", 400);
    const guildId = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;
    if (!guildId) throw crearError("Falta GUILD_ID o DISCORD_GUILD_ID en el bot.", 503);
    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId));
    try {
      return await guild.members.fetch(String(discordId));
    } catch (error) {
      if (error?.code === 10007 || error?.status === 404) {
        throw crearError("El usuario no pertenece al servidor de Discord.", 403);
      }
      throw error;
    }
  }

  function validarElegibilidad(miembro, encuesta) {
    if (miembro.roles.cache.has(ROL_ANTECEDENTES)) {
      throw crearError("⛔ Tienes antecedentes penales y no puedes realizar formularios de Fuerza Pública.", 403);
    }
    const fuerzaActual = Object.entries(FUERZAS).find(([, fuerza]) => miembro.roles.cache.has(fuerza.rolId));
    if (fuerzaActual) {
      const [clave, fuerza] = fuerzaActual;
      if (clave === encuesta?.fuerza) {
        throw crearError(`⛔ Ya tienes el rol de ${fuerza.nombre}. Solo puedes pertenecer a una fuerza y no puedes volver a realizar este formulario.`, 409);
      }
      throw crearError(`⛔ Ya perteneces a ${fuerza.nombre}. Solo puedes elegir una fuerza; no puedes postularte a ${encuesta?.fuerzaNombre || "otra fuerza"}.`, 409);
    }
    return true;
  }

  async function exigirFundacion(discordId) {
    const miembro = await obtenerMiembro(discordId);
    if (!miembro.roles.cache.has(ROL_FUNDACION) && !miembro.roles.cache.has(ROL_STAFF)) {
      throw crearError("No tienes el rol Fundación autorizado.", 403);
    }
    return miembro;
  }

  function validarPreguntas(preguntasEntrada) {
    if (!Array.isArray(preguntasEntrada) || preguntasEntrada.length < 1 || preguntasEntrada.length > 50) {
      throw crearError("La encuesta debe tener entre 1 y 50 preguntas.");
    }

    return preguntasEntrada.map((entrada, indice) => {
      const tipo = texto(entrada?.tipo, 20).toLowerCase();
      const enunciado = texto(entrada?.texto, 500);
      if (!enunciado) throw crearError(`La pregunta ${indice + 1} no tiene enunciado.`);
      if (!['abierta', 'cerrada'].includes(tipo)) {
        throw crearError(`La pregunta ${indice + 1} debe ser abierta o cerrada.`);
      }

      const pregunta = {
        id: crypto.randomUUID(),
        orden: indice + 1,
        tipo,
        texto: enunciado,
      };

      if (tipo === "cerrada") {
        const opciones = Array.isArray(entrada.opciones)
          ? entrada.opciones.map((opcion) => texto(opcion, 200)).filter(Boolean)
          : [];
        if (opciones.length < 2 || opciones.length > 10) {
          throw crearError(`La pregunta ${indice + 1} debe tener entre 2 y 10 opciones.`);
        }
        if (new Set(opciones.map(normalizarOpcion)).size !== opciones.length) {
          throw crearError(`La pregunta ${indice + 1} contiene opciones repetidas.`);
        }
        const correcta = Number(entrada.correcta);
        if (!Number.isInteger(correcta) || correcta < 0 || correcta >= opciones.length) {
          throw crearError(`Selecciona una respuesta correcta válida en la pregunta ${indice + 1}.`);
        }
        pregunta.opciones = opciones;
        pregunta.correcta = correcta;
      }
      return pregunta;
    });
  }

  function validarNuevaEncuesta(cuerpo) {
    const titulo = texto(cuerpo?.titulo, 120);
    const descripcion = texto(cuerpo?.descripcion, 1500);
    const fuerza = texto(cuerpo?.fuerza, 40).toLowerCase();
    const cierre = cuerpo?.fechaCierre ? fechaValida(cuerpo.fechaCierre) : null;
    const minimoAprobacion = cuerpo?.minimoAprobacion === undefined
      ? MINIMO_GLOBAL
      : Number(cuerpo.minimoAprobacion);

    if (titulo.length < 4) throw crearError("El título debe tener al menos 4 caracteres.");
    if (!FUERZAS[fuerza]) throw crearError("La fuerza seleccionada no es válida.");
    if (cierre && cierre.getTime() <= Date.now() + 60 * 1000) {
      throw crearError("La fecha de cierre debe ser al menos un minuto después de la hora actual de Colombia (America/Bogota).");
    }
    if (cierre && cierre.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) {
      throw crearError("La fecha de cierre no puede superar un año.");
    }
    if (!Number.isInteger(minimoAprobacion) || minimoAprobacion < MINIMO_GLOBAL || minimoAprobacion > 100) {
      throw crearError(`El porcentaje mínimo debe ser un entero entre ${MINIMO_GLOBAL} y 100.`);
    }

    return {
      id: crypto.randomUUID(),
      titulo,
      descripcion,
      fuerza,
      fuerzaNombre: FUERZAS[fuerza].nombre,
      rolId: FUERZAS[fuerza].rolId,
      minimoAprobacion,
      estado: cierre ? "activa" : "borrador",
      creadaEn: new Date().toISOString(),
      fechaCierre: cierre ? cierre.toISOString() : null,
      preguntas: validarPreguntas(cuerpo.preguntas),
      respuestas: [],
      publicacion: { estado: "pendiente", mensajes: [] },
    };
  }

  function encuestaPublica(encuesta, discordId, incluirDetalle = false) {
    const respuesta = encuesta.respuestas.find((item) => item.usuarioId === String(discordId));
    const base = {
      id: encuesta.id,
      titulo: encuesta.titulo,
      descripcion: encuesta.descripcion,
      fuerza: encuesta.fuerza,
      fuerzaNombre: encuesta.fuerzaNombre,
      minimoAprobacion: encuesta.minimoAprobacion,
      estado: encuesta.estado,
      fechaCierre: encuesta.fechaCierre,
      respondida: Boolean(respuesta),
      respondidaEn: respuesta?.respondidaEn || null,
    };
    if (incluirDetalle) {
      base.preguntas = encuesta.preguntas.map((pregunta) => ({
        id: pregunta.id,
        orden: pregunta.orden,
        tipo: pregunta.tipo,
        texto: pregunta.texto,
        opciones: pregunta.tipo === "cerrada" ? pregunta.opciones : undefined,
      }));
      if (respuesta) {
        base.misRespuestas = respuesta.respuestas.map((item) => ({
          preguntaId: item.preguntaId,
          valor: item.valor,
        }));
        if (encuesta.estado === "cerrada") base.resultado = respuesta.resultado || null;
      }
    }
    return base;
  }

  function validarRespuestas(encuesta, cuerpo) {
    const entradas = cuerpo?.respuestas;
    if (!Array.isArray(entradas) || entradas.length !== encuesta.preguntas.length) {
      throw crearError("Debes responder todas las preguntas de la encuesta.");
    }
    const mapa = new Map();
    for (const entrada of entradas) {
      const preguntaId = texto(entrada?.preguntaId, 80);
      if (!preguntaId || mapa.has(preguntaId)) throw crearError("Las respuestas contienen preguntas repetidas o inválidas.");
      mapa.set(preguntaId, entrada?.valor);
    }

    return encuesta.preguntas.map((pregunta) => {
      if (!mapa.has(pregunta.id)) throw crearError("Debes responder todas las preguntas.");
      if (pregunta.tipo === "abierta") {
        const valor = texto(mapa.get(pregunta.id), 2000);
        if (!valor) throw crearError(`La pregunta ${pregunta.orden} requiere una respuesta.`);
        return { preguntaId: pregunta.id, valor, calificacion: null, comentario: "" };
      }

      const indice = Number(mapa.get(pregunta.id));
      if (!Number.isInteger(indice) || indice < 0 || indice >= pregunta.opciones.length) {
        throw crearError(`La respuesta de la pregunta ${pregunta.orden} no es válida.`);
      }
      return {
        preguntaId: pregunta.id,
        valor: indice,
        correcta: indice === pregunta.correcta,
        calificacion: indice === pregunta.correcta ? 1 : 0,
      };
    });
  }

  function recalcularResultado(encuesta, respuesta) {
    const calificaciones = respuesta.respuestas.map((item) =>
      typeof item.calificacion === "number" ? item.calificacion : null,
    );
    const completo = calificaciones.every((valor) => valor !== null);
    const puntos = calificaciones.reduce((total, valor) => total + Number(valor || 0), 0);
    const porcentaje = Math.round((puntos / encuesta.preguntas.length) * 10000) / 100;
    respuesta.resultado = {
      completo,
      puntos: Math.round(puntos * 100) / 100,
      total: encuesta.preguntas.length,
      porcentaje,
      aprobado: completo ? porcentaje >= encuesta.minimoAprobacion : null,
      calculadoEn: new Date().toISOString(),
      rolAsignadoEn: respuesta.resultado?.rolAsignadoEn || null,
      rolError: respuesta.resultado?.rolError || null,
    };
    return respuesta.resultado;
  }

  async function crearEncuesta(adminId, cuerpo) {
    await exigirFundacion(adminId);
    const nueva = validarNuevaEncuesta(cuerpo);
    await enCola(() => {
      const datos = leerDatos();
      const existente = datos.encuestas.find((item) => item.fuerza === nueva.fuerza);
      if (existente) {
        throw crearError(`Ya existe una encuesta registrada para ${nueva.fuerzaNombre}. Ve a Configurar encuesta para editarla.`, 409);
      }
      datos.encuestas.push({ ...nueva, creadaPor: String(adminId) });
      escribirDatos(datos);
    });
    return nueva;
  }

  async function actualizarEncuesta(adminId, encuestaId, cuerpo) {
    await exigirFundacion(adminId);
    const cambios = validarNuevaEncuesta({ ...cuerpo, fechaCierre: undefined });
    let resultado;
    await enCola(() => {
      const datos = leerDatos();
      const encuesta = datos.encuestas.find((item) => item.id === encuestaId);
      if (!encuesta) throw crearError("Encuesta no encontrada.", 404);
      if (!["borrador", "cerrada"].includes(encuesta.estado)) throw crearError("La encuesta activa no se puede editar. Podrás editarla cuando cierre.", 409);
      const otra = datos.encuestas.find((item) => item.id !== encuestaId && item.fuerza === cambios.fuerza);
      if (otra) throw crearError(`Ya existe otra encuesta registrada para ${cambios.fuerzaNombre}.`, 409);
      encuesta.titulo = cambios.titulo;
      encuesta.descripcion = cambios.descripcion;
      encuesta.fuerza = cambios.fuerza;
      encuesta.fuerzaNombre = cambios.fuerzaNombre;
      encuesta.rolId = cambios.rolId;
      encuesta.minimoAprobacion = cambios.minimoAprobacion;
      encuesta.preguntas = cambios.preguntas;
      encuesta.actualizadaEn = new Date().toISOString();
      escribirDatos(datos);
      resultado = structuredClone(encuesta);
    });
    return resultado;
  }

  async function publicarEncuesta(adminId, encuestaId, cuerpo) {
    await exigirFundacion(adminId);
    const cierre = fechaValida(cuerpo?.fechaCierre);
    // datetime-local solo permite escoger minutos. A las 11:49:39, 11:50 es el siguiente minuto válido.
    const siguienteMinuto = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
    if (!cierre || cierre.getTime() < siguienteMinuto) throw crearError("Elige como mínimo el siguiente minuto de Colombia. Por ejemplo, si son las 11:49, selecciona 11:50.");
    if (cierre.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) throw crearError("La fecha de cierre no puede superar un año.");
    let instantanea;
    await enCola(() => {
      const datos = leerDatos();
      const encuesta = datos.encuestas.find((item) => item.id === encuestaId);
      if (!encuesta) throw crearError("Encuesta no encontrada.", 404);
      if (!["borrador", "cerrada"].includes(encuesta.estado)) throw crearError("La encuesta ya está activa. Espera a que cierre para volver a publicarla.", 409);
      encuesta.estado = "activa";
      encuesta.fechaCierre = cierre.toISOString();
      encuesta.publicadaEn = new Date().toISOString();
      encuesta.publicadaPor = String(adminId);
      encuesta.respuestas = [];
      encuesta.cerradaEn = null;
      encuesta.motivoCierre = null;
      encuesta.publicacion = { estado: "pendiente", mensajes: [] };
      escribirDatos(datos);
      instantanea = structuredClone(encuesta);
    });
    try {
      const mensajeId = await publicarAnuncioEncuestaDiscord(client, instantanea, logger);
      await enCola(() => {
        const datos = leerDatos();
        const encuesta = datos.encuestas.find((item) => item.id === encuestaId);
        if (encuesta) {
          encuesta.anuncioPublicacion = { canalId: CANAL_RESULTADOS, mensajeId, publicadoEn: new Date().toISOString() };
          escribirDatos(datos);
        }
      });
    } catch (error) {
      logger.error(`[ENCUESTAS] No se pudo publicar el anuncio en ${CANAL_RESULTADOS}:`, error.message);
      throw crearError(`La encuesta se guardó, pero no se pudo publicar el anuncio en el canal configurado (${CANAL_RESULTADOS}). Revisa los permisos del bot.`, 502);
    }
    return instantanea;
  }

  async function eliminarEncuesta(adminId, encuestaId) {
    await exigirFundacion(adminId);
    await enCola(() => {
      const datos = leerDatos();
      const indice = datos.encuestas.findIndex((item) => item.id === encuestaId);
      if (indice < 0) throw crearError("Encuesta no encontrada.", 404);
      if (!["borrador", "cerrada"].includes(datos.encuestas[indice].estado)) throw crearError("La encuesta activa no se puede eliminar.", 409);
      datos.encuestas.splice(indice, 1);
      escribirDatos(datos);
    });
    return true;
  }

  async function responderEncuesta(usuarioId, encuestaId, cuerpo) {
    const miembro = await obtenerMiembro(usuarioId);
    return enCola(() => {
      const datos = leerDatos();
      const encuesta = datos.encuestas.find((item) => item.id === encuestaId);
      if (!encuesta) throw crearError("Encuesta no encontrada.", 404);
      validarElegibilidad(miembro, encuesta);
      if (encuesta.estado !== "activa" || new Date(encuesta.fechaCierre).getTime() <= Date.now()) {
        throw crearError("La encuesta ya está cerrada.", 410);
      }
      if (encuesta.respuestas.some((item) => item.usuarioId === String(usuarioId))) {
        throw crearError("Ya respondiste esta encuesta; no se permiten respuestas duplicadas.", 409);
      }
      const registro = {
        usuarioId: String(usuarioId),
        respondidaEn: new Date().toISOString(),
        respuestas: validarRespuestas(encuesta, cuerpo),
        resultado: null,
      };
      recalcularResultado(encuesta, registro);
      encuesta.respuestas.push(registro);
      escribirDatos(datos);
      return { respondidaEn: registro.respondidaEn };
    });
  }

  async function asignarRolSiCorresponde(encuesta, respuesta) {
    if (!respuesta.resultado?.completo || respuesta.resultado.aprobado !== true) return false;
    if (respuesta.resultado.rolAsignadoEn) return true;
    try {
      const miembro = await obtenerMiembro(respuesta.usuarioId);
      if (!miembro.roles.cache.has(encuesta.rolId)) {
        await miembro.roles.add(encuesta.rolId, `Aprobó encuesta ${encuesta.titulo} con ${respuesta.resultado.porcentaje}%`);
      }
      await enCola(() => {
        const datos = leerDatos();
        const actual = datos.encuestas.find((item) => item.id === encuesta.id)
          ?.respuestas.find((item) => item.usuarioId === respuesta.usuarioId);
        if (actual?.resultado) {
          actual.resultado.rolAsignadoEn = new Date().toISOString();
          actual.resultado.rolError = null;
          escribirDatos(datos);
        }
      });
      return true;
    } catch (error) {
      logger.error(`[ENCUESTAS] No se pudo asignar ${encuesta.rolId} a ${respuesta.usuarioId}:`, error.message);
      await enCola(() => {
        const datos = leerDatos();
        const actual = datos.encuestas.find((item) => item.id === encuesta.id)
          ?.respuestas.find((item) => item.usuarioId === respuesta.usuarioId);
        if (actual?.resultado) {
          actual.resultado.rolError = texto(error.message, 300);
          escribirDatos(datos);
        }
      });
      return false;
    }
  }

  async function publicarResultados(encuesta) {
    const canal = await client.channels.fetch(canalResultadosId);
    if (!canal?.isTextBased?.()) throw new Error("El canal de resultados no es de texto o no está disponible.");
    const usuarios = await Promise.all(encuesta.respuestas.map(async (respuesta) => {
      let nombre = `Usuario ${respuesta.usuarioId}`;
      try {
        const usuario = await client.users.fetch(respuesta.usuarioId);
        nombre = usuario.globalName || usuario.displayName || usuario.username || nombre;
      } catch (error) {
        logger.warn?.(`[ENCUESTAS] No se pudo obtener nombre para resultados: ${respuesta.usuarioId}`, error.message);
      }
      return { respuesta, nombre };
    }));
    const aprobados = usuarios.filter(({ respuesta }) => respuesta.resultado?.completo && respuesta.resultado.aprobado);
    const noAprobados = usuarios.filter(({ respuesta }) => respuesta.resultado?.completo && !respuesta.resultado.aprobado);
    const pendientes = usuarios.filter(({ respuesta }) => !respuesta.resultado?.completo);
    const fila = ({ respuesta, nombre }) => `• **${nombre}** | ${respuesta.resultado.porcentaje}%`;
    const aprobadosTexto = aprobados.length ? aprobados.map(fila).join("\n") : "Ninguno";
    const noAprobadosTexto = noAprobados.length ? noAprobados.map(fila).join("\n") : "Ninguno";
    const pendientesTexto = pendientes.length ? pendientes.map(({ nombre }) => `• **${nombre}** | Pendiente`) .join("\n") : "Ninguno";
    const mensajes = [];
    const embed = new EncuestasEmbedBuilder()
      .setColor(0x42d8d0)
      .setTitle(`「ME:RP」Medellín RP︱ER:LC | Resultados de Formulario de Ingreso - ${encuesta.fuerzaNombre}`)
      .setDescription(`⏰ **Cierre:** <t:${Math.floor(new Date(encuesta.cerradaEn || Date.now()).getTime() / 1000)}:F>\n\n✅ **Aprobados (${aprobados.length})**\n${aprobadosTexto}\n\n❌ **No aprobados (${noAprobados.length})**\n${noAprobadosTexto}${pendientes.length ? `\n\n⏳ **Pendientes (${pendientes.length})**\n${pendientesTexto}` : ""}`)
      .addFields({ name: "🔗 Servidor de Discord", value: INVITACIONES_FUERZA[encuesta.fuerza] ? `[Entrar al servidor de ${encuesta.fuerzaNombre}](${INVITACIONES_FUERZA[encuesta.fuerza]})` : "Enlace del servidor pendiente de configurar.", inline: false })
      .setFooter({ text: `Importante: si no alcanzaste el puntaje mínimo (${encuesta.minimoAprobacion}%), podrás volver a postularte en el siguiente ciclo.` })
      .setTimestamp(new Date(encuesta.cerradaEn || Date.now()));
    const mensaje = await canal.send({
      content: `<@&${ROL_MENCION_ENCUESTAS}>`,
      embeds: [embed],
      allowedMentions: { roles: [ROL_MENCION_ENCUESTAS] },
    });
    mensajes.push(mensaje.id);
    return mensajes;
  }

  async function publicarResultadoActualizado(encuesta, respuesta) {
    if (!respuesta.resultado?.completo) return;
    const canal = await client.channels.fetch(canalResultadosId);
    if (!canal?.isTextBased?.()) return;
    await canal.send({
      embeds: [
        new EncuestasEmbedBuilder()
          .setColor(respuesta.resultado.aprobado ? 0x79e2aa : 0xef7777)
          .setTitle(`「ME:RP」Medellín RP︱ER:LC | Calificación final · ${encuesta.titulo}`)
          .setDescription(
            `<@${respuesta.usuarioId}> obtuvo **${respuesta.resultado.porcentaje}%** y ${respuesta.resultado.aprobado ? "**APROBÓ**" : "**NO APROBÓ**"}.`,
          )
          .setFooter({ text: `${encuesta.fuerzaNombre} · mínimo ${encuesta.minimoAprobacion}%` })
          .setTimestamp(),
      ],
      allowedMentions: { parse: [] },
    });
  }

  async function cerrarEncuesta(encuestaId, motivo = "fecha") {
    let instantanea;
    let debePublicar = false;
    await enCola(() => {
      const datos = leerDatos();
      const encuesta = datos.encuestas.find((item) => item.id === encuestaId);
      if (!encuesta) throw crearError("Encuesta no encontrada.", 404);
      if (encuesta.estado === "activa") {
        encuesta.estado = "cerrada";
        encuesta.cerradaEn = new Date().toISOString();
        encuesta.motivoCierre = motivo;
      }
      for (const respuesta of encuesta.respuestas) recalcularResultado(encuesta, respuesta);
      const intentoPublicacion = fechaValida(encuesta.publicacion?.intentoEn)?.getTime() || 0;
      const reservaObsoleta =
        encuesta.publicacion?.estado === "publicando" && Date.now() - intentoPublicacion > 2 * 60 * 1000;
      if (
        encuesta.publicacion?.estado !== "publicada" &&
        (encuesta.publicacion?.estado !== "publicando" || reservaObsoleta)
      ) {
        encuesta.publicacion = {
          ...(encuesta.publicacion || {}),
          estado: "publicando",
          intentoEn: new Date().toISOString(),
        };
        debePublicar = true;
      }
      escribirDatos(datos);
      instantanea = structuredClone(encuesta);
    });

    for (const respuesta of instantanea.respuestas) {
      await asignarRolSiCorresponde(instantanea, respuesta);
    }

    if (debePublicar) {
      try {
        const mensajes = await publicarResultados(instantanea);
        await enCola(() => {
          const datos = leerDatos();
          const encuesta = datos.encuestas.find((item) => item.id === encuestaId);
          encuesta.publicacion = {
            estado: "publicada",
            publicadaEn: new Date().toISOString(),
            mensajes,
          };
          escribirDatos(datos);
        });
      } catch (error) {
        logger.error(`[ENCUESTAS] No se publicaron resultados de ${encuestaId}:`, error.message);
        await enCola(() => {
          const datos = leerDatos();
          const encuesta = datos.encuestas.find((item) => item.id === encuestaId);
          encuesta.publicacion = {
            ...(encuesta.publicacion || {}),
            estado: "pendiente",
            ultimoError: texto(error.message, 300),
          };
          escribirDatos(datos);
        });
      }
    }

    return leerDatos().encuestas.find((item) => item.id === encuestaId);
  }

  async function procesarCierres() {
    if (procesandoCierres || !client.isReady?.()) return;
    procesandoCierres = true;
    try {
      const ahora = Date.now();
      const pendientes = leerDatos().encuestas.filter((encuesta) =>
        (encuesta.estado === "activa" && new Date(encuesta.fechaCierre).getTime() <= ahora) ||
        (encuesta.estado === "cerrada" && encuesta.publicacion?.estado !== "publicada"),
      );
      for (const encuesta of pendientes) {
        try {
          await cerrarEncuesta(encuesta.id, "fecha");
        } catch (error) {
          logger.error(`[ENCUESTAS] Error al cerrar ${encuesta.id}:`, error);
        }
      }
    } finally {
      procesandoCierres = false;
    }
  }

  function iniciar() {
    asegurarArchivo();
    if (temporizador) return;
    procesarCierres().catch((error) => logger.error("[ENCUESTAS] Cierre inicial:", error));
    temporizador = setInterval(() => {
      procesarCierres().catch((error) => logger.error("[ENCUESTAS] Cierre automático:", error));
    }, Math.max(15_000, Number(intervaloMs) || INTERVALO_CIERRE_MS));
    temporizador.unref?.();
    logger.log(`[ENCUESTAS] Sistema activo. Datos: ${dataPath}`);
  }

  function detener() {
    if (temporizador) clearInterval(temporizador);
    temporizador = null;
  }

  async function listarParaUsuario(usuarioId) {
    const miembro = await obtenerMiembro(usuarioId);
    if (miembro.roles.cache.has(ROL_ANTECEDENTES)) {
      throw crearError("⛔ Tienes antecedentes penales y no puedes realizar formularios de Fuerza Pública.", 403);
    }
    const fuerzaActual = Object.entries(FUERZAS).find(([, fuerza]) => miembro.roles.cache.has(fuerza.rolId));
    if (fuerzaActual) {
      throw crearError(`⛔ Ya perteneces a ${fuerzaActual[1].nombre}. Solo puedes elegir una fuerza y no puedes realizar otra postulación.`, 409);
    }
    const ahora = Date.now();
    return leerDatos().encuestas
      .filter((encuesta) => encuesta.estado === "activa" && new Date(encuesta.fechaCierre).getTime() > ahora)
      .map((encuesta) => encuestaPublica(encuesta, usuarioId));
  }

  async function detalleParaUsuario(usuarioId, encuestaId) {
    const miembro = await obtenerMiembro(usuarioId);
    const encuesta = leerDatos().encuestas.find((item) => item.id === encuestaId);
    if (!encuesta) throw crearError("Encuesta no encontrada.", 404);
    validarElegibilidad(miembro, encuesta);
    if (encuesta.estado !== "activa" && !encuesta.respuestas.some((item) => item.usuarioId === String(usuarioId))) {
      throw crearError("La encuesta ya no está disponible.", 410);
    }
    return encuestaPublica(encuesta, usuarioId, true);
  }

  async function listarAdministracion(adminId) {
    await exigirFundacion(adminId);
    return leerDatos().encuestas
      .map((encuesta) => ({
        id: encuesta.id,
        titulo: encuesta.titulo,
        fuerza: encuesta.fuerza,
        fuerzaNombre: encuesta.fuerzaNombre,
        estado: encuesta.estado,
        creadaEn: encuesta.creadaEn,
        fechaCierre: encuesta.fechaCierre,
        cerradaEn: encuesta.cerradaEn || null,
        minimoAprobacion: encuesta.minimoAprobacion,
        preguntas: encuesta.preguntas.length,
        respuestas: encuesta.respuestas.length,
        pendientes: encuesta.respuestas.filter((respuesta) => !respuesta.resultado?.completo).length,
        publicacion: encuesta.publicacion,
      }))
      .sort((a, b) => new Date(b.creadaEn) - new Date(a.creadaEn));
  }

  async function detalleAdministracion(adminId, encuestaId) {
    await exigirFundacion(adminId);
    const encuesta = leerDatos().encuestas.find((item) => item.id === encuestaId);
    if (!encuesta) throw crearError("Encuesta no encontrada.", 404);
    const respuestas = await Promise.all(encuesta.respuestas.map(async (respuesta) => {
      let usuarioNombre = "Usuario no identificado";
      try {
        const usuario = await client.users.fetch(respuesta.usuarioId);
        usuarioNombre = usuario.globalName || usuario.displayName || usuario.username || usuarioNombre;
      } catch (error) {
        logger.warn?.(`[ENCUESTAS] No se pudo obtener el nombre de ${respuesta.usuarioId}:`, error.message);
      }
      return { ...respuesta, usuarioNombre };
    }));
    return { ...encuesta, respuestas };
  }

  async function calificarAbierta(adminId, encuestaId, cuerpo) {
    await exigirFundacion(adminId);
    const usuarioId = texto(cuerpo?.usuarioId, 25);
    const preguntaId = texto(cuerpo?.preguntaId, 80);
    const tipoCalificacion = texto(cuerpo?.calificacion, 10).toLowerCase();
    const puntuacion = tipoCalificacion === "buena" ? 1 : tipoCalificacion === "mala" ? 0 : Number(cuerpo?.puntuacion);
    const comentario = texto(cuerpo?.comentario, 500);
    if (!esDiscordId(usuarioId) || !preguntaId) throw crearError("Usuario o pregunta inválidos.");
    if (!Number.isFinite(puntuacion) || puntuacion < 0 || puntuacion > 1) {
      throw crearError("La calificación debe ser Buena o Mala.");
    }

    let instantanea;
    let respuestaActual;
    let estabaCompleta = false;
    await enCola(() => {
      const datos = leerDatos();
      const encuesta = datos.encuestas.find((item) => item.id === encuestaId);
      if (!encuesta) throw crearError("Encuesta no encontrada.", 404);
      if (encuesta.estado !== "activa" || (encuesta.fechaCierre && new Date(encuesta.fechaCierre).getTime() <= Date.now())) {
        throw crearError("Esta encuesta ya cerró y no se puede calificar.", 409);
      }
      const pregunta = encuesta.preguntas.find((item) => item.id === preguntaId);
      if (!pregunta || pregunta.tipo !== "abierta") throw crearError("La pregunta abierta no existe.", 404);
      const respuesta = encuesta.respuestas.find((item) => item.usuarioId === usuarioId);
      if (!respuesta) throw crearError("El usuario no respondió esta encuesta.", 404);
      const item = respuesta.respuestas.find((valor) => valor.preguntaId === preguntaId);
      if (!item) throw crearError("La respuesta abierta no existe.", 404);
      estabaCompleta = Boolean(respuesta.resultado?.completo);
      item.calificacion = Math.round(puntuacion * 100) / 100;
      item.comentario = comentario;
      item.calificadaPor = String(adminId);
      item.calificadaEn = new Date().toISOString();
      recalcularResultado(encuesta, respuesta);
      escribirDatos(datos);
      instantanea = structuredClone(encuesta);
      respuestaActual = structuredClone(respuesta);
    });

    if (instantanea.estado === "cerrada" && respuestaActual.resultado?.completo) {
      await asignarRolSiCorresponde(instantanea, respuestaActual);
      if (!estabaCompleta) {
        await publicarResultadoActualizado(instantanea, respuestaActual).catch((error) =>
          logger.error("[ENCUESTAS] No se publicó la calificación final:", error.message),
        );
      }
    }
    return respuestaActual;
  }

  async function manejarSolicitudHttp(req, res, { responderJson, leerCuerpo, autorizado } = {}) {
    const ruta = new URL(req.url, "http://localhost").pathname;
    if (!ruta.startsWith("/api/encuestas/") && !/^\/api\/fundacion\/\d+\/encuestas(?:\/|$)/.test(ruta)) {
      return false;
    }
    if (
      typeof responderJson !== "function" ||
      typeof leerCuerpo !== "function" ||
      typeof autorizado !== "function"
    ) {
      throw new TypeError("El manejador requiere responderJson, leerCuerpo y autorizado de index.js.");
    }
    if (!autorizado(req)) {
      responderJson(res, 401, { error: "API no autorizada." });
      return true;
    }

    const partes = ruta.split("/").filter(Boolean);
    try {
      if (partes[1] === "encuestas") {
        const usuarioId = partes[2];
        if (!esDiscordId(usuarioId)) throw crearError("Discord ID inválido.");
        if (req.method === "GET" && partes.length === 3) {
          return responderJson(res, 200, { correcto: true, encuestas: await listarParaUsuario(usuarioId) }), true;
        }
        if (req.method === "GET" && partes.length === 4) {
          return responderJson(res, 200, { correcto: true, encuesta: await detalleParaUsuario(usuarioId, partes[3]) }), true;
        }
        if (req.method === "POST" && partes.length === 5 && partes[4] === "responder") {
          const resultado = await responderEncuesta(usuarioId, partes[3], await leerCuerpo(req));
          return responderJson(res, 201, { correcto: true, ...resultado }), true;
        }
      }

      if (partes[1] === "fundacion" && partes[3] === "encuestas") {
        const adminId = partes[2];
        if (!esDiscordId(adminId)) throw crearError("Discord ID inválido.");
        if (req.method === "GET" && partes.length === 4) {
          return responderJson(res, 200, { correcto: true, encuestas: await listarAdministracion(adminId) }), true;
        }
        if (req.method === "POST" && partes.length === 4) {
          const encuesta = await crearEncuesta(adminId, await leerCuerpo(req));
          return responderJson(res, 201, { correcto: true, encuesta }), true;
        }
        if (req.method === "PUT" && partes.length === 5) {
          const encuesta = await actualizarEncuesta(adminId, partes[4], await leerCuerpo(req));
          return responderJson(res, 200, { correcto: true, encuesta }), true;
        }
        if (req.method === "POST" && partes.length === 6 && partes[5] === "publicar") {
          const encuesta = await publicarEncuesta(adminId, partes[4], await leerCuerpo(req));
          return responderJson(res, 200, { correcto: true, encuesta }), true;
        }
        if (req.method === "DELETE" && partes.length === 5) {
          await eliminarEncuesta(adminId, partes[4]);
          return responderJson(res, 200, { correcto: true }), true;
        }
        if (req.method === "GET" && partes.length === 5) {
          return responderJson(res, 200, { correcto: true, encuesta: await detalleAdministracion(adminId, partes[4]) }), true;
        }
        if (req.method === "POST" && partes.length === 6 && partes[5] === "calificar") {
          const respuesta = await calificarAbierta(adminId, partes[4], await leerCuerpo(req));
          return responderJson(res, 200, { correcto: true, respuesta }), true;
        }
        if (req.method === "POST" && partes.length === 6 && partes[5] === "cerrar") {
          await exigirFundacion(adminId);
          const encuesta = await cerrarEncuesta(partes[4], `manual:${adminId}`);
          return responderJson(res, 200, { correcto: true, encuesta }), true;
        }
      }
      return responderJson(res, 404, { error: "Ruta de encuestas no encontrada." }), true;
    } catch (error) {
      logger.error("[API ENCUESTAS]", error);
      responderJson(res, error.statusCode || 500, {
        error: error.statusCode ? error.message : "No se pudo completar la operación de encuestas.",
      });
      return true;
    }
  }

  asegurarArchivo();

  return Object.freeze({
    iniciar,
    detener,
    procesarCierres,
    manejarSolicitudHttp,
    fuerzas: FUERZAS,
    dataPath,
  });
}



const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

const sistemaEncuestas = crearSistemaEncuestas({ client });


client.commands = new Collection();
const commandsList = [];
const commandFiles = fs
  .readdirSync("./commands")
  .filter((file) => file.endsWith(".js"));
for (const file of commandFiles) {
  delete require.cache[require.resolve(`./commands/${file}`)];
  const command = require(`./commands/${file}`);
  if (command?.data) {
    client.commands.set(command.data.name, command);
    commandsList.push(command.data.toJSON());
  }
}
console.log(`📋 Comandos cargados localmente: ${commandsList.length}`);

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    console.log(
      "🧹 [PURGA] Eliminando comandos globales residuales de Discord...",
    );
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
      body: [],
    });
    await rest.put(
      Routes.applicationGuildCommands(
        DISCORD_CLIENT_ID,
        DISCORD_GUILD_ID,
      ),
      {
        body: commandsList,
      },
    );
    console.log("🚀 Comandos sincronizados correctamente.");
  } catch (error) {
    console.error("❌ Error al sincronizar comandos:", error);
  }
})();

// ============================================================================
// API NEQUI: fuente real = data/saldo.json
// ============================================================================
const SALDO_PATH = path.join(__dirname, "data", "saldo.json");
let operacionEnCurso = Promise.resolve();

function ejecutarEnCola(trabajo) {
  const siguiente = operacionEnCurso.then(trabajo, trabajo);
  operacionEnCurso = siguiente.catch(() => {});
  return siguiente;
}

function leerSaldo() {
  if (!fs.existsSync(SALDO_PATH)) return [];
  const contenido = fs.readFileSync(SALDO_PATH, "utf8").trim();
  if (!contenido) return [];
  return JSON.parse(contenido);
}

function escribirSaldo(datos) {
  fs.mkdirSync(path.dirname(SALDO_PATH), { recursive: true });
  const temporal = `${SALDO_PATH}.tmp`;
  fs.writeFileSync(temporal, `${JSON.stringify(datos, null, 4)}\n`, "utf8");
  fs.renameSync(temporal, SALDO_PATH);
}

async function sincronizarSaldosIniciales() {
  await asegurarTablasSaldos();
  if (!fs.existsSync(SALDO_PATH)) {
    console.warn(`⚠️ [SALDOS] NO existe el archivo ${SALDO_PATH}. Todavia nadie ha usado /saldo en este servidor.`);
    return 0;
  }
  const saldos = registrosDeSaldo(leerSaldo());
  let cantidad = 0;
  for (const saldo of saldos) {
    if (!saldo?.discordId) continue;
    await sincronizarSaldoConWeb(saldo);
    cantidad++;
  }
  console.log(`✅ [SALDOS] ${cantidad} cuenta(s) sincronizada(s) desde ${SALDO_PATH}.`);
  return cantidad;
}

// ============================================================================
// MySQL (tabla saldos): se adapta sola a las columnas que existan
// ============================================================================
let columnasSaldosConocidas = null;

async function asegurarTablasSaldos() {
  try {
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS saldos (
        discord_id VARCHAR(32) NOT NULL PRIMARY KEY,
        billetera BIGINT NOT NULL DEFAULT 0,
        banco BIGINT NOT NULL DEFAULT 0,
        numero_tarjeta VARCHAR(64) NULL,
        actualizado_en DATETIME NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    );
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS inventario (
        discord_id VARCHAR(32) NOT NULL,
        item_id VARCHAR(64) NOT NULL,
        nombre VARCHAR(190) NULL,
        tipo VARCHAR(64) NULL,
        precio INT NOT NULL DEFAULT 0,
        emoji VARCHAR(32) NULL,
        descripcion TEXT NULL,
        comprado_en DATETIME NULL,
        payload JSON NULL,
        PRIMARY KEY (discord_id, item_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    );
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS tienda (
        producto_id VARCHAR(64) NOT NULL PRIMARY KEY,
        nombre VARCHAR(190) NOT NULL,
        descripcion TEXT NULL,
        precio INT NOT NULL DEFAULT 0,
        emoji VARCHAR(32) NULL,
        tipo VARCHAR(64) NULL,
        stock INT NULL,
        payload JSON NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    );
    // Si la tabla saldos es vieja (sin numero_tarjeta), intentamos agregarla.
    try {
      await pool.execute("ALTER TABLE saldos ADD COLUMN numero_tarjeta VARCHAR(64) NULL AFTER banco");
      console.log("[MYSQL] Columna numero_tarjeta agregada a la tabla saldos.");
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    }
    const [filas] = await pool.query("SHOW COLUMNS FROM saldos");
    columnasSaldosConocidas = new Set(filas.map((fila) => String(fila.Field)));
    console.log(`[MYSQL] Tablas listas. Columnas de saldos: ${[...columnasSaldosConocidas].join(", ")}`);
  } catch (error) {
    console.error("[MYSQL] No se pudieron crear/verificar las tablas:", error.message);
  }
}

async function sincronizarSaldoConWeb(saldo) {
  if (!saldo?.discordId) return;
  if (!columnasSaldosConocidas) {
    try {
      const [filas] = await pool.query("SHOW COLUMNS FROM saldos");
      columnasSaldosConocidas = new Set(filas.map((fila) => String(fila.Field)));
    } catch {
      columnasSaldosConocidas = new Set(["discord_id", "billetera", "banco"]);
    }
  }
  const campos = ["discord_id", "billetera", "banco"];
  const valores = [
    String(saldo.discordId),
    Number(saldo.billetera || 0),
    Number(saldo.banco || 0),
  ];
  if (columnasSaldosConocidas.has("numero_tarjeta")) {
    campos.push("numero_tarjeta");
    valores.push(saldo.numeroTarjeta || saldo.numero_tarjeta || null);
  }
  if (columnasSaldosConocidas.has("actualizado_en")) {
    campos.push("actualizado_en");
    valores.push(new Date());
  }
  const actualizaciones = campos
    .filter((campo) => campo !== "discord_id")
    .map((campo) => `${campo} = VALUES(${campo})`)
    .join(", ");
  await pool.execute(
    `INSERT INTO saldos (${campos.join(", ")})
     VALUES (${campos.map(() => "?").join(", ")})
     ON DUPLICATE KEY UPDATE ${actualizaciones}`,
    valores
  );
}

// ============================================================================
// WATCHER: lee data/saldo.json cada 1 segundo y guarda en MySQL (tabla saldos)
// ============================================================================
const INTERVALO_SALDOS_MS = 1000;
let ultimaModificacionSaldos = 0;

async function sincronizarSaldosWatcher() {
  try {
    if (!fs.existsSync(SALDO_PATH)) return;

    const stat = fs.statSync(SALDO_PATH);
    if (stat.mtimeMs === ultimaModificacionSaldos) return; // solo si cambió
    ultimaModificacionSaldos = stat.mtimeMs;

    // Si la creacion de tablas fallo al arrancar, se reintenta aqui.
    if (!columnasSaldosConocidas) await asegurarTablasSaldos();

    const saldos = registrosDeSaldo(leerSaldo());

    let cantidad = 0;
    for (const saldo of saldos) {
      if (!saldo?.discordId) continue;
      await sincronizarSaldoConWeb(saldo);
      cantidad++;
    }
    console.log(`✅ [SALDOS] Watcher sincronizo ${cantidad} cuenta(s) a MySQL desde data/saldo.json.`);
  } catch (error) {
    console.error("[SALDOS] Error sincronizando con MySQL:", error.message);
  }
}

function iniciarWatcherSaldos() {
  console.log(`[SALDOS] Vigilando archivo: ${SALDO_PATH} (existe: ${fs.existsSync(SALDO_PATH) ? "si" : "NO"})`);
  asegurarTablasSaldos().finally(() => {
    sincronizarSaldosWatcher();
    setInterval(sincronizarSaldosWatcher, INTERVALO_SALDOS_MS);
    console.log("[SALDOS] Watcher iniciado: lee data/saldo.json cada 1s y guarda en MySQL");
  });
}

function registrosDeSaldo(datos) {
  if (Array.isArray(datos)) return datos;
  if (!datos || typeof datos !== "object") return [];
  return Object.entries(datos).map(([id, registro]) => ({
    ...(registro && typeof registro === "object" ? registro : {}),
    discordId: String(registro?.discordId || registro?.discord_id || id),
  }));
}

function obtenerRegistro(datos, discordId) {
  const id = String(discordId);
  if (Array.isArray(datos)) {
    return datos.find(
      (registro) =>
        String(registro?.discordId || registro?.discord_id || registro?.id) ===
        id,
    );
  }
  if (datos && typeof datos === "object") {
    if (datos[id] && typeof datos[id] === "object") return datos[id];
    return Object.values(datos).find(
      (registro) =>
        String(registro?.discordId || registro?.discord_id || registro?.id) ===
        id,
    );
  }
  return null;
}

function actualizarRegistro(datos, discordId, cambios) {
  const actual = obtenerRegistro(datos, discordId);
  if (!actual) return null;
  Object.assign(actual, cambios);
  return actual;
}

function leerListaDatos(nombre) {
  const ruta = path.join(__dirname, "data", nombre);
  if (!fs.existsSync(ruta)) return [];
  try {
    const datos = JSON.parse(fs.readFileSync(ruta, "utf8"));
    if (Array.isArray(datos)) return datos.flatMap((item) => Array.isArray(item) ? item : [item]);
    return Object.values(datos || {}).flatMap((item) => Array.isArray(item) ? item : [item]);
  } catch (error) {
    console.error(`[API EXPEDIENTE] No se pudo leer ${nombre}:`, error.message);
    return [];
  }
}

function escribirListaDatos(nombre, datos) {
  const ruta = path.join(__dirname, "data", nombre);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, `${JSON.stringify(datos, null, 2)}\n`, "utf8");
}

function esMulta(registro) {
  return String(registro?.tipo || "").toLowerCase() === "multa" ||
    Boolean(registro?.multaId || registro?.comparendoId || registro?.totalMulta || registro?.saldoPendiente);
}

function leerMultasUnificadas() {
  const multas = leerListaDatos("multas.json");
  const antecedentes = leerListaDatos("antecedentes.json");
  const existentes = new Set(multas.map((r) => String(r?.id || r?.multaId || "")));
  for (const registro of antecedentes) {
    const id = String(registro?.id || registro?.multaId || "");
    if (esMulta(registro) && id && !existentes.has(id)) {
      multas.push(registro);
      existentes.add(id);
    }
  }
  return multas;
}

function leerAntecedentesReales() {
  return leerListaDatos("antecedentes.json").filter((registro) => !esMulta(registro));
}

function guardarArrestoCompletoDesdeWeb(registro) {
  const arrestos = leerListaDatos("arrestos.json");
  arrestos.push(registro);
  escribirListaDatos("arrestos.json", arrestos);
  const antecedentes = leerListaDatos("antecedentes.json");
  antecedentes.push({ arrestoId: registro.id, discordId: registro.discordId, nuip: registro.nuip, ciudadano: registro.ciudadano, delitos: registro.delitos, fecha: registro.fecha, fotoUrl: registro.fotoUrl, oficialId: registro.oficialId });
  escribirListaDatos("antecedentes.json", antecedentes);
}

const VEHICULOS_PATH = path.join(__dirname, "data", "vehiculos.json");
const INVENTARIO_PATH = path.join(__dirname, "data", "inventario.json");
const TIENDA_PATH = fs.existsSync(path.join(__dirname, "data", "tienda.json"))
  ? path.join(__dirname, "data", "tienda.json")
  : path.join(__dirname, "data", "items.json");
const COMPORTAMIENTO_PATH = path.join(__dirname, "data", "comportamiento.json");
const USUARIOS_PATH = path.join(__dirname, "data", "usuarios.json");
const TRABAJOS_PATH = path.join(__dirname, "data", "trabajos.json");

function leerUsuarios() {
  if (!fs.existsSync(USUARIOS_PATH)) return {};
  try {
    const datos = JSON.parse(fs.readFileSync(USUARIOS_PATH, "utf8"));
    return datos && typeof datos === "object" && !Array.isArray(datos) ? datos : {};
  } catch (error) {
    console.error("[USUARIOS] No se pudo leer usuarios.json:", error.message);
    return {};
  }
}

function leerVehiculos() {
  if (!fs.existsSync(VEHICULOS_PATH)) return [];
  try {
    const datos = JSON.parse(fs.readFileSync(VEHICULOS_PATH, "utf8"));
    return Array.isArray(datos) ? datos : Object.values(datos || {});
  } catch (error) {
    console.error("[VEHICULOS] No se pudo leer vehiculos.json:", error.message);
    return [];
  }
}

function escribirVehiculos(datos) {
  fs.mkdirSync(path.dirname(VEHICULOS_PATH), { recursive: true });
  const temporal = `${VEHICULOS_PATH}.tmp`;
  fs.writeFileSync(temporal, `${JSON.stringify(datos, null, 2)}\n`, "utf8");
  fs.renameSync(temporal, VEHICULOS_PATH);
}

function leerInventario() {
  if (!fs.existsSync(INVENTARIO_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(INVENTARIO_PATH, "utf8"));
  } catch (error) {
    console.error("[VEHICULOS] No se pudo leer inventario.json:", error.message);
    return {};
  }
}

function escribirInventario(datos) {
  const temporal = `${INVENTARIO_PATH}.tmp`;
  fs.writeFileSync(temporal, `${JSON.stringify(datos, null, 2)}\n`, "utf8");
  fs.renameSync(temporal, INVENTARIO_PATH);
}

function leerTienda() {
  if (!fs.existsSync(TIENDA_PATH)) return [];
  try {
    const datos = JSON.parse(fs.readFileSync(TIENDA_PATH, "utf8"));
    if (Array.isArray(datos)) return datos;
    if (Array.isArray(datos?.items)) return datos.items;
    return Object.values(datos || {});
  } catch (error) {
    console.error("[TIENDA] No se pudo leer el catálogo:", error.message);
    return [];
  }
}

function leerComportamiento() {
  if (!fs.existsSync(COMPORTAMIENTO_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(COMPORTAMIENTO_PATH, "utf8"));
  } catch (error) {
    console.error("[COMPORTAMIENTO] No se pudo leer comportamiento.json:", error.message);
    return {};
  }
}

function escribirComportamiento(datos) {
  fs.mkdirSync(path.dirname(COMPORTAMIENTO_PATH), { recursive: true });
  const temporal = `${COMPORTAMIENTO_PATH}.tmp`;
  fs.writeFileSync(temporal, `${JSON.stringify(datos, null, 2)}\n`, "utf8");
  fs.renameSync(temporal, COMPORTAMIENTO_PATH);
}

function leerTrabajos() {
  if (!fs.existsSync(TRABAJOS_PATH)) return [];
  try {
    const datos = JSON.parse(fs.readFileSync(TRABAJOS_PATH, "utf8"));
    return Array.isArray(datos) ? datos : [];
  } catch (error) {
    console.error("[TRABAJOS] No se pudo leer trabajos.json:", error.message);
    return [];
  }
}

function escribirTrabajos(datos) {
  fs.mkdirSync(path.dirname(TRABAJOS_PATH), { recursive: true });
  const temporal = `${TRABAJOS_PATH}.tmp`;
  fs.writeFileSync(temporal, `${JSON.stringify(datos, null, 2)}\n`, "utf8");
  fs.renameSync(temporal, TRABAJOS_PATH);
}

function escribirTienda(datos) {
  fs.mkdirSync(path.dirname(TIENDA_PATH), { recursive: true });
  const temporal = `${TIENDA_PATH}.tmp`;
  fs.writeFileSync(temporal, `${JSON.stringify(datos, null, 2)}\n`, "utf8");
  fs.renameSync(temporal, TIENDA_PATH);
}

async function enviarLogFundacion(titulo, descripcion, color = 0x42d8d0, canalId = "1539432339413799042", detalles = null) {
  const idCanal = String(canalId || "").trim();
  const token = DISCORD_TOKEN;
  if (!/^\d{10,25}$/.test(idCanal)) {
    throw new Error(`Canal de logs inválido: ${idCanal}`);
  }
  if (!token) {
    throw new Error("Falta TOKEN en el entorno del bot.");
  }

  const esComportamiento = ["nota", "sancion", "nota_cancelada", "sancion_cancelada"].includes(detalles?.tipo);
  const esCancelacion = detalles?.tipo === "nota_cancelada" || detalles?.tipo === "sancion_cancelada";
  const esDinero = detalles?.tipo === "dinero";
  const emojiRegistro = detalles?.tipo === "sancion"
    ? "⚠️"
    : "<:15202998040501986282:1549414463218655362>";
  const emojiEstado = "<:1544326143321047112:1548832193269338213>";
  const emojiAdmin = "<a:1334651531206856755:1548832195400040488>";
  const embed = {
    color: esCancelacion ? (String(detalles.tipo).startsWith("sancion") ? 0x2ecc71 : 0x3498db) : esComportamiento ? (String(detalles.tipo).includes("sancion") ? 0xf87171 : 0xf1c40f) : esDinero ? 0x00ff00 : color,
    author: esComportamiento
      ? { name: "「ME:RP」Medellín RP︱ER:LC • Gestión administrativa" }
      : esDinero
        ? { name: "LOGS | ADMINISTRACIÓN FINANCIERA", icon_url: "https://images-ext-1.discordapp.net/external/qCiajdFJYhtqMtSlgNAdxyew_aicx8akS9vNh92Gslk/%3Fq%3Dtbn%3AANd9GcRGNGdbqsun1jR_HaStAiMjCxRHj68WLGTl3-_5574erg%26s%3D10/https/encrypted-tbn0.gstatic.com/images" }
        : undefined,
    title: esComportamiento
      ? `${esCancelacion ? "<a:1334651531206856755:1548832195400040488>" : emojiRegistro} ${esCancelacion ? (String(detalles.tipo).startsWith("sancion") ? "SANCIÓN CANCELADA" : "NOTA CANCELADA") : (detalles.tipo === "sancion" ? "Nueva sanción de comportamiento" : "Nueva nota de comportamiento")}`
      : esDinero
        ? `${detalles.accion === "add_money" ? "✅" : "➖"} Registro de ${detalles.accion === "add_money" ? "carga" : "retiro"} de fondos`
        : `✦ Fundación · ${titulo}`,
    description: esComportamiento
      ? (esCancelacion ? `<:1544325897564200970:1548836183168000101> Se canceló un registro de <@${detalles.discordId}>.` : `${emojiEstado} Se ha registrado ${String(detalles.tipo).includes("sancion") ? "una sanción" : "una observación"} para <@${detalles.discordId}>.`)
      : esDinero
        ? `Se han ${detalles.accion === "add_money" ? "añadido" : "retirado"} fondos ${detalles.accion === "add_money" ? "a" : "de"} la cuenta de <@${detalles.discordId}>.`
      : descripcion,
    fields: esComportamiento ? [
      { name: `${emojiAdmin} Usuario`, value: `<@${detalles.discordId}>`, inline: true },
      { name: `${esCancelacion ? "<:1520299804050198628:1549034399905882172>" : emojiRegistro} ${String(detalles.tipo).includes("sancion") ? (esCancelacion ? "Motivo de la sanción" : "Sanción registrada") : (esCancelacion ? "Nota cancelada" : "Nota registrada")}`, value: String(detalles.texto || "Sin detalle").slice(0, 1024), inline: false },
      ...(esCancelacion ? [{ name: "<:1544325897564200970:1548836183168000101> Registros restantes", value: String(detalles.restantes ?? 0), inline: true }] : []),
      { name: `${emojiAdmin} ${esCancelacion ? "Cancelada por" : "Registrada por"}`, value: `<@${detalles.adminId}>`, inline: true },
    ] : esDinero ? [
      { name: "👤 Administrador", value: `<@${detalles.adminId}>`, inline: true },
      { name: "👤 Usuario objetivo", value: `<@${detalles.discordId}>`, inline: true },
      { name: "💰 Monto", value: `$${Number(detalles.monto || 0).toLocaleString("es-CO")}`, inline: true },
      { name: "📍 Destino", value: detalles.tipoDinero === "banco" ? "💳 NEQUI / BANCO" : "💵 BILLETERA / MANO", inline: true },
      { name: detalles.tipoDinero === "banco" ? "💳 Nuevo saldo en Nequi" : "💵 Nuevo saldo en Mano", value: `$${Number(detalles.nuevoSaldo || 0).toLocaleString("es-CO")}`, inline: true },
    ] : undefined,
    thumbnail: esDinero ? { url: "https://images-ext-1.discordapp.net/external/qCiajdFJYhtqMtSlgNAdxyew_aicx8akS9vNh92Gslk/%3Fq%3Dtbn%3AANd9GcRGNGdbqsun1jR_HaStAiMjCxRHj68WLGTl3-_5574erg%26s%3D10/https/encrypted-tbn0.gstatic.com/images" } : undefined,
    footer: { text: esComportamiento ? "「ME:RP」Medellín RP︱ER:LC • Registro administrativo" : esDinero ? "Seguridad Nequi • Tu plata a tu ritmo" : "Medellín RP · Panel Fundación" },
    timestamp: new Date().toISOString(),
  };

  const respuesta = await fetch(`https://discord.com/api/v10/channels/${idCanal}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Medellin-RP-Fundacion/1.0",
    },
    body: JSON.stringify({
      content: esComportamiento ? `${esCancelacion ? "✅" : emojiRegistro} **${esCancelacion ? "Registro cancelado de" : "Nuevo registro para"}** <@${detalles.discordId}>` : undefined,
      embeds: [embed],
      allowed_mentions: esComportamiento ? { users: [String(detalles.discordId)] } : undefined,
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    if (respuesta.status === 429) {
      console.warn(`⚠️ [FUNDACION LOG] Discord limitó temporalmente el canal ${idCanal}; la operación principal continuará.`);
      return false;
    }
    throw new Error(`Discord rechazó el log en ${idCanal}: ${respuesta.status} ${detalle}`);
  }

  console.log(`✅ [FUNDACION LOG] ${titulo} enviado al canal ${idCanal}.`);
  return true;
}

function inventarioMutableDelUsuario(inventario, discordId) {
  if (Array.isArray(inventario)) {
    let usuario = inventario.find((registro) => String(registro.discordId || registro.discord_id) === String(discordId));
    if (!usuario) {
      usuario = { discordId: String(discordId), items: [] };
      inventario.push(usuario);
    }
    if (!Array.isArray(usuario.items)) usuario.items = [];
    return usuario.items;
  }
  if (!Array.isArray(inventario[discordId])) inventario[discordId] = [];
  return inventario[discordId];
}

function inventarioDelUsuario(inventario, discordId) {
  if (Array.isArray(inventario)) {
    const usuario = inventario.find((registro) => String(registro.discordId || registro.discord_id) === String(discordId));
    return Array.isArray(usuario?.items) ? usuario.items : [];
  }
  return Array.isArray(inventario?.[discordId]) ? inventario[discordId] : [];
}

function vehiculosDelUsuario(discordId) {
  return leerVehiculos().filter((vehiculo) => String(vehiculo.discordId) === String(discordId));
}

async function sincronizarVehiculosUsuario(discordId) {
  await sincronizarVehiculosConWeb(discordId, vehiculosDelUsuario(discordId));
}

async function sincronizarVehiculosIniciales() {
  await crearTablaVehiculos();
  const ids = new Set(
    leerVehiculos()
      .map((vehiculo) => vehiculo?.discordId)
      .filter(Boolean)
      .map(String),
  );
  for (const discordId of ids) await sincronizarVehiculosUsuario(discordId);
  console.log(`✅ [VEHICULOS] ${ids.size} usuario(s) sincronizado(s).`);
}

async function sincronizarInventarioInicial() {
  const inventario = leerInventario();
  const cantidad = await sincronizarInventarioConWeb(inventario);
  console.log(`✅ [INVENTARIO] ${cantidad} item(s) sincronizado(s).`);
}

async function sincronizarTiendaComportamientoInicial() {
  try {
    await sincronizarTiendaArchivo();
  } catch (error) {
    console.error("❌ [TIENDA] No se pudo sincronizar:", error.message);
  }
  try {
    await sincronizarComportamientoArchivo();
  } catch (error) {
    console.error("❌ [COMPORTAMIENTO] No se pudo sincronizar:", error.message);
  }
}

function perteneceAlCiudadano(registro, discordId) {
  return (
    String(
      registro?.discordId ||
        registro?.discord_id ||
        registro?.userId ||
        registro?.usuarioId ||
        "",
    ) === String(discordId)
  );
}

async function sincronizarExpedientesIniciales() {
  const arrestos = leerListaDatos("arrestos.json");
  const antecedentes = leerAntecedentesReales();
  const multas = leerMultasUnificadas();
  const registros = [...arrestos, ...antecedentes, ...multas];
  const ids = new Set(
    registros
      .map((registro) => registro?.discordId || registro?.discord_id)
      .filter(Boolean)
      .map(String),
  );
  // También sincronizamos ciudadanos sin registros para retirar de MySQL
  // antecedentes o arrestos antiguos que ya no existen en los JSON.
  Object.keys(leerUsuarios()).forEach((discordId) => ids.add(String(discordId)));

  if (!ids.size) {
    console.log("📋 [EXPEDIENTE] No hay registros para sincronizar.");
    return;
  }

  for (const discordId of ids) {
    await sincronizarExpedienteConWeb({
      discordId,
      arrestos: arrestos.filter((registro) => perteneceAlCiudadano(registro, discordId)),
      antecedentes: antecedentes.filter((registro) => perteneceAlCiudadano(registro, discordId)),
      multas: multas.filter((registro) => perteneceAlCiudadano(registro, discordId)),
    });
    console.log(`✅ [EXPEDIENTE] Sincronizado: ${discordId}`);
  }
}

function responderJson(res, estado, cuerpo) {
  const origen = process.env.WEB_ORIGIN || "*";
  res.writeHead(estado, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origen,
    "Access-Control-Allow-Headers": "Content-Type, X-Nequi-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(cuerpo));
}

function autorizado(req) {
  const clave = process.env.NEQUI_API_KEY;
  return Boolean(clave && req.headers["x-nequi-key"] === clave);
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let cuerpo = "";
    req.on("data", (parte) => {
      cuerpo += parte;
      if (cuerpo.length > 12 * 1024 * 1024) reject(new Error("La imagen supera el límite de 12 MB."));
    });
    req.on("end", () => {
      try {
        resolve(cuerpo ? JSON.parse(cuerpo) : {});
      } catch {
        reject(new Error("JSON inválido."));
      }
    });
    req.on("error", reject);
  });
}

const GRAVEDAD_DELITOS = {
  "AC-01": 10, "AC-02": 4.5, "AC-03": 6, "AC-04": 2, "AC-05": 1.5,
  "AC-2.1": 8, "AC-06": 3, "AC-07": 6.5, "AC-08": 4.5, "AC-09": 2,
  "AC-10": 8, "AC-11": 10, "AC-12": 4.5, "AC-13": 1.5, "AC-14": 3.5,
  "AC-15": 1.5, "AC-16": 6, "AC-17": 8, "AC-18": 6.5, "AC-19": 8,
  "AC-20": 3.5, "AC-21": 4.5, "AC-22": 6.5, "AC-23": 3.5, "AC-24": 6,
  "AC-25": 6, "AC-26": 2, "AC-27": 8, "AC-28": 2, "AC-29": 3,
  "AC-29.1": 6, "AC-30": 8, "AC-31": 10, "AC-32": 4.5, "AC-32.1": 6,
  "AC-33": 6, "AC-34": 7.5, "AC-35": 1.5, "AC-36": 3.5, "AC-37": 4.5,
  "AC-38": 6, "AC-39": 3.5, "AC-40": 2, "AC-41": 1.5, "AC-42": 5,
  "AC-43": 4.5, "AC-44": 3.5, "AC-45": 6,
};

function calcularPrisionSegundos(delitos) {
  const gravedadTotal = delitos.reduce((total, delito) => {
    const codigo = String(delito).trim().match(/^AC-[\d.]+/i)?.[0]?.toUpperCase();
    return total + Number(GRAVEDAD_DELITOS[codigo] || 1.5);
  }, 0);
  const minutos = Math.max(2, Math.min(12, Math.round(2 + ((gravedadTotal - 1.5) / 8.5) * 10)));
  return minutos * 60;
}

const nequiServer = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return responderJson(res, 204, {});
  if (
    !req.url.startsWith("/api/nequi/") &&
    !req.url.startsWith("/api/expediente/") &&
    !req.url.startsWith("/api/vehiculos/") &&
    !req.url.startsWith("/api/tienda/") &&
    !req.url.startsWith("/api/comportamiento/") &&
    !req.url.startsWith("/api/fundacion/") &&
    !req.url.startsWith("/api/encuestas/") &&
    !req.url.startsWith("/api/arrestos/") &&
    !req.url.startsWith("/api/multas/") &&
    !req.url.startsWith("/api/alertas/") &&
    !req.url.startsWith("/api/twitter/")
  )
    return responderJson(res, 404, { error: "Ruta no encontrada." });
  if (!autorizado(req))
    return responderJson(res, 401, { error: "API no autorizada." });

  if (await sistemaEncuestas.manejarSolicitudHttp(req, res, { responderJson, leerCuerpo, autorizado })) return;

  const partes = req.url.split("?")[0].split("/").filter(Boolean);
  const discordId = partes[2];
  if (!/^\d{10,25}$/.test(discordId))
    return responderJson(res, 400, { error: "Discord ID inválido." });

  try {
    // Única extensión añadida al index original: notificaciones de Twitter.
    if (req.method === "POST" && partes[1] === "twitter" && partes.length === 3) {
      const cuerpo = await leerCuerpo(req);
      const followerIds = Array.isArray(cuerpo.followerIds)
        ? cuerpo.followerIds.map((id) => String(id)).filter((id) => /^\d{10,25}$/.test(id)).slice(0, 100)
        : [];
      if (!followerIds.length) return responderJson(res, 200, { correcto: true, notificados: 0 });
      const canal = await client.channels.fetch(process.env.CANAL_TWITTER || "1539432339413799042");
      if (!canal?.isTextBased?.()) return responderJson(res, 503, { error: "El canal de Twitter no está disponible." });
      const { EmbedBuilder } = require("discord.js");
      const titulo = String(cuerpo.nombre || "Publicación").slice(0, 120);
      const descripcion = String(cuerpo.descripcion || "").slice(0, 1800);
      for (const id of followerIds) {
        const embed = new EmbedBuilder()
          .setColor(0x42d8d0)
          .setTitle("🐦 Nueva publicación de una cuenta que sigues")
          .setDescription(`**<@${discordId}>** publicó algo nuevo en Twitter ciudadano.\n\n**${titulo}**\n${descripcion}`)
          .addFields(
            { name: "👤 Cuenta que publicó", value: `<@${discordId}>`, inline: true },
            { name: "🔔 Notificado", value: `<@${id}> está siguiendo esta cuenta`, inline: true },
          )
          .setFooter({ text: "「ME:RP」Medellín RP • Notificación Twitter" })
          .setTimestamp();
        await canal.send({
          content: `<@${id}>`,
          allowedMentions: { users: [id] },
          embeds: [embed],
        });
      }
      console.log(`[TWITTER] Notificación enviada por el bot a ${followerIds.length} seguidor(es).`);
      return responderJson(res, 200, { correcto: true, notificados: followerIds.length });
    }

    if (req.method === "POST" && partes[1] === "arrestos" && partes.length === 3) {
      const cuerpo = await leerCuerpo(req);
      const objetivo = String(cuerpo.discordId || "").trim();
      const oficialId = String(cuerpo.oficialId || discordId).trim();
      const delitos = Array.isArray(cuerpo.delitos) ? cuerpo.delitos.map((d) => String(d).trim()).filter(Boolean).slice(0, 25) : [];
      const imagenBase64 = String(cuerpo.imagenBase64 || "").replace(/^data:image\/[^;]+;base64,/, "");
      if (!/^\d{10,25}$/.test(objetivo) || !delitos.length || !imagenBase64) return responderJson(res, 400, { error: "Faltan ciudadano, delitos o evidencia fotográfica." });
      const buffer = Buffer.from(imagenBase64, "base64");
      if (!buffer.length || buffer.length > 8 * 1024 * 1024) return responderJson(res, 400, { error: "La imagen debe pesar menos de 8 MB." });
      const usuariosPath = path.join(__dirname, "data", "usuarios.json");
      const usuarios = fs.existsSync(usuariosPath) ? JSON.parse(fs.readFileSync(usuariosPath, "utf8")) : {};
      const ciudadano = usuarios[objetivo];
      if (!ciudadano) return responderJson(res, 404, { error: "El ciudadano no está registrado en el sistema civil." });
      const nombreCiudadano = `${ciudadano.nombres || ""} ${ciudadano.apellidos || ""}`.trim() || "Ciudadano";
      const oficial = cuerpo.oficial || `Oficial ${oficialId}`;
      const prisionSegundos = calcularPrisionSegundos(delitos);
      const registro = { id: `WEB-AR-${Date.now()}`, discordId: objetivo, nuip: ciudadano.nuip, ciudadano: nombreCiudadano, delitos: delitos.map((delito) => ({ delito })), oficialId, oficial, prisionSegundos, fecha: new Date().toISOString(), fotoUrl: null, origen: "panel_policial_web" };
      const canal = await client.channels.fetch("1539310402289016842");
      if (!canal?.isTextBased?.()) return responderJson(res, 503, { error: "El canal policial no está disponible." });
      const { EmbedBuilder } = require("discord.js");
      const fechaBonita = new Date(registro.fecha).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "medium" });
      const embed = new EmbedBuilder()
        .setColor(0xb71c1c)
        .setTitle("<:1529167307576705024:1538595451094310913> Arresto registrado")
        .setDescription("Se ha registrado oficialmente un nuevo arresto en el sistema de la policía metropolitana de aburra.")
        .addFields(
          { name: "👤 Ciudadano", value: `<@${objetivo}>\n${nombreCiudadano}`.slice(0, 1024), inline: true },
          { name: "🪪 NUIP", value: String(ciudadano.nuip || "No registrado"), inline: true },
          { name: "🛡️ Oficial", value: `<@${oficialId}>`, inline: true },
          { name: "🗓️ Fecha y hora", value: fechaBonita, inline: false },
          { name: "⚖️ Antecedentes", value: delitos.map((d) => `• ${d}`).join("\n").slice(0, 1024), inline: false },
          { name: "⏱️ Tiempo de prisión", value: `${Math.ceil(Number(registro.prisionSegundos || 0) / 60)} minutos`, inline: true },
          { name: "🆔 Registro", value: registro.id, inline: true },
        )
        .setFooter({ text: "Sistema de Datos Policiales" })
        .setImage("attachment://evidencia-arresto.png")
        .setTimestamp();
      const mensaje = await canal.send({ embeds: [embed], files: [{ attachment: buffer, name: "evidencia-arresto.png" }] });
      registro.fotoUrl = mensaje.attachments.first()?.url || null;
      guardarArrestoCompletoDesdeWeb(registro);
      await sincronizarExpedienteConWeb({ discordId: objetivo, arrestos: leerListaDatos("arrestos.json").filter((r) => perteneceAlCiudadano(r, objetivo)), antecedentes: leerAntecedentesReales().filter((r) => perteneceAlCiudadano(r, objetivo)), multas: leerMultasUnificadas().filter((r) => perteneceAlCiudadano(r, objetivo)) });
      return responderJson(res, 201, { correcto: true, mensaje: "Arresto enviado al canal policial y guardado correctamente.", fotoUrl: registro.fotoUrl });
    }

    if (req.method === "GET" && partes[1] === "alertas" && partes.length === 3) {
      const rutaAlertas = path.join(__dirname, "data", "alertas.json");
      let alertas = [];
      if (fs.existsSync(rutaAlertas)) {
        const datos = JSON.parse(fs.readFileSync(rutaAlertas, "utf8"));
        alertas = Array.isArray(datos) ? datos : Object.values(datos || {});
      }
      const ahora = Date.now();
      alertas = alertas.filter((a) => !a.expiraEn || Number(a.expiraEn) > ahora).map((a) => ({ ...a, restanteMinutos: a.expiraEn ? Math.max(0, Math.ceil((Number(a.expiraEn) - ahora) / 60000)) : null }));
      return responderJson(res, 200, { correcto: true, alertas });
    }

    if (req.method === "GET" && partes[1] === "fundacion" && partes.length === 3) {
      const consulta = new URL(req.url, "http://localhost");
      const vista = consulta.searchParams.get("vista");
      if (vista === "comportamiento") {
        const objetivo = String(consulta.searchParams.get("discordId") || "").trim();
        if (!/^\d{10,25}$/.test(objetivo)) return responderJson(res, 400, { error: "Discord ID inválido." });
        const datos = listasComportamiento(leerComportamiento(), objetivo);
        return responderJson(res, 200, { correcto: true, ...datos });
      }
      if (vista === "trabajos") {
        return responderJson(res, 200, { correcto: true, trabajos: leerTrabajos() });
      }
      return responderJson(res, 200, { correcto: true, tienda: leerTienda() });
    }

    if (req.method === "POST" && partes[1] === "fundacion" && partes.length === 3) {
      const cuerpo = await leerCuerpo(req);
      const accion = String(cuerpo.accion || "");
      const objetivo = String(cuerpo.discordId || "").trim();
      const accionesConCiudadano = ["add_money", "remove_money", "add_nota", "add_sancion"];
      if (accionesConCiudadano.includes(accion) && !/^\d{10,25}$/.test(objetivo)) return responderJson(res, 400, { error: "Debes seleccionar un ciudadano válido." });
      if (accion === "add_item" && !/^\d{10,25}$/.test(String(cuerpo.adminId || ""))) return responderJson(res, 400, { error: "Fundador no identificado." });
      if (!["add_money", "remove_money", "add_item", "add_nota", "add_sancion", "add_trabajo"].includes(accion)) return responderJson(res, 400, { error: "Acción de Fundación inválida." });
      if (accion === "add_money" || accion === "remove_money") {
        const monto = Number(cuerpo.monto);
        if (!Number.isInteger(monto) || monto <= 0) return responderJson(res, 400, { error: "El monto debe ser un entero mayor que cero." });
        const tipoDinero = String(cuerpo.tipoDinero || "").trim();
        if (!["billetera", "banco"].includes(tipoDinero)) return responderJson(res, 400, { error: "Debes elegir Billetera o Nequi." });
        const saldoResultado = await ejecutarEnCola(async () => {
          const datos = leerSaldo();
          let saldo = obtenerRegistro(datos, objetivo);
          if (!saldo) {
            saldo = { discordId: objetivo, billetera: 0, banco: 0 };
            if (Array.isArray(datos)) datos.push(saldo); else datos[objetivo] = saldo;
          }
          const saldoActual = Number(saldo[tipoDinero] || 0);
          if (accion === "remove_money" && saldoActual < monto) {
            throw Object.assign(
              new Error(`No hay suficiente dinero en ${tipoDinero === "banco" ? "Nequi" : "la Billetera"}.`),
              { statusCode: 400 },
            );
          }
          saldo[tipoDinero] = saldoActual + (accion === "add_money" ? monto : -monto);
          saldo.actualizadoEn = new Date().toISOString();
          escribirSaldo(datos);
          await enviarLogFundacion(
            accion === "add_money" ? "Dinero añadido" : "Dinero retirado",
            `**Fundador:** <@${cuerpo.adminId}>\n**Ciudadano:** <@${objetivo}>\n**Monto:** $${monto.toLocaleString("es-CO")}`,
            accion === "add_money" ? 0x79e2aa : 0xf87171,
            "1539432339413799042",
            {
              tipo: "dinero",
              accion,
              adminId: cuerpo.adminId,
              discordId: objetivo,
              monto,
              tipoDinero,
              nuevoSaldo: saldo[tipoDinero],
            },
          );
          await sincronizarSaldoConWeb({ ...saldo, discordId: objetivo });
          return saldo;
        });
        return responderJson(res, 200, { correcto: true, saldo: saldoResultado });
      }
      if (accion === "add_item") {
        const nombre = String(cuerpo.nombre || "").trim();
        const precio = Number(cuerpo.precio);
        if (!nombre || !Number.isInteger(precio) || precio < 0) return responderJson(res, 400, { error: "Nombre y precio válidos son obligatorios." });
        const tienda = leerTienda();
        if (tienda.some((item) => String(item.nombre || "").toLowerCase() === nombre.toLowerCase())) return responderJson(res, 409, { error: "Ya existe un artículo con ese nombre." });
        const item = { id: `${Date.now()}-${cuerpo.adminId}`, nombre, precio, emoji: String(cuerpo.emoji || "📦"), tipo: String(cuerpo.tipo || "objeto"), descripcion: String(cuerpo.descripcion || "Sin descripción"), creadoPor: String(cuerpo.adminId), creadoEn: new Date().toISOString() };
        tienda.push(item);
        escribirTienda(tienda);
        await sincronizarTiendaArchivo();
        await enviarLogFundacion(
          "Objeto añadido a la tienda",
          `**Fundador:** <@${cuerpo.adminId}>\n**Nombre:** ${item.emoji} ${item.nombre}\n**Precio:** $${precio.toLocaleString("es-CO")}\n**Tipo:** ${item.tipo}`,
        );
        return responderJson(res, 201, { correcto: true, item });
      }
      if (accion === "add_trabajo") {
        const rolId = String(cuerpo.rolId || "").trim();
        const rolNombre = String(cuerpo.rolNombre || "").trim();
        const pago = Number(cuerpo.pago);
        const tiempo = Number(cuerpo.tiempo);
        const unidad = String(cuerpo.unidad || "").trim();
        if (!/^\d{10,25}$/.test(rolId) || !rolNombre || !Number.isInteger(pago) || pago <= 0 || !Number.isInteger(tiempo) || tiempo <= 0 || !["minutos", "horas", "dias"].includes(unidad)) {
          return responderJson(res, 400, { error: "Completa rol, pago, intervalo y unidad válidos." });
        }
        const trabajos = leerTrabajos();
        const trabajo = { id: `TR-${Date.now()}`, rolId, rolNombre, pago, tiempo, unidad, ultimaEjecucion: Date.now(), creadoPor: String(cuerpo.adminId), creadoEn: new Date().toISOString() };
        const existente = trabajos.findIndex((item) => String(item.rolId) === rolId);
        if (existente >= 0) trabajos[existente] = { ...trabajos[existente], ...trabajo };
        else trabajos.push(trabajo);
        escribirTrabajos(trabajos);
        await enviarLogFundacion("Trabajo configurado", `**Administrador:** <@${cuerpo.adminId}>\n**Rol:** <@&${rolId}> (${rolNombre})\n**Pago:** $${pago.toLocaleString("es-CO")}\n**Ciclo:** ${tiempo} ${unidad}`, 0xf3c969, "1549215488721162420");
        return responderJson(res, 201, { correcto: true, trabajo });
      }
      const comportamiento = leerComportamiento();
      if (!Array.isArray(comportamiento[objetivo])) comportamiento[objetivo] = [];
      if (!comportamiento.sanciones || typeof comportamiento.sanciones !== "object") comportamiento.sanciones = {};
      if (!Array.isArray(comportamiento.sanciones[objetivo])) comportamiento.sanciones[objetivo] = [];
      const autor = { autorId: String(cuerpo.adminId || "web"), autorTag: String(cuerpo.adminTag || "Fundación"), fecha: new Date().toISOString() };
      const texto = String(cuerpo.contenido || cuerpo.motivo || "").trim();
      if (!texto) return responderJson(res, 400, { error: "El contenido no puede estar vacío." });
      if (accion === "add_nota") comportamiento[objetivo].push({ contenido: texto, ...autor });
      if (accion === "add_sancion") comportamiento.sanciones[objetivo].push({ motivo: texto, ...autor });
      escribirComportamiento(comportamiento);
      await sincronizarComportamientoConWeb(objetivo, comportamiento);
      await enviarLogFundacion(
        accion === "add_nota" ? "Nota añadida" : "Sanción añadida",
        `**Fundador:** <@${cuerpo.adminId}>\n**Ciudadano:** <@${objetivo}>\n**Contenido:** ${texto}`,
        accion === "add_nota" ? 0x42d8d0 : 0xf87171,
        "1549215488721162420",
        {
          tipo: accion === "add_nota" ? "nota" : "sancion",
          discordId: objetivo,
          adminId: cuerpo.adminId,
          texto,
        },
      );
      return responderJson(res, 201, { correcto: true });
    }

    if (req.method === "DELETE" && partes[1] === "fundacion" && partes.length === 4) {
      const productoId = decodeURIComponent(partes[3]);
      const tienda = leerTienda();
      const producto = tienda.find((item) => String(item.id || item.itemId) === productoId);
      if (!producto) return responderJson(res, 404, { error: "Objeto no encontrado." });
      escribirTienda(tienda.filter((item) => String(item.id || item.itemId) !== productoId));
      await sincronizarTiendaArchivo();
      await enviarLogFundacion(
        "Objeto eliminado de la tienda",
        `**Fundador:** <@${partes[2]}>\n**Objeto:** ${producto.emoji || "📦"} ${producto.nombre}\n**ID:** ${productoId}`,
        0xf87171,
      );
      return responderJson(res, 200, { correcto: true });
    }

    if (req.method === "DELETE" && partes[1] === "fundacion" && partes[3] === "comportamiento" && partes.length === 7) {
      const adminId = String(partes[2]);
      const objetivo = String(partes[4]);
      const tipo = String(partes[5]);
      const indice = Number(partes[6]);
      if (!/^\d{10,25}$/.test(objetivo) || !["nota", "sancion"].includes(tipo) || !Number.isInteger(indice) || indice < 0) return responderJson(res, 400, { error: "Registro de comportamiento inválido." });
      const comportamiento = leerComportamiento();
      const lista = tipo === "nota" ? comportamiento[objetivo] : comportamiento?.sanciones?.[objetivo];
      if (!Array.isArray(lista) || !lista[indice]) return responderJson(res, 404, { error: "El registro ya no existe." });
      const [eliminado] = lista.splice(indice, 1);
      escribirComportamiento(comportamiento);
      await sincronizarComportamientoConWeb(objetivo, comportamiento);
      await enviarLogFundacion(tipo === "nota" ? "Nota cancelada" : "Sanción cancelada", `**Administrador:** <@${adminId}>\n**Ciudadano:** <@${objetivo}>\n**Contenido:** ${eliminado.contenido || eliminado.motivo || "Sin detalle"}`, 0x2ecc71, "1549215488721162420", {
        tipo: `${tipo}_cancelada`,
        discordId: objetivo,
        adminId,
        texto: eliminado.contenido || eliminado.motivo || "Sin detalle",
        restantes: lista.length,
      });
      return responderJson(res, 200, { correcto: true });
    }

    if (req.method === "DELETE" && partes[1] === "fundacion" && partes[3] === "trabajo" && partes.length === 5) {
      const adminId = String(partes[2]);
      const trabajoId = decodeURIComponent(partes[4]);
      const trabajos = leerTrabajos();
      const trabajo = trabajos.find((item) => String(item.id) === trabajoId);
      if (!trabajo) return responderJson(res, 404, { error: "Trabajo no encontrado." });
      escribirTrabajos(trabajos.filter((item) => String(item.id) !== trabajoId));
      await enviarLogFundacion("Trabajo eliminado", `**Administrador:** <@${adminId}>\n**Rol:** ${trabajo.rolNombre || trabajo.rolId}`, 0xf87171, "1549215488721162420");
      return responderJson(res, 200, { correcto: true });
    }

    if (
      req.method === "GET" &&
      partes[1] === "expediente" &&
      partes.length === 3
    ) {
      const arrestos = leerListaDatos("arrestos.json").filter((registro) =>
        perteneceAlCiudadano(registro, discordId),
      );
      const antecedentes = leerAntecedentesReales().filter(
        (registro) => perteneceAlCiudadano(registro, discordId),
      );
      const antecedentesUnicos = antecedentes.filter(
        (registro) =>
          !registro.arrestoId ||
          !arrestos.some((arresto) => String(arresto.id) === String(registro.arrestoId)),
      );
      const multas = leerMultasUnificadas().filter((registro) =>
        perteneceAlCiudadano(registro, discordId),
      );
      return responderJson(res, 200, {
        correcto: true,
        expediente: {
          arrestos,
          antecedentes: antecedentesUnicos,
          multas,
          conteos: {
            arrestos: arrestos.length,
            antecedentes: antecedentesUnicos.length,
            multas: multas.length,
            ordenes: 0,
          },
        },
      });
    }

    if (req.method === "GET" && partes[1] === "vehiculos" && partes.length === 3) {
      const placaBuscada = new URL(req.url, "http://localhost").searchParams.get("placa")?.trim().toUpperCase();
      if (placaBuscada) {
        const vehiculo = leerVehiculos().find(
          (registro) => String(registro.placa || "").trim().toUpperCase() === placaBuscada,
        );
        if (!vehiculo) return responderJson(res, 404, { error: `No existe un vehículo registrado con la placa ${placaBuscada}.` });
        const usuarios = leerUsuarios();
        const propietarioId = String(vehiculo.discordId || vehiculo.propietarioId || vehiculo.ownerId || "");
        const propietario = usuarios[propietarioId] || {};
        return responderJson(res, 200, {
          correcto: true,
          vehiculo,
          propietario: {
            discordId: propietarioId,
            nombre: `${propietario.nombres || ""} ${propietario.apellidos || ""}`.trim() || propietario.username || propietarioId,
            nuip: propietario.nuip || null,
          },
        });
      }
      const vehiculos = vehiculosDelUsuario(discordId);
      await sincronizarVehiculosUsuario(discordId);
      return responderJson(res, 200, {
        correcto: true,
        vehiculos,
        inventario: inventarioDelUsuario(leerInventario(), discordId)
          .filter((item) => item?.tipo === "vehiculo"),
      });
    }

    if (req.method === "GET" && partes[1] === "tienda" && partes.length === 3) {
      return responderJson(res, 200, {
        correcto: true,
        tienda: leerTienda(),
        inventario: inventarioDelUsuario(leerInventario(), discordId),
      });
    }

    if (req.method === "GET" && partes[1] === "comportamiento" && partes.length === 3) {
      const comportamiento = leerComportamiento();
      const datos = listasComportamiento(comportamiento, discordId);
      await sincronizarComportamientoConWeb(discordId, comportamiento);
      return responderJson(res, 200, { correcto: true, ...datos });
    }

    if (req.method === "POST" && partes[1] === "tienda" && partes[3] === "comprar") {
      const cuerpo = await leerCuerpo(req);
      const productoId = String(cuerpo.productoId || cuerpo.itemId || "");
      const catalogo = leerTienda();
      const producto = catalogo.find((item) => String(item.id || item.itemId) === productoId);
      if (!producto) return responderJson(res, 404, { error: "Producto no encontrado." });
      const precio = Number(producto.precio || 0);
      if (!Number.isInteger(precio) || precio < 0) return responderJson(res, 400, { error: "El precio del producto no es válido." });
      const resultado = await ejecutarEnCola(() => {
        const saldos = leerSaldo();
        const saldo = obtenerRegistro(saldos, discordId);
        if (!saldo) throw Object.assign(new Error("No tienes una cuenta activa. Ejecuta /saldo en Discord."), { statusCode: 404 });
        saldo.billetera = Number(saldo.billetera || 0);
        if (saldo.billetera < precio) throw Object.assign(new Error("No tienes suficiente dinero en Mano."), { statusCode: 400 });
        saldo.billetera -= precio;
        saldo.actualizadoEn = new Date().toISOString();
        escribirSaldo(saldos);
        const inventario = leerInventario();
        const items = inventarioMutableDelUsuario(inventario, discordId);
        const comprado = {
          itemId: `${Date.now()}-${discordId}`,
          nombre: producto.nombre || "Producto",
          precio,
          emoji: producto.emoji || "🛍️",
          descripcion: producto.descripcion || "Sin descripción",
          tipo: producto.tipo || "objeto",
          compradoEn: new Date().toISOString(),
        };
        items.push(comprado);
        escribirInventario(inventario);
        return { saldo: saldo.billetera, item: comprado };
      });
      await sincronizarInventarioConWeb(leerInventario());
      return responderJson(res, 201, { correcto: true, ...resultado });
    }

    if (req.method === "POST" && partes[1] === "vehiculos" && partes.length === 3) {
      const cuerpo = await leerCuerpo(req);
      const itemId = String(cuerpo.itemId || "");
      const placa = String(cuerpo.placa || "").trim().toUpperCase();
      const inventario = inventarioDelUsuario(leerInventario(), discordId);
      const item = inventario.find((registro) => String(registro?.itemId) === itemId && registro?.tipo === "vehiculo");
      if (!item) return responderJson(res, 400, { error: "No tienes ese vehículo en tu inventario." });
      if (!/^[A-Z0-9-]{3,10}$/.test(placa)) return responderJson(res, 400, { error: "La placa debe tener entre 3 y 10 caracteres." });
      const vehiculos = leerVehiculos();
      if (vehiculos.some((vehiculo) => String(vehiculo.discordId) === discordId && String(vehiculo.itemId) === itemId)) {
        return responderJson(res, 409, { error: "Ese vehículo ya está registrado." });
      }
      if (vehiculos.some((vehiculo) => String(vehiculo.placa).toUpperCase() === placa)) {
        return responderJson(res, 409, { error: "Esa placa ya está registrada." });
      }
      const nuevo = {
        id: `VEH-${Date.now()}`,
        discordId,
        placa,
        modelo: item.nombre || "Vehículo",
        itemId,
        detalles: {},
        registradoEn: new Date().toISOString(),
      };
      vehiculos.push(nuevo);
      escribirVehiculos(vehiculos);
      await sincronizarVehiculosUsuario(discordId);
      return responderJson(res, 201, { correcto: true, vehiculo: nuevo });
    }

    if (req.method === "DELETE" && partes[1] === "vehiculos" && partes.length === 4) {
      const vehiculoId = decodeURIComponent(partes[3]);
      const vehiculos = leerVehiculos();
      const existe = vehiculos.some((vehiculo) => String(vehiculo.id) === vehiculoId && String(vehiculo.discordId) === discordId);
      if (!existe) return responderJson(res, 404, { error: "Vehículo no encontrado." });
      escribirVehiculos(vehiculos.filter((vehiculo) => !(String(vehiculo.id) === vehiculoId && String(vehiculo.discordId) === discordId)));
      await sincronizarVehiculosUsuario(discordId);
      return responderJson(res, 200, { correcto: true });
    }

    if (req.method === "POST" && partes[1] === "multas" && partes[3] === "pagar") {
      const cuerpo = await leerCuerpo(req);
      const multaId = String(cuerpo.multaId || partes[3] || "").trim();
      if (!multaId) return responderJson(res, 400, { error: "Multa inválida." });
      const resultado = await ejecutarEnCola(() => {
        const saldos = leerSaldo();
        const saldo = obtenerRegistro(saldos, discordId);
        if (!saldo) throw Object.assign(new Error("No tienes una cuenta activa. Ejecuta /saldo en Discord."), { statusCode: 404 });
        let multas = leerListaDatos("multas.json");
        let archivo = "multas.json";
        let indice = multas.findIndex((registro) => String(registro?.id || registro?.multaId) === multaId && perteneceAlCiudadano(registro, discordId));
        if (indice < 0) {
          multas = leerListaDatos("antecedentes.json");
          archivo = "antecedentes.json";
          indice = multas.findIndex((registro) => esMulta(registro) && String(registro?.id || registro?.multaId) === multaId && perteneceAlCiudadano(registro, discordId));
        }
        if (indice < 0) throw Object.assign(new Error("La multa no existe o no pertenece a tu cuenta."), { statusCode: 404 });
        const multa = multas[indice];
        const monto = Number(multa.saldoPendiente ?? multa.totalMulta ?? multa.total ?? 0);
        if (String(multa.estado || "pendiente").toLowerCase() === "pagada" || monto <= 0) {
          throw Object.assign(new Error("Esta multa ya está pagada."), { statusCode: 409 });
        }
        saldo.billetera = Number(saldo.billetera || 0);
        if (!Number.isInteger(monto) || monto <= 0) throw Object.assign(new Error("El valor de la multa no es válido."), { statusCode: 400 });
        if (saldo.billetera < monto) throw Object.assign(new Error(`No tienes suficiente dinero en Billetera. Necesitas $${monto.toLocaleString("es-CO")}.`), { statusCode: 400 });
        saldo.billetera -= monto;
        saldo.actualizadoEn = new Date().toISOString();
        multa.saldoPendiente = 0;
        multa.estado = "pagada";
        multa.pagadaEn = new Date().toISOString();
        multas[indice] = multa;
        escribirListaDatos(archivo, multas);
        escribirSaldo(saldos);
        return { monto, saldoBilletera: saldo.billetera, multa };
      });
      await sincronizarExpedienteConWeb({
        discordId,
        arrestos: leerListaDatos("arrestos.json").filter((r) => perteneceAlCiudadano(r, discordId)),
        antecedentes: leerAntecedentesReales().filter((r) => perteneceAlCiudadano(r, discordId)),
        multas: leerMultasUnificadas().filter((r) => perteneceAlCiudadano(r, discordId)),
      });
      return responderJson(res, 200, { correcto: true, ...resultado });
    }

    if (req.method === "GET" && partes.length === 3) {
      const datos = leerSaldo();
      const registro = obtenerRegistro(datos, discordId);
      if (!registro)
        return responderJson(res, 404, {
          codigo: "CUENTA_NEQUI_INEXISTENTE",
          error:
            "No tienes una cuenta Nequi activa. Ejecuta /saldo en Discord.",
        });
      return responderJson(res, 200, {
        correcto: true,
        saldo: {
          billetera: Number(registro.billetera || 0),
          banco: Number(registro.banco || 0),
          numeroTarjeta:
            registro.numeroTarjeta || registro.numero_tarjeta || null,
          actualizadoEn:
            registro.actualizadoEn || registro.actualizado_en || null,
        },
      });
    }

    if (req.method === "POST" && partes[3] === "operacion") {
      const cuerpo = await leerCuerpo(req);
      const resultado = await ejecutarEnCola(() => {
        const datos = leerSaldo();
        const actual = obtenerRegistro(datos, discordId);
        const monto = Number(cuerpo.monto);
        const tipo = String(cuerpo.tipo || "");
        if (!actual)
          throw Object.assign(
            new Error(
              "No tienes una cuenta Nequi activa. Ejecuta /saldo en Discord.",
            ),
            { statusCode: 404 },
          );
        if (!Number.isInteger(monto) || monto <= 0)
          throw Object.assign(
            new Error("El monto debe ser un entero mayor que cero."),
            { statusCode: 400 },
          );
        actual.billetera = Number(actual.billetera || 0);
        actual.banco = Number(actual.banco || 0);

        if (tipo === "depositar") {
          if (actual.billetera < monto)
            throw Object.assign(
              new Error("No tienes suficiente dinero en Mano."),
              { statusCode: 400 },
            );
          actual.billetera -= monto;
          actual.banco += monto;
        } else if (tipo === "retirar") {
          if (actual.banco < monto)
            throw Object.assign(
              new Error("No tienes suficiente dinero en Nequi."),
              { statusCode: 400 },
            );
          actual.banco -= monto;
          actual.billetera += monto;
        } else if (tipo === "transferir") {
          const destinoId = String(cuerpo.destinoId || "");
          if (destinoId === discordId)
            throw Object.assign(
              new Error("No puedes transferirte a ti mismo."),
              { statusCode: 400 },
            );
          const destino = obtenerRegistro(datos, destinoId);
          if (!destino)
            throw Object.assign(
              new Error("El destinatario no tiene una cuenta Nequi activa."),
              { statusCode: 404 },
            );
          if (actual.banco < monto)
            throw Object.assign(
              new Error(
                "No tienes suficiente dinero en Nequi para transferir.",
              ),
              { statusCode: 400 },
            );
          actual.banco -= monto;
          destino.banco = Number(destino.banco || 0) + monto;
          destino.actualizadoEn = new Date().toISOString();
        } else {
          throw Object.assign(new Error("Operación no válida."), {
            statusCode: 400,
          });
        }

        actual.actualizadoEn = new Date().toISOString();
        escribirSaldo(datos);
        return { billetera: actual.billetera, banco: actual.banco };
      });
      return responderJson(res, 200, { correcto: true, saldo: resultado });
    }

    return responderJson(res, 404, { error: "Ruta no encontrada." });
  } catch (error) {
    console.error("[API NEQUI]", error);
    return responderJson(res, error.statusCode || 500, {
      error: error.message || "Error interno.",
    });
  }
});

const apiPort = Number(process.env.NEQUI_API_PORT || 3001);
nequiServer.listen(apiPort, "0.0.0.0", () => {
  console.log(`🌐 API Nequi leyendo saldo.json en el puerto ${apiPort}`);
});

let presenceInterval = null;
client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 ¡Bot iniciado como ${c.user.tag}!`);
  sistemaEncuestas.iniciar();
  const sincronizaciones = [
    ["MYSQL", probarConexionMySQL],
    ["SALDOS", sincronizarSaldosIniciales],
    ["SALDOS WATCHER", iniciarWatcherSaldos],
    ["EXPEDIENTES", sincronizarExpedientesIniciales],
    ["VEHÍCULOS", sincronizarVehiculosIniciales],
    ["INVENTARIO", sincronizarInventarioInicial],
    ["TIENDA Y COMPORTAMIENTO", sincronizarTiendaComportamientoInicial],
  ];
  for (const [nombre, sincronizar] of sincronizaciones) {
    try {
      await sincronizar();
    } catch (error) {
      console.error(`❌ [${nombre}] No se pudo sincronizar al iniciar:`, error.message);
    }
  }
  const estados = [
    "creado por emma062013",
    "bot oficial COL",
    "el mejor server rp COLOMBIANO",
  ];
  let i = 0;
  if (presenceInterval) clearInterval(presenceInterval);
  presenceInterval = setInterval(() => {
    if (!client.isReady()) return;
    c.user.setPresence({
      activities: [{ name: estados[i], type: ActivityType.Watching }],
      status: "online",
    });
    i = (i + 1) % estados.length;
  }, 5000);
});

client.on(Events.ShardDisconnect, (event, id) =>
  console.warn(`🔌 Shard ${id} desconectado. Código: ${event?.code}`),
);
client.on(Events.ShardReconnecting, (id) =>
  console.warn(`🔄 Shard ${id} reconectando...`),
);
client.on(Events.ShardResume, (id, replayed) =>
  console.log(`✅ Shard ${id} reanudado. Eventos: ${replayed}`),
);
client.on(Events.ShardError, (error, id) =>
  console.error(`❌ Error en shard ${id}:`, error),
);
client.on(Events.Error, (error) =>
  console.error("❌ Error general del cliente Discord:", error),
);

const eventsPath = "./events";
if (fs.existsSync(eventsPath)) {
  const eventFiles = fs
    .readdirSync(eventsPath)
    .filter((file) => file.endsWith(".js"));
  for (const file of eventFiles) {
    const event = require(`./events/${file}`);
    const eventName = event.name === "ready" ? Events.ClientReady : event.name;
    if (event.once) client.once(eventName, (...args) => event.execute(...args));
    else client.on(eventName, (...args) => event.execute(...args));
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (typeof registrarVehiculo.handleInteraction === "function") {
    if (await registrarVehiculo.handleInteraction(interaction)) return;
  }
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    if (interaction.deferred || interaction.replied)
      await interaction
        .editReply({
          content: "❌ Error interno al ejecutar el comando.",
          embeds: [],
          files: [],
          components: [],
        })
        .catch(() => {});
  }
});

const PREFIXES = ["!", "+"];
const codigoPenal = require("./commands/codigo-penal.js");
const codigoTransito = require("./commands/codigo-transito.js");
const normativa = require("./commands/normativa.js");
const registrarVehiculo = require("./commands/registrar-vehiculo.js");
client.on(Events.MessageCreate, async (message) => {
  if (
    message.author.bot ||
    !message.guild ||
    !PREFIXES.some((prefijo) => message.content.startsWith(prefijo))
  )
    return;
  const prefijo = PREFIXES.find((valor) => message.content.trim().startsWith(valor));
  const partes = message.content.trim().slice(prefijo.length).split(/\s+/);
  const nombre = partes.shift()?.toLowerCase();
  try {
    if (nombre === "normativa") return await normativa.execute(message, partes);
    if (
      nombre === "transito" ||
      nombre === "tránsito" ||
      (nombre === "codigo" &&
        ["transito", "tránsito"].includes(partes[0]?.toLowerCase()))
    )
      return await codigoTransito.execute(message, partes);
    if (nombre === "codigo" || nombre === "código")
      return await codigoPenal.execute(message, partes);
  } catch (error) {
    console.error("❌ Error en comando de prefijo:", error);
    await message
      .reply("❌ No se pudo enviar el panel solicitado.")
      .catch(() => {});
  }
});

console.log(`🔎 Configuración Discord: TOKEN=${DISCORD_TOKEN ? "presente" : "FALTA"}, CLIENT_ID=${DISCORD_CLIENT_ID ? "presente" : "FALTA"}, GUILD_ID=${DISCORD_GUILD_ID ? "presente" : "FALTA"}`);
if (DISCORD_TOKEN.length < 20) {
  console.error("❌ TOKEN no está configurado o parece incompleto. Revisa la variable TOKEN en Pterodactyl.");
} else {
  client
    .login(DISCORD_TOKEN)
    .then(() => console.log("🔐 Solicitud de conexión a Discord enviada correctamente."))
    .catch((error) => {
      console.error("❌ El bot no pudo iniciar sesión en Discord:", error.message);
      console.error("Revisa TOKEN, CLIENT_ID, GUILD_ID y que el token no haya sido regenerado.");
      process.exitCode = 1;
    });
}
