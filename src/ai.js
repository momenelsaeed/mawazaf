import OpenAI from "openai";
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { detectSpecialty, classifyUrgency } from "./medical-knowledge.js";
import { findHealthAnswer } from "./health-knowledge.js";
import { getAllSessions, savePending, deletePending, saveHistory, deleteSession, getPatientBySender } from "./store.js";
import { ragAnswer } from "./rag.js";

import { getConfig, currentSlug } from "./tenants.js";
function loadConfig() {
  return getConfig();
}
function getClient() {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "PASTE_HERE") return null;
  // يدعم أي مزود متوافق مع OpenAI (Gemini/Groq/OpenRouter) عبر OPENAI_BASE_URL
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL !== "PASTE_HERE" ? process.env.OPENAI_BASE_URL : undefined
  });
}

const PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "receptionist.md");

function fillTemplate(tpl, config) {
  const services = config.services.map(s => `- ${s.name}: ${s.price} جنيه`).join("\n");
  const docs = (config.doctors || []).map(d => `- ${d.name} (${d.specialty}): ${d.info || ""}`).join("\n");
  return tpl
    .replaceAll("{{business_name}}", config.name || "")
    .replaceAll("{{working_hours}}", config.working_hours || "")
    .replaceAll("{{address}}", config.address || "")
    .replaceAll("{{emergency_phone}}", config.emergency_phone || "")
    .replaceAll("{{doctors}}", docs || "-")
    .replaceAll("{{services}}", services || "-")
    .replaceAll("{{booking_rules}}", config.booking_rules || "");
}

// البرومبت الأساسي من ملف prompts/receptionist.md (يتعدل بدون Restart).
// لو الملف اتمسح، بنرجع لبرومبت داخلي مختصر.
function systemPrompt(config) {
  if (existsSync(PROMPT_PATH)) {
    try {
      return fillTemplate(readFileSync(PROMPT_PATH, "utf-8"), config);
    } catch (e) {
      console.error("prompt file error:", e.message);
    }
  }
  const services = config.services.map(s => `- ${s.name}: ${s.price} جنيه`).join("\n");
  return `انت موظف استقبال طبي مصري في "${config.name}". رد بالمصري البسيط باختصار.
ممنوع التشخيص وممنوع وصف دواء. أي عرض خطير حوله للطوارئ ${config.emergency_phone || ""} واكتب [طارئ].
مواعيد: ${config.working_hours} | عنوان: ${config.address}
خدمات:
${services}
اكتمال الحجز يكون بصيغة: [حجز جديد] الاسم | الموبايل | الخدمة | اليوم الساعة`;
}

const memory = new Map();
const pending = new Map();
// عزل الجلسات بين العيادات: مفتاح الذاكرة = slug + رقم — والداتابيز بمفتاح الرقم الخام (معزولة أصلاً لكل عيادة)
const SEP = "";
const skey = phone => `${currentSlug()}${SEP}${phone}`;
const rawkey = k => { const s = String(k); const i = s.indexOf(SEP); return i >= 0 ? s.slice(i + 1) : s; };
for (const m of [memory, pending]) {
  const g = m.get.bind(m), s = m.set.bind(m), d = m.delete.bind(m), h = m.has.bind(m);
  m.get = k => g(skey(k)); m.set = (k, v) => s(skey(k), v);
  m.delete = k => d(skey(k)); m.has = k => h(skey(k));
}
// استرجاع الجلسات بعد الـ Restart + حفظ مستمر في الداتابيز
try {
  for (const s of getAllSessions()) {
    if (s.pending && Object.keys(s.pending).length) pending.set(s.phone, s.pending);
    if (s.history && s.history.length) memory.set(s.phone, s.history);
  }
} catch (e) { console.error("session restore:", e.message); }
pending.set = ((orig) => (k, v) => { orig(k, v); try { savePending(rawkey(k), v); } catch {} return pending; })(pending.set.bind(pending));
pending.delete = ((orig) => (k) => { try { deletePending(rawkey(k)); } catch {} return orig(k); })(pending.delete.bind(pending));
memory.set = ((orig) => (k, v) => { orig(k, v); try { saveHistory(rawkey(k), v); } catch {} return memory; })(memory.set.bind(memory));
const GREET = ["سلام", "اهلا", "أهلا", "ازيك", "صباح", "مساء", "هاي", "هلا", "مرحبا", "اهلين", "اهلا وسهلا", "صباح الخير", "مساء الخير", "السلام عليكم"];

function norm(s) { return String(s || "").replace(/[\u064B-\u0652]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ال/g, ""); }
// أدوات استخراج الكيانات — معاد تصديرها للـ State Machine (src/booking-flow.js) والاختبارات
export { norm };
export function extractName(text) {
  const m = String(text || "").match(/اسم[يى]\s+([^\d|,.،]+)/);
  if (!m) return "";
  let nm = m[1].trim().split(/\s+/).slice(0, 3).join(" ");
  nm = nm.split(/\s+(عايز|عاوز|عايزه|احجز|حجز|بكرة|بكرا|النهارده|اليوم|الساعة|رقم|موبايل|تليفون|كشف|تنضيف|حشو|جلدي|اسنان|باطن|اطفال|عظام|قلب|عيون|نسا|تمام|ماشي|شكرا)/)[0].trim();
  return nm.slice(0, 40);
}
// أرقام عربية مشرقية (٠١٢٣) → غربية (0123) عشان الفهم والحفظ يبقوا موحدين
function arDigits(s) { return String(s || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)); }
export function findService(text, config) {
  // مطابقة مرنة تتجاهل "ال" والهمزات عشان "كشف القلب" تلقط "كشف قلب"
  const nt = norm(text);
  const sorted = [...config.services].sort((a, b) => b.name.length - a.name.length);
  for (const s of sorted) if (nt.includes(norm(s.name))) return s.name;
  if (nt.includes(norm("كشف"))) return config.services.find(s => s.name.includes("كشف"))?.name || "كشف عام";
  return null;
}
export function findPhone(text) {
  // رقم مصري سليم: 11 رقم يبدأ بـ 010/011/012/015
  const m = text.replace(/[\s-]/g, "").match(/01[0125][0-9]{8}/);
  return m ? m[0] : null;
}
function looksLikeBadPhone(text) {
  // فيه حاجة شبه رقم (01 + أرقام) بس مش مطابقة للصيغة السليمة
  const cleaned = text.replace(/[\s-]/g, "");
  if (/01[0125][0-9]{8}/.test(cleaned)) return false;
  return /01[0-9]{5,}/.test(cleaned);
}
// "الساعة 5" من غير صبح/مغرب = غامضة
export function timeIsAmbiguous(text) {
  text = wordsToDigits(text);
  if (!/الساعة\s*\d{1,2}/.test(text)) return null;
  const nt = norm(text);
  if (/(صبح|صباح|فجر|بليل|ليل|مساء|مغرب|ضهر|عصر|عشا)/.test(nt)) return null;
  const m = text.match(/الساعة\s*(\d{1,2})/);
  return m ? m[1] : null;
}
const HANDOFF_WORDS = ["اكلم حد", "كلمني", "حد يكلمني", "كلموني", "عايز موظف", "عاوز موظف", "موظف بشري", "بني ادم", "بني آدم", "مش فاهم", "مش فاهمه", "انسان يرد", "حد يرد", "بدي احكي", "أبي أكلم", "ابغى اكلم", "أبغى أكلم", "حدا يرد", "أحد يرد", "موظف يحكي معي", "احكي مع حدا"];
// أرقام مكتوبة بالحروف (فصحى وعامية) → أرقام: "الساعة الخامسة/خمسة/اتنين"
function wordsToDigits(text) {
  let s = String(text || "");
  const map = [
    [/الساعة\s+(الواحده|الواحدة|واحده|واحدة)/g, "الساعة 1"],
    [/الساعة\s+(اتنين|اثنين|التانيه|الثانيه|الثانية|التانية)/g, "الساعة 2"],
    [/الساعة\s+(تلاته|تلاتة|الثالثه|الثالثة)/g, "الساعة 3"],
    [/الساعة\s+(اربعه|اربعة|الرابعه|الرابعة)/g, "الساعة 4"],
    [/الساعة\s+(خمسه|خمسة|الخامسه|الخامسة)/g, "الساعة 5"],
    [/الساعة\s+(سته|ستة|السادسه|السادسة)/g, "الساعة 6"],
    [/الساعة\s+(سبعه|سبعة|السابعه|السابعة)/g, "الساعة 7"],
    [/الساعة\s+(تمانيه|تمانية|الثامنه|الثامنة)/g, "الساعة 8"],
    [/الساعة\s+(تسعه|تسعة|التاسعه|التاسعة)/g, "الساعة 9"],
    [/الساعة\s+(عشره|عشرة|العاشره|العاشرة)/g, "الساعة 10"],
    [/الساعة\s+(حداشر|الحاديه\s*عشر|الحادية\s*عشر)/g, "الساعة 11"],
    [/الساعة\s+(اتناشر|الثانيه\s*عشر|الثانية\s*عشر)/g, "الساعة 12"]
  ];
  for (const [re, rep] of map) s = s.replace(re, rep);
  return s;
}
export function dayToken(text) {
  const ntw = norm(text);
  // "بعد بكرة/باجر" = بعد يومين
  if (/(بعد)/.test(ntw) && /(بكره|بكرة|بكرا|باجر|باكر|غدا|غد)/.test(ntw)) return "بعد بكرة";
  const tokens = norm(text).split(/\s+/).map(w => w.replace(/^ل+/, ""));
  const days = ["السبت", "الاحد", "الأحد", "الاتنين", "الاثنين", "التلات", "الثلاثاء", "الاربع", "الأربعاء", "الخميس", "الجمعة", "بكرة", "بكرا", "باجر", "باكر", "النهاردة", "اليوم", "غدا"];
  return days.find(d => tokens.includes(norm(d))) || "";
}
export function findSlot(text) {
  text = wordsToDigits(text);
  const day = dayToken(text);
  const timeM = text.match(/الساعة\s*(\d{1,2})(\s*:\s*(\d{2}))?/);
  let time = timeM ? timeM[0] : "";
  // احتفظ بكلمة الفترة (المغرب/الصبح...) عشان المعاد ميتسجلش غلط
  if (timeM) {
    const nt = norm(text);
    if (/(صبح|صباح|فجر)/.test(nt)) time += " الصبح";
    else if (/(بليل|ليل|مساء|مغرب|ضهر|عصر|عشا)/.test(nt)) time += " المغرب";
  }
  if (day || time) return `${day} ${time}`.trim();
  return null;
}

export async function aiReply(userPhone, userText) {
  const config = loadConfig();
  const text = arDigits((userText || "").trim());
  // Safety قبل أي LLM: الطوارئ لا تمر على الموديل أصلاً (قرار محلي حتمي)
  const preUrgency = classifyUrgency(text);
  if (preUrgency === "EMERGENCY") {
    const em = config.emergency_phone || "";
    return `ألف سلامة عليك يا فندم. الأعراض دي محتاجة تقييم عاجل — كلم طوارئ ${config.name}: ${em} أو روح أقرب استقبال فوراً، ومتستناش الحجز. [طارئ]`;
  }
  if (preUrgency === "URGENT") {
    try { pending.delete(userPhone); } catch {}
    return `[تحويل] أعراض تحتاج مراجعة بشرية سريعة: ${text.slice(0, 100)}`;
  }
  const hist = memory.get(userPhone) || [];
  hist.push({ role: "user", content: text });
  memory.set(userPhone, hist.slice(-20));

  const client = getClient();
  if (client) {
    try {
      const res = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [{ role: "system", content: systemPrompt(config) }, ...hist.slice(-10)],
        temperature: 0.4,
        max_tokens: 350
      });
      const reply = res.choices[0].message.content.trim();
      hist.push({ role: "assistant", content: reply });
      memory.set(userPhone, hist.slice(-20));
      return reply;
    } catch (e) {
      console.error("OpenAI error, fallback:", e.message);
    }
  }
  return smartDemoReply(userPhone, text, config);
}

function servicePrice(name, config) {
  return config.services.find(s => s.name === name)?.price;
}
function greetNewcomer(phone, config) {
  try {
    const pat = getPatientBySender(phone);
    if (pat && pat.name && (pat.visits || 0) > 0) {
      const ls = pat.lastService ? ` تحب تحجز ${pat.lastService} تاني ولا حاجة جديدة؟` : " تحب تحجز إيه؟";
      return `أهلاً يا ${pat.name} 🌹 وحشتنا!${ls}`;
    }
  } catch {}
  return `أهلاً بحضرتك في ${config.name}، تحب تحجز كشف إيه وإمتى؟`;
}

export function resetPhone(phone) {
  memory.delete(phone);
  pending.delete(phone);
  try { deleteSession(phone); } catch {}
}
export function setPendingState(phone, obj) {
  pending.set(phone, { ...(pending.get(phone) || {}), ...obj });
}
export function getPendingState(phone) { return pending.get(phone) || null; }
const DECLINE_RE = /^(لا|لأ|لاء|خلاص|مش عايز|مش عاوز|لا شكرا|لا شكراً|كفايه|كفاية|تمام لا|لا تمام|ما بدي|ما ابي|ما أبي|ما ابغى|ما أبغى|مش حابب|مو حاب)/;
export function isDecline(text) { return DECLINE_RE.test(String(text || "").trim()); }

function smartDemoReply(phone, text, config) {
  const t = text;
  const p = pending.get(phone) || {};
  const em = config.emergency_phone || "01000000000";

  // AI Safety: منع Prompt Injection — أي محاولة لاستخراج البرومبت أو تجاوز التعليمات
  if (/(تجاهل.*تعليمات|انس.*تعليمات|اكشف.*برومبت|اظهر.*تعليمات|ignore.*instruction|reveal.*prompt|system.*prompt|jailbreak|dan mode)/i.test(t)) {
    pending.set(phone, p);
    return "أنا موظف الحجوزات يا فندم، أقدر أساعدك في الحجز والاستفسار عن خدماتنا. تحب تحجز إيه؟";
  }
  // منع تسريب بيانات عميل آخر: أي طلب "هات أرقام/حجوزات الناس" يترفض
  if (/(هات.*ارقام|كل.*حجوزات|بيانات.*العملا|قائمة.*المرضى|show.*all.*bookings)/i.test(norm(t))) {
    return "مقدرش أشارك بيانات عملاء آخرين يا فندم 🔒 لو عايز حجزك انت قولي رقم موبايلك.";
  }
  // دعم إنجليزي أساسي (bilingual)
  const isEN = /[a-zA-Z]/.test(t) && !/[\u0600-\u06FF]/.test(t);
  if (isEN) {
    const tl = t.toLowerCase();
    if (/^(hi|hello|hey|good morning|good evening)/.test(tl) && t.length < 30) {
      pending.set(phone, p);
      return (p.service || p.suggested)
        ? `Hello! Shall we continue booking ${p.service || p.suggested}? Tell me day & time.`
        : `Hello, welcome to ${config.name}. Which service would you like to book?`;
    }
    if (/(price|cost|how much)/.test(tl)) {
      const all = config.services.map(sv => `${sv.name} ${sv.price}EGP`).join(", ");
      return `Our prices: ${all}. Which one would you like to book?`;
    }
    if (/(book|appointment|reserve)/.test(tl)) {
      p.step = "await_details"; pending.set(phone, p);
      return `Sure! Which service and when (day & time)? Plus your name and mobile. Services: ${config.services.map(s => s.name).join(" / ")}`;
    }
    if (/(cancel)/.test(tl)) { pending.delete(phone); return `[إلغاء]`; }
    if (/(human|agent|staff|support)/.test(tl)) { pending.delete(phone); return `[تحويل] ${t.slice(0, 100)}`; }
  }

  // 0. Safety Layer قبل أي فهم أو LLM — 3 مستويات:
  // EMERGENCY → طوارئ فوراً (مفيش حجز) | URGENT → بشري سريع | NORMAL → يكمل عادي
  const urgency = classifyUrgency(t);
  if (urgency === "EMERGENCY") {
    pending.delete(phone);
    return `ألف سلامة عليك يا فندم. الأعراض دي محتاجة تقييم عاجل — كلم طوارئ ${config.name}: ${em} أو روح أقرب استقبال فوراً، ومتستناش الحجز. [طارئ]`;
  }
  if (urgency === "URGENT") {
    pending.delete(phone);
    return `[تحويل] أعراض تحتاج مراجعة بشرية سريعة: ${t.slice(0, 100)}`;
  }

  // رفض/تغيير رأي: "لا" لوحدها → إغلاق لطيف ومسح الحالة
  // مهم: لو "لا" معاها نية حجز جديدة (لا عايز احجز بكرة...) متفهمهاش رفض
  if (isDecline(t)) {
    const hasNewIntent = /(حجز|احجز|معاد|ميعاد|موعد|بكرة|بكرا|باجر|النهارده|النهاردة|اليوم|الساعة|01[0125][0-9]{8}|اسنان|جلدي|باطن|اطفال|عظام|قلب|عيون|نسا)/.test(t);
    if (!hasNewIntent) {
      pending.delete(phone);
      return "تمام يا فندم، في خدمتك أي وقت تحب تحجز 🌹";
    }
    // فيها نية جديدة → كمل عادي وشيل "لا" من الأول عشان متبوظش الفهم
    // (من غير مسح الحالة)
  }

  // 2. إلغاء حجز (على النص الخام قبل تجريد "ال" عشان "ألغي" متتكسرش)
  if (/(لغي|لغاء|كنسل|cancel|فسخ)/.test(t) && /(حجز|معاد|ميعاد|موعد)/.test(t)) {
    pending.delete(phone);
    return `[إلغاء]`;
  }

  // 2ب. تحويل لبشري
  if (HANDOFF_WORDS.some(w => t.includes(w))) {
    pending.delete(phone);
    return `[تحويل] ${t.slice(0, 100)}`;
  }

  // 3. جمع بيانات الحجز من الرسالة (الاسم أولاً عشان ميتضيعش لو سألنا توضيح ورجعنا)
  const phoneFound = findPhone(t);
  if (phoneFound) p.phone = phoneFound;
  // الاسم: "اسمي محمد" → خد أول 2-3 كلمات بس واقف عند كلمات الحجز عشان "اسمي محمد عايز احجز" متتسجلش كلها اسم
  const extractedName = extractName(t);
  if (extractedName) p.name = extractedName;
  // رقم شكله غلط (ناقص أو بادئة غلط) → اطلبه صح بدل ما نسجله
  if (!phoneFound && looksLikeBadPhone(t)) {
    pending.set(phone, p);
    return "الرقم ده شكله ناقص يا فندم، ابعت رقم موبايل مصري 11 رقم يبدأ بـ 010 أو 011 أو 012 أو 015.";
  }
  const svcFound = findService(t, config);
  if (svcFound) { p.service = svcFound; delete p.suggested; }
  // حل غموض الصبح/المغرب من الرسالة اللي فاتت
  const nt0 = norm(t);
  const periodNow = /(صبح|صباح|فجر)/.test(nt0) ? "الصبح" : /(بليل|ليل|مساء|مغرب|ضهر|عصر|عشا)/.test(nt0) ? "المغرب" : null;
  if (p.needPeriod && periodNow) {
    p.slot = `${p.dayPart} الساعة ${p.hour} ${periodNow}`;
    delete p.needPeriod; delete p.dayPart; delete p.hour;
  }
  const slotFound = findSlot(t);
  if (slotFound) {
    const ambHour = timeIsAmbiguous(t);
    if (ambHour) {
      // "بكرة الساعة 5" من غير تحديد → اسأل قبل ما تسجل حاجة غلط (حتى لو كان فيه معاد قديم محفوظ)
      const dayW = dayToken(t);
      p.dayPart = dayW; p.hour = ambHour; p.needPeriod = true;
      if (svcFound) p.service = svcFound;
      else {
        // "احجز أسنان بكرة الساعة 5" — التخصص اتذكر من غير اسم خدمة صريح، احفظه قبل ما تسأل عن الفترة
        try {
          const sp = detectSpecialty(t.replace(/(الضهر|العصر|المغرب|الصبح|بليل|مساء|المساء|العشا|الفجر|الصباح|الظهر)/g, ""));
          if (sp) {
            const guess = config.services.find(s => s.name.includes(sp))?.name;
            if (guess) { p.service = guess; delete p.suggested; }
          }
        } catch {}
      }
      pending.set(phone, p);
      return `الساعة ${ambHour} الصبح ولا المغرب يا فندم؟`;
    }
    p.slot = slotFound;
  }
  const specFound = (() => {
    // لو فيه "الساعة + رقم" يبقى كلمات الفترة (الضهر/المغرب...) وقت مش وجع → متستخدمهاش في تحديد التخصص
    let s = t;
    if (/الساعة\s*\d/.test(wordsToDigits(t))) s = s.replace(/(الضهر|العصر|المغرب|الصبح|بليل|مساء|المساء|العشا|الفجر|الصباح|الظهر)/g, "");
    return detectSpecialty(s);
  })();
  const isPriceQ = /(بشحال|شقد|بقديش)/.test(t) || /(بكام|بكم|سعر|تكلفه|اسعار|أسعار|قديش|ثمن|اتعاب)/.test(norm(t));

  // ذكر تخصص بالاسم (جلدية/قلب...) من غير اسم خدمة صريح: اعتبره اختيار للخدمة
  if (!svcFound && specFound && !isPriceQ) {
    const guess = config.services.find(s => s.name.includes(specFound))?.name;
    if (guess && guess !== p.service) { p.service = guess; delete p.suggested; }
  }

  // 4. سؤال سعر بدون بيانات حجز: جاوب السعر بس
  if (isPriceQ && !slotFound && !phoneFound) {
    if (svcFound) {
      p.suggested = svcFound; p.step = "await_details"; pending.set(phone, p);
      return `${svcFound} بـ ${servicePrice(svcFound, config) ?? ""} جنيه يا فندم، تحب أحجزلك إمتى؟`;
    }
    if (specFound) {
      const list = config.services.filter(sv => sv.name.includes(specFound)).map(sv => `${sv.name} ${sv.price}ج`).join("، ");
      if (list) {
        p.suggested = config.services.find(sv => sv.name.includes(specFound))?.name;
        p.step = "await_details"; pending.set(phone, p);
        return `أسعار ${specFound}: ${list}. تحب تحجز إيه وإمتى؟`;
      }
    }
    const all = config.services.map(sv => `${sv.name} ${sv.price}ج`).join("، ");
    return `أسعارنا: ${all}. تحب تحجز إيه؟`;
  }

  // 4ب. سؤال عام في نص الحجز (تحية/مواعيد/دكاترة) → جاوبه مباشرة والحجز يفضل محفوظ
  const hasBookingData = !!(slotFound || phoneFound || svcFound || extractedName);
  if (!hasBookingData && !isPriceQ) {
    if (GREET.some(w => t.includes(w)) && t.length < 30) {
      pending.set(phone, p);
      const svc = p.service || p.suggested;
      if (svc) {
        const missing = [];
        if (!p.slot) missing.push("اليوم والساعة");
        if (!p.phone) missing.push("رقم الموبايل");
        if (!p.name) missing.push("الاسم");
        const missTxt = missing.length ? ` ناقصني: ${missing.join(" + ")}.` : "";
        return `أهلاً بحضرتك 😊 نكمل حجز ${svc}؟${missTxt} (مثال: بكرة الساعة 7 المغرب + اسمك ورقمك) — ولو عايز تلغي قول (إلغاء).`;
      }
      return greetNewcomer(phone, config);
    }
    if (/(مواعيد|فاتحين|امتى|إمتى|فين|عنوان|مكان)/.test(norm(t))) {
      pending.set(phone, p);
      if (t.includes("فين") || t.includes("عنوان") || t.includes("مكان"))
        return `${config.address}، و${config.working_hours}. تحب تحجز إيه؟`;
      return `فاتحين ${config.working_hours} يا فندم. تحب تحجز إمتى؟`;
    }
    if (t.includes("دكتور") || t.includes("حكيم") || t.includes("طبيب") || t.includes("احسن") || t.includes("مين") || t.includes("اشطر") || t.includes("افضل")) {
      pending.set(phone, p);
      const docs = (config.doctors || []).slice(0, 6).map(d => `${d.name} (${d.specialty})`).join("، ");
      return docs ? `عندنا: ${docs}. تحب تحجز عند مين وإمتى؟` : "عندنا نخبة من الدكاترة في كل التخصصات. تحب تحجز إيه وإمتى؟";
    }
    // استفسار صحي عام: جاوب من القاعدة المحلية وتذكر إن الحجز يفضل محفوظ لو موجود
    const isHealthQ = /(ما هو|ما هي|ايه هو|ايه هي|ايه اسباب|ايه علاج|اعراض|مرض|القولون|السكري|الضغط|حساسية|حبوب|قولون|سكري|دواء|جرعة|تحليل|اشعة|سونار|وقاية|نصايح|ليه|ازاي|كيف)/.test(norm(t)) || /(وجع|الم|حراره|سخون|كحه|سعال|برد|صداع|دوخه|ترجيع|اسهال|مغص|هرش|حكه|بلغم)/.test(norm(t));
    if (isHealthQ) {
      const ans = findHealthAnswer(t);
      if (ans) {
        pending.set(phone, p);
        return ans;
      }
      // لو مفيش إجابة محلية: وجه للتخصص + اعرض الحجز (والـ LLM هيجاوب أذكى لو متاح)
      if (specFound) {
        const guess = config.services.find(s => s.name.includes(specFound))?.name;
        if (guess) {
          pending.set(phone, p);
          return `ألف سلامة عليك 🌹 استفسارك تبع تخصص ${specFound} (${guess} ${servicePrice(guess, config) ?? ""} جنيه) والدكتور يشخص حالتك بدقة. ${findHealthAnswer(specFound) || ""}\n_المعلومة للتثقيف فقط._ تحب أحجز إمتى؟`;
        }
      }
    }
  }

  // 5. اكتمال الحجز؟
  if (p.step === "await_details" || p.service || p.slot || p.name || p.phone || p.suggested) {
    const svc = p.service || p.suggested;
    if (svc && p.slot && (p.name || p.phone)) {
      const name = p.name || "عميل";
      const ph = p.phone || phone;
      pending.delete(phone);
      return `[حجز جديد] ${name} | ${ph} | ${svc} | ${p.slot}`;
    }
    if (p.service || p.slot || p.step || p.suggested) {
      p.step = "await_details";
      if (!p.service && p.suggested) p.service = p.suggested;
      if (!p.service) {
        pending.set(phone, p);
        return `تحجز إيه يا فندم؟ (${config.services.map(s => s.name).join(" / ")}) وإمتى؟`;
      }
      pending.set(phone, p);
      const price = servicePrice(p.service, config);
      const parts = [];
      parts.push(`${p.service}${price ? ` (${price} جنيه)` : ""} ✅`);
      if (!p.slot) parts.push("قولي اليوم والساعة المناسبين");
      if (!p.name && !p.phone) parts.push("واسمك ورقم موبايلك");
      else if (!p.phone) parts.push("ورقم موبايلك");
      else if (!p.name) parts.push("واسمك");
      if (p.slot && (p.name || p.phone) && p.service) {
        return `تمام، ${p.service} ${p.slot} ${p.name || ""} ${p.phone || ""} ✅\nناقصني بس: ${!p.phone ? "رقم الموبايل" : "الاسم"}`;
      }
      return `تمام، ${parts.join("، ")}.`;
    }
  }

  // 6. تحية
  if (GREET.some(w => t.includes(w)) && t.length < 30)
    return greetNewcomer(phone, config);

  // 7. مواعيد وعنوان
  if (/(مواعيد|فاتحين|امتى|إمتى|فين|عنوان|مكان)/.test(norm(t))) {
    if (t.includes("فين") || t.includes("عنوان") || t.includes("مكان"))
      return `${config.address}، و${config.working_hours}. تحب تحجز إيه؟`;
    return `فاتحين ${config.working_hours} يا فندم. تحب تحجز إمتى؟`;
  }

  // 8. سؤال عن الدكاترة
  if (t.includes("دكتور") || t.includes("حكيم") || t.includes("طبيب") || t.includes("احسن") || t.includes("مين") || t.includes("اشطر") || t.includes("افضل")) {
    const docs = (config.doctors || []).slice(0, 6).map(d => `${d.name} (${d.specialty})`).join("، ");
    return docs ? `عندنا: ${docs}. تحب تحجز عند مين وإمتى؟` : "عندنا نخبة من الدكاترة في كل التخصصات. تحب تحجز إيه وإمتى؟";
  }

  // 9. طلب حجز مباشر (بكل اللهجات: عايز/أبغى/بدي/أريد/موعد)
  if (/(حجز|احجز|معاد|ميعاد|عياده|موعد|ابغى|ابغي|ابي|بدي|اريد|ودي|حدد)/.test(norm(t))) {
    p.step = "await_details"; pending.set(phone, p);
    const names = config.services.map(s => s.name).join(" / ");
    return `تمام، تحجز إيه؟ (${names}) وإمتى (اليوم والساعة)؟ واسم حضرتك ورقم الموبايل.`;
  }

  // 10. استفسار صحي عام (خادم ذكي): جاوب معلومة عامة + اعرض الحجز بذوق
  // الأعراض/الأسئلة اللي لها إجابة في health-knowledge.js بتترد هناك، الباقي بيتوجه للتخصص
  if (/(وجع|الم|ألم|حراره|سخون|سخونه|كحه|سعال|برد|زكام|صداع|دوخه|دوار|ترجيع|استفراغ|اسهال|مغص|هرش|حكه|حبوب|طفح|ضغط|سكر|بلغم|تعبان|عيان|مريض|اعراض|تحليل|دواء|مرض|قولون|سكري)/.test(norm(t))) {
    const ans = findHealthAnswer(t);
    if (ans) return ans;
    if (specFound) {
      const guess = config.services.find(s => s.name.includes(specFound))?.name;
      if (guess) {
        p.service = guess; p.step = "await_details"; pending.set(phone, p);
        return `ألف سلامة عليك. الحجز عند دكتور ${specFound} (${guess} ${servicePrice(guess, config) ?? ""} جنيه) وهو اللي هيكشف عليك. قولي اليوم والساعة المناسبين واسمك ورقم موبايلك.`;
      }
    }
    const maybeAns = findHealthAnswer(t);
    if (maybeAns) return maybeAns;
    p.step = "await_details"; pending.set(phone, p);
    return "ألف سلامة عليك 🌹 أقدر أوضح المعلومة العامة وأحجزلك عند الدكتور المختص اللي يشخص حالتك بدقة. تحب تحجز تخصص إيه وإمتى؟ واسمك ورقم موبايلك.";
  }

  if (t.includes("شكرا") || t.includes("تمام") || t.includes("ماشي"))
    return "العفو يا فندم، في خدمتك أي وقت 😊 لو احتجت حجز قولي.";

  // قاعدة المعرفة (RAG وسط): فقرات مرتبة معناها + استشهاد بالمصدر بدل الاختراع
  try {
    const hits = ragAnswer(t, 1);
    if (hits && hits.length) {
      pending.set(phone, p);
      return `${hits[0].snippet}\n_من معلومات العيادة: [${hits[0].title}]._ تحب تحجز؟`;
    }
  } catch {}

  return "تمام يا فندم، تحب تحجز كشف إيه وإمتى؟ (قولي التخصص واليوم والساعة واسمك ورقمك)";
}
