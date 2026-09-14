// تفريغ رسايل الفويس من واتساب بـ Whisper
// يشتغل فقط مع WHATSAPP_TOKEN + OPENAI_API_KEY (وضع حقيقي)، غير كده يرجع error والبوت يطلب كتابة
import axios from "axios";
import OpenAI from "openai";
import { createReadStream, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export async function transcribeVoice(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token || token === "PASTE_HERE") return { error: "no-whatsapp" };
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "PASTE_HERE") return { error: "no-openai" };
  let tmp = "";
  try {
    // 1. رابط الميديا من ميتا
    const meta = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000
    });
    // 2. تحميل الصوت
    const dl = await axios.get(meta.data.url, {
      headers: { Authorization: `Bearer ${token}` }, responseType: "arraybuffer", timeout: 30000
    });
    tmp = join(tmpdir(), `voice-${Date.now()}.ogg`);
    writeFileSync(tmp, Buffer.from(dl.data));
    // 3. تفريغ بـ Whisper
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const tr = await client.audio.transcriptions.create({
      file: createReadStream(tmp),
      model: "whisper-1",
      language: "ar"
    });
    const text = String(tr.text || "").trim();
    return text ? { text } : { error: "empty" };
  } catch (e) {
    console.error("voice error:", e.message);
    return { error: "failed" };
  } finally {
    if (tmp) try { unlinkSync(tmp); } catch {}
  }
}
