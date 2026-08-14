# ZITA PLM

Internal Project Management & Timesheet tool.

- **Backend:** Node.js + Express REST API connected to Supabase Postgres
- **Frontend:** Vanilla JS single-page app (no build step)
- **Auth:** username/password, tokens signed with HMAC; passwords hashed with scrypt

## Features

- **Admin role** (`ADMIN` / `****`) — create users, delete users, reset passwords, assign tasks, full edit on every task, view everyone's timesheets (monitor mode), see everything.
- **New-user password flow** — every account created by an admin starts with the default password `Welcome` and is forced to set its own password on the very first sign-in (verified against the current password). Resetting a password also re-enables that prompt.
- **Email alerts** *(optional)* — when a task is assigned to someone, they get an email: *"Hey {name}, you have a task awaiting you"* with task details and a link straight to it. When a task is marked **Completed**, the **creator** gets the "task completed" email. Add/update each member's email under **Team & Users** → edit (pencil) button.
- **User role** — can create tasks (auto or manual task ID) and assign them to a responsible person. A user who **created** a task gets full edit control over it (title, priority, due date, task type, % complete, comments, etc.). On tasks created by someone else, users can only **change status and add comments** (and only if the task is assigned to them — everything else is read-only).
- **Tasks tab** with two views:
  - **My work** — kanban board of tasks assigned to / created by you. Open a card → change status (card auto-moves) or add a comment.
  - **Overall** — every member's tasks: creators/admin get full edit, non-creator users get read-only. Filters: search, status, priority, task type, assignee, due-date range.
- **Task columns** — Task ID (auto next number, editable), Title, Task Type, Client, Status, % Complete, Priority, Assignee, Assigned By/Date (auto-populated), Created By, Due Date, Duration (auto), Dependencies, Risk/Blockers, Comments (thread with author+date stamps).
- **Excel export** — exports include every task column; timesheets and members also exportable from each screen.
- **Timesheets tab** — members log daily hours (task, description, date, hours, task type); **admins monitor all members** (no entry form, no logging).
- **Dashboard** — stat cards + charts (tasks by status, hours by member).
- **Team** — member directory; admins manage accounts.

## Set up

1. Install dependencies:

   ```
   npm install
   ```

2. Configure the database in `.env`:

   ```
   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
   ```

3. Create the tables and seed the `ADMIN` user (idempotent, safe to rerun):

   ```
   npm run init-db
   ```

## Run

```
npm start
```

Open **http://localhost:3000** and sign in with `ADMIN` / `ADMIN123`.

> Tip: log in as ADMIN → **Team & Users** → create accounts for each member (e.g. GANESH, KISHORE, MANISAI) and share their username + the default password `Welcome`; they'll set their own password on first sign-in.

## API overview

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/api/login` | public | sign in, returns token + user |
| GET | `/api/me` | any | current user |
| GET | `/api/users` | any | list members |
| POST | `/api/users` | admin | create user (default password `Welcome`, change forced on first sign-in) includes optional `email` |
| PATCH | `/api/users/:username` | admin | rename / change role / set email / reset password (forces change on next sign-in) |
| DELETE | `/api/users/:username` | admin | delete user |
| POST | `/api/me/password` | any | set your own password (verify current password; clears the forced-change flag) |
| GET | `/api/tasks/next-code` | any | next available task ID |
| GET | `/api/tasks?status=&assigned_to=&domain=&priority=&from=&to=&search=` | any | list/filter tasks |
| POST | `/api/tasks` | any | create + assign task |
| PATCH | `/api/tasks/:id` | admin or creator (full) / assignee (status+comment) | edit task / completion status / comments |
| DELETE | `/api/tasks/:id` | admin or creator | delete task |
| GET | `/api/timesheets?username=&from=&to=&domain=&search=` | any | non-admins see own only |
| POST/PATCH/DELETE | `/api/timesheets[/:id]` | any (owner/admin) | log / edit / delete hours |
| GET | `/api/summary` | any | dashboard stats |

## Security notes

- `.env` contains real database credentials and is git-ignored — do not commit or share it.
- Change `TOKEN_SECRET` in `.env` to a long random string before any shared deployment.
- Every new/reset user starts on the `Welcome` default and is forced to set a real password at first login; passwords are stored as scrypt hashes only.
- Permissions are enforced server-side; the UI only shows controls the user is allowed to use.

## Deployment (free: Render)

The app is a plain Node/Express process that serves the frontend AND the API, so a single web service is all you need. Supabase already hosts your database for free — it stays as-is.

1. **Commit and push to GitHub** (make sure `.env` is NOT pushed — it is already git-ignored):

   ```
   git add . && git commit -m "Prepare for Render deployment" && git push
   ```

2. **Create the service on Render** (https://dashboard.render.com):
   - `New +` → **Web Service** → connect your repo.
   - Settings: Runtime **Node**, Build `npm install`, Start `node server.js`, instance type **Free**.
   - Or use the blueprints file included in this repo (`render.yaml`).
3. **Add environment variables** in the service → *Environment* — same keys as `.env`:

   `PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSL=true, TOKEN_SECRET`
   - Grab their values from your local `.env` / Supabase dashboard. Set `TOKEN_SECRET` to a long random string.
   - Save → Render auto-deploys.
4. **Optional: turn on email alerts (Gmail):**
   - In your Gmail account: Google Account → **Security → 2-Step Verification** (must be on) → **App passwords** → create one (name it "ZITA PLM") → copy the 16-char password.
   - Back in Render → Environment, add and set:
     ```
     EMAIL_ENABLED = true
     SMTP_HOST    = smtp.gmail.com
     SMTP_PORT    = 465
     SMTP_USER    = your-account@gmail.com
     SMTP_PASS    = the-16-char-app-password
     EMAIL_FROM   = your-account@gmail.com
     APP_URL      = https://your-app.onrender.com
     ```
   - Then add each team member's email under **Team & Users → edit (pencil)**. Emails are disabled by default — leave `EMAIL_ENABLED` unset or `false` and nothing changes for the team.
4. **First boot** — Render runs `npm start` → `initSchema()` creates/upgrades the tables automatically. Open the generated `https://zita-plm.onrender.com`, sign in with `ADMIN / ADMIN123`, and change the password.

Notes:
- Deploys from the `main` branch happen automatically on every push (`autoDeploy: true`).
- Free Render web services spin down after ~15 min idle; the first request after that takes ~30–60 s to wake up. A cron ping (e.g. UptimeRobot free) keeps it warm.
- Only `PORT` is provided by Render (see `server.js`); everything else comes from your env vars.
