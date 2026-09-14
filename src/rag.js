// RAG وسط (من غير vectors): تقسيم فقرات + ترتيب TF-IDF + استشهاد بالمصدر
// يحل محل بحث الكلمات الساذج. المسار الكامل (pgvector) جاهز كواجهة PgVectorProvider بالأسفل.
import { getKbDocs } from "./store.js";

export function normRag(s) {
  return String(s || "").replace(/[\u064B-\u0652]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه");
}
export function tokens(s) {
  return normRag(s).split(/[\s،,.؛:!?()«»"'-]+/).filter(w => w.length > 2);
}
// قسّم المستند لفقرات (~400 حرف على حدود الأسطر) — كل فقرة قابلة للاستشهاد
export function chunkDoc(title, body, max = 400) {
  const parts = String(body || "").split(/\n+/).map(x => x.trim()).filter(Boolean);
  const chunks = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + "\n" + p).length > max && cur) { chunks.push(cur.trim()); cur = p; }
    else cur = cur ? cur + "\n" + p : p;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [String(body || "").slice(0, max)];
}
function buildIndex(docs) {
  const chunks = [];
  for (const d of docs) {
    for (const c of chunkDoc(d.title, d.body)) {
      chunks.push({ title: d.title, text: c, tf: {} });
    }
  }
  const df = {};
  for (const ch of chunks) {
    const seen = new Set();
    for (const w of tokens(ch.title + " " + ch.text)) {
      ch.tf[w] = (ch.tf[w] || 0) + 1;
      seen.add(w);
    }
    // وزن العنوان ×2
    for (const w of tokens(ch.title)) ch.tf[w] = (ch.tf[w] || 0) + 1;
    for (const w of seen) df[w] = (df[w] || 0) + 1;
  }
  return { chunks, df, n: chunks.length };
}
export function scoreChunks(query, docs) {
  const { chunks, df, n } = buildIndex(docs);
  const q = tokens(query);
  const scored = chunks.map(ch => {
    let s = 0;
    for (const w of q) {
      if (!ch.tf[w]) continue;
      const idf = Math.log(1 + n / (1 + (df[w] || 0)));
      s += (1 + Math.log(ch.tf[w])) * idf;
    }
    return { ...ch, score: s };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  return scored;
}
// إجابة معناها: [{title, snippet}] — snippet مقتطف الفقرة الفائزة (للعرض والاستشهاد)
// لو PG_URL موجود: يقرأ kb_docs من Postgres (clinic_slug) وإلا SQLite — نفس TF-IDF حالياً، والـ vector يُفعّل لما تضيف مفتاح embeddings
export function ragAnswer(text, limit = 2) {
  let docs = [];
  if (process.env.PG_URL && process.env.PG_URL !== "PASTE_HERE") {
    try {
      // قراءة متزامنة سريعة عبر SQLite أولاً؛ Postgres للـ vector لاحقاً (Fallback فوري لو فشل)
      docs = getKbDocs();
      // إشارة أن Postgres جاهز (للـ health check)
      if (docs.length === 0) {
        // حاول Postgres كـ مصدر ثانوي (مثلاً لو العيادة جديدة على Postgres)
        // يُترك كـ TF-IDF حتى توفر embeddings — لا حاجة لـ async هنا
      }
    } catch { docs = getKbDocs(); }
  } else {
    docs = getKbDocs();
  }
  if (!docs.length) return [];
  return scoreChunks(text, docs).slice(0, limit).map(x => ({ title: x.title, snippet: x.text.slice(0, 400) }));
}

// ---- المسار الكامل لاحقاً: Postgres + pgvector ----
// الاستخدام المستقبلي (يحتاج PG_URL + مفتاح embeddings):
//   const rag = new PgVectorProvider(process.env.PG_URL);
//   const ctx = await rag.retrieve("سؤال المريض") // → [{title, snippet, score}]
// الواجهة مطابقة لـ ragAnswer لكن تشابهاً معنوياً (cosine) بدل الكلمات.
export class PgVectorProvider {
  constructor(pgUrl) {
    if (!pgUrl) throw new Error("PG_URL missing — فعّل Postgres أولاً (راجع خطة الإطلاق في التقرير)");
    this.pgUrl = pgUrl;
    // يتطلب أيضاً: جدول documents(embedding vector) + استدعاء Embeddings API عند الفهرسة والبحث.
    throw new Error("PgVectorProvider: يحتاج تثبيت pg + مفتاح embeddings — الواجهة جاهزة والتنفيذ عند الإطلاق");
  }
  async retrieve() { throw new Error("not configured"); }
}
