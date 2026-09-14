// منطق المواعيد: تحويل "بكرة الساعة 7 المغرب" لتاريخ حقيقي + منع التضارب والإجازات
// يفترض توقيت السيرفر = توقيت مصر

const DAY_INDEX = { "الاحد": 0, "الأحد": 0, "الاتنين": 1, "الاثنين": 1, "التلات": 2, "الثلاثاء": 2, "الاربع": 3, "الأربعاء": 3, "الخميس": 4, "الجمعة": 5, "الجمعه": 5, "السبت": 6 };
const DAY_NAMES = ["الأحد", "الاتنين", "التلات", "الأربع", "الخميس", "الجمعة", "السبت"];
const CLOSED_INDEX = { "الاحد": 0, "الأحد": 0, "الاتنين": 1, "الاثنين": 1, "التلات": 2, "الثلاثاء": 2, "الاربع": 3, "الأربعاء": 3, "الخميس": 4, "الجمعة": 5, "الجمعه": 5, "السبت": 6 };

function norm(s) { return String(s || "").replace(/[\u064B-\u0652]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ال/g, ""); }
function arDigits(s) { return String(s || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)); }
function pad(n) { return String(n).padStart(2, "0"); }
export function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function toMin(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }

// أرقام مكتوبة بالحروف → أرقام (نفس خريطة ai.js)
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

// "بكرة الساعة 7 المغرب" → {date:'2026-..', time:'19:00', label} أو {error}
// ويدعم ISO مباشر من الموقع: "2026-09-20 الساعة 17:00" أو "2026-09-20 17:00"
export function parseSlotLabel(label) {
  const isoD = String(label || "").match(/(\d{4}-\d{2}-\d{2})/);
  const isoT = String(label || "").match(/(\d{1,2}):(\d{2})/);
  if (isoD && isoT) {
    const h = Number(isoT[1]), min = Number(isoT[2]);
    if (h > 23 || min > 59) return { error: "bad_time" };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoD[1])) return { error: "no_day" };
    return { date: isoD[1], time: `${pad(h)}:${pad(min)}`, weekday: new Date(isoD[1] + "T12:00:00").getDay() };
  }
  const t = arDigits(wordsToDigits(String(label || "")));
  const nt = norm(t);
  let base = new Date();
  // مطابقة الأيام بالكلمة الكاملة على النص المجرّد (تتجاهل ال/همزات ولام الجر زي "للجمعة"، وتمنع "واحد" ≠ "الأحد")
  const tokens = nt.split(/\s+/).map(w => w.replace(/^ل+/, ""));
  const dayWord = Object.keys(DAY_INDEX).find(d => tokens.includes(norm(d)));
  if (/(بعد)/.test(nt) && /(بكره|بكرة|بكرا|باجر|باكر|غدا|غد)/.test(nt)) { base = new Date(); base.setDate(base.getDate() + 2); }
  else if (/(بكره|بكرة|بكرا|باجر|باكر|غدا|الغد)/.test(norm(t))) { base = new Date(); base.setDate(base.getDate() + 1); }
  else if (/(نهارده|نهاردة|اليوم|انهارده)/.test(nt)) { base = new Date(); }
  else if (dayWord) {
    const target = DAY_INDEX[dayWord];
    base = new Date();
    let diff = (target - base.getDay() + 7) % 7;
    if (diff === 0) diff = 0; // نفس اليوم = النهاردة
    base.setDate(base.getDate() + diff);
  } else {
    return { error: "no_day" };
  }
  const hm = t.match(/الساعة\s*(\d{1,2})(\s*:\s*(\d{2}))?/);
  if (!hm) return { error: "no_time" };
  let h = Number(hm[1]); const min = Number(hm[3] || 0);
  if (h > 23 || min > 59) return { error: "bad_time" };
  const isPM = /(بليل|ليل|مساء|مغرب|ضهر|عصر|عشا)/.test(nt);
  if (isPM && h < 12) h += 12;
  // "12 بليل / 12 الصبح" = نص الليل مش الضهر
  if (h === 12 && /(بليل|ليل|مساء|عشا|فجر|صبح|صباح)/.test(nt) && !/(ضهر|عصر|مغرب)/.test(nt)) h = 0;
  if (h === 24) h = 0;
  // ملحوظة: الغموض (لا صبح ولا مغرب) بيتحل في ai.js قبل ما يوصل هنا
  return { date: dateStr(base), time: `${pad(h)}:${pad(min)}`, weekday: base.getDay() };
}

export function timeLabel(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const mm = m ? `:${pad(m)}` : "";
  if (h === 12) return `12${mm} الضهر`;
  if (h >= 13 && h <= 15) return `${h - 12}${mm} العصر`;
  if (h > 12) return `${h - 12}${mm} المغرب`;
  if (h === 0) return `12${mm} بليل`;
  return `${h}${mm} الصبح`;
}

export function dayLabel(dateStr_) {
  const today = new Date();
  const t = new Date(dateStr_ + "T12:00:00");
  const diffDays = Math.round((t - new Date(dateStr(today))) / 86400000);
  if (diffDays === 0) return "النهاردة";
  if (diffDays === 1) return "بكرة";
  return DAY_NAMES[t.getDay()];
}

export function slotLabel(dateStr_, hhmm) {
  return `${dayLabel(dateStr_)} الساعة ${timeLabel(hhmm)}`;
}

function isClosed(dateStr_, config) {
  const days = config.schedule?.closedDays || [];
  const t = new Date(dateStr_ + "T12:00:00");
  if (days.some(d => CLOSED_INDEX[d] === t.getDay())) return true;
  // إجازات استثنائية: "2026-10-06" أو "2026-09-20 إلى 2026-09-22" في schedule.closedDates
  const extra = config.schedule?.closedDates || [];
  return extra.some(d => {
    if (String(d).includes("إلى") || String(d).includes("to")) {
      const [a, b] = String(d).split(/إلى|to/).map(s => s.trim());
      return dateStr_ >= a && dateStr_ <= b;
    }
    return String(d).trim() === dateStr_;
  });
}

function doctorOnVacation(doc, dateStr_) {
  if (!doc) return false;
  const list = doc.unavailableDates || doc.vacationDates || [];
  for (const d of list) {
    if (String(d).includes("إلى") || String(d).includes("to")) {
      const [a, b] = String(d).split(/إلى|to/).map(s => s.trim());
      if (dateStr_ >= a && dateStr_ <= b) return true;
    } else if (String(d).trim() === dateStr_) return true;
  }
  if (doc.vacationUntil) return dateStr_ <= String(doc.vacationUntil).trim();
  return false;
}

function serviceDuration(service, config) {
  return config.services.find(s => s.name === service)?.duration_min || 30;
}

function overlaps(aStart, aDur, bStart, bDur) {
  return aStart < bStart + bDur && bStart < aStart + aDur;
}

export function serviceSpecialty(service, config) {
  return config.services.find(s => s.name === service)?.specialty || "";
}

function doctorWorksDay(doc, weekday) {
  if (!doc.days || !doc.days.length) return true;
  return doc.days.some(d => CLOSED_INDEX[d] === weekday);
}

// تعيين دكتور: من نفس التخصص + شغال اليوم + مش في إجازة + فاضي في المعاد (الأقل حجوزات اليوم يكسب)
export function assignDoctor(service, dateStr_, timeMin, dur, config, bookings) {
  const spec = serviceSpecialty(service, config);
  if (!spec) return { scoped: false, specialty: "" };
  // لو مفيش دكاترة متسجلين للتخصص ده أصلاً (عام/أنف وأذن/نفسية) → احجز على مستوى الخدمة من غير دكتور
  const hasSpecDoctors = (config.doctors || []).some(d => d.specialty === spec);
  if (!hasSpecDoctors) return { scoped: false, specialty: spec };
  const weekday = new Date(dateStr_ + "T12:00:00").getDay();
  let cands = (config.doctors || []).filter(d => d.specialty === spec && doctorWorksDay(d, weekday) && !doctorOnVacation(d, dateStr_));
  // لو كل دكاترة التخصص في إجازة استثنائية → اعتبر اليوم مقفول لنفس التخصص
  const load = doc => bookings.filter(b => b.status !== "cancelled" && b.doctor === doc.name && b.date === dateStr_).length;
  const free = cands.filter(doc => !bookings.some(b =>
    b.status !== "cancelled" && b.doctor === doc.name && b.date === dateStr_ && overlaps(timeMin, dur, toMin(b.time), b.duration || 30)
  ));
  free.sort((a, b) => load(a) - load(b));
  return { scoped: true, specialty: spec, doctor: free.length ? free[0].name : "", busy: cands.length > 0 };
}

// التحقق الكامل قبل تسجيل أي حجز
export function validateBooking(service, slotLabelText, config, bookings) {
  const parsed = parseSlotLabel(slotLabelText);
  if (parsed.error) return { ok: false, reason: "المعاد مش واضح يا فندم، قولي اليوم والساعة (مثال: بكرة الساعة 7 المغرب)." };
  const dur = serviceDuration(service, config);
  const open = config.schedule?.open || "10:00";
  const close = config.schedule?.close || "23:00";
  const step = config.schedule?.slotStepMin || 30;

  if (isClosed(parsed.date, config)) {
    const alt = nextOpenSameTime(parsed, config, bookings, service, dur);
    const msg = (config.schedule?.closedDates || []).some(d => String(d).trim() === parsed.date) ? `العيادة إجازة اليوم يا فندم 🙏` : `الجمعة إجازة يا فندم 🙏`;
    return { ok: false, reason: msg, alternatives: alt };
  }
  const tMin = toMin(parsed.time);
  const now = new Date();
  // تاريخ فات أصلاً (أمس أو قبله)؟ مرفوض — يمنع الحجز في الماضي عبر الـ API
  if (parsed.date < dateStr(now)) {
    return { ok: false, reason: "المعاد ده فات يا فندم، اختار يوم جاي." };
  }
  // معاد عدى النهاردة؟ (الحجز لوقت فات)
  if (parsed.date === dateStr(now) && tMin <= now.getHours() * 60 + now.getMinutes()) {
    return { ok: false, reason: "المعاد ده عدى النهاردة يا فندم، تحب تحجز بكرة؟" };
  }
  if (tMin < toMin(open) || tMin + dur > toMin(close)) {
    return { ok: false, reason: `المعاد ده بره مواعيدنا (من ${open} لـ ${close}). تحب معاد تاني إمتى؟` };
  }
  const a = assignDoctor(service, parsed.date, tMin, dur, config, bookings);
  if (a.scoped) {
    if (!a.doctor) {
      const alt = findFreeSlots(parsed.date, service, dur, config, bookings, parsed.time);
      // لو السبب إجازة استثنائية للدكتور
      const allSpec = (config.doctors || []).filter(d => d.specialty === a.specialty);
      const onVac = allSpec.length && allSpec.every(d => !doctorWorksDay(d, new Date(parsed.date + "T12:00:00").getDay()) || doctorOnVacation(d, parsed.date));
      const who = onVac ? `دكاترة ${a.specialty} في إجازة اليوم يا فندم 🙏` : (a.busy ? `دكتور ${a.specialty} مشغول في المعاد ده.` : `مفيش دكتور ${a.specialty} في اليوم ده.`);
      return { ok: false, reason: who, alternatives: alt };
    }
    return { ok: true, date: parsed.date, time: parsed.time, duration: dur, label: slotLabel(parsed.date, parsed.time), specialty: a.specialty, doctor: a.doctor };
  }
  // خدمة من غير تخصص/دكاترة: منع على مستوى الخدمة (السلوك القديم)
  const active = bookings.filter(b => b.status !== "cancelled" && b.service === service && b.date === parsed.date);
  if (active.some(b => overlaps(tMin, dur, toMin(b.time), b.duration || 30))) {
    const alt = findFreeSlots(parsed.date, service, dur, config, bookings, parsed.time);
    return { ok: false, reason: `المعاد ده محجوز للأسف.`, alternatives: alt };
  }
  return { ok: true, date: parsed.date, time: parsed.time, duration: dur, label: slotLabel(parsed.date, parsed.time), specialty: "", doctor: "" };
}

// كل المواعيد الفارغة في يوم معين لخدمة (للتقويم العام) — [{time:"17:00",label,doctor}]
export function daySlots(dateStr_, service, config, bookings) {
  const n = new Date();
  const today = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr_ || "") || dateStr_ < today) return { closed: true, slots: [] };
  const dur = serviceDuration(service, config);
  const open = config.schedule?.open || "10:00";
  const close = config.schedule?.close || "23:00";
  const step = config.schedule?.slotStepMin || 30;
  if (isClosed(dateStr_, config)) return { closed: true, slots: [] };
  const out = [];
  for (let m = toMin(open); m + dur <= toMin(close); m += step) {
    const hhmm = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    // تجاوز ما فات من اليوم
    const now = new Date();
    if (dateStr_ === dateStr(now) && m <= now.getHours() * 60 + now.getMinutes()) continue;
    const spec = serviceSpecialty(service, config);
    const scoped = spec && (config.doctors || []).some(d => d.specialty === spec);
    let okFree, doc = "";
    if (scoped) {
      const a = assignDoctor(service, dateStr_, m, dur, config, bookings);
      okFree = !!a.doctor; doc = a.doctor || "";
    } else {
      const active = bookings.filter(b => b.status !== "cancelled" && b.service === service && b.date === dateStr_);
      okFree = !active.some(b => overlaps(m, dur, toMin(b.time), b.duration || 30));
    }
    if (okFree) out.push({ time: hhmm, label: slotLabel(dateStr_, hhmm), doctor: doc });
  }
  return { closed: false, slots: out };
}

function findFreeSlots(dateStr_, service, dur, config, bookings, excludeTime) {
  const open = config.schedule?.open || "10:00";
  const close = config.schedule?.close || "23:00";
  const step = config.schedule?.slotStepMin || 30;
  const spec = serviceSpecialty(service, config);
  const scoped = spec && (config.doctors || []).some(d => d.specialty === spec);
  const out = [];
  for (let m = toMin(open); m + dur <= toMin(close) && out.length < 3; m += step) {
    const hhmm = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    if (hhmm === excludeTime) continue;
    let free;
    if (scoped) {
      free = !!assignDoctor(service, dateStr_, m, dur, config, bookings).doctor;
    } else {
      const active = bookings.filter(b => b.status !== "cancelled" && b.service === service && b.date === dateStr_);
      free = !active.some(b => overlaps(m, dur, toMin(b.time), b.duration || 30));
    }
    if (free) out.push(slotLabel(dateStr_, hhmm));
  }
  // لو اليوم مليان: نفس المعاد تاني يوم (لو مش إجازة)
  if (!out.length) {
    const d = new Date(dateStr_ + "T12:00:00"); d.setDate(d.getDate() + 1);
    const ns = dateStr(d);
    if (!isClosed(ns, config)) out.push(slotLabel(ns, excludeTime));
  }
  return out;
}

function nextOpenSameTime(parsed, config, bookings, service, dur) {
  const out = [];
  const d = new Date(parsed.date + "T12:00:00");
  for (let i = 1; i <= 7 && out.length < 2; i++) {
    d.setDate(d.getDate() + 1);
    const ns = dateStr(d);
    if (isClosed(ns, config)) continue;
    const spec = serviceSpecialty(service, config);
    const scoped = spec && (config.doctors || []).some(x => x.specialty === spec);
    let free;
    if (scoped) {
      free = !!assignDoctor(service, ns, toMin(parsed.time), dur, config, bookings).doctor;
    } else {
      const active = bookings.filter(b => b.status !== "cancelled" && b.service === service && b.date === ns);
      free = !active.some(b => overlaps(toMin(parsed.time), dur, toMin(b.time), b.duration || 30));
    }
    if (free) out.push(slotLabel(ns, parsed.time));
  }
  return out;
}
