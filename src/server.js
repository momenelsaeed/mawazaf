import "dotenv/config";
import express from "express";
import cron from "node-cron";
import crypto from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { aiReply, resetPhone, setPendingState, getPendingState, isDecline } from "./ai.js";
import { sendWhatsApp, sendReminder, parseIncoming, waStatus } from "./whatsapp.js";
import { validateBooking, parseSlotLabel } from "./schedule.js";
import { transcribeVoice } from "./voice.js";
import { route as smRoute } from "./booking-flow.js";
import { logMessage, createBooking, getBookings, getBookingsPaged, activeBookings, getMessages, getMessagesPaged, deleteBooking, setBookingStatus, getStats, clearAll, cancelLatestByPhone, addHandoff, getHandoffs, resolveHandoff, getTomorrowBookings, getLatestActiveByPhone, updateBookingSlot, getRemindedByPhone, getDueUnconfirmed, getReports, backupNow, getRecallCandidates, logRecall, clearReview, getPendingReviews, logAudit, getAudit, getAuditPaged, logNotification, getNotifications, getNotificationsPaged, addKbDoc, getKbDocs, deleteKbDoc, searchKb, getPatientFull, getAllPatients, getAllPatientsPaged, updatePatient, setBookingPayment, exportBookingsCSV, getBookingsByDate, getRecallCandidatesBySpec, getRecallSchedule, searchPatients, changePatientNumber, getBookingByCode, cancelByCode, alreadyProcessed, logCron, getCronStatus, getBackupStatus, getUser, listUsers, createUser, setUserHash, setUserActive, deleteUser, getSession, createSession, deleteSessionByToken, cleanExpiredSessions, addVisit, getVisitsByPatient, updateVisit, deleteVisit } from "./store.js";
import { bootstrapUsers, loginUser, hashPassword, newToken, isLocked } from "./auth.js";
import { can, atLeast, stripPatient, stripVisit, stripReports } from "./roles.js";
import { requestOtp, confirmOtp } from "./otp.js";
import { purgeOldMessages } from "./store.js";
import { linkDoctor } from "./store.js";
import { addClinicRequest, getClinicRequests, decideClinicRequest, getQueueStatus, purgeTestData } from "./store.js";
import { enqueue } from "./store.js";
import { startQueueWorker, queueStatus } from "./queue.js";
import { addToWaitlist, getWaitlist, removeFromWaitlist, matchWaitlist, markWaitNotified, addDoc, getDocsByPatient, getDoc, deleteDoc } from "./store.js";
import { als, currentSlug, tenantConfigPath, getConfig, listTenants, createTenant, deleteTenant, subscriptionStatus, withTenant, allTenantSlugs, getTenantMeta, saveTenantMeta, validSlug } from "./tenants.js";
import { daySlots } from "./schedule.js";
import { book_appointment, check_availability } from "./tools.js";
import { createPayIntent, confirmPayIntent } from "./store.js";

function loadConfig() {
  return getConfig();
}
const CONFIG_PATH = () => tenantConfigPath(currentSlug());

// ---- مصادقة: جلسات (جديد) + باسورد مباشر (قديم للتوافق) ----
const DASH_PASS = process.env.DASHBOARD_PASSWORD && process.env.DASHBOARD_PASSWORD !== "PASTE_HERE" ? process.env.DASHBOARD_PASSWORD : "";
const STAFF_PASS = process.env.STAFF_PASSWORD && process.env.STAFF_PASSWORD !== "PASTE_HERE" ? process.env.STAFF_PASSWORD : "";
const PASS_HASH = DASH_PASS ? crypto.createHash("sha256").update(DASH_PASS).digest() : null;
const STAFF_HASH = STAFF_PASS ? crypto.createHash("sha256").update(STAFF_PASS).digest() : null;
if (!DASH_PASS && !getUser("admin")) console.log("⚠️  تحذير: الداشبورد مفتوح بدون باسورد — حط DASHBOARD_PASSWORD في .env");
bootstrapUsers();
setInterval(() => { try { cleanExpiredSessions(); } catch {} }, 3600000);

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function secureFlag(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  return proto === "https" ? "; Secure" : "";
}
// {username, role} أو null — legacy staff تُترجم reception
export function authUser(req) {
  const c = cookies(req);
  if (/^[a-f0-9]{64}$/.test(c.clinic_sess || "")) {
    try {
      const s = getSession(c.clinic_sess);
      if (s) return { username: s.username, role: s.role };
    } catch {}
  }
  if (!PASS_HASH && !STAFF_HASH && !getUser("admin")) return { username: "open", role: "admin" };
  const m = String(c.clinic_auth || "").match(/^[a-f0-9]{64}$/);
  if (m) {
    try {
      if (PASS_HASH && crypto.timingSafeEqual(Buffer.from(m[0], "hex"), PASS_HASH)) return { username: "admin", role: "admin" };
      if (STAFF_HASH && crypto.timingSafeEqual(Buffer.from(m[0], "hex"), STAFF_HASH)) return { username: "reception", role: "reception" };
    } catch {}
  }
  return null;
}
function authRole(req) { return authUser(req)?.role || null; }
function authed(req) { return !!authUser(req); }
function needAdmin(req, res, next) {
  if (authRole(req) === "admin") return next();
  if (req.path.startsWith("/api/")) return res.status(403).json({ error: "admin only" });
  return res.redirect("/login.html");
}
function needRole(min) {
  return (req, res, next) => {
    if (atLeast(authRole(req), min)) return next();
    if (req.path.startsWith("/api/")) return res.status(403).json({ error: "forbidden" });
    return res.redirect("/login.html");
  };
}

const app = express();
app.use(express.json({ limit: "1mb" }));
// ترويسات أمان أساسية (من غير مكتبات)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
// فحص Origin للعمليات المغيرة (CSRF) — يُتجاهل لو مفيش Origin (نفس الأصل/أدوات)
app.use((req, res, next) => {
  if (!["POST", "PATCH", "DELETE", "PUT"].includes(req.method)) return next();
  if (!req.path.startsWith("/api/") || req.path === "/api/login" || req.path === "/webhook") return next();
  const o = req.headers.origin || req.headers.referer || "";
  if (!o) return next();
  try {
    const oh = new URL(o).host;
    const hh = String(req.headers.host || "").split(",")[0].trim();
    if (oh && hh && oh !== hh) return res.status(403).json({ error: "bad origin" });
  } catch {}
  next();
});

// ---- Multi-tenant: تحديد العيادة (subdomain → ?clinic= → default) قبل أي شيء ----
function resolveTenantSlug(req) {
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  const parts = host.split(".");
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  // subdomain: a.domain.com وكذلك a.localhost للتجربة المحلية
  if (!isIp && parts.length >= 2) {
    const sub = parts.length > 2 ? parts[0] : (parts[1] === "localhost" ? parts[0] : "");
    if (sub && sub !== "www" && sub !== "localhost" && validSlug(sub) && getTenantMeta(sub)) return sub;
  }
  const q = String(req.query?.clinic || "").toLowerCase();
  if (validSlug(q) && (q === "default" || getTenantMeta(q))) return q;
  return "default";
}
app.use((req, res, next) => {
  const slug = resolveTenantSlug(req);
  als.run({ slug }, () => {
    try { bootstrapUsers(); } catch {}
    next();
  });
});

// مسارات عامة (الواتساب لازم يوصل للـ webhook من غير باسورد)
app.get("/webhook", (req, res) => {
  // تحقق Meta: توكن العيادة (?clinic=) أو الافتراضي
  const qslug = String(req.query?.clinic || "");
  const verify = (validSlug(qslug) && getTenantMeta(qslug)?.whatsapp?.verify) || process.env.VERIFY_TOKEN;
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": ch } = req.query;
  if (mode === "subscribe" && token === verify) return res.status(200).send(ch);
  return res.sendStatus(403);
});
function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
}
app.post("/api/login", (req, res) => {
  const ip = clientIp(req);
  // دخول جديد: username + password
  if (req.body?.username) {
    if (isLocked(String(req.body.username), ip)) return res.status(429).json({ error: "محاولات كتير — جرب بعد 15 دقيقة" });
    const r = loginUser(req.body.username, req.body?.password || "", ip);
    if (!r.ok) return res.status(r.locked ? 429 : 401).json({ error: r.locked ? "محاولات كتير — جرب بعد 15 دقيقة" : "بيانات غلط" });
    res.setHeader("Set-Cookie", `clinic_sess=${r.token}; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}; Path=/${secureFlag(req)}`);
    return res.json({ ok: true, role: r.role, username: r.username });
  }
  // دخول قديم: password فقط (توافق) — يُنشئ جلسة أيضاً
  if (!PASS_HASH && !STAFF_HASH && !getUser("admin")) return res.json({ ok: true, open: true });
  const pw = String(req.body?.password || "");
  const h = crypto.createHash("sha256").update(pw).digest();
  let role = "", username = "";
  if (PASS_HASH && h.equals(PASS_HASH)) { role = "admin"; username = "admin"; }
  else if (STAFF_HASH && h.equals(STAFF_HASH)) { role = "reception"; username = "reception"; }
  if (role) {
    const token = newToken();
    try { createSession(token, username, role, 12, ip); } catch {}
    res.setHeader("Set-Cookie", [`clinic_auth=${h.toString("hex")}; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}; Path=/${secureFlag(req)}`, `clinic_sess=${token}; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}; Path=/${secureFlag(req)}`]);
    try { logAudit(username, "login", "dashboard login (legacy)"); } catch {}
    return res.json({ ok: true, role, username });
  }
  return res.status(401).json({ error: "wrong password" });
});
app.post("/api/logout", (req, res) => {
  try { deleteSessionByToken(cookies(req).clinic_sess); } catch {}
  res.setHeader("Set-Cookie", [`clinic_auth=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`, `clinic_sess=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`]);
  res.json({ ok: true });
});

// بوابة الحماية: كل حاجة بعد كده محتاجة دخول
app.use((req, res, next) => {
  if (req.path === "/webhook" || req.path === "/api/health" || req.path === "/api/login" || req.path === "/login.html") return next();
  if (req.path === "/super.html" || req.path === "/api/super/login") return next();
  if (req.path === "/site.html" || req.path === "/help.html" || req.path.startsWith("/api/public/")) return next(); // الموقع العام
  if (authed(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "login required" });
  return res.redirect("/login.html");
});
app.use(express.static("public"));

// صحة السيرفر
app.get("/api/health", (req, res) => {
  let database = "ok";
  try { getStats(); } catch (e) { database = "fail: " + e.message; }
  const ai = (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== "PASTE_HERE")
    ? `ok (${process.env.OPENAI_MODEL || "default"})` : "demo-mode";
  const whatsapp = (() => { try { return waStatus().whatsapp ? "connected" : "mock"; } catch { return "mock"; } })();
  const backup = getBackupStatus();
  const crons = getCronStatus();
  res.json({ ok: database === "ok", time: new Date().toISOString(), server: "ok", database, ai, whatsapp, backup, crons });
});
app.get("/api/cron-status", (req, res) => res.json(getCronStatus()));
app.get("/api/queue-status", needAdmin, (req, res) => res.json(queueStatus()));

// حالة الربط (للعيادة الحالية)
app.get("/api/status", (req, res) => {
  let wa = false;
  try { wa = waStatus().whatsapp; } catch {}
  res.json({
    whatsapp: wa,
    openai: !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== "PASTE_HERE",
    model: process.env.OPENAI_MODEL || "demo-mode",
    clinic: currentSlug(),
    sub: subscriptionStatus()
  });
});

function isRescheduleIntent(text) {
  const t = String(text || "");
  return /(عدل|أجل|اجل|قدم|أخر|اخر|غير|انقل|احول|أحول)/.test(t) && /(حجز|معاد|ميعاد|المعاد|موعد|الموعد)/.test(t);
}

async function finishReschedule(from, userText, existing) {
  const config = loadConfig();
  const others = activeBookings().filter(b => String(b.id) !== String(existing.id));
  const v = validateBooking(existing.service, userText, config, others);
  if (!v.ok) {
    const alt = (v.alternatives || []).length ? `\nالمتاح: ${v.alternatives.join("، ")}` : "";
    return `${v.reason}${alt}`;
  }
  updateBookingSlot(existing.id, { date: v.date, time: v.time, slot: v.label, duration: v.duration, doctor: v.doctor });
  setPendingState(from, { reschedId: null, step: null });
  const rDoc = v.doctor ? `\n👨‍⚕️ ${v.doctor}` : "";
  return `✅ تمام يا فندم، اتنقل حجزك (${existing.service}) لـ ${v.label}${rDoc}\n📍 ${config.address}\nرقم الحجز: ${existing.code || existing.id}`;
}

async function handleUserMessage(from, userText) {
  const config = loadConfig();
  const cm = String(userText || "").trim();
  const pend0 = getPendingState(from);
  // 0) تأكيد حجز معلق (AI Safety: مفيش تنفيذ خطير بدون confirm)
  if (pend0 && pend0.confirm_booking) {
    if (/^(تأكيد|اكد|أكد|أكيد|اكيد|تمام|ايوه|أيوه|نعم|مؤكد|اوكيه|اوكي|yes|ok|confirm)[.!؟\s]*$/i.test(cm)) {
      const cb = pend0.confirm_booking;
      setPendingState(from, { confirm_booking: null, step: null });
      const { book_appointment } = await import("./tools.js");
      const r = book_appointment({ from, name: cb.name, phone: cb.phone, service: cb.service, slotText: cb.slotText, actor: "ai-confirmed" });
      if (!r.ok) return `${r.reason}${(r.alternatives || []).length ? `\nالمتاح: ${r.alternatives.join("، ")}` : ""}`;
      const b = r.booking;
      const docLine = b.doctor ? `\n👨‍⚕️ ${b.doctor}` : "";
      return b.needs_review
        ? `✅ استلمنا حجزك يا ${b.name || "فندم"}\n📌 ${b.service} | ${b.slot}${docLine}\n🌙 الحجز اتسجل وهيتأكد من الاستقبال الصبح.\nرقم الحجز: ${b.code || b.id}`
        : `✅ تم تسجيل حجزك يا ${b.name || "فندم"}\n📌 ${b.service} | ${b.slot}${docLine}\n📍 ${config.address}\nرقم الحجز: ${b.code || b.id}\nهنستناك وتنورنا 😊`;
    }
    if (/^(لا|لأ|لاء|الغاء|إلغاء|cancel)[.!؟\s]*$/.test(cm)) {
      setPendingState(from, { confirm_booking: null });
      return "تمام يا فندم، لغيت الحجز قبل تسجيله 🌹 تحب حاجة تانية؟";
    }
    // أي رسالة تانية تلغي التأكيد المعلق وتكمل عادي
    setPendingState(from, { confirm_booking: null });
  }
  // تأكيد حجز بعد التذكير: "تأكيد/تمام/ايوه" لوحدها فقط → مؤكد (عشان "تمام احجز بكرة" متتفهمش تأكيد بالغلط)
  const pend = getPendingState(from);
  // عمليات برقم الحجز المقروء (SCH-2026-000123) — مع تحقق الملكية
  const codeM = String(userText || "").toUpperCase().match(/SCH-\d{4}-\d{4,20}/);
  if (codeM) {
    const code = codeM[0];
    if (/(لغي|لغاء|كنسل|cancel|فسخ)/.test(String(userText || ""))) {
      const cb = cancelByCode(code, from);
      if (cb && cb.denied) return "رقم الحجز ده مش مسجل برقمك يا فندم 🔒 لو حجزك ابعت من نفس رقم الواتساب اللي حجزت بيه.";
      if (cb) {
        try {
          const { notifyWaitlist } = await import("./booking-flow.js");
          notifyWaitlist(cb.service, cb.date).catch(() => {});
        } catch {}
      }
      return cb
        ? `تمام يا فندم، لغيت حجزك (${cb.service} | ${cb.slot} — ${cb.code}). تحب أحجزلك معاد تاني؟`
        : "رقم الحجز ده مش موجود أو ملغي بالفعل يا فندم. اتأكد من الرقم (مثال: SCH-2026-000123).";
    }
    if (isRescheduleIntent(userText)) {
      const eb = getBookingByCode(code, from);
      if (eb && eb.denied) return "رقم الحجز ده مش مسجل برقمك يا فندم 🔒";
      if (!eb) return "رقم الحجز ده مش موجود يا فندم. اتأكد من الرقم.";
      const parsed = parseSlotLabel(userText);
      if (!parsed.error) return finishReschedule(from, userText, eb);
      setPendingState(from, { reschedId: eb.id, step: "await_reschedule" });
      return `حجزك: ${eb.service} | ${eb.slot}. تحب ننقله لإمتى؟ (مثال: بكرة الساعة 7 المغرب)`;
    }
  }
  const hasPendingBooking = pend && (pend.service || pend.slot || pend.suggested || pend.step === "await_details");
  if (!hasPendingBooking && /^(تأكيد|اكد|أكد|أكيد|اكيد|تمام|ايوه|أيوه|نعم|مؤكد|اوكيه|اوكي)[.!؟\s]*$/.test(cm)) {
    const rb = getRemindedByPhone(from);
    if (rb) {
      setBookingStatus(rb.id, "confirmed");
      return `✅ اتأكد حجزك يا فندم (${rb.service} | ${rb.slot}). هنستناك 🌹`;
    }
  }
  // استكمال تعديل معاد بدأ قبل كده
  const st = getPendingState(from);
  if (st && st.reschedId) {
    if (isDecline(userText)) {
      setPendingState(from, { reschedId: null, step: null });
      return "تمام يا فندم، في خدمتك أي وقت تحب تحجز 🌹";
    }
    const existing = getBookings().find(b => String(b.id) === String(st.reschedId) && b.status === "confirmed");
    if (!existing) {
      setPendingState(from, { reschedId: null, step: null });
      return "الحجز ده مبقاش موجود يا فندم. تحب تحجز معاد جديد؟";
    }
    return finishReschedule(from, userText, existing);
  }
  // طلب تعديل جديد
  if (isRescheduleIntent(userText)) {
    const existing = getLatestActiveByPhone(from);
    if (!existing) return "مفيش حجز نشط عندي برقمك يا فندم. تحب تحجز معاد جديد؟";
    const parsed = parseSlotLabel(userText);
    if (!parsed.error) return finishReschedule(from, userText, existing); // المعاد الجديد في نفس الرسالة
    setPendingState(from, { reschedId: existing.id, step: "await_reschedule" });
    return `حجزك الحالي: ${existing.service} | ${existing.slot}. تحب ننقله لإمتى؟ (مثال: بكرة الساعة 7 المغرب)`;
  }
  // State Machine: فلو نشط أو نية (حجز/إلغاء/تعديل) → معالجة حتمية بدل الاستنتاج
  // غير كده → aiReply (أسعار/تحيات/استفسارات صحية)
  let reply;
  try {
    const smRes = smRoute(from, userText);
    if (smRes.handled) reply = smRes.reply;
  } catch (e) { console.error("sm error:", e.message); }
  if (reply === undefined) reply = await aiReply(from, userText);
  if (reply.includes("[إلغاء]")) {
    const cancelled = cancelLatestByPhone(from);
    if (cancelled) {
      try {
        const { notifyWaitlist } = await import("./booking-flow.js");
        notifyWaitlist(cancelled.service, cancelled.date).catch(() => {});
      } catch {}
    }
    return cancelled
      ? `تمام يا فندم، لغيت حجزك (${cancelled.service} | ${cancelled.slot}). تحب أحجزلك معاد تاني؟`
      : "مفيش حجز نشط عندي برقمك يا فندم. تحب تحجز معاد جديد؟";
  }
  if (reply.includes("[تحويل]")) {
    const reason = reply.replace("[تحويل]", "").trim();
    const h = addHandoff(from, reason || userText);
    // URGENT من الـ Safety Layer → تنبيه أحمر + رد مستعجل (مش حجز عادي)
    const isUrgent = reason.startsWith("أعراض تحتاج مراجعة بشرية");
    // تنبيه فوري للاستقبال (مهم: لو 3 الفجر محدش يفتح اللوحة)
    const staffPhone = (() => {
      try {
        const w = getTenantMeta()?.whatsapp || {};
        if (w.staffPhone && w.staffPhone !== "PASTE_HERE") return w.staffPhone;
      } catch {}
      return (process.env.STAFF_NOTIFY_PHONE && process.env.STAFF_NOTIFY_PHONE !== "PASTE_HERE" ? process.env.STAFF_NOTIFY_PHONE : (config.emergency_phone || ""));
    })();
    if (staffPhone) {
      sendWhatsApp(staffPhone, `${isUrgent ? "🔴 عاجل — أعراض تحتاج مراجعة:" : "🔔 محتاج بشري:"} ${from}\n📌 "${String(reason || userText).slice(0, 120)}"\nرد عليه من اللوحة → تبويب 🙋`).catch(()=>{});
    }
    try { logAudit("ai", isUrgent ? "handoff_urgent" : "handoff", `${from}: ${String(reason || userText).slice(0, 80)}`); } catch {}
    const em = config.emergency_phone || "";
    if (isUrgent) return `ألف سلامة عليك يا فندم 🌹 الأعراض دي الأفضل يراجعها موظفنا بسرعة — حولتك للاستقبال وهيكلمك في أقرب وقت.\nلو الأعراض شديدة أو زادت (ضيق نفس/إغماء/نزيف) كلم الطوارئ فوراً: ${em}`;
    return `تمام يا فندم، حولتك لموظف الاستقبال وهيكلمك في أقرب وقت على الرقم ده 🙏\nلو مستعجل كلم: ${em}`;
  }
  const tm = String(reply).match(/\[تعديل\]\s*(.+)/);
  if (tm) {
    const existing = getLatestActiveByPhone(from);
    if (!existing) return "مفيش حجز نشط عندي برقمك يا فندم. تحب تحجز معاد جديد؟";
    const parsed = parseSlotLabel(tm[1]);
    if (parsed.error) {
      setPendingState(from, { reschedId: existing.id, step: "await_reschedule" });
      return `حجزك الحالي: ${existing.service} | ${existing.slot}. تحب ننقله لإمتى؟`;
    }
    return finishReschedule(from, tm[1], existing);
  }
  const m = String(reply).match(/\[حجز جديد\]\s*(.+)/);
  if (m) {
    const parts = m[1].split("|").map(s => s.trim());
    const service = parts[2] || "", slotText = parts[3] || m[1];
    const v = validateBooking(service, slotText, config, activeBookings());
    if (!v.ok) {
      // المعاد مرفوض (محجوز/إجازة/بره المواعيد): رجع بيانات العميل للحالة وكمل من غير ما تسجل
      const restore = { service, step: "await_details" };
      if (parts[0] && parts[0] !== "عميل") restore.name = parts[0];
      if (/^01[0125][0-9]{8}$/.test(parts[1] || "")) restore.phone = parts[1];
      setPendingState(from, restore);
      const alt = (v.alternatives || []).length ? `\nالمتاح: ${v.alternatives.join("، ")}` : "";
      return `${v.reason}${alt}`;
    }
    // AI Safety: اعرض الملخص واطلب تأكيد قبل التنفيذ
    const nm = parts[0] || "", ph = parts[1] || from;
    const docLine = v.doctor ? ` عند ${v.doctor}` : "";
    setPendingState(from, { confirm_booking: { name: nm, phone: ph, service, slotText }, step: null });
    return `تمام يا فندم، هحجزلك:\n📌 ${service}${docLine}\n🕐 ${v.label}\n👤 ${nm} — ${ph}\nهل تؤكد؟ (رد: تأكيد / إلغاء)`;
  }
  reply = reply.replace(/\[طارئ\]/g, "");
  return reply;
}

// تذكير يومي الساعة 8 بليل لحجوزات بكرة المؤكدة → طابور (retry تلقائي) → reminded
async function sendReminders() {
  const list = getTomorrowBookings();
  for (const b of list) {
    const doc = b.doctor ? ` عند ${b.doctor}` : "";
    enqueue("reminder", { to: b.from, name: b.name, service: `${b.service}${doc}`, slot: b.slot, bookingId: b.id });
  }
  return list.length;
}
// المهام المجدولة: تعمل لكل عيادة نشطة على حدة (عزل كامل)
function eachTenant(fn, cronName) {
  for (const slug of allTenantSlugs()) {
    try {
      withTenant(slug, () => {
        Promise.resolve(fn()).then(() => logCron(cronName, true)).catch(e => logCron(cronName, false, e.message));
      });
    } catch (e) { try { logCron(cronName, false, e.message); } catch {} }
  }
}
cron.schedule("0 20 * * *", () => { eachTenant(sendReminders, "reminder-20h"); }, { timezone: "Africa/Cairo" });
app.post("/api/remind-now", async (req, res) => res.json({ sent: await sendReminders() }));

// إلغاء تلقائي للي ميأكدش: كل نص ساعة، أي حجز reminded النهاردة ومعاده خلال ساعتين أو فات
async function autoCancelUnconfirmed() {
  const list = getDueUnconfirmed();
  for (const b of list) {
    setBookingStatus(b.id, "cancelled");
    try {
      await sendWhatsApp(b.from, `يا ${b.name || "فندم"}، اتلغى حجزك (${b.service} | ${b.slot}) لعدم التأكيد. لو لسه محتاجه احجز معاد جديد 🌹`);
    } catch (e) { console.error("autocancel notify failed", b.id, e.message); }
    logMessage(b.from, "out", `[إلغاء تلقائي لعدم التأكيد] ${b.service} | ${b.slot}`);
  }
  return list.length;
}
cron.schedule("*/30 * * * *", () => { eachTenant(autoCancelUnconfirmed, "autocancel-30m"); });
app.post("/api/autocancel-now", async (req, res) => res.json({ cancelled: await autoCancelUnconfirmed() }));
app.get("/api/reports", (req, res) => res.json(stripReports(authRole(req), getReports())));

// مراجعة حجوزات الليل
app.get("/api/reviews", (req, res) => res.json(getPendingReviews()));
app.post("/api/bookings/:id/review", (req, res) => {
  const b = clearReview(req.params.id);
  if (!b) return res.status(404).json({ error: "not found" });
  res.json(b);
});

// نسخة احتياطية
app.get("/api/backup-download", (req, res) => {
  try {
    const p = backupNow();
    res.download(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/backup-now", (req, res) => {
  try { res.json({ ok: true, file: backupNow() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
cron.schedule("0 3 * * *", () => {
  eachTenant(async () => { backupNow(); console.log("backup done"); }, "backup-3h");
}, { timezone: "Africa/Cairo" });

// متابعة الغايبين: أول كل شهر 10 الصبح + تجربة يدوية (فترة لكل تخصص)
cron.schedule("0 10 1 * *", () => { eachTenant(sendRecallsAuto, "recall-monthly"); }, { timezone: "Africa/Cairo" });
async function sendRecallsAuto() {
  // تلقائي: كل تخصص بفترته (أسنان 180 / باطنة 30 ...) — عبر الطابور
  const list = getRecallCandidatesBySpec();
  for (const p of list) {
    const msg = `وحشتنا يا ${p.name || "فندم"} 🌹 بقالك ${p.days} يوم مكشفتش ${p.lastService || "عندنا"}، تحب تحجز معاد للاطمئنان؟ رد بكلمة (احجز).`;
    enqueue("recall", { phone: p.phone, text: msg, service: p.lastService });
  }
  return list.length;
}
app.post("/api/recall-now", async (req, res) => {
  if (req.body?.days) {
    const days = Number(req.body.days);
    const list = getRecallCandidates(days);
    for (const p of list) {
      const msg = `وحشتنا يا ${p.name || "فندم"} 🌹 بقالك فترة مكشفتش ${p.lastService || "عندنا"}، تحب تحجز معاد للاطمئنان؟ رد بكلمة (احجز).`;
      enqueue("recall", { phone: p.phone, text: msg, service: p.lastService });
    }
    return res.json({ sent: list.length, mode: "custom-days" });
  }
  res.json({ sent: await sendRecallsAuto(), mode: "per-specialty", schedule: getRecallSchedule() });
});
app.get("/api/recall-schedule", (req, res) => res.json(getRecallSchedule()));
app.post("/api/recall-schedule", needAdmin, (req, res) => {
  try {
    const cur = JSON.parse(readFileSync(CONFIG_PATH(), "utf-8"));
    cur.recall_schedule = { ...(cur.recall_schedule || {}), ...req.body };
    writeFileSync(CONFIG_PATH(), JSON.stringify(cur, null, 2), "utf-8");
    try { logAudit(authRole(req), "recall_schedule", JSON.stringify(req.body).slice(0, 200)); } catch {}
    res.json(cur.recall_schedule);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// رسالة جماعية لحجوزات يوم (الدكتور اتأخر ساعة...)
app.post("/api/broadcast", async (req, res) => {
  const { date, text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "اكتب نص الرسالة" });
  if (String(text).length > 500) return res.status(400).json({ error: "الرسالة طويلة (500 حد أقصى)" });
  const n = new Date();
  const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  const target = date || today;
  const list = getBookingsByDate(target);
  let sent = 0;
  for (const b of list) {
    const msg = `تنبيه من ${loadConfig().name} 🌹 يا ${b.name || "فندم"}: ${String(text).trim()}`;
    enqueue("broadcast", { to: b.from || b.phone, phone: b.phone, text: msg });
    sent++;
  }
  try { logAudit(authRole(req), "broadcast", `${target}: ${sent} — ${String(text).slice(0, 100)}`); } catch {}
  res.json({ sent, total: list.length, date: target });
});
// ملف المريض الكامل + العربون + تصدير إكسل
app.get("/api/patients", (req, res) => {
  const role = authRole(req);
  if (req.query.page || req.query.limit) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const q = String(req.query.q || "").trim();
    const paged = getAllPatientsPaged({ page, limit, q });
    paged.rows = paged.rows.map(p => stripPatient(role, p));
    return res.json(paged);
  }
  const list = req.query.q ? searchPatients(req.query.q) : getAllPatients();
  res.json(list.map(p => stripPatient(role, p)));
});
app.get("/api/patients/:key", (req, res) => {
  const p = getPatientFull(req.params.key);
  if (!p) return res.status(404).json({ error: "not found" });
  const role = authRole(req);
  const out = stripPatient(role, p);
  if (Array.isArray(out.medicalVisits)) out.medicalVisits = out.medicalVisits.map(v => stripVisit(role, v));
  res.json(out);
});
// تغيير الرقم المباشر: أدمن فقط — الباقي بتحقق OTP
app.post("/api/patients/:phone/change-number", needAdmin, (req, res) => {
  const r = changePatientNumber(req.params.phone, req.body?.newPhone);
  if (!r.ok) return res.status(400).json({ error: r.reason });
  try { logAudit(authUser(req)?.username || "admin", "patient_change_number", `${req.params.phone} -> ${req.body?.newPhone}`); } catch {}
  res.json(r.patient);
});
// OTP لتغيير الرقم (أي موظف داخل)
app.post("/api/otp/request", async (req, res) => {
  res.json(await requestOtp(req.body?.oldPhone, req.body?.newPhone));
});
app.post("/api/otp/confirm", (req, res) => {
  const r = confirmOtp(req.body?.oldPhone, req.body?.newPhone, req.body?.code);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r.patient);
});
app.patch("/api/patients/:phone", (req, res) => {
  const role = authRole(req);
  const body = req.body || {};
  // الاستقبال: الاسم فقط — الطبي للدكتور/الأدمن
  if (!can(role, "patients.update.medical") && ["history", "allergies", "meds", "notes", "birth", "gender", "lastService"].some(k => body[k] !== undefined)) {
    return res.status(403).json({ error: "medical fields: doctor only" });
  }
  if (!can(role, "patients.update.contact")) return res.status(403).json({ error: "forbidden" });
  const p = updatePatient(req.params.phone, body);
  try { logAudit(authUser(req)?.username || role, "patient_update", req.params.phone); } catch {}
  res.json(stripPatient(role, p));
});
app.patch("/api/bookings/:id/pay", (req, res) => {
  const b = setBookingPayment(req.params.id, req.body || {});
  if (!b) return res.status(404).json({ error: "not found" });
  try { logAudit(authRole(req), "booking_pay", `#${req.params.id} deposit=${req.body?.deposit} paid=${req.body?.paid}`); } catch {}
  res.json(b);
});
app.get("/api/export.csv", needAdmin, (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=bookings.csv");
  res.send(exportBookingsCSV());
});

// استقبال واتساب
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  // العيادة من رقم الواتساب المستقبل (phone_number_id) أو ?clinic= — عزل كامل لكل عيادة
  let slug = String(req.query?.clinic || "");
  try {
    const pid = req.body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    if (pid && pid !== (process.env.WHATSAPP_PHONE_NUMBER_ID || "")) {
      const found = listTenants().find(t => t.slug !== "default" && t.whatsapp?.phoneId === pid);
      if (found) slug = found.slug;
    }
  } catch {}
  if (!validSlug(slug) || (slug !== "default" && !getTenantMeta(slug))) slug = currentSlug();
  withTenant(slug, () => processWebhook(req.body).catch(e => console.error("webhook:", e.message)));
});
async function processWebhook(body) {
  const inc = parseIncoming(body);
  if (!inc) return;
  if (inc.msgId && alreadyProcessed(inc.msgId)) return; // رسالة مكررة من واتساب → تجاهل (منع حجز مرتين)
  if (tooFast(inc.from)) return; // سبام: تجاهل بصمت
  // الاشتراك: المنتهي يرد برسالة دفع بدل الخدمة (اللوحة تفضل شغالة للقراءة)
  const sub = subscriptionStatus();
  if (!sub.active) {
    const msg = "عذراً 🌹 اشتراك العيادة في خدمة الحجز الذكي منتهي حالياً. تواصل مع إدارة المجمع.";
    logMessage(inc.from, "in", inc.text || "(فويس)");
    logMessage(inc.from, "out", msg);
    try { await sendWhatsApp(inc.from, msg); } catch {}
    return;
  }
  logMessage(inc.from, "in", inc.text || "(فويس)");
  // أنواع غير مدعومة (صورة/ملصق/فيديو/لوكيشن...) → رد واضح بدل ما تدخل الحجز
  if (/^\[نوع غير مدعوم: (.+)\]$/.test(inc.text || "")) {
    const kind = inc.text.match(/^\[نوع غير مدعوم: (.+)\]$/)?.[1] || "";
    const reply = kind === "image"
      ? "استلمت الصورة يا فندم 🌹 بس مقدرش أشوف الصور — ابعت طلبك كتابة أو فويس (مثال: عايز احجز كشف جلدية بكرة)."
      : "معلش يا فندم، النوع ده مش مدعوم 🙏 ابعت طلبك كتابة أو رسالة صوتية.";
    logMessage(inc.from, "out", reply);
    try { await sendWhatsApp(inc.from, reply); } catch {}
    return;
  }
  let userText = inc.text;
  if (inc.isVoice) {
    const tr = await transcribeVoice(inc.mediaId);
    if (tr.text) {
      logMessage(inc.from, "in", `[فويس] ${tr.text}`);
      userText = tr.text;
    } else {
      const reply = "معلش يا فندم، مقدرتش أسمع الفويس 🙏 ممكن تبعت طلبك كتابة؟ (مثال: عايز احجز كشف جلدية بكرة)";
      logMessage(inc.from, "out", reply);
      try { await sendWhatsApp(inc.from, reply); } catch (e) { console.error("voice fallback failed", e.message); }
      return;
    }
  }
  try {
    const reply = await handleUserMessage(inc.from, userText);
    logMessage(inc.from, "out", reply);
    await sendWhatsApp(inc.from, reply);
  } catch (e) {
    console.error(e);
    await sendWhatsApp(inc.from, "معلش يا فندم حصل عطل بسيط، ممكن تبعت رسالتك تاني؟");
  }
}

// حماية سبام: حد أقصى 15 رسالة/دقيقة لكل رقم (عشان محدش يحرق الكوتة)
const rl = new Map();
function tooFast(phone) {
  const now = Date.now();
  const arr = (rl.get(phone) || []).filter(t => now - t < 60000);
  arr.push(now);
  if (rl.size > 5000) rl.clear();
  rl.set(phone, arr);
  return arr.length > 15;
}

// تجربة من الداشبورد
app.post("/api/chat", async (req, res) => {
  try {
    const { phone = "test", text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: "ابعت نص" });
    if (String(text).length > 1000) return res.status(400).json({ error: "الرسالة طويلة (1000 حرف حد أقصى)" });
    if (tooFast(phone)) return res.status(429).json({ error: "بالراحة شوية 😅 ابعت بعد دقيقة" });
    const sub = subscriptionStatus();
    if (!sub.active) return res.status(402).json({ error: "اشتراك العيادة منتهي — تواصل مع الإدارة" });
    logMessage(phone, "in", text);
    const reply = await handleUserMessage(phone, String(text));
    logMessage(phone, "out", reply);
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "عطل داخلي" });
  }
});

app.get("/api/bookings", (req, res) => {
  if (req.query.page || req.query.limit || req.query.q) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const q = String(req.query.q || "").trim();
    return res.json(getBookingsPaged({ page, limit, q }));
  }
  res.json(getBookings());
});
app.get("/api/messages", (req, res) => {
  if (req.query.page || req.query.limit) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    return res.json(getMessagesPaged({ page, limit }));
  }
  res.json(getMessages(150));
});
app.get("/api/stats", (req, res) => res.json(getStats()));
app.delete("/api/bookings/:id", needAdmin, (req, res) => {
  const ok = deleteBooking(req.params.id);
  try { logAudit(authUser(req)?.username || "admin", "booking_del", `#${req.params.id}`); } catch {}
  res.json({ ok });
});
app.patch("/api/bookings/:id", (req, res) => {
  const b = setBookingStatus(req.params.id, req.body.status || "cancelled");
  if (!b) return res.status(404).json({ error: "not found" });
  try { logAudit(authRole(req), "booking_status", `#${req.params.id} -> ${req.body.status}`); } catch {}
  res.json(b);
});
app.get("/api/handoffs", (req, res) => res.json(getHandoffs()));
app.post("/api/handoffs/resolve", (req, res) => {
  resolveHandoff(req.body?.phone);
  res.json({ ok: true });
});
app.post("/api/reset", needAdmin, (req, res) => { clearAll(); try { logAudit("admin", "reset", "clear all"); } catch {} res.json({ ok: true }); });
// محادثة جديدة: يمسح ذاكرة رقم معين (عشان تجربة موضوع جديد بدون لخبطة القديم)
app.post("/api/new-chat", (req, res) => {
  const { phone = "test" } = req.body || {};
  resetPhone(phone);
  res.json({ ok: true });
});

// إعدادات البيزنس
// إعدادات البيزنس (ملف العيادة الحالية)
app.get("/api/config", (req, res) => {
  res.json(JSON.parse(readFileSync(CONFIG_PATH(), "utf-8")));
});
app.post("/api/config", needAdmin, (req, res) => {
  try {
    const cur = JSON.parse(readFileSync(CONFIG_PATH(), "utf-8"));
    const next = { ...cur, ...req.body };
    writeFileSync(CONFIG_PATH(), JSON.stringify(next, null, 2), "utf-8");
    try { logAudit(authRole(req), "config", "update business config"); } catch {}
    res.json(next);
  } catch (e) { res.status(400).json({ error: "config invalid" }); }
});
// خدمات وأطباء (CRUD من اللوحة — بدل ملف فقط)
app.post("/api/services", needAdmin, (req, res) => {
  try {
    if (!req.body.name || String(req.body.name).trim().length < 2) return res.status(400).json({ error: "اسم الخدمة مطلوب" });
    const cur = JSON.parse(readFileSync(CONFIG_PATH(), "utf-8"));
    cur.services = cur.services || [];
    if (cur.services.some(s => s.name === String(req.body.name).trim())) return res.status(400).json({ error: "موجودة بالفعل" });
    cur.services.push({ name: String(req.body.name).trim().slice(0, 60), price: Math.max(0, Number(req.body.price) || 0), duration_min: Math.min(240, Math.max(5, Number(req.body.duration_min) || 20)), specialty: String(req.body.specialty || "عام").slice(0, 40) });
    writeFileSync(CONFIG_PATH(), JSON.stringify(cur, null, 2), "utf-8");
    try { logAudit(authRole(req), "service_add", req.body.name); } catch {}
    res.json(cur.services);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/services/:name", needAdmin, (req, res) => {
  try {
    const cur = JSON.parse(readFileSync(CONFIG_PATH(), "utf-8"));
    cur.services = (cur.services || []).filter(s => s.name !== req.params.name);
    writeFileSync(CONFIG_PATH(), JSON.stringify(cur, null, 2), "utf-8");
    try { logAudit(authRole(req), "service_del", req.params.name); } catch {}
    res.json(cur.services);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/doctors", needAdmin, (req, res) => {
  try {
    const cur = JSON.parse(readFileSync(CONFIG_PATH(), "utf-8"));
    cur.doctors = cur.doctors || [];
    cur.doctors.push({ name: req.body.name, specialty: req.body.specialty, info: req.body.info || "", days: req.body.days || [], photo: req.body.photo || "" });
    writeFileSync(CONFIG_PATH(), JSON.stringify(cur, null, 2), "utf-8");
    try { logAudit(authRole(req), "doctor_add", req.body.name); } catch {}
    res.json(cur.doctors);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// قاعدة المعرفة + تدقيق + إشعارات
app.get("/api/kb", (req, res) => res.json(getKbDocs()));
app.post("/api/kb", needAdmin, (req, res) => {
  const id = addKbDoc(req.body.title || "بدون عنوان", req.body.body || "");
  try { logAudit(authRole(req), "kb_add", req.body.title); } catch {}
  res.json({ ok: true, id });
});
app.delete("/api/kb/:id", needAdmin, (req, res) => res.json({ ok: deleteKbDoc(req.params.id) }));
app.get("/api/audit", needAdmin, (req, res) => {
  if (req.query.page || req.query.limit) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    return res.json(getAuditPaged({ page, limit }));
  }
  res.json(getAudit(100));
});
app.get("/api/notifications", (req, res) => {
  if (req.query.page || req.query.limit) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    return res.json(getNotificationsPaged({ page, limit }));
  }
  res.json(getNotifications(100));
});
app.get("/api/role", (req, res) => {
  const u = authUser(req);
  const full = u?.username ? getUser(u.username) : null;
  res.json({ role: u?.role || null, username: u?.username || null, doctor: full?.doctor || null });
});
// حجوزات الدكتور المرتبط (بوابة دكتور) — reception مرفوض
app.get("/api/doctor/today", (req, res) => {
  const u = authUser(req);
  if (!u || (u.role !== "doctor" && u.role !== "admin")) return res.status(403).json({ error: "doctor only" });
  const link = u.role === "admin" ? (req.query.doctor || "") : ((getUser(u.username)?.doctor) || "");
  const n = new Date();
  const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  let list = getBookings().filter(b => ["confirmed", "reminded"].includes(b.status) && b.date >= today);
  if (link) list = list.filter(b => b.doctor === link);
  res.json({ doctor: link || "all", count: list.length, bookings: list });
});
// زيارات طبية — كتابة التشخيص/العلاج للدكتور والأدمن فقط
app.post("/api/visits", needRole("doctor"), (req, res) => {
  const b = req.body || {};
  if (!b.patient) return res.status(400).json({ error: "patient required (pid/phone)" });
  const target = getPatientFull(b.patient);
  if (!target) return res.status(404).json({ error: "patient not found" });
  const id = addVisit({
    pid: target.pid, phone: target.phone, doctor: b.doctor || "", specialty: b.specialty || "",
    bookingCode: b.booking_code || "", complaint: String(b.complaint || "").slice(0, 500),
    notes: b.doctor_notes || "", diagnosis: b.diagnosis || "", treatment: b.treatment || "",
    by: authUser(req)?.username || ""
  });
  try { logAudit(authUser(req)?.username, "visit_add", `pid ${target.pid} visit ${id}`); } catch {}
  res.json({ ok: true, id });
});
app.patch("/api/visits/:id", needRole("doctor"), (req, res) => {
  const ok = updateVisit(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: "not found" });
  try { logAudit(authUser(req)?.username, "visit_update", `visit ${req.params.id}`); } catch {}
  res.json({ ok: true });
});
app.delete("/api/visits/:id", needAdmin, (req, res) => {
  res.json({ ok: deleteVisit(req.params.id) });
});
// قائمة الانتظار
app.get("/api/waitlist", (req, res) => res.json(getWaitlist(req.query.status || "waiting")));
app.delete("/api/waitlist/:id", (req, res) => res.json({ ok: removeFromWaitlist(req.params.id) }));
app.post("/api/waitlist/:id/notify", async (req, res) => {
  const w = getWaitlist("waiting").find(x => String(x.id) === String(req.params.id));
  if (!w) return res.status(404).json({ error: "not found" });
  try {
    await sendWhatsApp(w.phone, `خبر حلو يا ${w.name || "فندم"} 🌹 فضي معاد ${w.service} يوم ${w.date}. تحب أحجزلك؟ رد (احجز).`);
    markWaitNotified(w.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// مستندات المريض — رفع للموظفين، تحميل للدكتور/الأدمن فقط
app.post("/api/docs", (req, res) => {
  const b = req.body || {};
  if (!b.patient) return res.status(400).json({ error: "patient required" });
  if (!b.data || String(b.data).length > 7 * 1024 * 1024) return res.status(400).json({ error: "ملف حتى 5MB" });
  const target = getPatientFull(b.patient);
  if (!target) return res.status(404).json({ error: "patient not found" });
  const r = addDoc({ pid: target.pid, phone: target.phone, kind: b.kind, filename: b.filename, mime: b.mime, base64: b.data, by: authUser(req)?.username || "" });
  if (!r.ok) return res.status(400).json({ error: r.error });
  try { logAudit(authUser(req)?.username, "doc_add", `pid ${target.pid} doc ${r.id}`); } catch {}
  res.json(r);
});
app.get("/api/docs", (req, res) => {
  if (!req.query.patient) return res.status(400).json({ error: "patient required" });
  const target = getPatientFull(req.query.patient);
  if (!target) return res.status(404).json({ error: "not found" });
  res.json(getDocsByPatient(target.pid, target.phone));
});
app.get("/api/docs/:id", needRole("doctor"), (req, res) => {
  const d = getDoc(req.params.id);
  if (!d) return res.status(404).json({ error: "not found" });
  res.setHeader("Content-Type", d.mime);
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(d.filename)}"`);
  res.send(Buffer.from(d.data));
});
app.get("/api/docs/:id/thumb", needRole("doctor"), async (req, res) => {
  const d = getDoc(req.params.id);
  if (!d) return res.status(404).json({ error: "not found" });
  // Antivirus already done via magic check; thumbnail: try sharp resize, else original with cache
  if (d.mime.startsWith("image/")) {
    try {
      const sharp = await import("sharp").then(m => m.default).catch(() => null);
      if (sharp) {
        const buf = await sharp(Buffer.from(d.data)).resize(200, 200, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.send(buf);
      }
    } catch {}
  }
  res.setHeader("Content-Type", d.mime);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(Buffer.from(d.data));
});
app.delete("/api/docs/:id", needAdmin, (req, res) => res.json({ ok: deleteDoc(req.params.id) }));
// إدارة المستخدمين — أدمن فقط
app.get("/api/users", needAdmin, (req, res) => res.json(listUsers()));
app.post("/api/users", needAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || String(password).length < 6) return res.status(400).json({ error: "username + password(6+) required" });
  if (!["admin", "doctor", "reception"].includes(role)) return res.status(400).json({ error: "role: admin|doctor|reception" });
  const u = createUser(username, hashPassword(password), role);
  if (!u) return res.status(400).json({ error: "username exists" });
  try { logAudit(authUser(req)?.username, "user_create", `${username} (${role})`); } catch {}
  res.json({ ok: true, username: u.username, role: u.role });
});
app.patch("/api/users/:username", (req, res) => {
  const me = authUser(req)?.username;
  const myRole = authRole(req);
  const target = String(req.params.username).toLowerCase();
  const body = req.body || {};
  if (body.password) {
    if (String(body.password).length < 6) return res.status(400).json({ error: "password 6+ required" });
    if (me !== target && myRole !== "admin") return res.status(403).json({ error: "forbidden" });
    if (!getUser(target)) return res.status(404).json({ error: "not found" });
    setUserHash(target, hashPassword(body.password));
  }
  if (body.active !== undefined) {
    if (myRole !== "admin") return res.status(403).json({ error: "admin only" });
    if (me === target && !body.active) return res.status(400).json({ error: "لا تقفل نفسك" });
    setUserActive(target, !!body.active);
  }
  if (body.doctor !== undefined) {
    if (myRole !== "admin") return res.status(403).json({ error: "admin only" });
    linkDoctor(target, body.doctor);
  }
  try { logAudit(me, "user_update", target); } catch {}
  res.json({ ok: true });
});
app.delete("/api/users/:username", needAdmin, (req, res) => {
  const me = authUser(req)?.username;
  const target = String(req.params.username).toLowerCase();
  if (me === target) return res.status(400).json({ error: "لا تمسح نفسك" });
  if (target === "admin") return res.status(400).json({ error: "لا تمسح admin الأساسي" });
  try { logAudit(me, "user_delete", target); } catch {}
  res.json({ ok: deleteUser(target) });
});
// التحقق من النسخة الاحتياطية (integrity للقراءة فقط — من غير المساس بالحي)
app.post("/api/backup-verify", needAdmin, async (req, res) => {
  try {
    const st = getBackupStatus();
    if (!st.last) return res.json({ ok: false, error: "مفيش نسخ" });
    const { DatabaseSync } = await import("node:sqlite");
    const path = await import("path");
    const { backupDir, decryptBackupToTemp } = await import("./store.js");
    const full = path.join(backupDir(), st.last);
    let tmp = full, openedHere = false;
    if (st.last.endsWith(".enc")) { tmp = decryptBackupToTemp(full); openedHere = true; }
    const db = new DatabaseSync(tmp, { readOnly: true });
    const r = db.prepare("PRAGMA integrity_check").get();
    const tables = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
    try { db.close(); } catch {}
    if (openedHere) { try { (await import("fs")).unlinkSync(tmp); } catch {} }
    const ok = r && /ok/i.test(r.integrity_check || "");
    try { logCron("backup-verify", !!ok, ok ? "" : JSON.stringify(r)); } catch {}
    try { logAudit(authUser(req)?.username, "backup_verify", `${st.last}: ${ok ? "ok" : "FAIL"}`); } catch {}
    res.json({ ok: !!ok, file: st.last, tables, encrypted: st.last.endsWith(".enc") });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// تجربة استرجاع فعلية وآمنة (تفتح نسخة مؤقتة وتعد الصفوف — من غير المساس بالحي)
app.post("/api/backup-restore-test", needAdmin, (req, res) => {
  import("./store.js").then(s => {
    const r = s.restoreDrill();
    try { logAudit(authUser(req)?.username, "restore_test", `${r.file}: ${r.ok ? "ok" : r.error || "FAIL"}`); } catch {}
    res.json(r);
  }).catch(e => res.status(500).json({ ok: false, error: e.message }));
});
// مسح بيانات التجربة فقط (المحادثة التجريبية — الداتا الحقيقية سليمة)
app.post("/api/admin/purge-test", needAdmin, (req, res) => {
  const r = purgeTestData();
  try { logAudit(authUser(req)?.username, "purge_test", JSON.stringify(r)); } catch {}
  res.json({ ok: true, ...r });
});
// مسح الرسائل القديمة (سياسة الاحتفاظ — افتراضي 365 يوم)
app.post("/api/admin/purge", needAdmin, (req, res) => {
  const days = Math.max(30, Number(process.env.RETENTION_DAYS || req.body?.days || 365));
  const r = purgeOldMessages(days);
  try { logAudit(authUser(req)?.username, "purge", `messages older than ${days}d: ${r.deleted}`); } catch {}
  res.json({ ok: true, deleted: r.deleted, days });
});

// ---------- الموقع العام (من غير دخول) ----------
app.get("/api/public/info", (req, res) => {
  const c = loadConfig();
  res.json({
    name: c.name, tagline: c.tagline || "", about: c.about || "",
    hero_image: c.hero_image || "", working_hours: c.working_hours, address: c.address,
    emergency_phone: c.emergency_phone,
    services: (c.services || []).map(s => ({ name: s.name, price: s.price, specialty: s.specialty })),
    doctors: (c.doctors || []).map(d => ({ name: d.name, specialty: d.specialty, info: d.info, days: d.days || [], photo: d.photo || "" })),
    testimonials: c.testimonials || [], faqs: c.faqs || []
  });
});
// محتوى الموقع (آراء/أسئلة) — أدمن فقط
app.post("/api/content", needAdmin, (req, res) => {
  const { kind, item } = req.body || {};
  if (!["testimonial", "faq"].includes(kind) || !item) return res.status(400).json({ error: "kind: testimonial|faq + item" });
  const cur = JSON.parse(readFileSync(CONFIG_PATH(), "utf-8"));
  const key = kind === "testimonial" ? "testimonials" : "faqs";
  cur[key] = cur[key] || [];
  if (kind === "testimonial") {
    item.name = String(item.name || "").slice(0, 60); item.text = String(item.text || "").slice(0, 500);
    item.stars = Math.min(5, Math.max(1, Number(item.stars) || 5));
    if (!item.name || !item.text) return res.status(400).json({ error: "name + text required" });
  } else {
    item.q = String(item.q || "").slice(0, 200); item.a = String(item.a || "").slice(0, 1000);
    if (!item.q || !item.a) return res.status(400).json({ error: "q + a required" });
  }
  cur[key].push(item);
  writeFileSync(CONFIG_PATH(), JSON.stringify(cur, null, 2), "utf-8");
  try { logAudit(authUser(req)?.username, "content_add", `${kind}: ${JSON.stringify(item).slice(0, 100)}`); } catch {}
  res.json({ ok: true, count: cur[key].length });
});
app.delete("/api/content/:kind/:index", needAdmin, (req, res) => {
  const key = req.params.kind === "testimonial" ? "testimonials" : req.params.kind === "faq" ? "faqs" : null;
  if (!key) return res.status(400).json({ error: "kind invalid" });
  const cur = JSON.parse(readFileSync(CONFIG_PATH(), "utf-8"));
  cur[key] = cur[key] || [];
  const i = Number(req.params.index);
  if (!(i >= 0 && i < cur[key].length)) return res.status(404).json({ error: "not found" });
  cur[key].splice(i, 1);
  writeFileSync(CONFIG_PATH(), JSON.stringify(cur, null, 2), "utf-8");
  res.json({ ok: true, count: cur[key].length });
});
app.get("/api/public/slots", (req, res) => {
  if (tooFast(`slots-${clientIp(req)}`)) return res.status(429).json({ error: "بالراحة شوية 😅" });
  const { service, date } = req.query;
  if (!service || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return res.status(400).json({ error: "service + date (YYYY-MM-DD) required" });
  const config = loadConfig();
  if (!config.services.some(s => s.name === service)) return res.status(404).json({ error: "unknown service" });
  res.json(daySlots(date, service, config, activeBookings()));
});
app.post("/api/public/book", (req, res) => {
  const { name, phone, service, date, time } = req.body || {};
  if (!name || String(name).trim().length < 2) return res.status(400).json({ error: "الاسم مطلوب" });
  if (!/^01[0125][0-9]{8}$/.test(String(phone || "").replace(/[\s-]/g, ""))) return res.status(400).json({ error: "رقم موبايل مصري سليم مطلوب" });
  if (!service || !date || !time) return res.status(400).json({ error: "الخدمة واليوم والساعة مطلوبة" });
  if (tooFast(`web-${phone}`)) return res.status(429).json({ error: "محاولات كتير — جرب بعد دقيقة" });
  const sub = subscriptionStatus();
  if (!sub.active) return res.status(402).json({ error: "الحجز متوقف حالياً — تواصل مع العيادة" });
  const slotText = `${date} الساعة ${time}`;
  const chk = check_availability(service, slotText);
  if (!chk.ok) return res.status(409).json({ error: chk.reason, alternatives: chk.alternatives || [] });
  let r;
  try {
    r = book_appointment({ from: `web-${phone}`, name: String(name).trim().slice(0, 40), phone: String(phone).replace(/[\s-]/g, ""), service, slotText, actor: "public-site" });
  } catch (e) { return res.status(409).json({ error: "المعاد اتحجز حالاً — اختار معاد تاني" }); }
  if (!r.ok) return res.status(409).json({ error: r.reason, alternatives: r.alternatives || [] });
  res.json({ ok: true, code: r.booking.code, slot: r.booking.slot, doctor: r.booking.doctor, service: r.booking.service });
});
// طلب عيادة جديدة ذاتياً (من الموقع العام — يتخزن في المنصة)
app.post("/api/public/request-clinic", (req, res) => {
  const { name, slug, phone } = req.body || {};
  if (!name || String(name).trim().length < 3) return res.status(400).json({ error: "اسم العيادة مطلوب" });
  if (!/^01[0125][0-9]{8}$/.test(String(phone || "").replace(/[\s-]/g, ""))) return res.status(400).json({ error: "رقم موبايل مصري سليم مطلوب" });
  const s = String(slug || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "").slice(0, 32) || ("clinic-" + Date.now().toString(36));
  try {
    const id = withTenant("default", () => addClinicRequest({ name: String(name).trim(), slug: s, phone }));
    res.json({ ok: true, id, slug: s });
  } catch (e) { res.status(500).json({ error: "حاول تاني" }); }
});
app.post("/api/public/pay", (req, res) => {
  const { code, phone } = req.body || {};
  const b = getBookingByCode(code, phone);
  if (!b || b.denied) return res.status(404).json({ error: "الحجز مش موجود أو الرقم غلط" });
  if (!["confirmed", "reminded"].includes(b.status)) return res.status(400).json({ error: "الحجز مش نشط" });
  if (b.paid) return res.status(400).json({ error: "مدفوع already ✅" });
  const amount = (b.deposit && b.deposit > 0) ? b.deposit : 100;
  const token = createPayIntent(b.code, b.phone, amount);
  res.json({ ok: true, token, amount, code: b.code });
});
app.post("/api/public/pay/confirm", (req, res) => {
  const r = confirmPayIntent(req.body?.token);
  if (!r) return res.status(400).json({ error: "عملية غير صالحة أو تمت قبل كده" });
  res.json({ ok: true, code: r.booking_code, amount: r.amount });
});

// ---------- السوبر أدمن (مالك المنصة — إدارة العيادات والاشتراكات) ----------
const superTokens = new Map(); // token → expires
function needSuper(req, res, next) {
  const c = cookies(req);
  const t = superTokens.get(c.super_sess || "");
  if (t && t > Date.now()) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "super login required" });
  return res.redirect("/super.html");
}
app.post("/api/super/login", (req, res) => {
  const pw = String(req.body?.password || "");
  if (!process.env.SUPERADMIN_PASSWORD || process.env.SUPERADMIN_PASSWORD === "PASTE_HERE") {
    return res.status(400).json({ error: "ظبط SUPERADMIN_PASSWORD في .env الأول" });
  }
  if (pw !== process.env.SUPERADMIN_PASSWORD) {
    try { logAudit("super", "login_fail", clientIp(req)); } catch {}
    return res.status(401).json({ error: "غلط" });
  }
  const token = newToken();
  superTokens.set(token, Date.now() + 12 * 3600000);
  res.setHeader("Set-Cookie", `super_sess=${token}; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}; Path=/${secureFlag(req)}`);
  try { logAudit("super", "login", clientIp(req)); } catch {}
  res.json({ ok: true });
});
app.post("/api/super/logout", (req, res) => {
  try { superTokens.delete(cookies(req).super_sess); } catch {}
  res.setHeader("Set-Cookie", "super_sess=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/");
  res.json({ ok: true });
});
app.get("/api/super/tenants", needSuper, (req, res) => {
  res.json(listTenants().map(t => ({ ...t, sub: subscriptionStatus(t.slug) })));
});
app.post("/api/super/tenants", needSuper, (req, res) => {
  const r = createTenant(req.body?.slug, req.body?.name);
  if (!r.ok) return res.status(400).json({ error: r.error });
  try { logAudit("super", "tenant_create", r.slug); } catch {}
  res.json(r);
});
app.patch("/api/super/tenants/:slug", needSuper, (req, res) => {
  const slug = req.params.slug;
  const m = getTenantMeta(slug);
  if (!m) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  if (b.name !== undefined) m.name = String(b.name).slice(0, 100);
  if (b.status !== undefined && ["active", "suspended"].includes(b.status)) m.status = b.status;
  if (b.plan !== undefined) m.plan = String(b.plan).slice(0, 30);
  if (b.trialEnds !== undefined) m.trialEnds = b.trialEnds || null;
  if (b.whatsapp && typeof b.whatsapp === "object") m.whatsapp = { ...(m.whatsapp || {}), ...b.whatsapp };
  saveTenantMeta(slug, m);
  try { logAudit("super", "tenant_update", `${slug}: ${JSON.stringify(b).slice(0, 150)}`); } catch {}
  res.json({ ok: true, sub: subscriptionStatus(slug) });
});
app.delete("/api/super/tenants/:slug", needSuper, async (req, res) => {
  if (!await deleteTenant(req.params.slug)) return res.status(400).json({ error: "failed" });
  try { logAudit("super", "tenant_delete", req.params.slug); } catch {}
  res.json({ ok: true });
});
// طلبات العيادات: عرض + موافقة (ينشئ العيادة + أدمن بكلمة مرور لمرة واحدة) + رفض
app.get("/api/super/requests", needSuper, (req, res) => {
  res.json(withTenant("default", () => getClinicRequests()));
});
app.post("/api/super/requests/:id/approve", needSuper, (req, res) => {
  const r = withTenant("default", () => getClinicRequests().find(x => String(x.id) === String(req.params.id)));
  if (!r || r.status !== "pending") return res.status(404).json({ error: "not found" });
  const c = createTenant(r.slug, r.name);
  if (!c.ok) return res.status(400).json({ error: c.error });
  const crypto2 = crypto.randomBytes(4).toString("hex");
  const adminPass = `admin-${crypto2}`;
  withTenant(r.slug, () => {
    try { createUser("admin", hashPassword(adminPass), "admin"); } catch {}
  });
  withTenant("default", () => decideClinicRequest(r.id, "approved"));
  try { logAudit("super", "request_approve", `${r.slug} (${r.name})`); } catch {}
  res.json({ ok: true, slug: r.slug, adminUser: "admin", adminPass });
});
app.post("/api/super/requests/:id/reject", needSuper, (req, res) => {
  withTenant("default", () => decideClinicRequest(req.params.id, "rejected"));
  res.json({ ok: true });
});
// نظرة المنصة: كل العيادات (اشتراك/حجوزات/أعطال/نسخ) في شاشة واحدة
app.get("/api/super/overview", needSuper, (req, res) => {
  const out = listTenants().map(t => {
    try {
      return withTenant(t.slug, () => {
        const act = activeBookings();
        const crons = getCronStatus();
        let q = null;
        try { q = getQueueStatus(); } catch {}
        return {
          slug: t.slug, name: t.name, plan: t.plan, sub: subscriptionStatus(t.slug),
          activeBookings: act.length,
          cronFail: crons.filter(c => c.last_failure && (!c.last_success || c.last_failure > c.last_success)).map(c => c.name),
          queue: q ? { pending: q.pending || 0, failed: q.failed || 0 } : null,
          backup: getBackupStatus(),
        };
      });
    } catch (e) { return { slug: t.slug, error: e.message }; }
  });
  res.json(out);
});

const PORT = process.env.PORT || 3000;
startQueueWorker(5000);
app.listen(PORT, () => console.log(`✅ شغال على http://localhost:${PORT}`));
