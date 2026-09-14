# ترحيل Postgres + pgvector (اختياري — لـ Pilot صغير مش ضروري)

حالياً SQLite يكفي لـ Pilot عيادة/اتنين (atomic booking + busy_timeout + multi-tenant عبر ملفات). الترحيل لما الحمل يكبر (>500 حجز/يوم أو >5 عيادات نشطة) أو لما تحتاج RAG معنوي حقيقي.

## الخطوات
1. شغّل Postgres مع pgvector (في `docker-compose.yml` الخدمة `db` المعلقة — أزل التعليق).
2. ثبّت الاعتماديات: `npm install pg pgvector`
3. أنشئ الجداول بنفس أسماء SQLite + عمود `embedding vector(1536)` لجدول `kb_docs` أو `documents`.
4. شغّل سكربت `node scripts/migrate-to-pg.mjs` (ينسخ tenants/*.db → Postgres مع حفظ `?clinic=`).
5. بدّل `src/store.js` ليستخدم `pg` بدل `node:sqlite` عبر متغير `PG_URL` (الكود الحالي يبقى fallback لو `PG_URL` فارغ).
6. فعّل `PgVectorProvider` في `src/rag.js` (بدل TF-IDF) بمفتاح Embeddings (`OPENAI_API_KEY`).

## ملاحظات
- لا تنقل قبل أول 3 عيادات دافعة — SQLite أبسط وأسرع للبداية.
- النسخ الاحتياطي يتحول من ملفات `data.db` إلى `pg_dump` مشفرة بنفس `BACKUP_KEY`.
- اختبر RAG بعد الترحيل بـ `npm test -- --test-name-pattern=RAG` وتأكد من citations.
