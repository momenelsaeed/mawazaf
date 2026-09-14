import { logNotification } from "./store.js";

// Email/SMS كقناة تانية — يعمل بدون إعداد (يسجل فقط)، ويرسل حقيقي لو SMTP/Twilio متظبط
export async function sendEmail(to, subject, text) {
  const host = process.env.SMTP_HOST;
  if (!host || host === "PASTE_HERE") {
    console.log(`[Email MOCK -> ${to}]: ${subject} | ${text.slice(0, 80)}`);
    logNotification(to, "email_mock", text, "email");
    return { mock: true };
  }
  // لو SMTP متظبط، حاول إرسال عبر nodemailer إن وجد، وإلا fetch لخدمة خارجية
  try {
    const nodemailer = await import("nodemailer").catch(() => null);
    if (nodemailer) {
      const transporter = nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({ from: process.env.SMTP_FROM || `no-reply@${host}`, to, subject, text });
      logNotification(to, "email", text, "email");
      return { ok: true };
    }
  } catch (e) { console.error("email failed:", e.message); }
  console.log(`[Email FALLBACK MOCK -> ${to}]: ${subject}`);
  return { mock: true };
}

export async function sendSMS(to, text) {
  const sid = process.env.TWILIO_SID;
  if (!sid || sid === "PASTE_HERE") {
    console.log(`[SMS MOCK -> ${to}]: ${text.slice(0, 80)}`);
    logNotification(to, "sms_mock", text, "sms");
    return { mock: true };
  }
  try {
    const twilio = await import("twilio").catch(() => null);
    if (twilio) {
      const client = twilio.default(sid, process.env.TWILIO_TOKEN);
      await client.messages.create({ body: text, from: process.env.TWILIO_FROM, to });
      logNotification(to, "sms", text, "sms");
      return { ok: true };
    }
  } catch (e) { console.error("sms failed:", e.message); }
  return { mock: true };
}
