// 면접 준비 노트: 통합 사이트로 옮기기 위한 '내보내기' (읽기만 함, 기존 자료는 바꾸지 않음)
// 주소: /api/interview-export  (POST, JSON)  { pw: 관리자 코드(TEACHER_CODE), op: 'keys' | 'get', keys: [...] }
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/interview-export" };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS } });
const adminCode = () => (globalThis.Netlify?.env?.get("TEACHER_CODE")) || process.env.TEACHER_CODE;

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: true, message: "내보내기 준비됨" });
  try {
    const body = await req.json(), code = adminCode();
    if (!code || String(body.pw || "") !== code) return json({ ok: false, message: "면접 준비 노트의 관리자 코드가 맞지 않습니다." }, 401);
    let db; try { db = getStore({ name: "interview", consistency: "strong" }); await db.get("roster"); } catch { db = getStore("interview"); }
    if (body.op === "keys") return json({ ok: true, site: "interview", keys: (await db.list()).blobs.map((b) => b.key) });
    const keys = (Array.isArray(body.keys) ? body.keys : []).slice(0, 200).map(String), items = {};
    await Promise.all(keys.map(async (k) => { const v = await db.get(k); if (v != null) items[k] = v; }));
    return json({ ok: true, items });
  } catch (e) { console.error(e); return json({ ok: false, message: "내보내는 중 문제가 생겼습니다. 잠시 뒤 다시 시도하세요." }, 500); }
};
