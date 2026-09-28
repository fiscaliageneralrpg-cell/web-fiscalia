const mysql = require("mysql2/promise");
require("dotenv").config();

const configuracion = {
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  database: process.env.MYSQL_DATABASE,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  charset: "utf8mb4",
  timezone: "-05:00",
};

const variablesMySQL = [
  "MYSQL_HOST",
  "MYSQL_DATABASE",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
];

for (const variable of variablesMySQL) {
  if (!process.env[variable]) {
    console.warn(
      `[MYSQL] Falta la variable ${variable}. La conexión no estará disponible.`,
    );
  }
}

const pool = mysql.createPool(configuracion);

pool.on("connection", (conexion) => {
  conexion.query("SET time_zone = '-05:00'").catch((error) => {
    console.warn(`[MYSQL] No se pudo fijar la zona horaria Colombia: ${error.message}`);
  });
});

async function probarConexion() {
  const conexion = await pool.getConnection();

  try {
    await conexion.ping();
    console.log("[MYSQL] Web conectada correctamente a MySQL.");
  } finally {
    conexion.release();
  }
}

async function buscarUsuarioPorDiscord(discordId) {
  const [filas] = await pool.execute(
    `SELECT id, discord_id, nuip, nombre, nombres, apellidos, sexo,
                fecha_nacimiento, fecha_nac, nacionalidad, lugar_nac,
                fecha_exp, lugar_exp, roblox_id, roblox_name,
                cedula_imagen_url, creado_en, actualizado_en
         FROM usuarios
         WHERE discord_id = ?
         LIMIT 1`,
    [discordId],
  );

  return filas[0] || null;
}

module.exports = {
  pool,
  probarConexion,
  buscarUsuarioPorDiscord,
};
