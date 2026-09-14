// OTP عبر واتساب للعمليات الحساسة (تغيير الرقم) — بدون SMS مدفوع
// الكود يتبعت على الرقم *القديم* (إثبات الملكية) ولا يُرجع في الإنتاج المتصل.
import crypto from "crypto";
import { saveOtp, getOtp, bumpOtpAttempts, clearOtp, getPatient, changePatientNumber, logAudit } from "./store.js";
import { getConfig } from "./tenants.js";
import { sendWhatsApp } from "./whatsapp.js";

const isMobile = s => /^01[0125][0-9]{8}$/.test(String(s || "").replace(/[\s-]/g, ""));
const reqTimes = new Map(); // حد الطلبات: 5 في الساعة لكل رقم
function tooManyOtp(phone) {
  const now = Date.now();
  const arr = (reqTimes.get(phone) || []).filter(t => now - t < 3600000);
  if (arr.length >= 5) return true;
  arr.push(now);
  reqTimes.set(phone, arr);
  return false;
}
function hashCode(code, phone) {
  return crypto.createHash("sha256").update(`${phone}:${code}`).digest("hex");
}

export async function requestOtp(oldPhone, newPhone) {
  oldPhone = String(oldPhone || "").replace(/[\s-]/g, "");
  newPhone = String(newPhone || "").replace(/[\s-]/g, "");
  if (!isMobile(oldPhone) || !isMobile(newPhone)) return { ok: false, error: "الأرقام لازم 11 رقم (010/011/012/015)" };
  if (oldPhone === newPhone) return { ok: false, error: "الرقم الجديد نفس القديم" };
  if (!getPatient(oldPhone)) return { ok: false, error: "الرقم القديم مش مسجل كمريض" };
  if (getPatient(newPhone)) return { ok: false, error: "الرقم الجديد مسجل لمريض تاني" };
  if (tooManyOtp(oldPhone)) return { ok: false, error: "طلبات كتير — جرب بعد ساعة" };
  const code = String(Math.floor(100000 + Math.random() * 900000));
  saveOtp(oldPhone, newPhone, hashCode(code, oldPhone), 10);
  let clinicName = "المجمع";
  try { clinicName = getConfig().name || clinicName; } catch {}
  const msg = `كود تغيير الرقم في ${clinicName}: ${code}\nصالح 10 دقائق. لو مطلبتوش تجاهل الرسالة.`;
  let mock = false;
  try {
    const r = await sendWhatsApp(oldPhone, msg);
    mock = !!(r && r.mock);
  } catch (e) { mock = true; }
  try { logAudit("system", "otp_request", `${oldPhone} -> ${newPhone} (mock=${mock})`); } catch {}
  // وضع تجريبي (من غير واتساب حقيقي): نرجع الكود للتجربة فقط
  return { ok: true, mock, code: mock ? code : undefined };
}

export function confirmOtp(oldPhone, newPhone, code) {
  oldPhone = String(oldPhone || "").replace(/[\s-]/g, "");
  const row = getOtp(oldPhone);
  if (!row) return { ok: false, error: "مفيش طلب تغيير — اطلب كود الأول" };
  if (String(row.new_phone) !== String(newPhone || "").replace(/[\s-]/g, "")) return { ok: false, error: "الرقم الجديد مختلف عن الطلب" };
  if (new Date(row.expires_at).getTime() < Date.now()) { clearOtp(oldPhone); return { ok: false, error: "الكود انتهت صلاحيته — اطلب واحد جديد" }; }
  if ((row.attempts || 0) >= 5) { clearOtp(oldPhone); return { ok: false, error: "محاولات كتير — اطلب كود جديد" }; }
  let good = false;
  try {
    good = crypto.timingSafeEqual(Buffer.from(hashCode(code, oldPhone)), Buffer.from(row.code_hash));
  } catch { good = false; }
  if (!good) {
    bumpOtpAttempts(oldPhone);
    try { logAudit("system", "otp_fail", oldPhone); } catch {}
    return { ok: false, error: "الكود غلط" };
  }
  clearOtp(oldPhone);
  const r = changePatientNumber(oldPhone, row.new_phone);
  if (!r.ok) return r;
  try { logAudit("system", "otp_ok_change", `${oldPhone} -> ${row.new_phone}`); } catch {}
  return { ok: true, patient: r.patient };
}
