import process from "node:process";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3001);
const allowedOrigins = String(
  process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173"
).split(",").map((origin) => origin.trim()).filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const PTERO_URL = (process.env.PTERO_URL || "").replace(/\/+$/, "");
const PTERO_APP_KEY = process.env.PTERO_APP_KEY;
const PTERO_NODE_ID = Number(process.env.PTERO_NODE_ID);
const PTERO_NEST_ID = Number(process.env.PTERO_NEST_ID);
const PTERO_EGG_ID = Number(process.env.PTERO_EGG_ID);
const PTERO_NODE_EGG_ID = Number(process.env.PTERO_NODE_EGG_ID || PTERO_EGG_ID);
const PTERO_PYTHON_NEST_ID = Number(process.env.PTERO_PYTHON_NEST_ID || PTERO_NEST_ID);
const PTERO_PYTHON_EGG_ID = Number(process.env.PTERO_PYTHON_EGG_ID || 0);
const PTERO_NODE_DOCKER_IMAGE =
  process.env.PTERO_DOCKER_IMAGE || "ghcr.io/parkervcp/yolks:nodejs_21";
const PTERO_PYTHON_DOCKER_IMAGE =
  process.env.PTERO_PYTHON_DOCKER_IMAGE || "ghcr.io/ptero-eggs/yolks:python_3.12";
const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY || process.env.WOMPI_PUB_KEY || "";
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const PLAN_CONFIG = {
  free: { label: "Free", cost: 0, memory: 1024, disk: 5120, cpu: 50, databases: 1 },
  advanced: { label: "Advanced", cost: 8, memory: 2048, disk: 15360, cpu: 100, databases: 3 },
  pro: { label: "Pro", cost: 12, memory: 4096, disk: 40960, cpu: 200, databases: 10 }
};

const BAN_TYPES = {
  PERMANENT: "permanent",
  TEMPORARY: "temporary"
};

/* ---------- Encrypted Pterodactyl password storage ----------
   The panel password and the Pterodactyl password are always the same
   in DuckHosting, so we keep an AES-256-GCM encrypted copy to call the
   Pterodactyl CLIENT API (databases) on behalf of the user. */

const PTERO_ENC_KEY = process.env.PTERO_ENC_KEY || process.env.JWT_SECRET || "duckhosting-encryption-key-change-me";
const pteroSessions = new Map(); // userId -> { cookie, xsrf, expiresAt }

function encryptText(text) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(String(PTERO_ENC_KEY)).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptText(payload) {
  const parts = String(payload || "").split(":");
  if (parts.length !== 3) throw new Error("Stored panel password is corrupted. Sign out and sign in again.");
  const key = crypto.createHash("sha256").update(String(PTERO_ENC_KEY)).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "hex"));
  decipher.setAuthTag(Buffer.from(parts[1], "hex"));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], "hex")), decipher.final()]).toString("utf8");
}

function extractResponseCookies(res) {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const raw = res.headers.get("set-cookie");
  if (!raw) return [];
  return raw.split(/,(?=\s*[^;=]+\s*=)/);
}

function cookieValue(cookies, name) {
  for (const cookie of cookies) {
    const pair = cookie.split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return "";
}

// Logs into Pterodactyl as the user and caches the session (30 min).
async function getUserPteroSession(userRow) {
  const cached = pteroSessions.get(userRow.id);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const password = decryptText(userRow.ptero_password);

  const csrfRes = await fetch(`${PTERO_URL}/sanctum/csrf-cookie`);
  const csrfCookies = extractResponseCookies(csrfRes);
  const xsrf = cookieValue(csrfCookies, "XSRF-TOKEN");

  const loginRes = await fetch(`${PTERO_URL}/api/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-XSRF-TOKEN": decodeURIComponent(xsrf),
      Cookie: `XSRF-TOKEN=${xsrf}`
    },
    body: JSON.stringify({ email: userRow.email, password })
  });

  if (!loginRes.ok) {
    throw new Error("Could not sign in to the panel with your credentials. Change your password and try again.");
  }

  const loginCookies = extractResponseCookies(loginRes);
  const xsrfAfterLogin = cookieValue(loginCookies, "XSRF-TOKEN") || xsrf;
  const sessionCookie = loginCookies
    .map((c) => c.split(";")[0].trim())
    .filter((pair) => /^(XSRF-TOKEN|pterodactyl_session)=/.test(pair))
    .join("; ");

  const session = {
    cookie: sessionCookie,
    xsrf: decodeURIComponent(xsrfAfterLogin),
    expiresAt: Date.now() + 30 * 60 * 1000
  };
  pteroSessions.set(userRow.id, session);
  return session;
}

// Calls the Pterodactyl CLIENT API as the user (with one retry on 401).
async function pteroClientRequest(userRow, method, path, body) {
  let session = await getUserPteroSession(userRow);

  const doRequest = () =>
    fetch(`${PTERO_URL}/api/client${path}`, {
      method,
      headers: {
        Accept: "application/vnd.pterodactyl.v1+json",
        "Content-Type": "application/json",
        "X-XSRF-TOKEN": session.xsrf,
        Cookie: session.cookie
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

  let res = await doRequest();
  if (res.status === 401) {
    pteroSessions.delete(userRow.id);
    session = await getUserPteroSession(userRow);
    res = await doRequest();
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const error = new Error(
      data?.errors?.[0]?.detail || data?.message || `Pterodactyl responded with HTTP ${res.status}`
    );
    error.status = res.status;
    throw error;
  }

  return data;
}

async function getOwnedHost(userId, hostId) {
  const [rows] = await pool.execute(
    "SELECT id, user_id, name, plan, pterodactyl_identifier FROM hosts WHERE id = ? AND user_id = ? LIMIT 1",
    [Number(hostId), userId]
  );
  return rows[0] || null;
}

async function getHostUserRow(userId) {
  const [rows] = await pool.execute(
    "SELECT id, email, ptero_password FROM users WHERE id = ? LIMIT 1",
    [userId]
  );
  return rows[0] || null;
}

async function pteroRequest(path, options = {}) {
  if (!PTERO_URL || !PTERO_APP_KEY) {
    throw new Error("Falta configurar PTERO_URL o PTERO_APP_KEY en backend/.env");
  }

  const response = await fetch(`${PTERO_URL}${path}`, {
    ...options,
    headers: {
      Accept: "Application/vnd.pterodactyl.v1+json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${PTERO_APP_KEY}`,
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      data?.errors?.[0]?.detail ||
        data?.message ||
        `Pterodactyl respondió con HTTP ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  return data;
}

function validatePterodactylConfig() {
  const values = {
    PTERO_URL,
    PTERO_APP_KEY,
    PTERO_NODE_ID,
    PTERO_NEST_ID,
    PTERO_NODE_EGG_ID,
    PTERO_PYTHON_NEST_ID
  };

  const missing = Object.entries(values)
    .filter(([, value]) => !value || (typeof value === "number" && !Number.isInteger(value)))
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing values in backend/.env: ${missing.join(", ")}`);
  }
}

function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Invalid session" });
    }

    req.user = jwt.verify(
      header.slice("Bearer ".length),
      process.env.JWT_SECRET
    );
    next();
  } catch {
    return res.status(401).json({ message: "Session expired" });
  }
}

async function adminRequired(req, res, next) {
  try {
    const [users] = await pool.execute(
      "SELECT is_admin FROM users WHERE id = ? LIMIT 1",
      [req.user.userId]
    );

    if (users.length === 0 || Number(users[0].is_admin) !== 1) {
      return res.status(403).json({ message: "Only an administrator can perform this action" });
    }

    next();
  } catch (error) {
    console.error("Error checking administrator access:", error.message);
    res.status(500).json({ message: "Could not verify administrator access" });
  }
}

function daysRemaining(expiresAt) {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000));
}

async function cleanupExpiredHosts() {
  try {
    const [expiredHosts] = await pool.execute(
      "SELECT id, pterodactyl_server_id FROM hosts WHERE expires_at <= NOW()"
    );

    for (const host of expiredHosts) {
      try {
        await pteroRequest(`/api/application/servers/${host.pterodactyl_server_id}`, {
          method: "DELETE"
        });
      } catch (error) {
        if (error.status !== 404) {
          console.error(`Could not delete the host expirado ${host.id}:`, error.message);
          continue;
        }
      }

      await pool.execute("DELETE FROM hosts WHERE id = ?", [host.id]);
      console.log(`Host expirado eliminado: ${host.id}`);
    }
  } catch (error) {
    console.error("Error checking expired hosts:", error.message);
  }
}

app.get("/", (req, res) => {
  res.json({ ok: true, message: "DuckHosting API is running" });
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "conectada" });
  } catch (error) {
    console.error("MySQL connection error:", error.message);
    res.status(500).json({
      ok: false,
      database: "desconectada",
      message: "Could not connect to the database"
    });
  }
});

app.post("/api/auth/register", async (req, res) => {
  let createdPteroUser = null;

  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: "Complete all fields" });
    }

    const cleanUsername = String(username).trim();
    const cleanEmail = String(email).trim().toLowerCase();

    if (cleanUsername.length < 3) {
      return res.status(400).json({
        message: "Username must be at least 3 characters"
      });
    }

    if (!cleanEmail.includes("@")) {
      return res.status(400).json({ message: "Enter a valid email address" });
    }

    if (String(password).length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters"
      });
    }

    const [existingUsers] = await pool.execute(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [cleanEmail]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({ message: "That email is already registered" });
    }

    validatePterodactylConfig();

    createdPteroUser = await pteroRequest("/api/application/users", {
      method: "POST",
      body: JSON.stringify({
        username: cleanUsername,
        email: cleanEmail,
        first_name: cleanUsername,
        last_name: "DuckHosting",
        password: String(password),
        language: "en"
      })
    });

    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      "INSERT INTO users (username, email, password_hash, pterodactyl_user_id, ptero_password, is_admin, coins) VALUES (?, ?, ?, ?, ?, ?, 0)",
      [
        cleanUsername,
        cleanEmail,
        passwordHash,
        createdPteroUser.attributes.id,
        encryptText(String(password)),
        ADMIN_EMAIL && cleanEmail === ADMIN_EMAIL ? 1 : 0
      ]
    );

    const token = jwt.sign(
      { userId: result.insertId, email: cleanEmail },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      message: "Account created successfully",
      token,
      user: {
        id: result.insertId,
        username: cleanUsername,
        email: cleanEmail,
        is_admin: Boolean(ADMIN_EMAIL && cleanEmail === ADMIN_EMAIL),
        coins: 0
      }
    });
  } catch (error) {
    console.error("Error registering user:", error.message);

    if (createdPteroUser?.attributes?.id) {
      try {
        await pteroRequest(`/api/application/users/${createdPteroUser.attributes.id}`, {
          method: "DELETE"
        });
      } catch (cleanupError) {
        console.error("Could not clean up the Pterodactyl user:", cleanupError.message);
      }
    }

    if (error.status === 422) {
      return res.status(409).json({
        message: "The email or username already exists in Pterodactyl"
      });
    }

    if (error.message?.includes("PTERO_")) {
      return res.status(500).json({ message: error.message });
    }

    res.status(500).json({
      message: error.message || "Could not create the account"
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Enter your email and password" });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const [users] = await pool.execute(
      "SELECT id, username, email, password_hash, ptero_password, is_admin, coins, ban_reason, ban_until, suspend_reason, suspend_until FROM users WHERE email = ? LIMIT 1",
      [cleanEmail]
    );

    if (users.length === 0) {
      return res.status(401).json({ message: "Incorrect email or password" });
    }

    const user = users[0];

    // Active ban check (temporary bans with a future end date)
    if (user.ban_until && new Date(user.ban_until) > new Date()) {
      return res.status(403).json({
        message: "Account banned",
        ban: {
          reason: user.ban_reason,
          until: user.ban_until,
          type: "temporary"
        }
      });
    }

    // Permanent ban check (reason set, no end date)
    if (user.ban_until === null && user.ban_reason) {
      return res.status(403).json({
        message: "Account permanently banned",
        ban: {
          reason: user.ban_reason,
          type: "permanent"
        }
      });
    }

    // Active suspension check
    if (user.suspend_until && new Date(user.suspend_until) > new Date()) {
      return res.status(403).json({
        message: "Account suspended",
        suspend: {
          reason: user.suspend_reason,
          until: user.suspend_until
        }
      });
    }

    const passwordCorrecta = await bcrypt.compare(password, user.password_hash);

    if (!passwordCorrecta) {
      return res.status(401).json({ message: "Incorrect email or password" });
    }

    // Keep an encrypted copy of the panel password so the backend can call the
    // Pterodactyl client API (databases) on the user's behalf. Also backfills
    // accounts created before this feature existed.
    if (!user.ptero_password) {
      await pool.execute(
        "UPDATE users SET ptero_password = ? WHERE id = ?",
        [encryptText(String(password)), user.id]
      );
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Signed in successfully",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        is_admin: Boolean(user.is_admin),
        coins: Number(user.coins)
      }
    });
  } catch (error) {
    console.error("Sign-in error:", error.message);
    res.status(500).json({ message: "Could not sign in" });
  }
});

// Verifies the current session and reports active bans/suspensions.
// Returns 403 with ban/suspend details when the account is blocked.
app.get("/api/auth/me", authRequired, async (req, res) => {
  try {
    const [users] = await pool.execute(
      "SELECT id, username, email, is_admin, coins, ban_reason, ban_until, suspend_reason, suspend_until FROM users WHERE id = ? LIMIT 1",
      [req.user.userId]
    );
    if (users.length === 0) return res.status(404).json({ message: "Account not found" });
    const user = users[0];
    const now = new Date();
    const ban = user.ban_reason && ((user.ban_until && new Date(user.ban_until) > now) || (!user.ban_until && user.ban_reason))
      ? { reason: user.ban_reason, until: user.ban_until, type: user.ban_until ? "temporary" : "permanent" }
      : null;
    const suspend = user.suspend_until && new Date(user.suspend_until) > now
      ? { reason: user.suspend_reason, until: user.suspend_until }
      : null;
    if (ban || suspend) {
      return res.status(403).json({ ban, suspend });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error("Error checking auth:", error.message);
    res.status(500).json({ message: "Could not verify account" });
  }
});

app.get("/api/hosts", authRequired, async (req, res) => {
  try {
    const [hosts] = await pool.execute(
      `SELECT id, name, description, language, plan, memory_mb, disk_mb,
              pterodactyl_server_id, pterodactyl_identifier,
              pterodactyl_uuid, expires_at, created_at
       FROM hosts WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.userId]
    );

    res.json({
      hosts: hosts.map((host) => ({
        ...host,
        panel_url: `${PTERO_URL}/server/${host.pterodactyl_identifier}`,
        days_remaining: daysRemaining(host.expires_at),
        can_renew: daysRemaining(host.expires_at) <= 4 && daysRemaining(host.expires_at) > 0
      }))
    });
  } catch (error) {
    console.error("Error loading hosts:", error.message);
    res.status(500).json({ message: "Could not load hosts" });
  }
});

app.get("/api/account", authRequired, async (req, res) => {
  try {
    const [users] = await pool.execute(
      "SELECT id, username, email, is_admin, coins FROM users WHERE id = ? LIMIT 1",
      [req.user.userId]
    );
    if (users.length === 0) return res.status(404).json({ message: "Account not found" });
    res.json({ user: { ...users[0], is_admin: Boolean(users[0].is_admin), coins: Number(users[0].coins) } });
  } catch (error) {
    console.error("Error loading account:", error.message);
    res.status(500).json({ message: "Could not load balance" });
  }
});

app.post("/api/hosts", authRequired, async (req, res) => {
  let createdPteroServer = null;

  try {
    validatePterodactylConfig();
    const name = String(req.body.name || "").trim();
    const description = String(req.body.description || "").trim();
    const plan = String(req.body.plan || "free").toLowerCase();
    const language = String(req.body.language || "node").toLowerCase();
    const selectedPlan = PLAN_CONFIG[plan];

    if (!['node', 'python'].includes(language)) {
      return res.status(400).json({ message: "Invalid runtime. Choose Node.js or Python." });
    }

    if (language === "python" && !PTERO_PYTHON_EGG_ID) {
      return res.status(503).json({ message: "Python is not configured yet: PTERO_PYTHON_EGG_ID is missing from the backend." });
    }

    if (!selectedPlan) {
      return res.status(400).json({ message: "Invalid plan" });
    }

    if (name.length < 3 || name.length > 80) {
      return res.status(400).json({
        message: "Name must be between 3 and 80 characters"
      });
    }

    if (description.length > 255) {
      return res.status(400).json({ message: "Description is too long" });
    }

    const [existingHosts] = await pool.execute(
      "SELECT id, pterodactyl_user_id, coins FROM users WHERE id = ? LIMIT 1",
      [req.user.userId]
    );

    if (existingHosts.length === 0 || !existingHosts[0].pterodactyl_user_id) {
      return res.status(409).json({ message: "Your account is not linked to Pterodactyl" });
    }

    const currentCoins = Number(existingHosts[0].coins);
    if (currentCoins < selectedPlan.cost) {
      return res.status(402).json({
        message: `You need ${selectedPlan.cost} coins for the plan ${selectedPlan.label}. Current balance: ${currentCoins}`,
        coins: currentCoins,
        required_coins: selectedPlan.cost
      });
    }

    if (plan === "free") {
      const [freeHosts] = await pool.execute(
        "SELECT id FROM hosts WHERE user_id = ? AND plan = 'free' LIMIT 1",
        [req.user.userId]
      );
      if (freeHosts.length > 0) {
        return res.status(409).json({
          message: "The Free plan allows only one host. Choose Advanced or Pro to create more."
        });
      }
    }

    const allocations = await pteroRequest(
      `/api/application/nodes/${PTERO_NODE_ID}/allocations?per_page=100`
    );
    const freeAllocation = (allocations.data || []).find(
      (allocation) => allocation.attributes.assigned === false
    );

    if (!freeAllocation) {
      return res.status(503).json({ message: "No ports are available right now" });
    }

    const allocationId = freeAllocation.attributes.id;
    const runtime = language === "python"
      ? {
          nest: PTERO_PYTHON_NEST_ID,
          egg: PTERO_PYTHON_EGG_ID,
          docker_image: PTERO_PYTHON_DOCKER_IMAGE,
          startup: "if [[ -d .git ]] && [[ \"{{AUTO_UPDATE}}\" == \"1\" ]]; then git pull; fi; if [[ ! -z \"{{PY_PACKAGES}}\" ]]; then pip install -U --prefix .local {{PY_PACKAGES}}; fi; if [[ -f /home/container/${REQUIREMENTS_FILE} ]]; then pip install -U --prefix .local -r ${REQUIREMENTS_FILE}; fi; /usr/local/bin/python /home/container/{{PY_FILE}}",
          environment: {
            GIT_ADDRESS: "",
            BRANCH: "",
            USER_UPLOAD: "1",
            AUTO_UPDATE: "0",
            PY_FILE: "main.py",
            PY_PACKAGES: "",
            USERNAME: "",
            ACCESS_TOKEN: "",
            REQUIREMENTS_FILE: "requirements.txt"
          }
        }
      : {
          nest: PTERO_NEST_ID,
          egg: PTERO_NODE_EGG_ID,
          docker_image: PTERO_NODE_DOCKER_IMAGE,
          startup: "if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; /usr/local/bin/node /home/container/${MAIN_FILE} ${NODE_ARGS}",
          environment: {
            MAIN_FILE: "index.js",
            NODE_ARGS: "",
            USER_UPLOAD: "1",
            AUTO_UPDATE: "0",
            NODE_PACKAGES: "",
            UNNODE_PACKAGES: ""
          }
        };
    const serverPayload = {
      name,
      user: existingHosts[0].pterodactyl_user_id,
      nest: runtime.nest,
      egg: runtime.egg,
      docker_image: runtime.docker_image,
      startup: runtime.startup,
      environment: runtime.environment,
      limits: { memory: selectedPlan.memory, swap: 0, disk: selectedPlan.disk, io: 500, cpu: selectedPlan.cpu },
      feature_limits: { databases: selectedPlan.databases, allocations: 1, backups: plan === "free" ? 0 : 2 },
      allocation: { default: allocationId },
      description: description || null
    };

    createdPteroServer = await pteroRequest("/api/application/servers", {
      method: "POST",
      body: JSON.stringify(serverPayload)
    });

    const attributes = createdPteroServer.attributes;
    const durationDays = plan === "free" ? 10 : 30;
    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

    await pool.execute(
      `INSERT INTO hosts
       (user_id, pterodactyl_server_id, pterodactyl_identifier,
        pterodactyl_uuid, name, description, language, plan, memory_mb, disk_mb, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.userId,
        attributes.id,
        attributes.identifier,
        attributes.uuid,
        name,
        description || null,
        language,
        plan,
        selectedPlan.memory,
        selectedPlan.disk,
        expiresAt
      ]
    );

    if (selectedPlan.cost > 0) {
      await pool.execute("UPDATE users SET coins = coins - ? WHERE id = ?", [selectedPlan.cost, req.user.userId]);
    }

    res.status(201).json({
      message: "Host created successfully",
      host: {
        id: attributes.id,
        name,
        description,
        language,
        plan,
        memory_mb: selectedPlan.memory,
        disk_mb: selectedPlan.disk,
        cpu_percent: selectedPlan.cpu,
        cost: selectedPlan.cost,
        coins_remaining: currentCoins - selectedPlan.cost,
        expires_at: expiresAt,
        panel_url: `${PTERO_URL}/server/${attributes.identifier}`
      }
    });
  } catch (error) {
    console.error("Error creating host:", error.message);

    if (createdPteroServer?.attributes?.id) {
      try {
        await pteroRequest(`/api/application/servers/${createdPteroServer.attributes.id}`, {
          method: "DELETE"
        });
      } catch (cleanupError) {
        console.error("No se pudo limpiar el servidor creado:", cleanupError.message);
      }
    }

    res.status(error.status || 500).json({
      message: error.message || "Could not create the host"
    });
  }
});

app.post("/api/hosts/:id/renew", authRequired, async (req, res) => {
  try {
    const hostId = Number(req.params.id);
    const [rows] = await pool.execute(
      "SELECT id, expires_at FROM hosts WHERE id = ? AND user_id = ? LIMIT 1",
      [hostId, req.user.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Host not found" });
    }

    const remaining = daysRemaining(rows[0].expires_at);
    if (remaining > 4 || remaining <= 0) {
      return res.status(400).json({
        message: "A host can only be renewed when 4 days or less remain"
      });
    }

    const [[host]] = await pool.execute(
      "SELECT plan FROM hosts WHERE id = ? AND user_id = ? LIMIT 1",
      [hostId, req.user.userId]
    );
    const renewalCost = PLAN_CONFIG[host?.plan]?.cost ?? 0;

    if (renewalCost > 0) {
      const [[user]] = await pool.execute("SELECT coins FROM users WHERE id = ? LIMIT 1", [req.user.userId]);
      if (!user || Number(user.coins) < renewalCost) {
        return res.status(402).json({
          message: `You need ${renewalCost} coins to renew the ${host?.plan || "host"} plan. Buy more coins to renew.`,
          coins: Number(user?.coins || 0)
        });
      }
      await pool.execute("UPDATE users SET coins = coins - ? WHERE id = ?", [renewalCost, req.user.userId]);
    }

    const expiresAt = new Date(Date.now() + (renewalCost > 0 ? 30 : 10) * 86400000);
    await pool.execute(
      "UPDATE hosts SET expires_at = ? WHERE id = ? AND user_id = ?",
      [expiresAt, hostId, req.user.userId]
    );

    res.json({
      message: renewalCost > 0
        ? `Host renewed for 30 days. ${renewalCost} coins deducted.`
        : "Host renewed for 10 days.",
      expires_at: expiresAt,
      days_remaining: renewalCost > 0 ? 30 : 10,
      can_renew: false
    });
  } catch (error) {
    console.error("Error renewing host:", error.message);
    res.status(500).json({ message: "Could not renew the host" });
  }
});

/* ---------- Host databases (Pterodactyl client API, acting as the user) ---------- */

app.get("/api/hosts/:id/databases", authRequired, async (req, res) => {
  try {
    const host = await getOwnedHost(req.user.userId, req.params.id);
    if (!host) return res.status(404).json({ message: "Host not found" });

    const userRow = await getHostUserRow(req.user.userId);
    if (!userRow || !userRow.ptero_password) {
      return res.status(400).json({ message: "Sign out and sign in again to enable database management." });
    }

    const list = await pteroClientRequest(userRow, "GET", `/api/servers/${host.pterodactyl_identifier}/databases`);

    res.json({
      databases: (list?.data || []).map((item) => ({
        id: item.id,
        name: item.attributes?.database,
        username: item.attributes?.username,
        remote: item.attributes?.remote,
        created_at: item.attributes?.created_at
      })),
      limit: PLAN_CONFIG[host.plan]?.databases ?? 0
    });
  } catch (error) {
    console.error("Error loading databases:", error.message);
    res.status(error.status || 500).json({ message: error.message || "Could not load databases" });
  }
});

app.post("/api/hosts/:id/databases", authRequired, async (req, res) => {
  try {
    const host = await getOwnedHost(req.user.userId, req.params.id);
    if (!host) return res.status(404).json({ message: "Host not found" });

    const userRow = await getHostUserRow(req.user.userId);
    if (!userRow || !userRow.ptero_password) {
      return res.status(400).json({ message: "Sign out and sign in again to enable database management." });
    }

    const planLimit = PLAN_CONFIG[host.plan]?.databases ?? 0;
    if (planLimit <= 0) {
      return res.status(403).json({ message: "Your plan does not include databases." });
    }

    const name = String(req.body?.name || "").trim();
    if (!/^[A-Za-z0-9_]{3,48}$/.test(name)) {
      return res.status(400).json({ message: "Database name must be 3-48 characters: letters, numbers and underscores only." });
    }

    const remote = String(req.body?.remote || "").trim() || "%";

    const list = await pteroClientRequest(userRow, "GET", `/api/servers/${host.pterodactyl_identifier}/databases`);
    const current = (list?.data || []).length;
    if (current >= planLimit) {
      return res.status(403).json({ message: `Your plan allows up to ${planLimit} database${planLimit === 1 ? "" : "s"}. Delete one to create another.` });
    }

    const created = await pteroClientRequest(userRow, "POST", `/api/servers/${host.pterodactyl_identifier}/databases`, {
      database: name,
      remote
    });

    const attrs = created?.data?.attributes || {};
    res.json({
      message: "Database created successfully",
      database: { id: created?.data?.id, name: attrs.database, username: attrs.username, remote: attrs.remote },
      password: attrs.password || ""
    });
  } catch (error) {
    console.error("Error creating database:", error.message);
    res.status(error.status || 500).json({ message: error.message || "Could not create the database" });
  }
});

app.delete("/api/hosts/:id/databases/:databaseId", authRequired, async (req, res) => {
  try {
    const host = await getOwnedHost(req.user.userId, req.params.id);
    if (!host) return res.status(404).json({ message: "Host not found" });

    const userRow = await getHostUserRow(req.user.userId);
    if (!userRow || !userRow.ptero_password) {
      return res.status(400).json({ message: "Sign out and sign in again to enable database management." });
    }

    await pteroClientRequest(userRow, "DELETE", `/api/servers/${host.pterodactyl_identifier}/databases/${Number(req.params.databaseId)}`);
    res.json({ message: "Database deleted successfully" });
  } catch (error) {
    console.error("Error deleting database:", error.message);
    res.status(error.status || 500).json({ message: error.message || "Could not delete the database" });
  }
});

app.post("/api/hosts/:id/databases/:databaseId/reset", authRequired, async (req, res) => {
  try {
    const host = await getOwnedHost(req.user.userId, req.params.id);
    if (!host) return res.status(404).json({ message: "Host not found" });

    const userRow = await getHostUserRow(req.user.userId);
    if (!userRow || !userRow.ptero_password) {
      return res.status(400).json({ message: "Sign out and sign in again to enable database management." });
    }

    const updated = await pteroClientRequest(userRow, "POST", `/api/servers/${host.pterodactyl_identifier}/databases/${Number(req.params.databaseId)}/reset-password`);
    const attrs = updated?.data?.attributes || {};
    res.json({
      message: "Database password reset",
      password: attrs.password || ""
    });
  } catch (error) {
    console.error("Error resetting database password:", error.message);
    res.status(error.status || 500).json({ message: error.message || "Could not reset the database password" });
  }
});

app.post("/api/auth/change-password", authRequired, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword || String(newPassword).length < 8) {
      return res.status(400).json({
        message: "New password must be at least 8 characters"
      });
    }

    const [users] = await pool.execute(
      "SELECT password_hash, pterodactyl_user_id FROM users WHERE id = ? LIMIT 1",
      [req.user.userId]
    );
    if (users.length === 0 || !(await bcrypt.compare(currentPassword, users[0].password_hash))) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    await pteroRequest(`/api/application/users/${users[0].pterodactyl_user_id}`, {
      method: "PATCH",
      body: JSON.stringify({ password: String(newPassword) })
    });

    const passwordHash = await bcrypt.hash(String(newPassword), 12);
    await pool.execute(
      "UPDATE users SET password_hash = ?, ptero_password = ? WHERE id = ?",
      [passwordHash, encryptText(String(newPassword)), req.user.userId]
    );
    pteroSessions.delete(req.user.userId);

    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error changing password:", error.message);
    res.status(error.status || 500).json({ message: "Could not change the password" });
  }
});

app.delete("/api/hosts/:id", authRequired, async (req, res) => {
  try {
    const hostId = Number(req.params.id);
    const [rows] = await pool.execute(
      "SELECT pterodactyl_server_id FROM hosts WHERE id = ? AND user_id = ? LIMIT 1",
      [hostId, req.user.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Host not found" });
    }

    await pteroRequest(`/api/application/servers/${rows[0].pterodactyl_server_id}`, {
      method: "DELETE"
    });
    await pool.execute("DELETE FROM hosts WHERE id = ? AND user_id = ?", [hostId, req.user.userId]);

    res.json({ message: "Host deleted successfully" });
  } catch (error) {
    console.error("Error deleting host:", error.message);
    res.status(error.status || 500).json({ message: error.message || "Could not delete the host" });
  }
});

app.get("/api/admin/users", authRequired, adminRequired, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 10;
    const offset = (page - 1) * limit;
    const [[count]] = await pool.query("SELECT COUNT(*) AS total FROM users");
    const [users] = await pool.execute(
      `SELECT id, username, email, is_admin, coins, created_at,
              ban_reason, ban_until, banned_by, banned_at,
              suspend_reason, suspend_until, suspended_by, suspended_at
       FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    res.json({
      users: users.map((user) => {
        const now = new Date();
        const banActive = Boolean(user.ban_reason) && (!user.ban_until || new Date(user.ban_until) > now);
        const suspendActive = Boolean(user.suspend_until) && new Date(user.suspend_until) > now;
        return {
          ...user,
          password_masked: "***********",
          coins: Number(user.coins),
          banned: banActive ? (user.ban_until ? "temporary" : "permanent") : false,
          ban_reason: user.ban_reason,
          ban_until: user.ban_until,
          banned_by: user.banned_by,
          banned_at: user.banned_at,
          suspended: suspendActive,
          suspend_reason: user.suspend_reason,
          suspend_until: user.suspend_until,
          suspended_by: user.suspended_by,
          suspended_at: user.suspended_at
        };
      }),
      page,
      per_page: limit,
      total: Number(count.total),
      total_pages: Math.max(1, Math.ceil(Number(count.total) / limit))
    });
  } catch (error) {
    console.error("Error listing users:", error.message);
    res.status(500).json({ message: "Could not load users" });
  }
});

app.post("/api/admin/users/:id/coins", authRequired, adminRequired, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const amount = Math.floor(Number(req.body.amount));
    const operation = req.body.operation === "remove" ? "remove" : "add";
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ message: "Amount must be a whole number greater than zero" });
    }

    const [users] = await pool.execute("SELECT id, coins FROM users WHERE id = ? LIMIT 1", [userId]);
    if (users.length === 0) return res.status(404).json({ message: "User not found" });
    if (operation === "remove" && Number(users[0].coins) < amount) {
      return res.status(400).json({ message: "User does not have enough coins to remove" });
    }

    const query = operation === "add"
      ? "UPDATE users SET coins = coins + ? WHERE id = ?"
      : "UPDATE users SET coins = coins - ? WHERE id = ?";
    await pool.execute(query, [amount, userId]);
    const [[updated]] = await pool.query("SELECT coins FROM users WHERE id = ?", [userId]);
    res.json({ message: operation === "add" ? "Coins added" : "Coins removed", coins: Number(updated.coins) });
  } catch (error) {
    console.error("Error managing coins:", error.message);
    res.status(500).json({ message: "Could not update coins" });
  }
});

app.post("/api/admin/users/:id/reset-password", authRequired, adminRequired, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const newPassword = String(req.body.newPassword || "");
    if (newPassword.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const [users] = await pool.execute(
      "SELECT pterodactyl_user_id FROM users WHERE id = ? LIMIT 1",
      [userId]
    );
    if (users.length === 0) return res.status(404).json({ message: "User not found" });

    await pteroRequest(`/api/application/users/${users[0].pterodactyl_user_id}`, {
      method: "PATCH",
      body: JSON.stringify({ password: newPassword })
    });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.execute(
      "UPDATE users SET password_hash = ?, ptero_password = ? WHERE id = ?",
      [passwordHash, encryptText(newPassword), userId]
    );
    pteroSessions.delete(userId);
    res.json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Error resetting admin password:", error.message);
    res.status(error.status || 500).json({ message: "Could not reset the password" });
  }
});

app.delete("/api/admin/users/:id", authRequired, adminRequired, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (userId === req.user.userId) {
      return res.status(400).json({ message: "You cannot delete your own account here" });
    }

    const [users] = await pool.execute(
      "SELECT pterodactyl_user_id FROM users WHERE id = ? LIMIT 1",
      [userId]
    );
    if (users.length === 0) return res.status(404).json({ message: "User not found" });

    const [hosts] = await pool.execute(
      "SELECT pterodactyl_server_id FROM hosts WHERE user_id = ?",
      [userId]
    );
    for (const host of hosts) {
      try {
        await pteroRequest(`/api/application/servers/${host.pterodactyl_server_id}`, { method: "DELETE" });
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }

    try {
      await pteroRequest(`/api/application/users/${users[0].pterodactyl_user_id}`, { method: "DELETE" });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    await pool.execute("DELETE FROM users WHERE id = ?", [userId]);
    res.json({ message: "Account deleted successfully" });
  } catch (error) {
    console.error("Error deleting account:", error.message);
    res.status(error.status || 500).json({ message: "Could not delete the account" });
  }
});

app.post("/api/admin/users/:id/ban", authRequired, adminRequired, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { reason, type = "permanent", until } = req.body;

    if (userId === req.user.userId) {
      return res.status(400).json({ message: "You cannot ban yourself" });
    }

    const [users] = await pool.execute(
      "SELECT id, username, email, is_admin, ban_reason, ban_until FROM users WHERE id = ? LIMIT 1",
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    if (users[0].is_admin) {
      return res.status(403).json({ message: "Cannot ban an administrator" });
    }

    let banUntil = null;
    if (type === "temporary" && until) {
      banUntil = new Date(until);
      if (banUntil <= new Date()) {
        return res.status(400).json({ message: "Ban end date must be in the future" });
      }
    }

    await pool.execute(
      "UPDATE users SET ban_reason = ?, ban_until = ?, banned_by = ?, banned_at = NOW() WHERE id = ?",
      [reason || null, banUntil, req.user.userId, userId]
    );

    const targetUser = users[0];
    const message = type === "temporary"
      ? `User ${targetUser.username} temporarily banned until ${banUntil.toLocaleString()}`
      : `User ${targetUser.username} permanently banned`;

    res.json({ message, ban: { reason, type, until: banUntil } });
  } catch (error) {
    console.error("Error banning user:", error.message);
    res.status(500).json({ message: error.message || "Could not ban user" });
  }
});

app.post("/api/admin/users/:id/unban", authRequired, adminRequired, async (req, res) => {
  try {
    const userId = Number(req.params.id);

    const [users] = await pool.execute(
      "SELECT id, username FROM users WHERE id = ? LIMIT 1",
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    await pool.execute(
      "UPDATE users SET ban_reason = NULL, ban_until = NULL, banned_by = NULL, banned_at = NULL WHERE id = ?",
      [userId]
    );

    res.json({ message: `User ${users[0].username} has been unbanned` });
  } catch (error) {
    console.error("Error unbanning user:", error.message);
    res.status(500).json({ message: "Could not unban user" });
  }
});

app.post("/api/admin/users/:id/suspend", authRequired, adminRequired, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { reason, until } = req.body;

    if (userId === req.user.userId) {
      return res.status(400).json({ message: "You cannot suspend yourself" });
    }

    const [users] = await pool.execute(
      "SELECT id, username, email, is_admin, suspend_reason, suspend_until FROM users WHERE id = ? LIMIT 1",
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    if (users[0].is_admin) {
      return res.status(403).json({ message: "Cannot suspend an administrator" });
    }

    if (!until) {
      return res.status(400).json({ message: "Suspension end date is required" });
    }

    const suspendUntil = new Date(until);
    if (suspendUntil <= new Date()) {
      return res.status(400).json({ message: "Suspension end date must be in the future" });
    }

    await pool.execute(
      "UPDATE users SET suspend_reason = ?, suspend_until = ?, suspended_by = ?, suspended_at = NOW() WHERE id = ?",
      [reason || null, suspendUntil, req.user.userId, userId]
    );

    res.json({
      message: `User ${users[0].username} suspended until ${suspendUntil.toLocaleString()}`,
      suspend: { reason, until: suspendUntil }
    });
  } catch (error) {
    console.error("Error suspending user:", error.message);
    res.status(500).json({ message: error.message || "Could not suspend user" });
  }
});

app.post("/api/admin/users/:id/unsuspend", authRequired, adminRequired, async (req, res) => {
  try {
    const userId = Number(req.params.id);

    const [users] = await pool.execute(
      "SELECT id, username FROM users WHERE id = ? LIMIT 1",
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    await pool.execute(
      "UPDATE users SET suspend_reason = NULL, suspend_until = NULL, suspended_by = NULL, suspended_at = NULL WHERE id = ?",
      [userId]
    );

    res.json({ message: `User ${users[0].username} suspension lifted` });
  } catch (error) {
    console.error("Error unsuspending user:", error.message);
    res.status(500).json({ message: "Could not lift suspension" });
  }
});

const COIN_PACKAGES_BY_LINK = {
  wdYvP2: { coins: 8 },
  vzTMkn: { coins: 15 },
  mZNDgt: { coins: 20 }
};

app.get("/api/payments/verify/:id", authRequired, async (req, res) => {
  try {
    if (!WOMPI_PUBLIC_KEY) {
      return res.status(503).json({ message: "Wompi is not configured on the server" });
    }

    const response = await fetch(`https://production.wompi.co/v1/transactions/${req.params.id}`, {
      headers: { Authorization: `Bearer ${WOMPI_PUBLIC_KEY}` }
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(400).json({ message: "Invalid transaction" });
    }

    const tx = data.data;
    if (tx.status !== "APPROVED") {
      return res.status(400).json({ message: `Payment status: ${tx.status}` });
    }

    const referencePrefix = String(tx.reference || "").split("_")[0];
    const packageInfo = COIN_PACKAGES_BY_LINK[referencePrefix];
    if (!packageInfo) {
      return res.status(400).json({ message: `Purchase reference does not match any coin package: ${tx.reference}` });
    }

    await pool.execute("UPDATE users SET coins = coins + ? WHERE id = ?", [packageInfo.coins, req.user.userId]);
    const [[updated]] = await pool.execute("SELECT coins FROM users WHERE id = ? LIMIT 1", [req.user.userId]);

    res.json({
      message: `Payment approved. You received ${packageInfo.coins} coins.`,
      coins: Number(updated.coins)
    });
  } catch (error) {
    console.error("Error verifying payment:", error.message);
    res.status(500).json({ message: "Could not verify the payment" });
  }
});

/* ---------- Support mail (contact support form) ---------- */

// Simple anti-spam: max 5 messages per IP every 10 minutes
const mailHits = new Map();
const MAIL_LIMIT = 5;
const MAIL_WINDOW_MS = 10 * 60 * 1000;

function mailRateLimited(ip) {
  const now = Date.now();
  const hits = (mailHits.get(ip) || []).filter((t) => now - t < MAIL_WINDOW_MS);
  if (hits.length >= MAIL_LIMIT) {
    mailHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  mailHits.set(ip, hits);
  return false;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SUPPORT_TYPES = [
  "General question",
  "Host issue",
  "Billing & coins",
  "Bug report",
  "Account issue",
  "Discord bot",
  "Database issue",
  "Other"
];

app.post("/api/support/mail", async (req, res) => {
  try {
    const { type, title, message, email } = req.body || {};

    // Every field is required now (email included)
    if (!type || !title || !message || !email) {
      return res.status(400).json({ message: "Complete all fields, including your email" });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(cleanEmail)) {
      return res.status(400).json({ message: "Enter a valid email address so we can reply to you" });
    }

    const cleanTitle = String(title).trim().slice(0, 120);
    const cleanMessage = String(message).trim().slice(0, 4000);
    const cleanType = SUPPORT_TYPES.includes(type) ? type : "Other";

    if (cleanTitle.length < 3) {
      return res.status(400).json({ message: "The title must be at least 3 characters" });
    }
    if (cleanMessage.length < 10) {
      return res.status(400).json({ message: "Please describe your problem with a bit more detail" });
    }

    if (mailRateLimited(req.ip || req.socket?.remoteAddress || "unknown")) {
      return res.status(429).json({ message: "Too many messages sent. Please try again in a few minutes." });
    }

    const smtpHost = process.env.SMTP_HOST || "smtp.hostinger.com";
    const smtpPort = Number(process.env.SMTP_PORT || 465);
    const smtpUser = process.env.SMTP_USER || "supportteam@duck-hosting.lat";
    const smtpPass = process.env.SMTP_PASS || "";
    const toEmail = process.env.SUPPORT_EMAIL || "supportteam@duck-hosting.lat";

    if (!smtpPass) {
      console.error("SMTP_PASS is not configured in the backend environment");
      return res.status(500).json({ message: "Email service not configured yet. Please contact us on Discord." });
    }

    // Lazy import: a missing nodemailer package must not take the whole API down
    let nodemailer;
    try {
      const mod = await import("nodemailer");
      nodemailer = mod.default || mod;
    } catch {
      console.error("nodemailer package is not installed. Run: npm install nodemailer");
      return res.status(500).json({ message: "Email service not available yet. Please contact us on Discord." });
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass }
    });

    await transporter.verify().catch((verifyError) => {
      console.error("SMTP verify failed:", verifyError.message);
    });

    const ticketId = `DH-${Date.now().toString(36).toUpperCase().slice(-6)}`;

    const html = `
      <div style="margin:0;padding:24px;background:#080808;font-family:'Segoe UI',Arial,sans-serif;">
        <div style="max-width:640px;margin:0 auto;border:1px solid #302d25;border-radius:16px;overflow:hidden;background:#14130f;">

          <div style="padding:22px 26px;border-bottom:1px solid #302d25;background:linear-gradient(135deg,#1b180e,#14130f);">
            <div style="color:#ffc107;font-size:11px;font-weight:700;letter-spacing:1.6px;">DUCKHOSTING SUPPORT</div>
            <div style="color:#fffdf2;font-size:22px;font-weight:700;margin-top:6px;">New support ticket</div>
            <div style="color:#8e897b;font-size:12px;margin-top:4px;">Ticket ${ticketId}</div>
          </div>

          <div style="padding:26px;">
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr>
                <td style="padding:10px 0;color:#77736a;font-size:11px;font-weight:700;letter-spacing:1.2px;width:120px;vertical-align:top;">CATEGORY</td>
                <td style="padding:10px 0;color:#ffc107;font-weight:700;">${escapeHtml(cleanType)}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:#77736a;font-size:11px;font-weight:700;letter-spacing:1.2px;vertical-align:top;">SUBJECT</td>
                <td style="padding:10px 0;color:#fffdf2;font-weight:700;">${escapeHtml(cleanTitle)}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:#77736a;font-size:11px;font-weight:700;letter-spacing:1.2px;vertical-align:top;">REPLY TO</td>
                <td style="padding:10px 0;color:#8fd3ef;">${escapeHtml(cleanEmail)}</td>
              </tr>
            </table>

            <div style="margin-top:18px;padding:16px;border:1px solid #302d25;border-radius:12px;background:#0d0d0b;">
              <div style="color:#77736a;font-size:11px;font-weight:700;letter-spacing:1.2px;margin-bottom:8px;">MESSAGE</div>
              <div style="color:#e9e3cf;font-size:14px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(cleanMessage)}</div>
            </div>

            <div style="margin-top:20px;padding:14px 16px;border-left:3px solid #ffc107;border-radius:8px;background:rgba(255,193,7,.08);">
              <div style="color:#ffc107;font-size:12px;font-weight:700;">Reply directly to this email</div>
              <div style="color:#8e897b;font-size:12px;margin-top:3px;">The answer will be sent to ${escapeHtml(cleanEmail)}</div>
            </div>
          </div>

          <div style="padding:16px 26px;border-top:1px solid #302d25;color:#6b675c;font-size:11px;">
            Sent from duck-hosting.lat/support/mail &middot; ${new Date().toUTCString()}
          </div>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: `"DuckHosting Support" <${smtpUser}>`,
      to: toEmail,
      replyTo: `"${escapeHtml(cleanEmail)}" <${cleanEmail}>`,
      subject: `[${cleanType}] ${cleanTitle} — ${ticketId}`,
      text: `Category: ${cleanType}\nSubject: ${cleanTitle}\nFrom: ${cleanEmail}\n\n${cleanMessage}`,
      html
    });

    // ---------------------------------------------------------------
    // Automatic confirmation sent to the user's own email address.
    // It must never break the ticket registration, so it has its own try/catch.
    // ---------------------------------------------------------------
    const userHtml = `
      <div style="margin:0;padding:24px;background:#080808;font-family:'Segoe UI',Arial,sans-serif;">
        <div style="max-width:600px;margin:0 auto;border:1px solid #302d25;border-radius:16px;overflow:hidden;background:#14130f;">

          <div style="padding:22px 26px;border-bottom:1px solid #302d25;background:linear-gradient(135deg,#1b180e,#14130f);">
            <div style="color:#ffc107;font-size:11px;font-weight:700;letter-spacing:1.6px;">DUCKHOSTING SUPPORT</div>
            <div style="color:#fffdf2;font-size:22px;font-weight:700;margin-top:6px;">We received your message</div>
            <div style="color:#8e897b;font-size:12px;margin-top:4px;">Ticket ${ticketId}</div>
          </div>

          <div style="padding:26px;">
            <p style="color:#fffdf2;font-size:14px;line-height:1.7;margin:0 0 16px;">
              Hello <strong>${escapeHtml(cleanEmail)}</strong>, your message is now
              <strong style="color:#ffc107;">under review</strong>.
            </p>

            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr>
                <td style="padding:9px 0;color:#77736a;font-size:11px;font-weight:700;letter-spacing:1.2px;width:120px;vertical-align:top;">CATEGORY</td>
                <td style="padding:9px 0;color:#ffc107;font-weight:700;">${cleanType}</td>
              </tr>
              <tr>
                <td style="padding:9px 0;color:#77736a;font-size:11px;font-weight:700;letter-spacing:1.2px;vertical-align:top;">SUBJECT</td>
                <td style="padding:9px 0;color:#fffdf2;font-weight:700;">${escapeHtml(cleanTitle)}</td>
              </tr>
              <tr>
                <td style="padding:9px 0;color:#77736a;font-size:11px;font-weight:700;letter-spacing:1.2px;vertical-align:top;">STATUS</td>
                <td style="padding:9px 0;color:#8fd3ef;font-weight:700;">In review</td>
              </tr>
            </table>

            <div style="margin-top:18px;padding:16px;border:1px solid #302d25;border-radius:12px;background:#0d0d0b;">
              <div style="color:#77736a;font-size:11px;font-weight:700;letter-spacing:1.2px;margin-bottom:8px;">YOUR MESSAGE</div>
              <div style="color:#e9e3cf;font-size:14px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(cleanMessage)}</div>
            </div>

            <div style="margin-top:20px;padding:14px 16px;border-left:3px solid #ffc107;border-radius:8px;background:rgba(255,193,7,.08);">
              <div style="color:#ffc107;font-size:12px;font-weight:700;">What happens next?</div>
              <div style="color:#8e897b;font-size:12px;margin-top:3px;">
                Our team will reply to this email as soon as possible. You do not need to send the message again.
              </div>
            </div>
          </div>

          <div style="padding:16px 26px;border-top:1px solid #302d25;color:#6b675c;font-size:11px;">
            DuckHosting &middot; https://duck-hosting.lat
          </div>
        </div>
      </div>
    `;

    try {
      await transporter.sendMail({
        from: `"DuckHosting Support" <${smtpUser}>`,
        to: cleanEmail,
        subject: `✅ Your message is under review — ${ticketId}`,
        text:
          `Hello ${cleanEmail},\n\n` +
          `We received your message and it is already under review.\n\n` +
          `Ticket: ${ticketId}\n` +
          `Category: ${cleanType}\n` +
          `Subject: ${cleanTitle}\n\n` +
          `Our team will reply to this email shortly.\n\n` +
          `DuckHosting Team`,
        html: userHtml
      });
    } catch (confirmError) {
      // The ticket is already registered — a failed auto-reply must not break the request
      console.error("Confirmation email could not be sent:", confirmError.message);
    }

    res.json({
      ok: true,
      ticket: ticketId,
      message: "Your message was sent. We will reply to your email shortly."
    });
  } catch (error) {
    console.error("Error sending support email:", error.message);
    res.status(500).json({ message: "Could not send the message. Please try again or contact us on Discord." });
  }
});

app.listen(PORT, () => {
  console.log(`Backend activo en http://localhost:${PORT}`);
  cleanupExpiredHosts();
  setInterval(cleanupExpiredHosts, 60 * 60 * 1000);
});
