"use strict";

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const dns = require("dns");
// Render free instances have no outbound IPv6; prefer IPv4 so Gmail SMTP (465) connects
dns.setDefaultResultOrder("ipv4first");
const { query, initSchema } = require("./db");
const mailer = require("./mailer");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TOKEN_SECRET = process.env.TOKEN_SECRET || "dev-secret";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const DEFAULT_PASSWORD = "Welcome";

/* ------------------------------ auth helpers ------------------------------ */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const calc = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(calc, "hex"), Buffer.from(hash, "hex"));
}

function signToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ username: user.username, role: user.role, exp: Date.now() + TOKEN_TTL_MS })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (Date.now() > data.exp) return null;
  return { username: data.username, role: data.role };
}

async function loadUser(username) {
  const r = await query("SELECT username, name, role FROM app_users WHERE username = $1", [username]);
  return r.rows[0] || null;
}

function auth(adminOnly = false) {
  return async (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: "Not authenticated" });
    const user = await loadUser(payload.username);
    if (!user) return res.status(401).json({ error: "User no longer exists" });
    req.user = user;
    if (adminOnly && user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    next();
  };
}

const asyncWrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* --------------------------- task notification emails --------------------------- */

function lookupUser(username) {
  if (!username) return Promise.resolve(null);
  return query("SELECT username, name, email FROM app_users WHERE username = $1", [username]).then((r) => r.rows[0] || null);
}

function taskLink(task) {
  return `${mailer.appUrl()}/app.html?task=${encodeURIComponent(task.id)}`;
}

function notifyAssigned(task, assignerName) {
  if (!task.assigned_to) return;
  lookupUser(task.assigned_to).then((u) => {
    if (!u || !u.email) {
      console.log(`[notify] no email for ${task.assigned_to} — assignment email skipped`);
      return;
    }
    const due = task.due_date ? `Due: <b>${task.due_date}</b>` : "No due date set";
    const subject = `New task assigned to you — ${task.task_code} · ${task.title}`;
    mailer
      .send({
        to: u.email,
        subject,
        html: mailer.wrap(`
          <h2 style="margin:0 0 8px;font-size:19px">Hey ${mailer.esc(u.name)},</h2>
          <p style="margin:0 0 18px;color:#475569;line-height:1.6">${mailer.esc(assignerName || "A teammate")} has assigned a new task to you. It's waiting for you in ZITA PLM.</p>
          <table style="width:100%;border-collapse:collapse;font-size:13.5px;margin-bottom:18px">
            <tr><td style="padding:6px 0;color:#64748b;width:110px">Task</td><td style="padding:6px 0"><b>${mailer.esc(task.task_code)}</b> · ${mailer.esc(task.title)}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Type</td><td style="padding:6px 0">${mailer.esc(task.task_type || "—")}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Priority</td><td style="padding:6px 0">${mailer.esc(task.priority)}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Due</td><td style="padding:6px 0">${due}</td></tr>
          </table>
          <p style="margin:0 0 22px;color:#475569;line-height:1.6">Small steps every day add up to big results — dive in whenever you're ready. 💪</p>
          <a href="${mailer.esc(taskLink(task))}" style="display:inline-block;background:#4338ca;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px">Open task →</a>
          <p style="font-size:12px;color:#94a3b8;margin-top:16px">If the button doesn't work, open this link: ${mailer.esc(taskLink(task))}</p>
        `),
      })
      .catch((e) => console.error("[notify] assignment email failed", e.message));
  }).catch((e) => console.error("[notify] user lookup failed", e.message));
}

function notifyCompleted(task, completerName) {
  const creator = task.created_by || task.assigned_by;
  if (!creator) return;
  lookupUser(creator).then((u) => {
    if (!u || !u.email) {
      console.log(`[notify] no email for ${creator} — completion email skipped`);
      return;
    }
    const subject = `Task completed — ${task.task_code} · ${task.title}`;
    mailer
      .send({
        to: u.email,
        subject,
        html: mailer.wrap(`
          <h2 style="margin:0 0 8px;font-size:19px">Hey ${mailer.esc(u.name)},</h2>
          <p style="margin:0 0 18px;color:#475569;line-height:1.6">${mailer.esc(completerName || "A team member")} has marked your task <b>${mailer.esc(task.task_code)} · ${mailer.esc(task.title)}</b> as <b>Completed</b> ✅. Great work — one more off the list!</p>
          <a href="${mailer.esc(taskLink(task))}" style="display:inline-block;background:#4338ca;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px">View task →</a>
          <p style="font-size:12px;color:#94a3b8;margin-top:16px">If the button doesn't work, open this link: ${mailer.esc(taskLink(task))}</p>
        `),
      })
      .catch((e) => console.error("[notify] completion email failed", e.message));
  }).catch((e) => console.error("[notify] user lookup failed", e.message));
}

/* --------------------------------- routes --------------------------------- */

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// login
app.post(
  "/api/login",
  asyncWrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Username and password are required" });
    const r = await query("SELECT * FROM app_users WHERE username = $1", [username.trim()]);
    const row = r.rows[0];
    if (!row || !verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const user = { username: row.username, name: row.name, role: row.role, must_change_password: row.must_change_password };
    if (row.must_change_password) {
      const check = verifyPassword(DEFAULT_PASSWORD, row.password_hash);
      user.using_default_password = check;
    }
    res.json({ token: signToken(user), user });
  })
);

// me
app.get(
  "/api/me",
  auth(),
  asyncWrap(async (req, res) => res.json(req.user))
);

// users
app.get(
  "/api/users",
  auth(),
  asyncWrap(async (req, res) => {
    const r = await query("SELECT username, name, email, role, must_change_password, created_at FROM app_users ORDER BY name");
    res.json(r.rows);
  })
);

app.post(
  "/api/users",
  auth(true),
  asyncWrap(async (req, res) => {
    const { username, name, role, email } = req.body || {};
    if (!username || !name) return res.status(400).json({ error: "username and name are required" });
    const uname = String(username).trim().toUpperCase();
    const r = await query("SELECT 1 FROM app_users WHERE username = $1", [uname]);
    if (r.rowCount) return res.status(409).json({ error: "User already exists" });
    await query("INSERT INTO app_users (username, name, email, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,TRUE)", [
      uname,
      name.trim(),
      String(email || "").trim(),
      role === "admin" ? "admin" : "user",
      hashPassword(DEFAULT_PASSWORD),
    ]);
    res.status(201).json({ username: uname, name: name.trim(), email: String(email || "").trim(), role: role === "admin" ? "admin" : "user", must_change_password: true });
  })
);

app.delete(
  "/api/users/:username",
  auth(true),
  asyncWrap(async (req, res) => {
    const uname = String(req.params.username).toUpperCase();
    if (uname === "ADMIN") return res.status(400).json({ error: "Cannot delete the ADMIN account" });
    await query("DELETE FROM app_users WHERE username = $1", [uname]);
    res.json({ ok: true });
  })
);

app.patch(
  "/api/users/:username",
  auth(true),
  asyncWrap(async (req, res) => {
    const { name, role, password, email } = req.body || {};
    const uname = String(req.params.username).toUpperCase();
    const fields = [];
    const params = [];
    if (name) { params.push(name.trim()); fields.push(`name = $${params.length}`); }
    if (role) { params.push(role === "admin" ? "admin" : "user"); fields.push(`role = $${params.length}`); }
    if ("email" in req.body) { params.push(String(email || "").trim()); fields.push(`email = $${params.length}`); }
    if (password) {
      params.push(hashPassword(password));
      fields.push(`password_hash = $${params.length}`);
      params.push(true);
      fields.push(`must_change_password = $${params.length}`);
    }
    if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
    params.push(uname);
    const r = await query(`UPDATE app_users SET ${fields.join(", ")} WHERE username = $${params.length}`, params);
    if (!r.rowCount) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true });
  })
);

// change my own password (used on first sign-in with the default password)
app.post(
  "/api/me/password",
  auth(),
  asyncWrap(async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: "Current and new password are required" });
    }
    if (String(new_password).length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }
    const row = await query("SELECT * FROM app_users WHERE username = $1", [req.user.username]);
    if (!row.rowCount || !verifyPassword(current_password, row.rows[0].password_hash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    await query("UPDATE app_users SET password_hash = $1, must_change_password = FALSE WHERE username = $2", [
      hashPassword(new_password),
      req.user.username,
    ]);
    const user = { username: req.user.username, name: req.user.name, role: req.user.role, must_change_password: false };
    res.json({ ok: true, user });
  })
);

// tasks
async function nextTaskCode() {
  const r = await query("SELECT task_code FROM tasks");
  let max = 0;
  for (const row of r.rows) {
    const m = /(\d+)$/.exec(row.task_code || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `TSK-${String(max + 1).padStart(4, "0")}`;
}

app.get(
  "/api/tasks/next-code",
  auth(),
  asyncWrap(async (req, res) => res.json({ next_code: await nextTaskCode() }))
);

app.get(
  "/api/tasks",
  auth(),
  asyncWrap(async (req, res) => {
    const { status, assigned_to, created_by, task_type, priority, from, to, search } = req.query;
    const conds = [];
    const params = [];
    const where = (col, val) => { params.push(val); conds.push(`${col} = $${params.length}`); };
    if (status) where("t.status", status);
    if (assigned_to) where("t.assigned_to", String(assigned_to).toUpperCase());
    if (created_by) where("t.assigned_by", String(created_by).toUpperCase());
    if (task_type) where("t.task_type", task_type);
    if (priority) where("t.priority", priority);
    if (from) { params.push(from); conds.push(`t.due_date >= $${params.length}`); }
    if (to) { params.push(to); conds.push(`t.due_date <= $${params.length}`); }
    if (search) { params.push(`%${search}%`); conds.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length} OR t.task_code ILIKE $${params.length} OR t.dependencies ILIKE $${params.length} OR t.client ILIKE $${params.length} OR t.comments ILIKE $${params.length})`); }
    const sql = `
      SELECT t.*,
             a.name AS assigned_name, ab.name AS assigned_by_name
      FROM tasks t
      LEFT JOIN app_users a ON a.username = t.assigned_to
      LEFT JOIN app_users ab ON ab.username = t.assigned_by
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
      ORDER BY COALESCE(t.due_date, '9999-12-31'), t.id DESC`;
    const r = await query(sql, params);
    res.json(r.rows);
  })
);

const STATUS_PCT = { Pending: 0, "In Progress": 30, "On Hold": 20, Blocked: 10, Completed: 100 };
function durationFor(due, fromDate) {
  if (!due || !fromDate) return null;
  const a = new Date(fromDate); a.setHours(0, 0, 0, 0);
  const b = new Date(due); b.setHours(0, 0, 0, 0);
  const d = Math.round((b - a) / 86400000);
  return d >= 0 ? d : null;
}

app.post(
  "/api/tasks",
  auth(),
  asyncWrap(async (req, res) => {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: "Task title is required" });
    const code = b.task_code ? String(b.task_code).trim().toUpperCase() : await nextTaskCode();
    const dup = await query("SELECT 1 FROM tasks WHERE task_code = $1", [code]);
    if (dup.rowCount) return res.status(409).json({ error: `Task ID '${code}' already exists — pick another` });
    const status = b.status || "Pending";
    const pct = "percent_complete" in b ? Number(b.percent_complete) : (STATUS_PCT[status] ?? 0);
    const today = new Date().toISOString().slice(0, 10);
    const due = b.due_date || null;
    const r = await query(
      `INSERT INTO tasks (task_code, title, description, client, task_type, priority, status, percent_complete,
                          due_date, duration, dependencies, risk_blockers, assigned_to, assigned_by, created_by, assigned_at, comments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        code,
        String(b.title).trim(),
        b.description || "",
        b.client || "",
        b.task_type || "",
        b.priority || "Medium",
        status,
        pct,
        due,
        durationFor(due, today),
        b.dependencies || "",
        b.risk_blockers || "",
        b.assigned_to ? String(b.assigned_to).toUpperCase() : null,
        req.user.username,
        req.user.username,
        today,
        b.comments || "",
      ]
    );
    const row = r.rows[0];
    if (row.assigned_to) notifyAssigned(row, req.user.name);
    res.status(201).json(row);
  })
);

app.patch(
  "/api/tasks/:id",
  auth(),
  asyncWrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await query("SELECT * FROM tasks WHERE id = $1", [id]);
    const task = t.rows[0];
    if (!task) return res.status(404).json({ error: "Task not found" });

    const isAdmin = req.user.role === "admin";
    const isCreator = task.created_by === req.user.username;
    const isAssignee = task.assigned_to === req.user.username;
    if (!isAdmin && !isCreator && !isAssignee) {
      return res.status(403).json({ error: "You can only act on tasks you created or that are assigned to you" });
    }

    const b = req.body || {};

    if (!isAdmin && !isCreator) {
      const allowedUserKeys = Object.keys(b).filter((k) => k !== "status" && k !== "comment");
      if (allowedUserKeys.length) {
        return res.status(403).json({ error: "Only the task creator (or admin) can edit task details" });
      }
    }

    const sets = [];
    const params = [];
    const today = new Date().toISOString().slice(0, 10);
    let newComments = null;
    let newAssignedAt = null;
    let newAssignedBy = null;

    if ("comment" in b) {
      const text = String(b.comment || "").trim();
      if (!text) return res.status(400).json({ error: "Comment cannot be empty" });
      const stamp = `[${req.user.name} · ${today}]`;
      newComments = (task.comments || "").trimEnd();
      newComments = newComments ? newComments + "\n\n" + stamp + " " + text : stamp + " " + text;
    }
    if ((isAdmin || isCreator) && "comments" in b) {
      newComments = String(b.comments || "");
    }

    const patchable = ["task_code", "title", "description", "client", "task_type", "priority", "status", "percent_complete", "due_date", "dependencies", "risk_blockers", "assigned_to"];
    for (const k of patchable) {
      if (!(k in b)) continue;
      let v = b[k];
      if (k === "task_code") v = String(v).trim().toUpperCase();
      if (k === "assigned_to") v = v ? String(v).toUpperCase() : null;
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    if ("task_code" in b) {
      const code = String(b.task_code).trim().toUpperCase();
      if (!code) return res.status(400).json({ error: "Task ID cannot be empty" });
      const dup = await query("SELECT 1 FROM tasks WHERE task_code = $1 AND id <> $2", [code, id]);
      if (dup.rowCount) return res.status(409).json({ error: `Task ID '${code}' already exists — pick another` });
    }
    if (b.assigned_to) {
      const exists = await query("SELECT 1 FROM app_users WHERE username = $1", [String(b.assigned_to).toUpperCase()]);
      if (!exists.rowCount) return res.status(400).json({ error: "Assigned user does not exist" });
      newAssignedAt = today;
      newAssignedBy = req.user.username;
      params.push(newAssignedBy);
      sets.push(`assigned_by = $${params.length}`);
      params.push(newAssignedAt);
      sets.push(`assigned_at = $${params.length}`);
    }
    if ("status" in b && !("percent_complete" in b)) {
      params.push(STATUS_PCT[b.status] ?? 0);
      sets.push(`percent_complete = $${params.length}`);
    }
    if (newComments !== null) {
      params.push(newComments);
      sets.push(`comments = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    params.push(new Date());
    sets.push(`updated_at = $${params.length}`);
    params.push(id);
    const r = await query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
    const row = r.rows[0];

    const duration = durationFor(row.due_date, row.assigned_at || (row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : null));
    const d2 = await query("UPDATE tasks SET duration = $1 WHERE id = $2 RETURNING *", [duration, id]);

    const joined = await query(
      `SELECT t.*, a.name AS assigned_name, ab.name AS assigned_by_name
       FROM tasks t
       LEFT JOIN app_users a ON a.username = t.assigned_to
       LEFT JOIN app_users ab ON ab.username = t.assigned_by
       WHERE t.id = $1`, [id]);
    const final = joined.rows[0];

    if (b.assigned_to && String(b.assigned_to).toUpperCase() !== String(task.assigned_to || "").toUpperCase()) {
      notifyAssigned(final, req.user.name);
    }
    if ("status" in b && String(b.status) === "Completed" && String(task.status) !== "Completed") {
      notifyCompleted(final, req.user.name);
    }

    res.json(final);
  })
);

app.delete(
  "/api/tasks/:id",
  auth(),
  asyncWrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await query("SELECT * FROM tasks WHERE id = $1", [id]);
    const task = t.rows[0];
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (req.user.role !== "admin" && task.created_by !== req.user.username) {
      return res.status(403).json({ error: "Only admin or the user who created this task can delete it" });
    }
    await query("DELETE FROM tasks WHERE id = $1", [id]);
    res.json({ ok: true });
  })
);

// timesheets
app.get(
  "/api/timesheets",
  auth(),
  asyncWrap(async (req, res) => {
    const { username, from, to, domain, search } = req.query;
    const conds = [];
    const params = [];
    if (req.user.role !== "admin" && !username) {
      params.push(req.user.username);
      conds.push(`ts.username = $${params.length}`);
    } else if (username) {
      params.push(String(username).toUpperCase());
      conds.push(`ts.username = $${params.length}`);
    }
    if (from) { params.push(from); conds.push(`ts.entry_date >= $${params.length}`); }
    if (to) { params.push(to); conds.push(`ts.entry_date <= $${params.length}`); }
    if (domain) { params.push(domain); conds.push(`ts.domain = $${params.length}`); }
    if (search) { params.push(`%${search}%`); conds.push(`(ts.task ILIKE $${params.length} OR ts.description ILIKE $${params.length})`); }
    const sql = `
      SELECT ts.*, u.name AS user_name
      FROM timesheets ts
      LEFT JOIN app_users u ON u.username = ts.username
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
      ORDER BY ts.entry_date DESC, ts.id DESC`;
    const r = await query(sql, params);
    res.json(r.rows);
  })
);

app.post(
  "/api/timesheets",
  auth(),
  asyncWrap(async (req, res) => {
    if (req.user.role === "admin") {
      return res.status(403).json({ error: "Admins monitor timesheets and do not log hours" });
    }
    const b = req.body || {};
    if (!b.entry_date) return res.status(400).json({ error: "Date is required" });
    const hours = Number(b.hours);
    if (isNaN(hours) || hours <= 0) return res.status(400).json({ error: "Hours must be a positive number" });
    const r = await query(
      `INSERT INTO timesheets (username, task, description, entry_date, hours, domain)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.username, b.task || "", b.description || "", b.entry_date, hours, b.domain || ""]
    );
    res.status(201).json(r.rows[0]);
  })
);

app.patch(
  "/api/timesheets/:id",
  auth(),
  asyncWrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await query("SELECT * FROM timesheets WHERE id = $1", [id]);
    const ts = t.rows[0];
    if (!ts) return res.status(404).json({ error: "Timesheet entry not found" });
    if (req.user.role !== "admin" && ts.username !== req.user.username) {
      return res.status(403).json({ error: "You can only edit your own timesheet entries" });
    }
    const b = req.body || {};
    const allowed = ["task", "description", "entry_date", "hours", "domain"];
    const sets = [];
    const params = [];
    for (const k of allowed) {
      if (!(k in b)) continue;
      params.push(b[k]);
      sets.push(`${k} = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    params.push(id);
    const r = await query(`UPDATE timesheets SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
    res.json(r.rows[0]);
  })
);

app.delete(
  "/api/timesheets/:id",
  auth(),
  asyncWrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await query("SELECT * FROM timesheets WHERE id = $1", [id]);
    if (!t.rows[0]) return res.status(404).json({ error: "Not found" });
    if (req.user.role !== "admin" && t.rows[0].username !== req.user.username) {
      return res.status(403).json({ error: "You can only delete your own entries" });
    }
    await query("DELETE FROM timesheets WHERE id = $1", [id]);
    res.json({ ok: true });
  })
);

// summary stats for dashboard
app.get(
  "/api/summary",
  auth(),
  asyncWrap(async (req, res) => {
    const from = req.query.from || null;
    const to = req.query.to || null;
    const mine = req.user.role !== "admin" ? "AND assigned_to = $1" : "";
    const tParams = req.user.role !== "admin" ? [req.user.username] : [];
    const statusRows = await query(
      `SELECT status, COUNT(*)::int AS c FROM tasks WHERE 1=1 ${mine} GROUP BY status`,
      tParams
    );
    const tsWhere = [];
    const tsParams = [];
    if (req.user.role !== "admin") { tsParams.push(req.user.username); tsWhere.push(`username = $${tsParams.length}`); }
    if (from) { tsParams.push(from); tsWhere.push(`entry_date >= $${tsParams.length}`); }
    if (to) { tsParams.push(to); tsWhere.push(`entry_date <= $${tsParams.length}`); }
    const hoursRow = await query(
      `SELECT COALESCE(SUM(hours),0)::float AS total_hours, COUNT(*)::int AS entries, COUNT(DISTINCT entry_date)::int AS days
       FROM timesheets ${tsWhere.length ? "WHERE " + tsWhere.join(" AND ") : ""}`,
      tsParams
    );
    const totalTasks = await query(`SELECT COUNT(*)::int FROM tasks WHERE 1=1 ${mine}`, tParams);
    res.json({
      tasksByStatus: statusRows.rows,
      totalTasks: totalTasks.rows[0].count,
      hours: hoursRow.rows[0],
    });
  })
);

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

const PORT = Number(process.env.PORT) || 3000;
initSchema().then(() => {
  app.listen(PORT, () => {
    console.log(`[server] PLM running at http://localhost:${PORT}`);
  });
});