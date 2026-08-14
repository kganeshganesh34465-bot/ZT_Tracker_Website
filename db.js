"use strict";

const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_users (
  username     TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'user',
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id           SERIAL PRIMARY KEY,
  task_code    TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  description  TEXT DEFAULT '',
  client       TEXT DEFAULT '',
  task_type    TEXT DEFAULT '',
  priority     TEXT NOT NULL DEFAULT 'Medium',
  status       TEXT NOT NULL DEFAULT 'Pending',
  percent_complete INTEGER NOT NULL DEFAULT 0,
  due_date     DATE,
  duration     INTEGER,
  dependencies TEXT DEFAULT '',
  risk_blockers TEXT DEFAULT '',
  assigned_to  TEXT REFERENCES app_users(username) ON DELETE SET NULL,
  assigned_by  TEXT REFERENCES app_users(username) ON DELETE SET NULL,
  created_by   TEXT REFERENCES app_users(username) ON DELETE SET NULL,
  assigned_at  DATE,
  comments     TEXT DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE app_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT '';
END $$;

-- In-place upgrade for databases created before these columns/renames existed
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='domain')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='task_type') THEN
    ALTER TABLE tasks RENAME COLUMN domain TO task_type;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='prerequisites')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='dependencies') THEN
    ALTER TABLE tasks RENAME COLUMN prerequisites TO dependencies;
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS client TEXT DEFAULT '';
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS comments TEXT DEFAULT '';
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type TEXT DEFAULT '';
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_by TEXT;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_at DATE;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS duration INTEGER;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS percent_complete INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS risk_blockers TEXT DEFAULT '';
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by TEXT;
END $$;

-- Backfill duration for existing rows based on due date vs creation/assignment
UPDATE tasks
   SET duration = CASE WHEN due_date IS NULL OR due_date < COALESCE(assigned_at, created_at::date)
                       THEN NULL
                       ELSE due_date - COALESCE(assigned_at, created_at::date) END
 WHERE duration IS NULL;

-- Carry legacy created_by/created_at into the new auto-populated assigned fields
UPDATE tasks SET assigned_by = created_by WHERE assigned_by IS NULL AND created_by IS NOT NULL;
UPDATE tasks SET assigned_at = created_at::date WHERE assigned_at IS NULL AND created_at IS NOT NULL;

-- Creator is immutable; for rows created before this column existed, treat the original assigner as the creator
UPDATE tasks SET created_by = assigned_by WHERE created_by IS NULL AND assigned_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS timesheets (
  id           SERIAL PRIMARY KEY,
  username     TEXT NOT NULL REFERENCES app_users(username) ON DELETE CASCADE,
  task         TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  entry_date   DATE NOT NULL,
  hours        NUMERIC(6,2) NOT NULL DEFAULT 0,
  domain       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_timesheets_user ON timesheets(username);
CREATE INDEX IF NOT EXISTS idx_timesheets_date ON timesheets(entry_date);
`;

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    console.log("[db] Schema ready.");
  } finally {
    client.release();
  }
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query, initSchema };