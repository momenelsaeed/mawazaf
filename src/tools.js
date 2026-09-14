// Tools حقيقية للـ AI — بدل tags فقط: كل أداة بتعمل validation + audit
import { readFileSync } from "fs";
import { validateBooking, slotLabel } from "./schedule.js";
import { createBooking, createBookingChecked, activeBookings, cancelLatestByPhone, getLatestActiveByPhone, getBookings, updateBookingSlot, getPatientBySender, addHandoff, logAudit, logNotification } from "./store.js";

import { getConfig } from "./tenants.js";
function loadConfig() {
  return getConfig();
}

export function check_availability(service, slotText) {
  const config = loadConfig();
  const v = validateBooking(service, slotText, config, activeBookings());
  if (v.ok) return { ok: true, date: v.date, time: v.time, label: v.label, doctor: v.doctor, specialty: v.specialty };
  return { ok: false, reason: v.reason, alternatives: v.alternatives || [] };
}

export function book_appointment({ from, name, phone, service, slotText, actor = "ai" }) {
  // ذري: الفحص + الإنشاء في معاملة واحدة (تمنع حجز مزدوج متزامن)
  let r;
  try {
    r = createBookingChecked({ from, name, phone, service, slotText });
  } catch (e) {
    return { ok: false, reason: "المعاد اتحجز حالاً من عميل تاني، اختار معاد قريب منه.", alternatives: [] };
  }
  if (!r.ok) return r;
  const booking = r.booking;
  try { logAudit(actor, "book", `booking ${booking.code} ${service} ${booking.slot}`); } catch {}
  try { logNotification(phone || from, "confirmation", `تم حجز ${service} | ${booking.slot} (${booking.code})`); } catch {}
  return { ok: true, booking };
}

export function cancel_appointment({ from, actor = "ai" }) {
  const b = cancelLatestByPhone(from);
  if (!b) return { ok: false, reason: "مفيش حجز نشط" };
  try { logAudit(actor, "cancel", `booking #${b.id}`); } catch {}
  try { logNotification(b.phone || from, "cancellation", `اتلغى حجز ${b.service} | ${b.slot}`); } catch {}
  return { ok: true, booking: b };
}

export function reschedule_appointment({ from, newSlotText, actor = "ai" }) {
  const existing = getLatestActiveByPhone(from);
  if (!existing) return { ok: false, reason: "مفيش حجز نشط" };
  const config = loadConfig();
  // استبعاد الحجز نفسه من فحص التضارب (وإلا النقل لنفس المعاد يفشل بنفسه)
  const others = activeBookings().filter(b => String(b.id) !== String(existing.id));
  const v = validateBooking(existing.service, newSlotText, config, others);
  if (!v.ok) return v;
  const upd = updateBookingSlot(existing.id, { date: v.date, time: v.time, slot: v.label, duration: existing.duration, doctor: v.doctor || existing.doctor });
  try { logAudit(actor, "reschedule", `booking #${existing.id} -> ${v.label}`); } catch {}
  return { ok: true, booking: upd };
}

export function get_customer({ from }) {
  // AI يرى الحد الأدنى فقط — ممنوع السجل الطبي الكامل (patients.read.medical)
  try {
    const p = getPatientBySender(from);
    if (!p) return null;
    return { name: p.name, visits: p.visits, lastService: p.lastService, pid: p.pid ?? null };
  } catch { return null; }
}

export function transfer_to_human({ from, reason }) {
  const h = addHandoff(from, reason || "");
  try { logAudit("ai", "handoff", `${from}: ${String(reason || "").slice(0, 80)}`); } catch {}
  return { ok: true, handoff: h };
}

export const TOOLS = { check_availability, book_appointment, cancel_appointment, reschedule_appointment, get_customer, transfer_to_human };
