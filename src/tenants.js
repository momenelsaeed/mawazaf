// Multi-tenant: كل عيادة ملف DB مستقل + إعداد مستقل + اشتراك
// العزل عبر AsyncLocalStorage (آمن مع التداخل) — الافتراضي slug="default" (نفس data.db الحالية).
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TENANTS_DIR = join(ROOT, "tenants");
try { mkdirSync(TENANTS_DIR, { recursive: true }); } catch {}

export const als = new AsyncLocalStorage();
export const DEFAULT_TENANT = "default";
export const validSlug = s => /^[a-z0-9-]{3,32}$/.test(String(s || ""));

export function currentSlug() {
  try { return als.getStore()?.slug || DEFAULT_TENANT; } catch { return DEFAULT_TENANT; }
}
export function tenantDir(slug) { return join(TENANTS_DIR, slug); }
export function tenantDbPath(slug) {
  if (!slug || slug === DEFAULT_TENANT) return join(ROOT, "data.db");
  return join(tenantDir(slug), "tenant.db");
}
export function tenantMetaPath(slug) { return join(tenantDir(slug), "tenant.json"); }
export function tenantConfigPath(slug) {
  if (!slug || slug === DEFAULT_TENANT) return join(ROOT, "src", "business-config.json");
  return join(tenantDir(slug), "business-config.json");
}

// إعداد العيادة الحالية (من سياق الطلب — أو الافتراضية)
export function getConfig() {
  const slug = currentSlug();
  try {
    return JSON.parse(readFileSync(tenantConfigPath(slug), "utf-8"));
  } catch {
    return JSON.parse(readFileSync(join(ROOT, "src", "business-config.json"), "utf-8"));
  }
}
export function saveConfigPatch(patch) {
  const slug = currentSlug();
  const p = tenantConfigPath(slug);
  const cur = JSON.parse(readFileSync(p, "utf-8"));
  const next = { ...cur, ...patch };
  writeFileSync(p, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
export function readFullConfig() {
  return JSON.parse(readFileSync(tenantConfigPath(currentSlug()), "utf-8"));
}

// ميتا العيادة (اشتراك/واتساب) — الافتراضية من .env
export function getTenantMeta(slug = currentSlug()) {
  if (!slug || slug === DEFAULT_TENANT) {
    return {
      slug: DEFAULT_TENANT, name: getConfig().name || "العيادة",
      plan: "owner", status: "active", trialEnds: null,
      whatsapp: {
        token: process.env.WHATSAPP_TOKEN, phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        verify: process.env.VERIFY_TOKEN, reminderTemplate: process.env.WHATSAPP_REMINDER_TEMPLATE,
        templateLang: process.env.WHATSAPP_TEMPLATE_LANG, staffPhone: process.env.STAFF_NOTIFY_PHONE,
      }
    };
  }
  try { return JSON.parse(readFileSync(tenantMetaPath(slug), "utf-8")); }
  catch { return null; }
}
export function saveTenantMeta(slug, meta) {
  mkdirSync(tenantDir(slug), { recursive: true });
  writeFileSync(tenantMetaPath(slug), JSON.stringify(meta, null, 2), "utf-8");
  return meta;
}

export function listTenants() {
  const out = [{ slug: DEFAULT_TENANT, ...(getTenantMeta(DEFAULT_TENANT) || {}), db: tenantDbPath(DEFAULT_TENANT) }];
  try {
    for (const d of readdirSync(TENANTS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const m = getTenantMeta(d.name);
      if (m) out.push({ ...m, db: tenantDbPath(d.name) });
    }
  } catch {}
  return out;
}

export function createTenant(slug, name) {
  slug = String(slug || "").toLowerCase().trim();
  if (!validSlug(slug) || slug === DEFAULT_TENANT) return { ok: false, error: "slug غير صالح (3-32 حرف إنجليزي/أرقام/-)" };
  if (existsSync(tenantDir(slug))) return { ok: false, error: "موجودة بالفعل" };
  mkdirSync(tenantDir(slug), { recursive: true });
  // انسخ إعداد البداية من الافتراضية وغيّر الاسم
  const base = JSON.parse(readFileSync(join(ROOT, "src", "business-config.json"), "utf-8"));
  base.name = name || slug;
  writeFileSync(tenantConfigPath(slug), JSON.stringify(base, null, 2), "utf-8");
  const trialEnds = new Date(Date.now() + 14 * 86400000).toISOString();
  saveTenantMeta(slug, {
    slug, name: name || slug, plan: "trial", status: "active", trialEnds,
    created_at: new Date().toISOString(), whatsapp: {}, recall_schedule: null,
  });
  return { ok: true, slug, trialEnds };
}

export async function deleteTenant(slug) {
  if (!slug || slug === DEFAULT_TENANT || !validSlug(slug)) return false;
  try {
    // اقفل اتصال القاعدة الأول (وإلا crash على مستوى النظام)
    const store = await import("./store.js");
    if (store.closeTenant) store.closeTenant(slug);
  } catch {}
  try { rmSync(tenantDir(slug), { recursive: true, force: true }); return true; }
  catch { return false; }
}

// الاشتراك: نشط؟ (التجربة 14 يوم ثم يلزم تفعيل من السوبر أدمن)
export function subscriptionStatus(slug = currentSlug()) {
  const m = getTenantMeta(slug);
  if (!m) return { active: false, reason: "tenant not found" };
  if (m.status === "suspended") return { active: false, reason: "suspended" };
  if (m.status === "active" && !m.trialEnds) return { active: true, plan: m.plan || "active" };
  if (m.trialEnds && new Date(m.trialEnds).getTime() > Date.now()) {
    const days = Math.ceil((new Date(m.trialEnds).getTime() - Date.now()) / 86400000);
    return { active: true, plan: "trial", daysLeft: days };
  }
  if (m.status === "active") return { active: true, plan: m.plan || "paid" };
  return { active: false, reason: "trial expired" };
}

// تشغيل كود داخل سياق عيادة (للـ cron والاختبارات)
export function withTenant(slug, fn) {
  return als.run({ slug }, fn);
}
export function allTenantSlugs() {
  const slugs = [DEFAULT_TENANT];
  try {
    for (const d of readdirSync(TENANTS_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && validSlug(d.name) && getTenantMeta(d.name)) slugs.push(d.name);
    }
  } catch {}
  return slugs;
}
export { ROOT };
