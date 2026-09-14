// مصفوفة الصلاحيات — مرجع واحد لكل القرارات (السيرفر والاختبارات)
// الهرمية: admin(3) > doctor(2) > reception(1) | AI كيان منفصل بصلاحيات مقيدة صراحة
export const ROLE_LEVEL = { reception: 1, doctor: 2, admin: 3 };
export const VALID_ROLES = ["admin", "doctor", "reception"];

// ماذا يفعل كل دور؟ (true = مسموح)
const MATRIX = {
  // مرضى
  "patients.read.basic": { admin: true, doctor: true, reception: true },   // اسم/رقم/زيارات أساسية
  "patients.read.medical": { admin: true, doctor: true, reception: false }, // تاريخ مرضي/حساسية/أدوية/تشخيص
  "patients.update.contact": { admin: true, doctor: true, reception: true }, // الاسم فقط للاستقبال
  "patients.update.medical": { admin: true, doctor: true, reception: false },
  "patients.change_number": { admin: true, doctor: false, reception: false }, // المباشر للأدمن فقط — الباقي OTP
  "patients.delete": { admin: true, doctor: false, reception: false },
  "patients.export": { admin: true, doctor: false, reception: false },
  // زيارات طبية
  "visits.read": { admin: true, doctor: true, reception: true },
  "visits.read.diagnosis": { admin: true, doctor: true, reception: false },
  "visits.write": { admin: true, doctor: true, reception: false }, // تشخيص/علاج: دكتور فقط (+أدمن)
  // حجوزات
  "bookings.read": { admin: true, doctor: true, reception: true },
  "bookings.write": { admin: true, doctor: true, reception: true },
  "bookings.pay": { admin: true, doctor: false, reception: true },
  // مالية وتقارير
  "reports.financial": { admin: true, doctor: false, reception: false },
  "reports.workload": { admin: true, doctor: true, reception: true },
  // إدارة
  "config.write": { admin: true, doctor: false, reception: false },
  "users.manage": { admin: true, doctor: false, reception: false },
  "audit.read": { admin: true, doctor: false, reception: false },
  "kb.write": { admin: true, doctor: false, reception: false },
  "broadcast.send": { admin: true, doctor: true, reception: true },
  "purge.data": { admin: true, doctor: false, reception: false },
};

// صلاحيات كيان الـ AI (الشات) — قائمة بيضاء صريحة، كل ما عداها ممنوع
export const AI_ALLOW = new Set([
  "check_availability", "create_booking", "cancel_booking", "reschedule_booking",
  "get_limited_patient", "transfer_to_human",
]);
const AI_DENY = [
  "read_medical_history", "modify_diagnosis", "modify_medications",
  "delete_patient", "export_patients", "change_phone", "manage_users", "read_audit",
];
export function aiCan(action) {
  if (AI_DENY.includes(action)) return false;
  return AI_ALLOW.has(action);
}

export function can(role, action) {
  const row = MATRIX[action];
  if (!row) return false;
  return !!row[role];
}
export function level(role) { return ROLE_LEVEL[role] || 0; }
export function atLeast(role, minRole) { return level(role) >= level(minRole); }

// إخفاء الحقول الطبية عن الاستقبال
const MEDICAL_PATIENT_FIELDS = ["history", "allergies", "meds", "notes", "birth"];
export function stripPatient(role, p) {
  if (!p) return p;
  if (can(role, "patients.read.medical")) return p;
  const out = { ...p };
  for (const f of MEDICAL_PATIENT_FIELDS) delete out[f];
  if (Array.isArray(out.visitsList)) {
    out.visitsList = out.visitsList.map(v => {
      const c = { ...v };
      delete c.diagnosis; delete c.treatment; delete c.doctor_notes;
      return c;
    });
  }
  return out;
}

export function stripVisit(role, v) {
  if (!v) return v;
  if (can(role, "visits.read.diagnosis")) return v;
  const out = { ...v };
  delete out.diagnosis; delete out.treatment; delete out.doctor_notes;
  return out;
}

export function stripReports(role, rep) {
  if (!rep) return rep;
  if (can(role, "reports.financial")) return rep;
  const out = { ...rep };
  delete out.totalRevenue; delete out.totalDeposit;
  if (out.bySpecialty) {
    const bs = {};
    for (const [k, v] of Object.entries(out.bySpecialty)) bs[k] = { count: v.count };
    out.bySpecialty = bs;
  }
  if (out.byDoctor) {
    const bd = {};
    for (const [k, v] of Object.entries(out.byDoctor)) bd[k] = { count: v.count };
    out.byDoctor = bd;
  }
  return out;
}
