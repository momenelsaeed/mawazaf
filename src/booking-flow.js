// State Machine للحجز/الإلغاء/التعديل — بديل حتمي للاستنتاج من النص
// IDLE → BOOKING(SERVICE→SLOT→CONTACT→CONFIRM→BOOKED) | CANCEL(CODE→CONFIRM→CANCELLED) | RESCHED(CODE→SLOT→CONFIRM→UPDATED)
// يستخدم نفس مستخرجات ai.js + نفس أدوات tools.js، والحالة محفوظة في pending (بتفضل بعد الـ Restart).
import { readFileSync } from "fs";
import { findService, findPhone, findSlot, timeIsAmbiguous, extractName, getPendingState, setPendingState } from "./ai.js";
import { detectSpecialty, classifyUrgency } from "./medical-knowledge.js";
import { validateBooking, parseSlotLabel } from "./schedule.js";
import { activeBookings, getBookingByCode, cancelByCode, updateBookingSlot, getLatestActiveByPhone, addToWaitlist, matchWaitlist, markWaitNotified } from "./store.js";
import { sendWhatsApp } from "./whatsapp.js";
const WAIT_RE = /(انتظار|ضيفني|ضيفنى|موافق.*انتظار|أيوه.*انتظار|قايمه الانتظار|قائمة الانتظار)/;
import { book_appointment } from "./tools.js";

import { getConfig } from "./tenants.js";
function loadConfig() {
  return getConfig();
}

const CONFIRM_RE = /^(تأكيد|اكد|أكد|أكيد|اكيد|تمام|ايوه|أيوه|نعم|مؤكد|اوكيه|اوكي|yes|ok|confirm)[.!؟\s]*$/i;
const ABORT_RE = /^(لا|لأ|لاء|بلاش|خلاص|مش عايز|مش عاوز)[.!؟\s]*$/;
const CODE_RE = /SCH-\d{4}-\d{4,20}/i;
const BOOK_RE = /(حجز|احجز|معاد|ميعاد|موعد|ابغى|ابغي|ابي|بدي|اريد|book|reserve|appointment)/i;
// فعل حجز صريح (مش اسم): "احجز/عايز/عاوز/أبغى..." — عشان "بكام الحجز؟" متدخلش فلو الحجز
const BOOK_VERB_RE = /(احجز|عايز|عاوز|عايزه|ابغى|ابغي|ابي|بدي|اريد|ودي|book|reserve)/i;
const PRICE_RE = /(بكام|بكم|سعر|تكلفه|اسعار|أسعار|قديش|ثمن|اتعاب|بشحال|شقد|بقديش|price|cost|how much)/i;
const CANCEL_RE = /(لغي|لغاء|كنسل|cancel|فسخ)/;
const RESCHED_RE = /(عدل|أجل|اجل|قدم|أخر|اخر|غير|انقل|احول|أحول)/;
const LATEST_RE = /(الاخير|الأخير|اخر حجز|آخر حجز|الاخيره|الأخيرة)/;
const PERIOD_AM = /(صبح|صباح|فجر)/;
const PERIOD_PM = /(بليل|ليل|مساء|مغرب|ضهر|عصر|عشا)/;

const isMobile = s => /^01[0125][0-9]{8}$/.test(String(s || ""));
const isSenderPhone = from => isMobile(from);

// إلغاء حجز → بلغ أول المنتظرين لنفس الخدمة واليوم
export async function notifyWaitlist(service, date) {
  try {
    const list = matchWaitlist(service, date, 3);
    for (const w of list) {
      const msg = `خبر حلو يا ${w.name || "فندم"} 🌹 فضي معاد ${service} يوم ${date}. تحب أحجزلك؟ رد (احجز).`;
      try { await sendWhatsApp(w.phone, msg); markWaitNotified(w.id); } catch {}
    }
    return list.length;
  } catch { return 0; }
}

function getSM(phone) {
  const p = getPendingState(phone);
  return (p && p.sm) || null;
}
function setSM(phone, sm) {
  // تنظيف مفاتيح نظام ai.js القديم عشان النظامان ميتعارضوش
  setPendingState(phone, {
    sm,
    service: null, slot: null, suggested: null, step: null,
    confirm_booking: null, reschedId: null, needPeriod: null, dayPart: null, hour: null
  });
}
function clearSM(phone) {
  setPendingState(phone, { sm: null });
}

// سحب الكيانات من رسالة واحدة (خدمة/معاد/اسم/رقم/كود) — تُستدعى في كل خطوة
function extract(text, data, config) {
  const t = String(text || "");
  const svc = findService(t, config);
  if (svc) { data.service = svc; delete data.spec; }
  if (!data.service && !svc) {
    // تخصص بالاسم من غير خدمة صريحة ("أسنان") — بس لو مفيش "الساعة + رقم" (عشان المغرب/الصبح وقت مش وجع)
    let s = t;
    if (/الساعة\s*\d/.test(t)) s = s.replace(/(الضهر|العصر|المغرب|الصبح|بليل|مساء|المساء|العشا|الفجر|الصباح|الظهر)/g, "");
    const spec = detectSpecialty(s);
    if (spec && config.services.some(x => x.name.includes(spec))) data.spec = spec;
  }
  // حل غموض معلق من الرسالة السابقة
  if (data.pendPeriod) {
    const nt = t.replace(/[\u064B-\u0652]/g, "");
    if (PERIOD_AM.test(nt)) { data.slotText = `${data.pendPeriod.day} الساعة ${data.pendPeriod.hour} الصبح`; delete data.pendPeriod; }
    else if (PERIOD_PM.test(nt)) { data.slotText = `${data.pendPeriod.day} الساعة ${data.pendPeriod.hour} المغرب`; delete data.pendPeriod; }
  }
  if (!data.slotText) {
    const slot = findSlot(t);
    if (slot) {
      const amb = timeIsAmbiguous(t);
      if (amb) {
        const m = t.match(/بكرة|بكرا|باجر|باكر|النهاردة|النهارده|اليوم|غدا|بعد بكرة|السبت|الأحد|الاحد|الاتنين|الاثنين|التلات|الثلاثاء|الاربع|الأربعاء|الخميس|الجمعة|الجمعه/);
        data.pendPeriod = { day: (m && m[0]) || "بكرة", hour: amb };
      } else data.slotText = slot;
    }
  }
  const ph = findPhone(t);
  if (ph) data.phone = ph;
  const nm = extractName(t);
  if (nm) data.name = nm;
  const cd = t.toUpperCase().match(CODE_RE);
  if (cd) data.code = cd[0];
  return data;
}

function serviceNames(config, spec) {
  return config.services.filter(s => !spec || s.name.includes(spec)).map(s => s.name);
}

// ---------- BOOKING ----------
function bookingAsk(step, data, config) {
  if (step === "SERVICE") {
    if (data.spec) return `عندنا في ${data.spec}: ${serviceNames(config, data.spec).join(" / ")}. تحب تحجز إيه؟`;
    return `تمام، تحجز إيه يا فندم؟ (${config.services.map(s => s.name).join(" / ")})`;
  }
  if (step === "SLOT") {
    if (data.pendPeriod) return `الساعة ${data.pendPeriod.hour} الصبح ولا المغرب يا فندم؟`;
    const got = [];
    if (data.service) got.push(data.service);
    return `${got.length ? `تمام ${got.join(" ")} ✅ ` : ""}قولي اليوم والساعة (مثال: بكرة الساعة 7 المغرب).`;
  }
  if (step === "CONTACT") {
    const miss = [];
    if (!data.name) miss.push("اسمك");
    if (!data.phone) miss.push("رقم موبايلك");
    return `تمام ${data.service} | ${data.slotText} ✅\nناقصني: ${miss.join(" + ")} (مثال: اسمي أحمد 01012345678).`;
  }
  return "";
}

function bookingAdvance(phone, text, sm, config) {
  const t = String(text || "");
  const data = sm.data;
  // قبول قائمة الانتظار
  if (data.waitOffer && WAIT_RE.test(t)) {
    const w = addToWaitlist({ phone: data.phone && isMobile(data.phone) ? data.phone : phone, name: data.name || "", service: data.waitOffer.service, date: data.waitOffer.date });
    delete data.waitOffer;
    setSM(phone, { ...sm, step: "SLOT", data });
    return w.ok ? "تمام يا فندم، ضفتك لقائمة الانتظار ✅ أول ما يفضى معاد في نفس اليوم هبعتلك فوراً." : "انت مسجل في الانتظار بالفعل لنفس اليوم 🌹";
  }
  // تصحيح المعاد في خطوة التأكيد ("لا بكرة 8 المغرب") → امسح القديم قبل الاستخراج عشان الجديد يتسجل
  if (sm.step === "CONFIRM" && !CONFIRM_RE.test(t) && findSlot(t)) {
    delete data.slotText; delete data.validated; delete data.pendPeriod;
  }
  extract(text, data, config);
  if (ABORT_RE.test(String(text).trim())) { clearSM(phone); return "تمام يا فندم، لغيت الحجز قبل تسجيله 🌹 تحب حاجة تانية؟"; }
  // SERVICE — لو التخصص له خدمة واحدة اختارها، ولو أكثر والمريض قال المعاد خلاص اختار "كشف" (يتصحح في التأكيد)
  if (!data.service) {
    if (data.spec) {
      const cands = serviceNames(config, data.spec);
      if (cands.length === 1) { data.service = cands[0]; delete data.spec; }
      else if (data.slotText || data.pendPeriod) {
        data.service = cands.find(n => n.startsWith("كشف")) || cands[0];
        delete data.spec;
      }
    }
    if (!data.service) {
      setSM(phone, { ...sm, step: "SERVICE", data });
      return bookingAsk("SERVICE", data, config);
    }
  }
  // SLOT
  if (!data.slotText) {
    setSM(phone, { ...sm, step: "SLOT", data });
    return bookingAsk("SLOT", data, config);
  }
  // تحقق مبكر من المعاد قبل طلب البيانات (عشان مناخدش اسم ورقم على معاد محجوز)
  const v = validateBooking(data.service, data.slotText, config, activeBookings());
  if (!v.ok) {
    // المعاد مليان (مش إجازة/وقت فات) → اعرض قائمة الانتظار
    const busy = /(محجوز|مشغول)/.test(v.reason);
    let parsed = null;
    try { parsed = parseSlotLabel(data.slotText); } catch {}
    if (busy && parsed && !parsed.error) data.waitOffer = { service: data.service, date: parsed.date };
    else delete data.waitOffer;
    data.slotText = ""; delete data.pendPeriod;
    setSM(phone, { ...sm, step: "SLOT", data });
    const alt = (v.alternatives || []).length ? `\nالمتاح: ${v.alternatives.join("، ")}` : "";
    const wait = data.waitOffer ? `\nتحب أضيفك لقائمة الانتظار لنفس اليوم؟ رد (انتظار).` : "";
    return `${v.reason}${alt}${wait}`;
  }
  delete data.waitOffer;
  data.validated = { date: v.date, time: v.time, label: v.label, doctor: v.doctor };
  // CONTACT (رقم المرسل نفسه يكفي لو موبايل حقيقي)
  if (!data.phone && isSenderPhone(phone)) data.phone = phone;
  if (!data.name || !data.phone) {
    setSM(phone, { ...sm, step: "CONTACT", data });
    return bookingAsk("CONTACT", data, config);
  }
  // CONFIRM
  if (sm.step === "CONFIRM" && !CONFIRM_RE.test(String(text).trim())) {
    // تصحيح في نفس خطوة التأكيد (مثال: "لا بكرة 8") → حدثنا واعرض الملخص الجديد
    setSM(phone, { ...sm, step: "CONFIRM", data });
    return confirmSummary(data, config);
  }
  if (CONFIRM_RE.test(String(text).trim()) || sm.step !== "CONFIRM") {
    if (!CONFIRM_RE.test(String(text).trim())) {
      setSM(phone, { ...sm, step: "CONFIRM", data });
      return confirmSummary(data, config);
    }
    const r = book_appointment({ from: phone, name: data.name, phone: data.phone, service: data.service, slotText: data.slotText, actor: "state-machine" });
    clearSM(phone);
    if (!r.ok) {
      const alt = (r.alternatives || []).length ? `\nالمتاح: ${r.alternatives.join("، ")}` : "";
      return `${r.reason}${alt}`;
    }
    const b = r.booking;
    const doc = b.doctor ? `\n👨‍⚕️ ${b.doctor}` : "";
    return `✅ تم تسجيل حجزك يا ${b.name}\n📌 ${b.service} | ${b.slot}${doc}\n📍 ${config.address}\nرقم الحجز: ${b.code}\nهنستناك وتنورنا 😊`;
  }
  setSM(phone, { ...sm, step: "CONFIRM", data });
  return confirmSummary(data, config);
}

function confirmSummary(data, config) {
  const doc = data.validated && data.validated.doctor ? ` عند ${data.validated.doctor}` : "";
  const label = (data.validated && data.validated.label) || data.slotText;
  return `تمام يا فندم، هحجزلك:\n📌 ${data.service}${doc}\n🕐 ${label}\n👤 ${data.name} — ${data.phone}\nهل تؤكد؟ (رد: تأكيد / إلغاء)`;
}

// ---------- CANCEL / RESCHED ----------
function lookupBooking(phone, data) {
  if (data.code) {
    const b = getBookingByCode(data.code, phone);
    if (b && b.denied) return { error: "رقم الحجز ده مش مسجل برقمك يا فندم 🔒 لو حجزك ابعت من نفس رقم الواتساب اللي حجزت بيه." };
    if (!b) return { error: "رقم الحجز ده مش موجود أو ملغي يا فندم. اتأكد من الرقم (مثال: SCH-2026-000123) أو قول (الأخير)." };
    return { booking: b };
  }
  return { needCode: true };
}

function cancelAdvance(phone, text, sm) {
  const data = extract(text, sm.data, loadConfig());
  const t = String(text).trim();
  if (ABORT_RE.test(t) && !CANCEL_RE.test(t)) { clearSM(phone); return "تمام يا فندم، في خدمتك أي وقت 🌹"; }
  if (!data.code && LATEST_RE.test(t)) {
    const b = getLatestActiveByPhone(phone);
    if (!b) { clearSM(phone); return "مفيش حجز نشط عندي برقمك يا فندم. تحب تحجز معاد جديد؟"; }
    data.code = b.code; data.bookingId = b.id;
  }
  if (!data.code) {
    setSM(phone, { ...sm, step: "CODE", data });
    return "تمام، ابعت رقم الحجز (مثال: SCH-2026-000123) أو قول (الأخير) لإلغاء آخر حجز.";
  }
  const found = lookupBooking(phone, data);
  if (found.error) { setSM(phone, { ...sm, step: "CODE", data: {} }); return found.error; }
  const b = found.booking;
  if (sm.step !== "CONFIRM") {
    setSM(phone, { ...sm, step: "CONFIRM", data });
    return `هل تؤكد إلغاء حجزك؟\n📌 ${b.service} | ${b.slot} — ${b.code}\n(رد: تأكيد / لا)`;
  }
  if (CONFIRM_RE.test(t)) {
    const c = cancelByCode(data.code, phone);
    clearSM(phone);
    if (!c) return "الحجز ده مبقاش نشط يا فندم.";
    notifyWaitlist(c.service, c.date).catch(() => {});
    return `تمام يا فندم، لغيت حجزك (${c.service} | ${c.slot} — ${c.code}). تحب أحجزلك معاد تاني؟`;
  }
  setSM(phone, { ...sm, step: "CODE", data: {} });
  return "تمام، ملغيناش حاجة 🌹 تحب حاجة تانية؟";
}

function reschedAdvance(phone, text, sm, config) {
  const data = extract(text, sm.data, config);
  const t = String(text).trim();
  if (!data.code && LATEST_RE.test(t)) {
    const b = getLatestActiveByPhone(phone);
    if (!b) { clearSM(phone); return "مفيش حجز نشط عندي برقمك يا فندم. تحب تحجز معاد جديد؟"; }
    data.code = b.code;
  }
  if (!data.code) {
    setSM(phone, { ...sm, step: "CODE", data });
    return "تمام، ابعت رقم الحجز (مثال: SCH-2026-000123) أو قول (الأخير).";
  }
  const found = lookupBooking(phone, data);
  if (found.error) { setSM(phone, { ...sm, step: "CODE", data: {} }); return found.error; }
  const existing = found.booking;
  if (!data.slotText) {
    setSM(phone, { ...sm, step: "SLOT", data });
    if (data.pendPeriod) return `الساعة ${data.pendPeriod.hour} الصبح ولا المغرب يا فندم؟`;
    return `حجزك الحالي: ${existing.service} | ${existing.slot}. تحب ننقله لإمتى؟ (مثال: بكرة الساعة 7 المغرب)`;
  }
  const others = activeBookings().filter(b => String(b.id) !== String(existing.id));
  const v = validateBooking(existing.service, data.slotText, config, others);
  if (!v.ok) {
    data.slotText = ""; delete data.pendPeriod;
    setSM(phone, { ...sm, step: "SLOT", data });
    const alt = (v.alternatives || []).length ? `\nالمتاح: ${v.alternatives.join("، ")}` : "";
    return `${v.reason}${alt}`;
  }
  data.newSlot = { date: v.date, time: v.time, label: v.label, doctor: v.doctor };
  if (sm.step !== "CONFIRM") {
    setSM(phone, { ...sm, step: "CONFIRM", data });
    return `هننقل حجزك (${existing.service}) من ${existing.slot} لـ ${v.label}.\nهل تؤكد؟ (رد: تأكيد / لا)`;
  }
  if (CONFIRM_RE.test(t)) {
    const upd = updateBookingSlot(existing.id, { date: v.date, time: v.time, slot: v.label, duration: existing.duration, doctor: v.doctor || existing.doctor });
    clearSM(phone);
    return `✅ تمام يا فندم، اتنقل حجزك (${existing.service}) لـ ${v.label}\n📍 ${config.address}\nرقم الحجز: ${upd.code || upd.id}`;
  }
  setSM(phone, { ...sm, step: "CODE", data: { code: data.code } });
  return "تمام، مخليناش حاجة زي ما هي 🌹 تحب حاجة تانية؟";
}
// ---------- المدخل ----------
export function detectTrigger(text, config) {
  const t = String(text || "");
  // توحيد الهمزات عشان "أبغى/أريد" تتمسك زي "ابغى/اريد"
  const tn = t.replace(/[أإآ]/g, "ا");
  const hasCode = CODE_RE.test(t.toUpperCase());
  if (hasCode && CANCEL_RE.test(tn)) return "cancel";
  if (hasCode && RESCHED_RE.test(tn)) return "resched";
  if (CANCEL_RE.test(tn) && BOOK_RE.test(tn)) return "cancel";
  if (/^(كنسل|cancel|إلغاء|الغاء)[.!؟\s]*$/i.test(t.trim())) return "cancel";
  if (RESCHED_RE.test(tn) && BOOK_RE.test(tn)) return "resched";
  // سؤال سعر من غير فعل حجز → مش فلو حجز (ai.js يجاوب السعر)
  if (PRICE_RE.test(tn) && !BOOK_VERB_RE.test(tn)) return null;
  if (BOOK_VERB_RE.test(tn)) return "booking";
  // خدمة صريحة + معاد في نفس الرسالة ("كشف أسنان بكرة 7") → فلو حجز
  if (config && findService(t, config) && findSlot(t)) return "booking";
  return null;
}

export function route(phone, text) {
  const config = loadConfig();
  const t = String(text || "");
  // Safety أولاً دائماً — حتى وسط الفلو
  const urgency = classifyUrgency(t);
  if (urgency === "EMERGENCY") {
    clearSM(phone);
    const em = config.emergency_phone || "";
    return { handled: true, reply: `ألف سلامة عليك يا فندم. الأعراض دي محتاجة تقييم عاجل — كلم طوارئ ${config.name}: ${em} أو روح أقرب استقبال فوراً، ومتستناش الحجز. [طارئ]` };
  }
  if (urgency === "URGENT") {
    clearSM(phone);
    return { handled: true, reply: `[تحويل] أعراض تحتاج مراجعة بشرية سريعة: ${t.slice(0, 100)}` };
  }
  const sm = getSM(phone);
  if (sm) {
    if (sm.flow === "booking") return { handled: true, reply: bookingAdvance(phone, text, sm, config) };
    if (sm.flow === "cancel") return { handled: true, reply: cancelAdvance(phone, text, sm) };
    if (sm.flow === "resched") return { handled: true, reply: reschedAdvance(phone, text, sm, config) };
    clearSM(phone);
  }
  const trig = detectTrigger(t, config);
  if (trig === "cancel") {
    const data = extract(t, {}, config);
    // "ألغي الحجز" من غير كود → نسأل، ومن غير ما نمسح أي حاجة
    const sm = { flow: "cancel", step: "CODE", data };
    setSM(phone, sm);
    return { handled: true, reply: cancelAdvance(phone, "", sm) };
  }
  if (trig === "resched") {
    const data = extract(t, {}, config);
    const sm = { flow: "resched", step: "CODE", data };
    setSM(phone, sm);
    return { handled: true, reply: reschedAdvance(phone, "", sm, config) };
  }
  if (trig === "booking") {
    const data = extract(t, {}, config);
    const sm = { flow: "booking", step: "SERVICE", data };
    setSM(phone, sm);
    return { handled: true, reply: bookingAdvance(phone, "", sm, config) };
  }
  return { handled: false };
}
