// مخزن البيانات: SQLite (ملف data.db) بدل data.json
// أول تشغيل بيهاجر الداتا القديمة من data.json تلقائياً
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { DatabaseSync } from "node:sqlite";
import { validateBooking } from "./schedule.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// Multi-tenant: اتصال مستقل لكل عيادة (من سياق الطلب عبر AsyncLocalStorage).
// الـ Proxy يوجّه كل db.prepare/exec لقاعدة العيادة الحالية تلقائياً.
import { tenantDbPath, tenantDir, tenantConfigPath, tenantMetaPath, getConfig, DEFAULT_TENANT, currentSlug } from "./tenants.js";
const dbs = new Map();
function initDb(db, slug) {
db.exec(`
CREATE TABLE IF NOT EXISTS bookings(
  id INTEGER PRIMARY KEY, at TEXT, sender TEXT, name TEXT, phone TEXT,
  service TEXT, specialty TEXT, doctor TEXT, slot TEXT,
  date TEXT, time TEXT, duration INTEGER, status TEXT,
  needs_review INTEGER DEFAULT 0, deposit INTEGER DEFAULT 0, paid INTEGER DEFAULT 0, code TEXT
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, sender TEXT, direction TEXT, text TEXT
);
CREATE TABLE IF NOT EXISTS handoffs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, reason TEXT, at TEXT, done INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS patients(
  phone TEXT PRIMARY KEY, name TEXT, visits INTEGER DEFAULT 0, lastService TEXT, lastAt TEXT,
  history TEXT DEFAULT '', allergies TEXT DEFAULT '', meds TEXT DEFAULT '', notes TEXT DEFAULT '',
  birth TEXT DEFAULT '', gender TEXT DEFAULT '', pid INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(
  phone TEXT PRIMARY KEY, pending TEXT, history TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sender_phones(
  sender TEXT PRIMARY KEY, phone TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS recall_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, service TEXT, sent_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, actor TEXT, action TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, phone TEXT, kind TEXT, text TEXT, channel TEXT DEFAULT 'whatsapp'
);
CREATE TABLE IF NOT EXISTS kb_docs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS payments(
  token TEXT PRIMARY KEY, booking_code TEXT, phone TEXT, amount INTEGER,
  status TEXT DEFAULT 'pending', created_at TEXT, confirmed_at TEXT
);
CREATE TABLE IF NOT EXISTS waitlist(
  id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, name TEXT, service TEXT,
  date TEXT, status TEXT DEFAULT 'waiting', created_at TEXT, notified_at TEXT
);
CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY AUTOINCREMENT, pid INTEGER, phone TEXT, kind TEXT,
  filename TEXT, mime TEXT, size INTEGER, data BLOB, uploaded_by TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, payload TEXT, status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0, next_run TEXT, created_at TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS clinic_requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, slug TEXT, phone TEXT,
  status TEXT DEFAULT 'pending', created_at TEXT, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, next_run);
CREATE INDEX IF NOT EXISTS idx_waitlist_sd ON waitlist(service, date, status);
CREATE TABLE IF NOT EXISTS processed_messages(
  msg_id TEXT PRIMARY KEY, at TEXT
);
CREATE TABLE IF NOT EXISTS cron_runs(
  name TEXT PRIMARY KEY, last_success TEXT, last_failure TEXT, last_error TEXT, runs INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, pass_hash TEXT, role TEXT, active INTEGER DEFAULT 1,
  created_at TEXT, last_login TEXT, doctor TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS user_sessions(
  token TEXT PRIMARY KEY, username TEXT, role TEXT, expires_at TEXT, created_at TEXT, ip TEXT
);
CREATE TABLE IF NOT EXISTS otp_codes(
  phone TEXT PRIMARY KEY, new_phone TEXT, code_hash TEXT, expires_at TEXT, attempts INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS visits(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_pid INTEGER, patient_phone TEXT,
  doctor TEXT, specialty TEXT, booking_code TEXT, complaint TEXT,
  doctor_notes TEXT, diagnosis TEXT, treatment TEXT,
  created_by TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_pid, patient_phone);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, service, status);
`);

// عمود المراجعة الليلية (للداتابيز القديمة)
try {
  const cols = db.prepare("PRAGMA table_info(bookings)").all();
  if (!cols.some(c => c.name === "needs_review")) db.exec("ALTER TABLE bookings ADD COLUMN needs_review INTEGER DEFAULT 0");
  if (!cols.some(c => c.name === "deposit")) db.exec("ALTER TABLE bookings ADD COLUMN deposit INTEGER DEFAULT 0");
  if (!cols.some(c => c.name === "paid")) db.exec("ALTER TABLE bookings ADD COLUMN paid INTEGER DEFAULT 0");
  if (!cols.some(c => c.name === "code")) db.exec("ALTER TABLE bookings ADD COLUMN code TEXT");
} catch {}
// رقم حجز مقروء SCH-2026-000123 — backfill للقديم
try {
  const olds = db.prepare("SELECT id, at FROM bookings WHERE code IS NULL OR code=''").all();
  const upd = db.prepare("UPDATE bookings SET code=? WHERE id=?");
  for (const b of olds) {
    const y = (b.at || "").slice(0, 4) || new Date().getFullYear();
    upd.run(`SCH-${y}-${String(b.id).padStart(6, "0")}`, b.id);
  }
  if (olds.length) console.log(`assigned booking codes to ${olds.length} bookings`);
} catch (e) { console.error("code migration:", e.message); }
// ملف المريض الكامل (للداتابيز القديمة)
try {
  const pc = db.prepare("PRAGMA table_info(patients)").all();
  const add = (n, t) => { if (!pc.some(c => c.name === n)) db.exec(`ALTER TABLE patients ADD COLUMN ${n} ${t}`); };
  add("history", "TEXT DEFAULT ''");
  add("allergies", "TEXT DEFAULT ''");
  add("meds", "TEXT DEFAULT ''");
  add("notes", "TEXT DEFAULT ''");
  add("birth", "TEXT DEFAULT ''");
  add("gender", "TEXT DEFAULT ''");
  add("pid", "INTEGER");
} catch {}
// ID ثابت للمريض (P-1001...) — مبيتغيرش لو الرقم اتغير
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_pid ON patients(pid)");
  const missing = db.prepare("SELECT COUNT(*) c FROM patients WHERE pid IS NULL").get().c;
  if (missing > 0) {
    const maxR = db.prepare("SELECT MAX(pid) m FROM patients WHERE pid IS NOT NULL").get();
    let next = (maxR && maxR.m) || 1000;
    const rows = db.prepare("SELECT phone FROM patients WHERE pid IS NULL ORDER BY lastAt").all();
    const upd = db.prepare("UPDATE patients SET pid=? WHERE phone=?");
    for (const r of rows) { next++; upd.run(next, r.phone); }
    console.log(`assigned pid to ${rows.length} patients`);
  }
} catch (e) { console.error("pid migration:", e.message); }

// ترحيل من data.json القديم (مرة واحدة — للعيادة الافتراضية فقط، الجديدة تبدأ فاضية)
if (slug === DEFAULT_TENANT) try {
  const count = db.prepare("SELECT COUNT(*) c FROM bookings").get().c;
  const legacy = join(ROOT, "data.json");
  if (count === 0 && existsSync(legacy)) {
    const old = JSON.parse(readFileSync(legacy, "utf-8"));
    const ins = db.prepare("INSERT INTO bookings(id,at,sender,name,phone,service,specialty,doctor,slot,date,time,duration,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const b of (old.bookings || [])) {
      try { ins.run(b.id, b.at, b.from, b.name, b.phone, b.service, b.specialty || "", b.doctor || "", b.slot, b.date || "", b.time || "", b.duration || 30, b.status || "confirmed"); } catch {}
    }
    const im = db.prepare("INSERT INTO messages(at,sender,direction,text) VALUES(?,?,?,?)");
    for (const m of (old.messages || []).slice(-300)) {
      try { im.run(m.at, m.from, m.direction, m.text); } catch {}
    }
    console.log("migrated legacy data.json to data.db");
  }
} catch (e) { console.error("migration error:", e.message); }
} // end initDb

// ---- رسائل ----
export function logMessage(from, direction, text) {
  db.prepare("INSERT INTO messages(at,sender,direction,text) VALUES(?,?,?,?)")
    .run(new Date().toISOString(), from, direction, String(text || "").slice(0, 1000));
  db.prepare("DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 500)").run();
}

export function getMessages(limit = 100) {
  return db.prepare("SELECT at, sender AS \"from\", direction, text FROM messages ORDER BY id DESC LIMIT ?").all(limit).map(m => ({ at: m.at, from: m.from, direction: m.direction, text: m.text }));
}
export function getMessagesPaged({ page = 1, limit = 50 } = {}) {
  page = Math.max(1, Number(page) || 1);
  limit = Math.min(100, Math.max(1, Number(limit) || 50));
  const offset = (page - 1) * limit;
  const rows = db.prepare("SELECT at, sender AS \"from\", direction, text FROM messages ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset).map(m => ({ at: m.at, from: m.from, direction: m.direction, text: m.text }));
  const total = db.prepare("SELECT COUNT(*) c FROM messages").get().c;
  return { rows, total, page, limit, pages: Math.ceil(total / limit) };
}

// الحجز بره ساعات العمل؟ (بين القفل والفتح) → محتاج مراجعة الصبح
function isNightNow() {
  try {
    const cfg = getConfig();
    const toMin = s => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
    const n = new Date();
    const now = n.getHours() * 60 + n.getMinutes();
    const open = toMin(cfg.schedule?.open || "10:00");
    const close = toMin(cfg.schedule?.close || "23:00");
    return now >= close || now < open;
  } catch { return false; }
}

// ---- حجوزات ----
export function bookingCode(id, at) {
  const y = (at || "").slice(0, 4) || new Date().getFullYear();
  return `SCH-${y}-${String(id).padStart(6, "0")}`;
}
// معاملة ذرية: BEGIN IMMEDIATE → تنفيذ → COMMIT (ولفّ back لو فشل) — لمنع حجز مزدوج متزامن
export function withTransaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}
export function createBooking({ from, name, phone, service, specialty, doctor, slot, date, time, duration }) {
  return withTransaction(() => {
    const review = isNightNow() ? 1 : 0;
    const at = new Date().toISOString();
    const r = db.prepare("INSERT INTO bookings(at,sender,name,phone,service,specialty,doctor,slot,date,time,duration,status,needs_review) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(at, from, name || "", phone || from, service, specialty || "", doctor || "", slot, date || "", time || "", duration || 30, "confirmed", review);
    const id = Number(r.lastInsertRowid);
    const code = bookingCode(id, at);
    db.prepare("UPDATE bookings SET code=? WHERE id=?").run(code, id);
    upsertPatient(phone || from, name || "", service);
    if (phone && phone !== from) linkSender(from, phone);
    return { id, code, at, from, name: name || "", phone: phone || from, service, specialty: specialty || "", doctor: doctor || "", slot, date, time, duration: duration || 30, status: "confirmed", needs_review: review };
  });
}

function row2b(r) {
  return { id: r.id, code: r.code || bookingCode(r.id, r.at), at: r.at, from: r.sender, name: r.name, phone: r.phone, service: r.service, specialty: r.specialty, doctor: r.doctor, slot: r.slot, date: r.date, time: r.time, duration: r.duration, status: r.status, needs_review: r.needs_review || 0, deposit: r.deposit || 0, paid: r.paid || 0 };
}

export function getBookings() {
  return db.prepare("SELECT * FROM bookings ORDER BY id DESC").all().map(row2b);
}
export function getBookingsPaged({ page = 1, limit = 50, q = "" } = {}) {
  page = Math.max(1, Number(page) || 1);
  limit = Math.min(100, Math.max(1, Number(limit) || 50));
  const offset = (page - 1) * limit;
  if (q) {
    const like = `%${q}%`;
    const rows = db.prepare("SELECT * FROM bookings WHERE name LIKE ? OR phone LIKE ? OR service LIKE ? OR code LIKE ? OR doctor LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?").all(like, like, like, like, like, limit, offset).map(row2b);
    const total = db.prepare("SELECT COUNT(*) c FROM bookings WHERE name LIKE ? OR phone LIKE ? OR service LIKE ? OR code LIKE ? OR doctor LIKE ?").get(like, like, like, like, like).c;
    return { rows, total, page, limit, pages: Math.ceil(total / limit) };
  }
  const rows = db.prepare("SELECT * FROM bookings ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset).map(row2b);
  const total = db.prepare("SELECT COUNT(*) c FROM bookings").get().c;
  return { rows, total, page, limit, pages: Math.ceil(total / limit) };
}

export function activeBookings() {
  return db.prepare("SELECT * FROM bookings WHERE status IN ('confirmed','reminded') ORDER BY id").all().map(row2b);
}

export function cancelLatestByPhone(phone) {
  const b = db.prepare("SELECT * FROM bookings WHERE (sender=? OR phone=?) AND status IN ('confirmed','reminded') ORDER BY id DESC LIMIT 1").get(phone, phone);
  if (!b) return null;
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(b.id);
  return row2b({ ...b, status: "cancelled" });
}

export function getLatestActiveByPhone(phone) {
  const b = db.prepare("SELECT * FROM bookings WHERE (sender=? OR phone=?) AND status IN ('confirmed','reminded') ORDER BY id DESC LIMIT 1").get(phone, phone);
  return b ? row2b(b) : null;
}
// بحث برقم الحجز المقروء — مع تحقق الملكية (لازم نفس الرقم)
export function getBookingByCode(code, phone) {
  const b = db.prepare("SELECT * FROM bookings WHERE code=?").get(String(code || "").toUpperCase().trim());
  if (!b) return null;
  if (phone && b.sender !== phone && b.phone !== phone) return { denied: true };
  return row2b(b);
}
export function cancelByCode(code, phone) {
  const b = getBookingByCode(code, phone);
  if (!b || b.denied) return b;
  if (!["confirmed", "reminded"].includes(b.status)) return null;
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(b.id);
  return { ...b, status: "cancelled" };
}
// حجز ذري: الفحص + الإنشاء داخل معاملة واحدة ( Atomic — يمنع حجز مزدوج متزامن)
export function createBookingChecked({ from, name, phone, service, slotText }) {
  return withTransaction(() => {
    const cfg = getConfig();
    const active = db.prepare("SELECT * FROM bookings WHERE status IN ('confirmed','reminded') ORDER BY id").all().map(row2b);
    const v = validateBooking(service, slotText, cfg, active);
    if (!v.ok) return { ok: false, reason: v.reason, alternatives: v.alternatives || [] };
    const review = isNightNow() ? 1 : 0;
    const at = new Date().toISOString();
    const r = db.prepare("INSERT INTO bookings(at,sender,name,phone,service,specialty,doctor,slot,date,time,duration,status,needs_review) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(at, from, name || "", phone || from, service, v.specialty || "", v.doctor || "", v.label, v.date || "", v.time || "", v.duration || 30, "confirmed", review);
    const id = Number(r.lastInsertRowid);
    const code = bookingCode(id, at);
    db.prepare("UPDATE bookings SET code=? WHERE id=?").run(code, id);
    upsertPatient(phone || from, name || "", service);
    if (phone && phone !== from) linkSender(from, phone);
    return { ok: true, booking: { id, code, at, from, name: name || "", phone: phone || from, service, specialty: v.specialty || "", doctor: v.doctor || "", slot: v.label, date: v.date, time: v.time, duration: v.duration || 30, status: "confirmed", needs_review: review } };
  });
}
export function alreadyProcessed(msgId) {
  if (!msgId) return false;
  const r = db.prepare("SELECT msg_id FROM processed_messages WHERE msg_id=?").get(msgId);
  if (r) return true;
  try { db.prepare("INSERT INTO processed_messages(msg_id,at) VALUES(?,?)").run(msgId, new Date().toISOString()); } catch {}
  // تنظيف: احتفظ بآخر 2000 فقط
  try { db.prepare("DELETE FROM processed_messages WHERE rowid NOT IN (SELECT rowid FROM processed_messages ORDER BY rowid DESC LIMIT 2000)").run(); } catch {}
  return false;
}
// مراقبة الـ Cron: آخر نجاح/فشل لكل مهمة
export function logCron(name, ok, error = "") {
  db.prepare("INSERT INTO cron_runs(name,last_success,last_failure,last_error,runs) VALUES(?,?,?,?,1) ON CONFLICT(name) DO UPDATE SET last_success=CASE WHEN ? THEN excluded.last_success ELSE last_success END, last_failure=CASE WHEN ? THEN excluded.last_failure ELSE last_failure END, last_error=excluded.last_error, runs=runs+1")
    .run(name, ok ? new Date().toISOString() : null, ok ? null : new Date().toISOString(), String(error || "").slice(0, 300), ok ? 1 : 0, ok ? 0 : 1);
  // تنبيه فعلي للأدمن عند الفشل (يظهر في مركز الإشعارات — مش مجرد سجل)
  if (!ok) {
    try {
      db.prepare("INSERT INTO notifications(at,phone,kind,text,channel) VALUES(?,?,?,?,?)")
        .run(new Date().toISOString(), "", "cron_fail", `🔴 فشلت مهمة ${name}: ${String(error || "").slice(0, 200)}`, "dashboard");
    } catch {}
  }
}
export function getCronStatus() {
  const rows = db.prepare("SELECT * FROM cron_runs").all();
  const expected = ["reminder-20h", "autocancel-30m", "backup-3h", "recall-monthly"];
  return expected.map(n => rows.find(r => r.name === n) || { name: n, last_success: null, last_failure: null, last_error: "", runs: 0 });
}
export function backupDir() {
  const slug = currentSlug();
  const dir = (slug && slug !== DEFAULT_TENANT) ? join(tenantDir(slug), "backups") : join(ROOT, "backups");
  mkdirSync(dir, { recursive: true });
  return dir;
}
export function getBackupStatus() {
  try {
    const files = readdirSync(backupDir()).filter(f => f.startsWith("data-") && (f.endsWith(".db") || f.endsWith(".enc"))).sort();
    return { count: files.length, last: files.length ? files[files.length - 1] : null, unencrypted: !backupKey() };
  } catch { return { count: 0, last: null, unencrypted: true }; }
}
// تشفير النسخ: AES-256-GCM بمفتاح BACKUP_KEY (64 hex) — من غيره plaintext + تحذير في /api/health
import crypto from "crypto";
function backupKey() {
  const k = process.env.BACKUP_KEY;
  if (k && /^[a-f0-9]{64}$/i.test(k)) return Buffer.from(k, "hex");
  return null;
}
export function encryptBackupFile(srcPath, destEncPath) {
  const key = backupKey();
  if (!key) return false;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = readFileSync(srcPath);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(destEncPath, Buffer.concat([iv, tag, enc]));
  return true;
}
export function decryptBackupToTemp(encPath) {
  const key = backupKey();
  if (!key) throw new Error("BACKUP_KEY missing");
  const raw = readFileSync(encPath);
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  const tmp = join(backupDir(), `.restore-test-${Date.now()}.db`);
  writeFileSync(tmp, out);
  return tmp;
}
// تجربة استرجاع فعلية وآمنة: فك (لو مشفرة) لملف مؤقت → integrity + عد الصفوف → مسح المؤقت
export function restoreDrill() {
  const st = getBackupStatus();
  if (!st.last) return { ok: false, error: "مفيش نسخ" };
  const full = join(backupDir(), st.last);
  let tmp = null, openedHere = false;
  try {
    tmp = st.last.endsWith(".enc") ? decryptBackupToTemp(full) : full;
    openedHere = tmp !== full;
    const db = new DatabaseSync(tmp, { readOnly: true });
    const integ = db.prepare("PRAGMA integrity_check").get();
    const counts = {};
    for (const t of ["bookings", "patients", "messages"]) {
      try { counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { counts[t] = -1; }
    }
    try { db.close(); } catch {}
    const ok = integ && /ok/i.test(integ.integrity_check || "");
    try { logCron("backup-restore-test", !!ok, ok ? "" : JSON.stringify(integ)); } catch {}
    return { ok: !!ok, file: st.last, integrity: integ?.integrity_check, counts };
  } finally {
    if (openedHere && tmp) { try { unlinkSync(tmp); } catch {} }
  }
}

export function updateBookingSlot(id, { date, time, slot, duration, doctor }) {
  const cur = db.prepare("SELECT doctor FROM bookings WHERE id=?").get(id);
  db.prepare("UPDATE bookings SET date=?, time=?, slot=?, duration=?, doctor=? WHERE id=?").run(date, time, slot, duration, doctor || (cur && cur.doctor) || "", id);
  return getBooking(id);
}

export function getBooking(id) {
  const b = db.prepare("SELECT * FROM bookings WHERE id=?").get(id);
  return b ? row2b(b) : null;
}

export function deleteBooking(id) {
  const r = db.prepare("DELETE FROM bookings WHERE id=?").run(id);
  return r.changes > 0;
}
export function clearReview(id) {
  db.prepare("UPDATE bookings SET needs_review=0 WHERE id=?").run(id);
  return getBooking(id);
}
export function getPendingReviews() {
  return db.prepare("SELECT * FROM bookings WHERE needs_review=1 AND status IN ('confirmed','reminded') ORDER BY id DESC").all().map(row2b);
}

export function setBookingStatus(id, status) {
  const allowed = ["confirmed", "reminded", "cancelled", "attended", "no_show"];
  if (!allowed.includes(status)) return null;
  db.prepare("UPDATE bookings SET status=? WHERE id=?").run(status, id);
  return getBooking(id);
}

export function clearAll() {
  db.exec("DELETE FROM bookings; DELETE FROM messages; DELETE FROM handoffs; DELETE FROM patients; DELETE FROM sessions;");
}

// ---- تحويل لبشري ----
export function addHandoff(phone, reason) {
  const open = db.prepare("SELECT * FROM handoffs WHERE phone=? AND done=0 LIMIT 1").get(phone);
  if (open) return open;
  const r = db.prepare("INSERT INTO handoffs(phone,reason,at,done) VALUES(?,?,?,0)").run(phone, String(reason || "").slice(0, 200), new Date().toISOString());
  return { id: Number(r.lastInsertRowid), phone, reason, done: 0 };
}
export function getHandoffs() {
  return db.prepare("SELECT * FROM handoffs ORDER BY id DESC").all();
}
export function resolveHandoff(phone) {
  const r = db.prepare("UPDATE handoffs SET done=1 WHERE phone=? AND done=0").run(phone);
  return r.changes > 0;
}

// ---- مرضى (ذاكرة) ----
function nextPid() {
  const r = db.prepare("SELECT MAX(pid) m FROM patients").get();
  return ((r && r.m) || 1000) + 1;
}
export function upsertPatient(phone, name, service) {
  if (!phone) return;
  const ex = db.prepare("SELECT * FROM patients WHERE phone=?").get(phone);
  if (ex) {
    db.prepare("UPDATE patients SET name=COALESCE(NULLIF(?,''),name), visits=visits+1, lastService=COALESCE(NULLIF(?,''),lastService), lastAt=? WHERE phone=?")
      .run(name || "", service || "", new Date().toISOString(), phone);
    if (!ex.pid) { try { db.prepare("UPDATE patients SET pid=? WHERE phone=?").run(nextPid(), phone); } catch {} }
  } else {
    try {
      db.prepare("INSERT INTO patients(phone,name,visits,lastService,lastAt,pid) VALUES(?,?,?,?,?,?)")
        .run(phone, name || "", 1, service || "", new Date().toISOString(), nextPid());
    } catch {
      db.prepare("INSERT INTO patients(phone,name,visits,lastService,lastAt) VALUES(?,?,?,?,?)")
        .run(phone, name || "", 1, service || "", new Date().toISOString());
    }
  }
}
export function getPatient(phone) {
  return db.prepare("SELECT * FROM patients WHERE phone=?").get(phone) || null;
}
export function getPatientByPid(pid) {
  return db.prepare("SELECT * FROM patients WHERE pid=?").get(Number(pid)) || null;
}
// بحث بالاسم أو الرقم أو ID الثابت
export function searchPatients(q, limit = 50) {
  q = String(q || "").trim();
  if (!q) return db.prepare("SELECT * FROM patients ORDER BY lastAt DESC LIMIT ?").all(limit);
  if (/^\d+$/.test(q)) {
    // رقم ID صغير (1001...) أو رقم موبايل
    const byPid = db.prepare("SELECT * FROM patients WHERE pid=?").get(Number(q));
    if (byPid) return [byPid];
    return db.prepare("SELECT * FROM patients WHERE phone LIKE ? ORDER BY lastAt DESC LIMIT ?").all(`%${q}%`, limit);
  }
  return db.prepare("SELECT * FROM patients WHERE name LIKE ? OR phone LIKE ? ORDER BY lastAt DESC LIMIT ?").all(`%${q}%`, `%${q}%`, limit);
}
// نقل الملف لرقم جديد (المريض غيّر خطه) — الـ pid والملف والزيارات بيفضلوا
export function changePatientNumber(oldPhone, newPhone) {
  newPhone = String(newPhone || "").replace(/[\s-]/g, "");
  if (!/^01[0125][0-9]{8}$/.test(newPhone)) return { ok: false, reason: "الرقم الجديد لازم 11 رقم يبدأ بـ 010/011/012/015" };
  const p = getPatient(oldPhone);
  if (!p) return { ok: false, reason: "المريض القديم مش موجود" };
  if (getPatient(newPhone)) return { ok: false, reason: "الرقم الجديد مسجل لمريض تاني — ادمج يدوياً" };
  db.prepare("UPDATE patients SET phone=? WHERE phone=?").run(newPhone, oldPhone);
  db.prepare("UPDATE bookings SET phone=? WHERE phone=?").run(newPhone, oldPhone);
  db.prepare("UPDATE bookings SET sender=? WHERE sender=?").run(newPhone, oldPhone);
  db.prepare("INSERT INTO sender_phones(sender,phone,updated_at) VALUES(?,?,?) ON CONFLICT(sender) DO UPDATE SET phone=excluded.phone, updated_at=excluded.updated_at").run(oldPhone, newPhone, new Date().toISOString());
  return { ok: true, patient: getPatient(newPhone) };
}
// ملف مريض كامل: بيانات + سجل زيارات + إجمالي مدفوع/عربون (بالرقم أو الـ ID الثابت)
export function getPatientFull(key) {
  let p = getPatient(key);
  if (!p && /^\d+$/.test(String(key || ""))) p = getPatientByPid(key);
  if (!p) return null;
  const phone = p.phone;
  const visits = db.prepare("SELECT * FROM bookings WHERE phone=? OR sender=? ORDER BY id DESC").all(phone, phone).map(row2b);
  const totalDeposit = visits.reduce((a, b) => a + (Number(b.deposit) || 0), 0);
  let medicalVisits = [];
  try { medicalVisits = getVisitsByPatient(p.pid, phone); } catch {}
  return { ...p, visitsList: visits, medicalVisits, totalDeposit };
}
export function getAllPatients(limit = 300) {
  return db.prepare("SELECT * FROM patients ORDER BY lastAt DESC LIMIT ?").all(limit);
}
export function getAllPatientsPaged({ page = 1, limit = 50, q = "" } = {}) {
  page = Math.max(1, Number(page) || 1);
  limit = Math.min(100, Math.max(1, Number(limit) || 50));
  const offset = (page - 1) * limit;
  if (q) {
    const like = `%${q}%`;
    const rows = db.prepare("SELECT * FROM patients WHERE name LIKE ? OR phone LIKE ? ORDER BY lastAt DESC LIMIT ? OFFSET ?").all(like, like, limit, offset);
    const total = db.prepare("SELECT COUNT(*) c FROM patients WHERE name LIKE ? OR phone LIKE ?").get(like, like).c;
    return { rows, total, page, limit, pages: Math.ceil(total / limit) };
  }
  const rows = db.prepare("SELECT * FROM patients ORDER BY lastAt DESC LIMIT ? OFFSET ?").all(limit, offset);
  const total = db.prepare("SELECT COUNT(*) c FROM patients").get().c;
  return { rows, total, page, limit, pages: Math.ceil(total / limit) };
}
export function updatePatient(phone, fields = {}) {
  const allow = ["name", "history", "allergies", "meds", "notes", "birth", "gender", "lastService"];
  const sets = [], vals = [];
  for (const k of allow) {
    if (fields[k] !== undefined) { sets.push(`${k}=?`); vals.push(String(fields[k]).slice(0, 1000)); }
  }
  if (!sets.length) return getPatient(phone);
  // لو المريض مش موجود أنشئه (مع pid ثابت)
  if (!getPatient(phone)) {
    try {
      db.prepare("INSERT INTO patients(phone,name,visits,lastAt,pid) VALUES(?,?,0,?,?)").run(phone, fields.name || "", new Date().toISOString(), nextPid());
    } catch {
      db.prepare("INSERT INTO patients(phone,name,visits,lastAt) VALUES(?,?,0,?)").run(phone, fields.name || "", new Date().toISOString());
    }
  }
  vals.push(phone);
  db.prepare(`UPDATE patients SET ${sets.join(",")} WHERE phone=?`).run(...vals);
  return getPatient(phone);
}
export function setBookingPayment(id, { deposit, paid }) {
  const cur = getBooking(id);
  if (!cur) return null;
  const d = deposit !== undefined ? Number(deposit) || 0 : (cur.deposit || 0);
  const pd = paid !== undefined ? (Number(paid) ? 1 : 0) : (cur.paid || 0);
  db.prepare("UPDATE bookings SET deposit=?, paid=? WHERE id=?").run(d, pd, id);
  return getBooking(id);
}
export function linkSender(sender, phone) {
  if (!sender || !phone || sender === phone) return;
  db.prepare("INSERT INTO sender_phones(sender,phone,updated_at) VALUES(?,?,?) ON CONFLICT(sender) DO UPDATE SET phone=excluded.phone, updated_at=excluded.updated_at")
    .run(sender, phone, new Date().toISOString());
}
export function getPatientBySender(sender) {
  const m = db.prepare("SELECT phone FROM sender_phones WHERE sender=?").get(sender);
  if (m) {
    const p = getPatient(m.phone);
    if (p) return p;
  }
  return getPatient(sender);
}

// ---- جلسات المحادثة (حالة الحجز + الهيستوري — بتفضل بعد الـ Restart) ----
export function getPending(phone) {
  const s = db.prepare("SELECT pending FROM sessions WHERE phone=?").get(phone);
  if (!s || !s.pending) return undefined;
  try { return JSON.parse(s.pending); } catch { return undefined; }
}
export function savePending(phone, obj) {
  const cur = db.prepare("SELECT history FROM sessions WHERE phone=?").get(phone);
  const now = new Date().toISOString();
  if (cur) db.prepare("UPDATE sessions SET pending=?, updated_at=? WHERE phone=?").run(JSON.stringify(obj || {}), now, phone);
  else db.prepare("INSERT INTO sessions(phone,pending,history,updated_at) VALUES(?,?,?,?)").run(phone, JSON.stringify(obj || {}), "[]", now);
}
export function deletePending(phone) {
  db.prepare("UPDATE sessions SET pending=NULL, updated_at=? WHERE phone=?").run(new Date().toISOString(), phone);
}
export function getHistory(phone) {
  const s = db.prepare("SELECT history FROM sessions WHERE phone=?").get(phone);
  if (!s || !s.history) return [];
  try { return JSON.parse(s.history); } catch { return []; }
}
export function saveHistory(phone, arr) {
  const now = new Date().toISOString();
  const cur = db.prepare("SELECT phone FROM sessions WHERE phone=?").get(phone);
  if (cur) db.prepare("UPDATE sessions SET history=?, updated_at=? WHERE phone=?").run(JSON.stringify((arr || []).slice(-20)), now, phone);
  else db.prepare("INSERT INTO sessions(phone,pending,history,updated_at) VALUES(?,?,?,?)").run(phone, null, JSON.stringify((arr || []).slice(-20)), now);
}
export function deleteSession(phone) {
  db.prepare("DELETE FROM sessions WHERE phone=?").run(phone);
}
export function getAllSessions() {
  return db.prepare("SELECT phone, pending, history FROM sessions").all().map(s => {
    let pending = null, history = [];
    try { pending = s.pending ? JSON.parse(s.pending) : null; } catch {}
    try { history = s.history ? JSON.parse(s.history) : []; } catch {}
    return { phone: s.phone, pending, history };
  });
}

// ---- متابعة الغايبين: مرضى آخر زيارة من +N يوم ومتبعتلهمش قريب ----
export function getRecallCandidates(days = 180) {
  const all = db.prepare("SELECT * FROM patients WHERE lastAt IS NOT NULL").all();
  const cutoff = Date.now() - days * 86400000;
  return all.filter(p => {
    if (new Date(p.lastAt).getTime() > cutoff) return false;
    const recent = db.prepare("SELECT id FROM recall_log WHERE phone=? AND sent_at > ? LIMIT 1")
      .get(p.phone, new Date(cutoff).toISOString());
    return !recent;
  });
}
export function logRecall(phone, service) {
  db.prepare("INSERT INTO recall_log(phone,service,sent_at) VALUES(?,?,?)").run(phone, service || "", new Date().toISOString());
}

// ---- متابعة الغايبين: فترة لكل تخصص (أسنان 6ش vs باطنة شهر) ----
export function getRecallSchedule() {
  let cfg = {};
  try { cfg = getConfig(); } catch {}
  return cfg.recall_schedule || { "أسنان": 180, "جلدية": 90, "باطنة": 30, "قلب": 30, "أطفال": 60, "نسا": 30, "عظام": 90, "عيون": 180, "عام": 90, "default": Number(process.env.RECALL_DAYS || 180) };
}
export function getRecallCandidatesBySpec() {
  const sched = getRecallSchedule();
  const all = db.prepare("SELECT * FROM patients WHERE lastAt IS NOT NULL").all();
  const out = [];
  for (const p of all) {
    // حدد تخصص آخر خدمة للمريض من آخر حجز
    let spec = "";
    try {
      const last = db.prepare("SELECT specialty, service FROM bookings WHERE phone=? OR sender=? ORDER BY id DESC LIMIT 1").get(p.phone, p.phone);
      spec = (last && last.specialty) || "";
    } catch {}
    const days = sched[spec] || sched["default"] || 180;
    const cutoff = Date.now() - days * 86400000;
    if (new Date(p.lastAt).getTime() > cutoff) continue;
    const recent = db.prepare("SELECT id FROM recall_log WHERE phone=? AND sent_at > ? LIMIT 1")
      .get(p.phone, new Date(cutoff).toISOString());
    if (!recent) out.push({ ...p, specialty: spec, days });
  }
  return out;
}
// تصدير إكسل (CSV يفتح في Excel مباشرة — بدون مكتبات)
export function exportBookingsCSV() {
  const all = getBookings();
  let cfg = { services: [] };
  try { cfg = getConfig(); } catch {}
  const price = n => cfg.services.find(s => s.name === n)?.price || 0;
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["id", "date", "time", "name", "phone", "service", "specialty", "doctor", "slot", "status", "price", "deposit", "paid"].join(",")];
  for (const b of all) rows.push([b.id, b.date, b.time, esc(b.name), b.phone, esc(b.service), esc(b.specialty), esc(b.doctor), esc(b.slot), b.status, price(b.service), b.deposit || 0, b.paid ? "نعم" : "لا"].join(","));
  return "\uFEFF" + rows.join("\n");
}
// رسالة جماعية لحجوزات يوم معين (الدكتور اتأخر ساعة...)
export function getBookingsByDate(dateStr_) {
  return db.prepare("SELECT * FROM bookings WHERE date=? AND status IN ('confirmed','reminded')").all(dateStr_).map(row2b);
}
const DB_PATH = tenantDbPath(currentSlug());
export function backupNow() {
  const dir = backupDir();
  const slug = currentSlug();
  const DB_PATH = tenantDbPath(slug);
  const n = new Date();
  const stamp = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}_${String(n.getHours()).padStart(2, "0")}-${String(n.getMinutes()).padStart(2, "0")}`;
  const dest = join(dir, `data-${stamp}.db`);
  try { db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'"); }
  catch { copyFileSync(DB_PATH, dest); }
  let final = dest;
  // لو BACKUP_KEY موجود: شفر وامسح المكشوفة (مفيش plaintext على السيرفر)
  if (backupKey()) {
    const enc = dest + ".enc";
    if (encryptBackupFile(dest, enc)) {
      try { unlinkSync(dest); } catch {}
      final = enc;
    }
  }
  const files = readdirSync(dir).filter(f => f.startsWith("data-") && (f.endsWith(".db") || f.endsWith(".enc"))).sort();
  while (files.length > 7) unlinkSync(join(dir, files.shift()));
  // (مع النسخة: ملفات الإعداد بنفس الطابع — تُمسح معها)
  try {
    const cfgs = readdirSync(dir).filter(f => f.startsWith("data-") && (f.endsWith(".config.json") || f.endsWith(".tenant.json"))).sort();
    while (cfgs.length > 7) unlinkSync(join(dir, cfgs.shift()));
  } catch {}
  // مع النسخة: ملفات إعداد العيادة (من غيرها النسخة ناقصة عند موت السيرفر بالكامل)
  try {
    const cfgSrc = tenantConfigPath(slug);
    if (existsSync(cfgSrc)) copyFileSync(cfgSrc, join(dir, `data-${stamp}.config.json`));
    if (slug && slug !== DEFAULT_TENANT) {
      const metaSrc = tenantMetaPath(slug);
      if (existsSync(metaSrc)) copyFileSync(metaSrc, join(dir, `data-${stamp}.tenant.json`));
    }
  } catch {}
  // نسخة خارجية اختيارية (جوجل درايف عبر webhook/سيرفر خارجي)
  const hook = process.env.BACKUP_WEBHOOK_URL && process.env.BACKUP_WEBHOOK_URL !== "PASTE_HERE" ? process.env.BACKUP_WEBHOOK_URL : "";
  if (hook) {
    import("node:fs").then(fs => {
      const { default: axios } = require ? {} : {};
    }).catch(()=>{});
    // نار وforget — من غير تعطيل
    fetch(hook, { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-backup-name": `data-${stamp}.db` }, body: readFileSync(final) }).catch(()=>{});
  }
  return final;
}
// ---- مستخدمون وجلسات (Login حقيقي) ----
export function getUser(username) {
  return db.prepare("SELECT * FROM users WHERE username=?").get(String(username || "").toLowerCase().trim()) || null;
}
export function listUsers() {
  return db.prepare("SELECT username, role, active, created_at, last_login, doctor FROM users ORDER BY username").all();
}
export function createUser(username, passHash, role) {
  username = String(username || "").toLowerCase().trim();
  if (!username || !passHash) return null;
  try {
    db.prepare("INSERT INTO users(username,pass_hash,role,active,created_at) VALUES(?,?,?,?,?)")
      .run(username, passHash, role, 1, new Date().toISOString());
    return getUser(username);
  } catch { return null; }
}
export function setUserHash(username, passHash) {
  return db.prepare("UPDATE users SET pass_hash=? WHERE username=?").run(passHash, username).changes > 0;
}
export function setUserActive(username, active) {
  return db.prepare("UPDATE users SET active=? WHERE username=?").run(active ? 1 : 0, username).changes > 0;
}
export function deleteUser(username) {
  return db.prepare("DELETE FROM users WHERE username=?").run(username).changes > 0;
}
try {
  const uc = db.prepare("PRAGMA table_info(users)").all();
  if (!uc.some(c => c.name === "doctor")) db.exec("ALTER TABLE users ADD COLUMN doctor TEXT DEFAULT ''");
} catch {}
export function linkDoctor(username, doctorName) {
  return db.prepare("UPDATE users SET doctor=? WHERE username=?").run(String(doctorName || "").slice(0, 100), username).changes > 0;
}
function openTenant(slug) {
  const s = slug || DEFAULT_TENANT;
  if (!dbs.has(s)) {
    const conn = new DatabaseSync(tenantDbPath(s));
    try { conn.exec("PRAGMA busy_timeout = 5000"); } catch {}
    initDb(conn, s);
    dbs.set(s, conn);
  }
  return dbs.get(s);
}
function getDb() { return openTenant(currentSlug()); }
// قفل اتصال عيادة وتحريره من الكاش (لازم قبل مسح ملفاتها — وإلا crash)
export function closeTenant(slug) {
  const db = dbs.get(slug);
  if (db) {
    try { db.close(); } catch {}
    dbs.delete(slug);
  }
}
const db = new Proxy({}, {
  get: (_, prop) => {
    const v = Reflect.get(getDb(), prop);
    return typeof v === "function" ? v.bind(getDb()) : v;
  }
});
export function touchLogin(username) {
  db.prepare("UPDATE users SET last_login=? WHERE username=?").run(new Date().toISOString(), username);
}
export function createSession(token, username, role, hoursValid = 12, ip = "") {
  const exp = new Date(Date.now() + hoursValid * 3600000).toISOString();
  db.prepare("INSERT INTO user_sessions(token,username,role,expires_at,created_at,ip) VALUES(?,?,?,?,?,?)")
    .run(token, username, role, exp, new Date().toISOString(), String(ip || "").slice(0, 60));
  return exp;
}
export function getSession(token) {
  if (!token) return null;
  const s = db.prepare("SELECT * FROM user_sessions WHERE token=?").get(token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    try { db.prepare("DELETE FROM user_sessions WHERE token=?").run(token); } catch {}
    return null;
  }
  return s;
}
export function deleteSessionByToken(token) {
  db.prepare("DELETE FROM user_sessions WHERE token=?").run(token);
}
export function cleanExpiredSessions() {
  try { db.prepare("DELETE FROM user_sessions WHERE expires_at < ?").run(new Date().toISOString()); } catch {}
}

// ---- OTP (تحقق من الرقم قبل العمليات الحساسة) ----
export function saveOtp(phone, newPhone, codeHash, minutesValid = 10) {
  const exp = new Date(Date.now() + minutesValid * 60000).toISOString();
  db.prepare("INSERT INTO otp_codes(phone,new_phone,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,0,?) ON CONFLICT(phone) DO UPDATE SET new_phone=excluded.new_phone, code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, created_at=excluded.created_at")
    .run(phone, newPhone, codeHash, exp, new Date().toISOString());
  return exp;
}
export function getOtp(phone) {
  return db.prepare("SELECT * FROM otp_codes WHERE phone=?").get(phone) || null;
}
export function bumpOtpAttempts(phone) {
  db.prepare("UPDATE otp_codes SET attempts=attempts+1 WHERE phone=?").run(phone);
}
export function clearOtp(phone) {
  db.prepare("DELETE FROM otp_codes WHERE phone=?").run(phone);
}

// ---- زيارات طبية (فصل طبي/إداري — التشخيص للدكتور فقط) ----
export function addVisit({ pid, phone, doctor, specialty, bookingCode, complaint, notes, diagnosis, treatment, by }) {
  const r = db.prepare("INSERT INTO visits(patient_pid,patient_phone,doctor,specialty,booking_code,complaint,doctor_notes,diagnosis,treatment,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(pid || null, phone || "", doctor || "", specialty || "", bookingCode || "", String(complaint || "").slice(0, 1000), String(notes || "").slice(0, 1000), String(diagnosis || "").slice(0, 1000), String(treatment || "").slice(0, 1000), by || "", new Date().toISOString());
  return Number(r.lastInsertRowid);
}
export function getVisitsByPatient(pid, phone) {
  return db.prepare("SELECT * FROM visits WHERE patient_pid=? OR patient_phone=? ORDER BY id DESC").all(pid || -1, phone || "").map(v => ({
    id: v.id, pid: v.patient_pid, phone: v.patient_phone, doctor: v.doctor, specialty: v.specialty,
    booking_code: v.booking_code, complaint: v.complaint, doctor_notes: v.doctor_notes,
    diagnosis: v.diagnosis, treatment: v.treatment, by: v.created_by, at: v.created_at
  }));
}
export function updateVisit(id, fields = {}) {
  const allow = ["complaint", "doctor_notes", "diagnosis", "treatment", "doctor", "specialty"];
  const sets = [], vals = [];
  for (const k of allow) if (fields[k] !== undefined) { sets.push(`${k}=?`); vals.push(String(fields[k]).slice(0, 1000)); }
  if (!sets.length) return false;
  vals.push(id);
  return db.prepare(`UPDATE visits SET ${sets.join(",")} WHERE id=?`).run(...vals).changes > 0;
}
export function deleteVisit(id) {
  return db.prepare("DELETE FROM visits WHERE id=?").run(id).changes > 0;
}

// ---- مدفوعات تجريبية (Sandbox — تُستبدل ببوابة حقيقية) ----
export function createPayIntent(code, phone, amount) {
  const token = `pay_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  db.prepare("INSERT INTO payments(token,booking_code,phone,amount,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(token, code, phone, amount, "pending", new Date().toISOString());
  return token;
}
export function confirmPayIntent(token) {
  const p = db.prepare("SELECT * FROM payments WHERE token=?").get(token);
  if (!p || p.status !== "pending") return null;
  db.prepare("UPDATE payments SET status='paid', confirmed_at=? WHERE token=?").run(new Date().toISOString(), token);
  const b = db.prepare("SELECT * FROM bookings WHERE code=?").get(p.booking_code);
  if (b) db.prepare("UPDATE bookings SET deposit=?, paid=1 WHERE id=?").run(p.amount, b.id);
  try { logNotification(p.phone, "payment", `تم استلام عربون ${p.amount}ج للحجز ${p.booking_code} ✅`); } catch {}
  try { logAudit("gateway-sandbox", "pay", `${p.booking_code} ${p.amount}ج`); } catch {}
  return { ...p, status: "paid" };
}

// ---- قائمة الانتظار: المعاد مليان → سجل وبلغ عند الإلغاء ----
export function addToWaitlist({ phone, name, service, date }) {
  const ex = db.prepare("SELECT id FROM waitlist WHERE phone=? AND service=? AND date=? AND status='waiting'").get(phone, service, date);
  if (ex) return { ok: false, reason: "مسجل بالفعل" };
  const r = db.prepare("INSERT INTO waitlist(phone,name,service,date,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(phone, name || "", service, date, "waiting", new Date().toISOString());
  return { ok: true, id: Number(r.lastInsertRowid) };
}
export function getWaitlist(status = "waiting") {
  return db.prepare("SELECT * FROM waitlist WHERE status=? ORDER BY id").all(status);
}
export function removeFromWaitlist(id) {
  return db.prepare("DELETE FROM waitlist WHERE id=?").run(id).changes > 0;
}
export function matchWaitlist(service, date, limit = 3) {
  return db.prepare("SELECT * FROM waitlist WHERE service=? AND date=? AND status='waiting' ORDER BY id LIMIT ?").all(service, date, limit);
}
export function markWaitNotified(id) {
  db.prepare("UPDATE waitlist SET status='notified', notified_at=? WHERE id=?").run(new Date().toISOString(), id);
}

// ---- مستندات المريض (تحليل/أشعة/روشتة — حد 5MB، pdf/jpg/png) ----
const DOC_MIMES = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png" };
// فحص البصمة السحرية للمحتوى (مش الامتداد/الـ MIME المعلن فقط)
function magicOk(mime, buf) {
  if (!buf || buf.length < 4) return false;
  if (mime === "application/pdf") return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
  if (mime === "image/jpeg") return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  if (mime === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47; // ‰PNG
  return false;
}
export function addDoc({ pid, phone, kind, filename, mime, base64, by }) {
  if (!DOC_MIMES[mime]) return { ok: false, error: "النوع المسموح: PDF/JPG/PNG فقط" };
  let buf;
  try { buf = Buffer.from(base64, "base64"); } catch { return { ok: false, error: "ملف تالف" }; }
  if (!buf.length || buf.length > 5 * 1024 * 1024) return { ok: false, error: "الحجم الأقصى 5MB" };
  if (!magicOk(mime, buf)) return { ok: false, error: "محتوى الملف لا يطابق نوعه (مرفوض أمنياً)" };
  const kinds = ["تحليل", "أشعة", "روشتة", "أخرى"];
  if (!kinds.includes(kind)) kind = "أخرى";
  const r = db.prepare("INSERT INTO documents(pid,phone,kind,filename,mime,size,data,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(pid || null, phone || "", kind, String(filename || "file").slice(0, 120), mime, buf.length, buf, by || "", new Date().toISOString());
  return { ok: true, id: Number(r.lastInsertRowid) };
}
export function getDocsByPatient(pid, phone) {
  return db.prepare("SELECT id, pid, phone, kind, filename, mime, size, uploaded_by, created_at FROM documents WHERE pid=? OR phone=? ORDER BY id DESC")
    .all(pid || -1, phone || "").map(d => d);
}
export function getDoc(id) {
  return db.prepare("SELECT * FROM documents WHERE id=?").get(id) || null;
}
export function deleteDoc(id) {
  return db.prepare("DELETE FROM documents WHERE id=?").run(id).changes > 0;
}
// ---- طلبات عيادات جديدة (ذاتي من الموقع — تعيش في قاعدة المنصة الافتراضية) ----
export function addClinicRequest({ name, slug, phone }) {
  const r = db.prepare("INSERT INTO clinic_requests(name,slug,phone,status,created_at) VALUES(?,?,?,?,?)")
    .run(String(name || "").slice(0, 100), String(slug || "").slice(0, 32), String(phone || "").slice(0, 20), "pending", new Date().toISOString());
  return Number(r.lastInsertRowid);
}
export function getClinicRequests(status = "") {
  if (status) return db.prepare("SELECT * FROM clinic_requests WHERE status=? ORDER BY id DESC").all(status);
  return db.prepare("SELECT * FROM clinic_requests ORDER BY id DESC").all();
}
export function decideClinicRequest(id, status) {
  db.prepare("UPDATE clinic_requests SET status=?, decided_at=? WHERE id=?").run(status, new Date().toISOString(), id);
}
export function enqueue(kind, payload, delaySec = 0) {
  const next = new Date(Date.now() + delaySec * 1000).toISOString();
  const r = db.prepare("INSERT INTO jobs(kind,payload,status,attempts,next_run,created_at) VALUES(?,?,?,0,?,?)")
    .run(kind, JSON.stringify(payload || {}), "pending", next, new Date().toISOString());
  return Number(r.lastInsertRowid);
}
export function claimJobs(limit = 20) {
  return withTransaction(() => {
    const now = new Date().toISOString();
    const rows = db.prepare("SELECT * FROM jobs WHERE status='pending' AND next_run<=? ORDER BY id LIMIT ?").all(now, limit);
    for (const j of rows) db.prepare("UPDATE jobs SET status='processing', attempts=attempts+1 WHERE id=?").run(j.id);
    return rows.map(j => ({ ...j, payload: JSON.parse(j.payload || "{}") }));
  });
}
export function finishJob(id, ok, error = "") {
  if (ok) { db.prepare("DELETE FROM jobs WHERE id=?").run(id); return; }
  const j = db.prepare("SELECT attempts FROM jobs WHERE id=?").get(id);
  if (j && j.attempts >= 3) {
    db.prepare("UPDATE jobs SET status='failed', last_error=? WHERE id=?").run(String(error).slice(0, 300), id);
  } else {
    const next = new Date(Date.now() + 60000).toISOString();
    db.prepare("UPDATE jobs SET status='pending', next_run=?, last_error=? WHERE id=?").run(next, String(error).slice(0, 300), id);
  }
}
export function getQueueStatus() {
  const rows = db.prepare("SELECT status, COUNT(*) c FROM jobs GROUP BY status").all();
  const out = { pending: 0, processing: 0, failed: 0 };
  for (const r of rows) out[r.status] = r.c;
  const lastFail = db.prepare("SELECT * FROM jobs WHERE status='failed' ORDER BY id DESC LIMIT 3").all();
  return { ...out, lastFail };
}

// مسح بيانات التجربة فقط (المحادثة التجريبية + الاختبارات) — الداتا الحقيقية سليمة
const TEST_PATTERNS = ["test", "web-%", "t-sm-%", "t-race-%", "t-pay", "01090%", "01060%", "01091%", "0107777%"];
function testWhere(col) {
  return `${col} = 'test' OR ${col} LIKE 'web-%' OR ${col} LIKE 't-sm-%' OR ${col} LIKE 't-race-%' OR ${col} = 't-pay' OR ${col} LIKE '01090%' OR ${col} LIKE '01060%' OR ${col} LIKE '01091%' OR ${col} LIKE '0107777%'`;
}
export function purgeTestData() {
  const out = {};
  out.bookings = db.prepare(`DELETE FROM bookings WHERE ${testWhere("sender")} OR ${testWhere("phone")}`).run().changes;
  out.patients = db.prepare(`DELETE FROM patients WHERE ${testWhere("phone")}`).run().changes;
  out.messages = db.prepare(`DELETE FROM messages WHERE ${testWhere("sender")}`).run().changes;
  out.sessions = db.prepare(`DELETE FROM sessions WHERE ${testWhere("phone")}`).run().changes;
  try { db.prepare(`DELETE FROM sender_phones WHERE ${testWhere("sender")} OR ${testWhere("phone")}`).run(); } catch {}
  try { db.prepare(`DELETE FROM visits WHERE ${testWhere("phone")}`).run(); } catch {}
  return out;
}

// سياسة الاحتفاظ: مسح الرسائل الأقدم من N يوم (الافتراضي 365 — يحدده المجمع)
export function purgeOldMessages(days = 365) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const r = db.prepare("DELETE FROM messages WHERE at < ?").run(cutoff);
  return { deleted: r.changes };
}

// ---- تدقيق + إشعارات + قاعدة معرفة ----
export function logAudit(actor, action, detail) {
  db.prepare("INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)")
    .run(new Date().toISOString(), String(actor || ""), String(action || ""), String(detail || "").slice(0, 500));
}
export function getAudit(limit = 100) {
  return db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
}
export function getAuditPaged({ page = 1, limit = 50 } = {}) {
  page = Math.max(1, Number(page) || 1);
  limit = Math.min(100, Math.max(1, Number(limit) || 50));
  const offset = (page - 1) * limit;
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);
  const total = db.prepare("SELECT COUNT(*) c FROM audit_log").get().c;
  return { rows, total, page, limit, pages: Math.ceil(total / limit) };
}
export function logNotification(phone, kind, text, channel = "whatsapp") {
  db.prepare("INSERT INTO notifications(at,phone,kind,text,channel) VALUES(?,?,?,?,?)")
    .run(new Date().toISOString(), String(phone || ""), String(kind || ""), String(text || "").slice(0, 500), channel);
}
export function getNotifications(limit = 100) {
  return db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT ?").all(limit);
}
export function getNotificationsPaged({ page = 1, limit = 50 } = {}) {
  page = Math.max(1, Number(page) || 1);
  limit = Math.min(100, Math.max(1, Number(limit) || 50));
  const offset = (page - 1) * limit;
  const rows = db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);
  const total = db.prepare("SELECT COUNT(*) c FROM notifications").get().c;
  return { rows, total, page, limit, pages: Math.ceil(total / limit) };
}
// قاعدة معرفة بسيطة (بحث كلمات — نواة RAG بدون embeddings)
export function addKbDoc(title, body) {
  const r = db.prepare("INSERT INTO kb_docs(title,body,updated_at) VALUES(?,?,?)")
    .run(String(title || "").slice(0, 200), String(body || "").slice(0, 5000), new Date().toISOString());
  return Number(r.lastInsertRowid);
}
export function getKbDocs() {
  return db.prepare("SELECT * FROM kb_docs ORDER BY id DESC").all();
}
export function deleteKbDoc(id) {
  return db.prepare("DELETE FROM kb_docs WHERE id=?").run(id).changes > 0;
}
function normKb(s) { return String(s || "").replace(/[\u064B-\u0652]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه"); }
export function searchKb(text, limit = 2) {
  const docs = getKbDocs();
  if (!docs.length) return [];
  const words = normKb(text).split(/\s+/).filter(w => w.length > 2);
  const scored = docs.map(d => {
    const nb = normKb(d.title + " " + d.body);
    let score = 0;
    for (const w of words) if (nb.includes(w)) score++;
    return { d, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  return scored.map(x => x.d);
}

export function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  const totalBookings = db.prepare("SELECT COUNT(*) c FROM bookings").get().c;
  const todayBookings = db.prepare("SELECT COUNT(*) c FROM bookings WHERE substr(at,1,10)=?").get(today).c;
  const totalMessages = db.prepare("SELECT COUNT(*) c FROM messages").get().c;
  const clients = db.prepare("SELECT COUNT(DISTINCT sender) c FROM messages").get().c;
  const openHandoffs = db.prepare("SELECT COUNT(*) c FROM handoffs WHERE done=0").get().c;
  const last = db.prepare("SELECT * FROM bookings ORDER BY id DESC LIMIT 1").get();
  return { totalBookings, todayBookings, totalMessages, clients, openHandoffs, lastBooking: last ? row2b(last) : null };
}

export function getRemindedByPhone(phone) {
  const b = db.prepare("SELECT * FROM bookings WHERE (sender=? OR phone=?) AND status='reminded' ORDER BY date, time LIMIT 1").get(phone, phone);
  return b ? row2b(b) : null;
}
export function getDueUnconfirmed() {
  // حجوزات النهاردة لسه متأكدتش ومعادها خلال ساعتين أو فات
  const n = new Date();
  const s = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  const nowMin = n.getHours() * 60 + n.getMinutes();
  return db.prepare("SELECT * FROM bookings WHERE date=? AND status='reminded'").all(s).map(row2b).filter(b => {
    const [h, m] = String(b.time || "0:0").split(":").map(Number);
    return (h * 60 + m) <= nowMin + 120;
  });
}
export function getTomorrowBookings() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return db.prepare("SELECT * FROM bookings WHERE date=? AND status='confirmed'").all(s).map(row2b);
}

export function getReports() {
  const all = db.prepare("SELECT * FROM bookings").all().map(row2b);
  let cfg = { services: [] };
  try { cfg = getConfig(); } catch {}
  const price = n => cfg.services.find(s => s.name === n)?.price || 0;
  const live = all.filter(b => ["confirmed", "reminded", "attended"].includes(b.status));
  const bySpec = {};
  for (const b of live) {
    const k = b.specialty || "عام";
    bySpec[k] = bySpec[k] || { count: 0, revenue: 0 };
    bySpec[k].count++;
    bySpec[k].revenue += price(b.service);
  }
  const attended = all.filter(b => b.status === "attended").length;
  const noShow = all.filter(b => b.status === "no_show").length;
  const cancelled = all.filter(b => b.status === "cancelled").length;
  const done = attended + noShow;
  // إيراد وحجوزات لكل دكتور + حجوزات آخر 14 يوم
  const byDoctor = {};
  for (const b of live) {
    const k = b.doctor || "بدون دكتور";
    byDoctor[k] = byDoctor[k] || { count: 0, revenue: 0 };
    byDoctor[k].count++;
    byDoctor[k].revenue += price(b.service);
  }
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    daily.push({ date: s.slice(5), count: all.filter(b => (b.at || "").slice(0, 10) === s).length });
  }
  // تحليلات AI: عدد المحادثات، التحويل لبشري، أكثر الخدمات، أكثر الأسئلة
  let totalConvs = 0, handoffs = 0, aiResolution = 0, handoffRate = 0;
  let topServices = [], topQuestions = [], avgRespSec = 0;
  try {
    totalConvs = db.prepare("SELECT COUNT(DISTINCT sender) c FROM messages").get().c;
    handoffs = db.prepare("SELECT COUNT(*) c FROM handoffs").get().c;
    handoffRate = totalConvs ? Math.round((handoffs / totalConvs) * 100) : 0;
    aiResolution = 100 - handoffRate;
    const svc = db.prepare("SELECT service, COUNT(*) c FROM bookings GROUP BY service ORDER BY c DESC LIMIT 5").all();
    topServices = svc;
    // أكثر الأسئلة: أول 60 حرف من رسائل العملاء الأكثر تكراراً
    const qs = db.prepare("SELECT substr(text,1,60) q, COUNT(*) c FROM messages WHERE direction='in' GROUP BY q ORDER BY c DESC LIMIT 5").all();
    topQuestions = qs;
    // متوسط زمن الاستجابة: فرق in -> out التالية لنفس المرسل (آخر 200)
    const msgs = db.prepare("SELECT sender, direction, at FROM messages ORDER BY id DESC LIMIT 200").all().reverse();
    let sum = 0, n = 0;
    for (let i = 0; i < msgs.length - 1; i++) {
      if (msgs[i].direction === "in" && msgs[i + 1].direction === "out" && msgs[i].sender === msgs[i + 1].sender) {
        const d = new Date(msgs[i + 1].at) - new Date(msgs[i].at);
        if (d >= 0 && d < 600000) { sum += d; n++; }
      }
    }
    avgRespSec = n ? Math.round((sum / n / 1000) * 10) / 10 : 0;
  } catch {}
  return {
    totalRevenue: Object.values(bySpec).reduce((a, x) => a + x.revenue, 0),
    totalDeposit: all.reduce((a, b) => a + (Number(b.deposit) || 0), 0),
    paidCount: all.filter(b => b.paid).length,
    bySpecialty: bySpec,
    attended, noShow, cancelled,
    noShowRate: done ? Math.round((noShow / done) * 100) : 0,
    total: all.length,
    totalConvs, handoffs, aiResolution, handoffRate, topServices, topQuestions, avgRespSec,
    byDoctor, daily
  };
}
