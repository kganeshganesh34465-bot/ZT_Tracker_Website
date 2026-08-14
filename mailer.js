"use strict";

const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 465,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { rejectUnauthorized: false },
  });
  return transporter;
}

function isEnabled() {
  return process.env.EMAIL_ENABLED === "true" && (!!process.env.SMTP_USER || !!process.env.RESEND_API_KEY || !!process.env.BREVO_API_KEY);
}

function sendViaResend({ to, subject, html, from }) {
  // Render free tier blocks outbound SMTP (25/465/587), so send over HTTPS (443)
  // via Resend's REST API when RESEND_API_KEY is set.
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  }).then((res) => {
    if (!res.ok) {
      return res.text().then((t) => {
        throw new Error(`Resend HTTP ${res.status}: ${t}`);
      });
    }
    return res.json();
  });
}

function sendViaBrevo({ to, subject, html, name }) {
  // Brevo (free tier, no domain needed — just a verified sender email).
  // API: https://developers.brevo.com/reference/sendtransacemail
  const fromField = process.env.EMAIL_FROM || process.env.SMTP_USER || "";
  const emailMatch = String(fromField).match(/<([^>]+)>/) || String(fromField).match(/[^\s@]+@[^\s@]+/);
  const senderEmail = emailMatch ? emailMatch[1] || emailMatch[0] : fromField;
  return fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sender: { name: name || "ZITA PLM", email: senderEmail },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  }).then((res) => {
    if (!res.ok) {
      return res.text().then((t) => {
        throw new Error(`Brevo HTTP ${res.status}: ${t}`);
      });
    }
    return res.json();
  });
}

function appUrl() {
  return process.env.APP_URL || "http://localhost:" + (process.env.PORT || 3000);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function send({ to, subject, html }) {
  if (!isEnabled()) {
    console.log(`[mailer] disabled — skipping "${subject}" -> ${to || "(no recipient)"}`);
    return Promise.resolve(false);
  }
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.warn(`[mailer] no valid recipient for "${subject}"`);
    return Promise.resolve(false);
  }
  let from;
  let name = process.env.EMAIL_NAME || "ZITA PLM";
  const customFrom = process.env.EMAIL_FROM;
  if (customFrom && /<[^>]+@[^>]+>/.test(customFrom)) {
    from = customFrom;
  } else {
    const fromAddr = customFrom || process.env.SMTP_USER || "onboarding@resend.dev";
    from = `${name} <${fromAddr}>`;
  }

  if (process.env.BREVO_API_KEY) {
    return sendViaBrevo({ to, subject, html, name }).then(() => {
      console.log(`[mailer] sent "${subject}" -> ${to} (Brevo)`);
      return true;
    });
  }

  if (process.env.RESEND_API_KEY) {
    return sendViaResend({ to, subject, html, from }).then((info) => {
      console.log(`[mailer] sent "${subject}" -> ${to} (${info.id})`);
      return true;
    });
  }

  return getTransporter()
    .sendMail({ from, to, subject, html })
    .then((info) => {
      console.log(`[mailer] sent "${subject}" -> ${to} (${info.messageId})`);
      return true;
    });
}

function wrap(inner) {
  const base = appUrl();
  return `<div style="max-width:520px;margin:0 auto;padding:28px 24px;font-family:Inter,Arial,Helvetica,sans-serif;background:#ffffff">
      <div style="text-align:center;margin-bottom:18px">
        <span style="font-size:20px;font-weight:800;color:#4338ca;letter-spacing:.5px">ZITA PLM</span>
      </div>
      <div style="background:#f8f9fd;border:1px solid #e5e9f2;border-radius:14px;padding:22px">
        ${inner}
      </div>
      <p style="font-size:11.5px;color:#94a3b8;text-align:center;margin-top:18px">This is an automated message from ZITA PLM (${base}).</p>
    </div>`;
}

module.exports = { send, appUrl, esc, wrap };