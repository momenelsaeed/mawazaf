// مصادقة حقيقية: scrypt + جلسات منتهية + قفل بعد محاولات فاشلة
import crypto from "crypto";
import { getUser, createUser, setUserHash, touchLogin, createSession, getSession, deleteSessionByToken, logAudit } from "./store.js";
import { VALID_ROLES } from "./roles.js";

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}
export function verifyPassword(password, stored) {
  try {
    if (!stored) return false;
    // دعم الشكل القديم (sha256 بدون ملح) للترحيل — يُعاد تشفيره scrypt عند أول دخول ناجح
    if (!stored.startsWith("scrypt:")) {
      const h = crypto.createHash("sha256").update(String(password)).digest("hex");
      return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(stored));
    }
    const [, salt, hash] = stored.split(":");
    const h = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(hash, "hex"));
  } catch { return false; }
}
export function needsRehash(stored) {
  return !String(stored || "").startsWith("scrypt:");
}

// قفل الدخول: 5 محاولات فاشلة خلال 15 دقيقة → حظر 15 دقيقة (لكل مستخدم + IP)
const fails = new Map();
function failKey(user, ip) { return `${String(user || "").toLowerCase()}|${ip}`; }
export function isLocked(user, ip) {
  const r = fails.get(failKey(user, ip));
  if (!r) return false;
  if (Date.now() - r.first > 15 * 60000) { fails.delete(failKey(user, ip)); return false; }
  return r.count >= 5 && Date.now() - r.last < 15 * 60000;
}
export function noteFail(user, ip) {
  const k = failKey(user, ip);
  const r = fails.get(k) || { count: 0, first: Date.now(), last: 0 };
  if (Date.now() - r.first > 15 * 60000) { r.count = 0; r.first = Date.now(); }
  r.count++; r.last = Date.now();
  fails.set(k, r);
}
export function noteSuccess(user, ip) { fails.delete(failKey(user, ip)); }

export function newToken() { return crypto.randomBytes(32).toString("hex"); }

// إنشاء مستخدمين من .env عند أول تشغيل (لا يعيد الكتابة لو موجودين)
export function bootstrapUsers() {
  const out = [];
  const ensure = (username, password, role) => {
    if (!password || password === "PASTE_HERE") return;
    if (!VALID_ROLES.includes(role)) return;
    try {
      if (!getUser(username)) {
        createUser(username, hashPassword(password), role);
        out.push(`${username} (${role})`);
      }
    } catch (e) { console.error("bootstrap user:", e.message); }
  };
  ensure("admin", process.env.DASHBOARD_PASSWORD, "admin");
  ensure("reception", process.env.STAFF_PASSWORD, "reception");
  ensure("doctor", process.env.DOCTOR_PASSWORD, "doctor");
  if (out.length) console.log("👥 مستخدمون جدد:", out.join("، "));
}

export function loginUser(username, password, ip) {
  username = String(username || "").toLowerCase().trim();
  if (isLocked(username, ip)) {
    try { logAudit(username, "login_locked", ip); } catch {}
    return { ok: false, locked: true };
  }
  const u = getUser(username);
  if (!u || !u.active || !verifyPassword(password, u.pass_hash)) {
    noteFail(username, ip);
    try { logAudit(username, "login_fail", ip); } catch {}
    return { ok: false };
  }
  if (needsRehash(u.pass_hash)) {
    try { setUserHash(username, hashPassword(password)); } catch {}
  }
  noteSuccess(username, ip);
  const token = newToken();
  createSession(token, username, u.role, 12, ip);
  touchLogin(username);
  try { logAudit(username, "login", `${u.role} from ${ip}`); } catch {}
  return { ok: true, username, role: u.role, token };
}
