// عامل الطابور: رسائل جماعية/تذكير/متابعة —重试 تلقائي 3 مرات ثم failed
// (بديل Redis في حجم العيادة — persistent في SQLite، وكل عيادة طابورها منفصل)
import { claimJobs, finishJob, getQueueStatus, logMessage, logNotification, setBookingStatus, logRecall, logCron } from "./store.js";
import { sendWhatsApp, sendReminder } from "./whatsapp.js";
import { withTenant, allTenantSlugs } from "./tenants.js";

async function handle(job) {
  const p = job.payload || {};
  if (job.kind === "send") {
    await sendWhatsApp(p.to, p.text);
    try { logMessage(p.to, "out", p.text); } catch {}
    return;
  }
  if (job.kind === "reminder") {
    await sendReminder(p.to, p.name, p.service, p.slot);
    setBookingStatus(p.bookingId, "reminded");
    try { logMessage(p.to, "out", `[تذكير تلقائي] ${p.service} | ${p.slot}`); } catch {}
    return;
  }
  if (job.kind === "recall") {
    await sendWhatsApp(p.phone, p.text);
    logRecall(p.phone, p.service);
    try { logMessage(p.phone, "out", `[متابعة تلقائية] ${p.text}`); } catch {}
    return;
  }
  if (job.kind === "broadcast") {
    await sendWhatsApp(p.to, p.text);
    try { logMessage(p.to, "out", `[جماعية] ${p.text}`); } catch {}
    try { logNotification(p.phone || p.to, "broadcast", p.text); } catch {}
    return;
  }
  throw new Error("unknown job kind: " + job.kind);
}

export async function runQueueOnce(limit = 20) {
  const jobs = claimJobs(limit);
  let done = 0, failed = 0;
  for (const j of jobs) {
    try { await handle(j); finishJob(j.id, true); done++; }
    catch (e) { finishJob(j.id, false, e.message); failed++; }
  }
  if (jobs.length) { try { logCron("queue", failed === 0, failed ? `${failed} failed` : ""); } catch {} }
  return { total: jobs.length, done, failed };
}

let timer = null;
export function startQueueWorker(ms = 5000) {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      for (const slug of allTenantSlugs()) {
        try { await withTenant(slug, () => runQueueOnce()); } catch {}
      }
    } catch (e) { console.error("queue worker:", e.message); }
  }, ms);
}

export function queueStatus() { return getQueueStatus(); }
