import axios from "axios";
import { getTenantMeta } from "./tenants.js";

function waCreds() {
  // بيانات العيادة الحالية أولاً، ثم .env للافتراضية
  try {
    const w = getTenantMeta()?.whatsapp || {};
    const token = (w.token && w.token !== "PASTE_HERE") ? w.token : process.env.WHATSAPP_TOKEN;
    const phoneId = w.phoneId || process.env.WHATSAPP_PHONE_NUMBER_ID;
    return {
      token, phoneId,
      reminderTemplate: (w.reminderTemplate && w.reminderTemplate !== "PASTE_HERE") ? w.reminderTemplate : process.env.WHATSAPP_REMINDER_TEMPLATE,
      templateLang: w.templateLang || process.env.WHATSAPP_TEMPLATE_LANG || "ar_EG",
      staffPhone: (w.staffPhone && w.staffPhone !== "PASTE_HERE") ? w.staffPhone : process.env.STAFF_NOTIFY_PHONE,
    };
  } catch {
    return { token: process.env.WHATSAPP_TOKEN, phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID };
  }
}
export function waStatus() {
  const c = waCreds();
  return { whatsapp: !!(c.token && c.token !== "PASTE_HERE") };
}

export async function sendWhatsApp(to, text) {
  const { token, phoneId } = waCreds();
  // وضع تجريبي: اطبع في الكونسول لو مفيش توكن
  if (!token || token === "PASTE_HERE") {
    console.log(`[WhatsApp MOCK -> ${to}]: ${text}`);
    return { mock: true };
  }
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const res = await axios.post(url, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

export async function sendTemplate(to, templateName, lang = "ar_EG", params = []) {
  const { token, phoneId } = waCreds();
  if (!token || token === "PASTE_HERE") {
    console.log(`[WhatsApp MOCK TEMPLATE ${templateName} -> ${to}]: ${params.join(" | ")}`);
    return { mock: true };
  }
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const res = await axios.post(url, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components: params.length ? [{ type: "body", parameters: params.map(p => ({ type: "text", text: String(p) })) }] : []
    }
  }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

// التذكير: قالب معتمد لو متظبط (إلزامي بعد 24 ساعة من آخر رسالة)، وإلا نص عادي
export async function sendReminder(to, name, service, slot) {
  const { reminderTemplate: tpl, templateLang } = waCreds();
  if (tpl && tpl !== "PASTE_HERE") {
    return sendTemplate(to, tpl, templateLang || "ar_EG", [name || "فندم", service, slot]);
  }
  return sendWhatsApp(to, `تذكير يا ${name || "فندم"} 🌹 عندك حجز ${service} بكرة (${slot}).\nللتأكيد رد بكلمة (تأكيد)، وللإلغاء رد (إلغاء).`);
}
export function parseIncoming(body) {
  // يرجع {from, text, isVoice, msgId} أو null — msgId لمنع المعالجة المكررة
  try {
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return null;
    const from = msg.from;
    const msgId = msg.id || "";
    if (msg.type === "text") return { from, text: msg.text.body, isVoice: false, msgId };
    if (msg.type === "audio") return { from, text: "", isVoice: true, mediaId: msg.audio.id, msgId };
    return { from, text: `[نوع غير مدعوم: ${msg.type}]`, isVoice: false, msgId };
  } catch { return null; }
}
