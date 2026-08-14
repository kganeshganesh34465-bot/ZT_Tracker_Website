require("dotenv").config();
const mailer = require("./mailer");

const to = process.argv[2] || process.env.SMTP_USER || "test@example.com";
mailer
  .send({
    to,
    subject: "ZITA PLM — Resend test ✅",
    html: mailer.wrap(
      `<h2 style="margin:0 0 8px;font-size:19px">SMTP workaround test</h2>
       <p style="margin:0;color:#475569;line-height:1.6">If you can read this, the HTTPS mail path (Resend) is working from this host.</p>`
    ),
  })
  .then((ok) => {
    console.log(ok ? "done" : "not sent (check logs above)");
    process.exit(ok ? 0 : 1);
  })
  .catch((e) => {
    console.error("failed:", e.message);
    process.exit(1);
  });