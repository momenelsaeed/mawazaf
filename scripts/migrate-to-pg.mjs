import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readdirSync, existsSync } from "fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PG_URL = process.env.PG_URL || "postgres://clinic:clinic123@localhost:5433/clinic";

const client = new pg.Client({ connectionString: PG_URL });
await client.connect();
console.log("✓ Connected to Postgres");

// Enable pgvector
await client.query("CREATE EXTENSION IF NOT EXISTS vector");
console.log("✓ pgvector enabled");

// Create tables with clinic_slug for multi-tenant
await client.query(`
CREATE TABLE IF NOT EXISTS bookings (
  id BIGINT PRIMARY KEY, clinic_slug TEXT NOT NULL DEFAULT 'default',
  at TEXT, sender TEXT, name TEXT, phone TEXT,
  service TEXT, specialty TEXT, doctor TEXT, slot TEXT,
  date TEXT, time TEXT, duration INTEGER, status TEXT,
  needs_review INTEGER, deposit INTEGER, paid INTEGER, code TEXT
);
CREATE TABLE IF NOT EXISTS patients (
  phone TEXT, clinic_slug TEXT NOT NULL DEFAULT 'default',
  name TEXT, visits INTEGER, lastService TEXT, lastAt TEXT,
  history TEXT, allergies TEXT, meds TEXT, notes TEXT, birth TEXT, gender TEXT, pid INTEGER,
  PRIMARY KEY (phone, clinic_slug)
);
CREATE TABLE IF NOT EXISTS kb_docs (
  id SERIAL PRIMARY KEY, clinic_slug TEXT NOT NULL DEFAULT 'default',
  title TEXT, body TEXT, updated_at TEXT, embedding vector(1536)
);
CREATE INDEX IF NOT EXISTS idx_bookings_clinic ON bookings(clinic_slug, date);
CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_slug);
`);

console.log("✓ Tables created");

// Migrate from SQLite files
const tenants = ["default"];
try {
  for (const d of readdirSync(join(ROOT, "tenants"), { withFileTypes: true })) {
    if (d.isDirectory()) tenants.push(d.name);
  }
} catch {}

let totalBookings = 0, totalPatients = 0, totalKb = 0;
for (const slug of tenants) {
  const dbPath = slug === "default" ? join(ROOT, "data.db") : join(ROOT, "tenants", slug, "tenant.db");
  if (!existsSync(dbPath)) continue;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const bookings = db.prepare("SELECT * FROM bookings").all();
    for (const b of bookings) {
      await client.query(
        `INSERT INTO bookings (id, clinic_slug, at, sender, name, phone, service, specialty, doctor, slot, date, time, duration, status, needs_review, deposit, paid, code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO NOTHING`,
        [b.id, slug, b.at, b.sender, b.name, b.phone, b.service, b.specialty, b.doctor, b.slot, b.date, b.time, b.duration, b.status, b.needs_review, b.deposit, b.paid, b.code]
      );
      totalBookings++;
    }
  } catch (e) { console.log(` - ${slug} bookings: ${e.message}`); }
  try {
    const patients = db.prepare("SELECT * FROM patients").all();
    for (const p of patients) {
      await client.query(
        `INSERT INTO patients (phone, clinic_slug, name, visits, lastService, lastAt, history, allergies, meds, notes, birth, gender, pid)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (phone, clinic_slug) DO NOTHING`,
        [p.phone, slug, p.name, p.visits, p.lastService, p.lastAt, p.history, p.allergies, p.meds, p.notes, p.birth, p.gender, p.pid]
      );
      totalPatients++;
    }
  } catch (e) { console.log(` - ${slug} patients: ${e.message}`); }
  try {
    const kbs = db.prepare("SELECT * FROM kb_docs").all();
    for (const k of kbs) {
      await client.query(
        `INSERT INTO kb_docs (clinic_slug, title, body, updated_at) VALUES ($1,$2,$3,$4)`,
        [slug, k.title, k.body, k.updated_at]
      );
      totalKb++;
    }
  } catch {}
  try { db.close(); } catch {}
  console.log(`  → ${slug}: migrated`);
}

console.log(`\n✓ Migration done: ${totalBookings} bookings, ${totalPatients} patients, ${totalKb} kb_docs`);
const check = await client.query("SELECT clinic_slug, COUNT(*) as c FROM bookings GROUP BY clinic_slug");
console.log("Bookings per clinic:", check.rows);
await client.end();
console.log("\nNext: Set PG_URL in .env and restart — SQLite stays as fallback, RAG will use pgvector.");
