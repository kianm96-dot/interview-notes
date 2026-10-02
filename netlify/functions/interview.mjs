// 면접 준비 노트 - 저장 서버 (Netlify Functions + Netlify Blobs)
// 주소: /api/interview   (POST, JSON)
// 환경변수: TEACHER_CODE = 관리자 코드 (관리자 페이지, 학년 전체 보기)
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes } from "node:crypto";

const MAX_ANSWER = 3000;
class Http extends Error { constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.extra = extra; } }

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const hash = (pin, salt) => createHash("sha256").update(salt + ":" + pin).digest("hex");
const newHash = (pin) => { const salt = randomBytes(8).toString("hex"); return { salt, hash: hash(pin, salt) }; };
const validKey = (k) => /^\d{1,2}-\d{1,2}$/.test(k);
const validId = (k) => /^[a-z0-9-]{1,24}$/.test(k);
const adminCode = () => (globalThis.Netlify?.env?.get("TEACHER_CODE")) || process.env.TEACHER_CODE;
// 명단의 생년월일 확인 (예전에 암호화해 저장한 명단도 그대로 통과)
const birthOk = (r, pin) => !!r && (r.birth ? r.birth === pin : !!r.hash && r.hash === hash(pin, r.salt));
const emptyFb = () => ({ items: {}, note: {}, released: {}, extra: {} });

function cleanAnswers(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const [school, qa] of Object.entries(input).slice(0, 30)) {
    if (!qa || typeof qa !== "object") continue;
    out[school] = {};
    for (const [qid, text] of Object.entries(qa).slice(0, 80)) {
      if (typeof text === "string" && text.trim()) out[school][qid] = text.slice(0, MAX_ANSWER);
    }
  }
  return out;
}
const publicStudent = (s) => { const { pinHash, salt, ...rest } = s; return { ...rest, hasPin: !!pinHash }; };

// 학생에게는 공개한 첨삭과, 담임이 따로 낸 추가 질문만 보낸다
function forStudent(fb) {
  const out = emptyFb();
  if (!fb) return out;
  out.extra = fb.extra || {};
  for (const school of Object.keys(fb.released || {})) {
    if (!fb.released[school]) continue;
    out.released[school] = true;
    out.items[school] = (fb.items || {})[school] || {};
    out.note[school] = (fb.note || {})[school] || "";
  }
  return out;
}

async function teacherAuth(store, auth) {
  const admin = adminCode();
  if (!admin) throw new Http("Netlify 환경변수 TEACHER_CODE가 아직 설정되지 않았습니다.", 500);
  if (!auth || typeof auth !== "object") throw new Http("다시 로그인해 주세요.", 401);
  if (auth.cls === "all") {
    if (String(auth.pass || "") !== admin) throw new Http("관리자 코드가 맞지 않습니다.", 401);
    return { scope: "all", label: "관리자" };
  }
  const cls = Number(auth.cls);
  if (!(cls >= 1 && cls <= 20)) throw new Http("반을 확인하세요.");
  const t = await store.get("t/" + cls, { type: "json" });
  if (!t) throw new Http(`${cls}반 담임 비밀번호가 아직 없습니다. 관리자 페이지에서 먼저 만들어 주세요.`, 401);
  if (t.hash !== hash(String(auth.pass || ""), t.salt)) throw new Http("비밀번호가 맞지 않습니다.", 401);
  return { scope: cls, label: `${cls}반 담임` };
}
const inScope = (who, key) => who.scope === "all" || key.startsWith(who.scope + "-");

async function handle(body, store) {
  const { action } = body;

  /* ---------- 누구나: 질문 데이터(담임이 고친 내용) ---------- */
  // 질문 데이터는 두 겹: 학년 공통(관리자가 고침) + 반별(담임이 고침, 그 반 학생에게만 보임)
  if (action === "getData") {
    const want = body.cls === "all" ? "all" : Number(body.cls) || 0;
    const { blobs } = await store.list({ prefix: "cfg/" });
    const out = { schools: {}, common: null }, classes = {};
    const layer = (c) => (classes[c] = classes[c] || { schools: {}, common: null });
    await Promise.all(blobs.map(async (b) => {
      const m = b.key.match(/^cfg\/c\/(\d+)\/(common|s\/(.+))$/);
      if (m && want !== "all" && Number(m[1]) !== want) return;
      const v = await store.get(b.key, { type: "json" });
      if (!v) return;
      if (m) { if (m[2] === "common") layer(m[1]).common = v; else layer(m[1]).schools[m[3]] = v; }
      else if (b.key === "cfg/common") out.common = v;
      else if (b.key.startsWith("cfg/s/")) out.schools[b.key.slice(6)] = v;
    }));
    if (want === "all") out.classes = classes; else if (want) out.cls = classes[want] || { schools: {}, common: null };
    return { cfg: out };
  }

  if (action === "rosterNames") {
    const cls = Number(body.cls);
    const roster = (await store.get("roster", { type: "json" })) || {};
    const names = {};
    for (const [key, r] of Object.entries(roster)) { const [c, n] = key.split("-").map(Number); if (c === cls) names[n] = r.name; }
    return { names };
  }

  /* ---------- 학생 ---------- */
  // 처음에는 명단에 등록된 생년월일 6자리로 들어오고, 바로 새 비밀번호를 만든다.
  if (action === "studentLogin" || action === "studentSave" || action === "studentSetPin") {
    const cls = Number(body.cls), num = Number(body.num), pin = String(body.pin || "");
    if (!(cls >= 1 && cls <= 20) || !(num >= 1 && num <= 50)) throw new Http("반과 번호를 확인하세요.");
    const key = `${cls}-${num}`;
    const roster = (await store.get("roster", { type: "json" })) || {};
    const r = roster[key];
    let s = await store.get("s/" + key, { type: "json" });
    if (!r && !s) throw new Http("명단에 없는 학생입니다. 반과 번호를 확인하거나 담임 선생님께 알려 주세요.", 404);
    const byPin = !!(s && s.pinHash && s.pinHash === hash(pin, s.salt));
    const byBirth = !(s && s.pinHash) && birthOk(r, pin);
    if (!byPin && !byBirth) throw new Http(s && s.pinHash ? "비밀번호가 맞지 않습니다. 잊었다면 담임 선생님께 초기화를 부탁하세요." : "처음에는 생년월일 6자리(예: 110305)를 넣으세요.", 401);

    if (action === "studentLogin") {
      if (byBirth) return { mustChange: true, name: r.name };
      if (r && r.name && s.name !== r.name) { s.name = r.name; await store.setJSON("s/" + key, s); }
      const [fb, gpa] = await Promise.all([store.get("f/" + key, { type: "json" }), store.get("gpa", { type: "json" })]);
      return { me: publicStudent(s), feedback: forStudent(fb), gpa: (gpa || {})[key] || null };
    }
    if (action === "studentSetPin") {
      const np = String(body.newPin || "");
      if (np.length < 4 || np.length > 20) throw new Http("새 비밀번호는 4자 이상이어야 합니다.");
      if (birthOk(r, np)) throw new Http("생년월일과 다른 비밀번호를 만들어 주세요.");
      if (!s) s = { cls, num, name: r.name, answers: {}, submitted: {}, createdAt: new Date().toISOString() };
      const h = newHash(np); s.salt = h.salt; s.pinHash = h.hash;
      await store.setJSON("s/" + key, s);
      return {};
    }
    if (!byPin) throw new Http("먼저 새 비밀번호를 만들어 주세요.", 401);
    s.school = String(body.school || "").slice(0, 30);
    s.dept = String(body.dept || "").slice(0, 30);
    s.customSchool = String(body.customSchool || "").slice(0, 40);
    s.answers = cleanAnswers(body.answers);
    s.submitted = s.submitted || {};
    if (body.submitSchool) s.submitted[String(body.submitSchool).slice(0, 30)] = new Date().toISOString();
    s.updatedAt = new Date().toISOString();
    await store.setJSON("s/" + key, s);
    return { me: publicStudent(s) };
  }

  /* ---------- 관리자 ---------- */
  if (action && action.startsWith("admin")) {
    const admin = adminCode();
    if (!admin) throw new Http("Netlify 환경변수 TEACHER_CODE가 아직 설정되지 않았습니다.", 500);
    if (String(body.code || "") !== admin) throw new Http("관리자 코드가 맞지 않습니다.", 401);
    const roster = (await store.get("roster", { type: "json" })) || {};
    const gpa = (await store.get("gpa", { type: "json" })) || {};
    const putGpa = (key, score, note) => {
      score = String(score ?? "").trim().slice(0, 20); note = String(note ?? "").trim().slice(0, 60);
      if (score || note) gpa[key] = { score, note }; else delete gpa[key];
    };

    if (action === "adminSaveGpa") {
      for (const row of (Array.isArray(body.rows) ? body.rows.slice(0, 600) : [])) { if (validKey(String(row.key))) putGpa(row.key, row.score, row.note); }
      await store.setJSON("gpa", gpa);
      return { count: Object.keys(gpa).length };
    }
    if (action === "adminGet") {
      const [sl, tl] = await Promise.all([store.list({ prefix: "s/" }), store.list({ prefix: "t/" })]);
      const map = {};
      await Promise.all(sl.blobs.map(async (b) => {
        const key = b.key.slice(2);
        const [s, fb] = await Promise.all([store.get(b.key, { type: "json" }), store.get("f/" + key, { type: "json" })]);
        if (s) map[key] = { s, fb };
      }));
      const keys = [...new Set([...Object.keys(roster), ...Object.keys(map)])];
      const students = keys.map((key) => {
        const [cls, num] = key.split("-").map(Number); const m = map[key];
        return { key, cls, num, name: roster[key]?.name || m?.s.name || "", inRoster: !!roster[key], birth: roster[key]?.birth || "", changed: !!m?.s.pinHash, gpa: gpa[key] || null,
          answered: m ? Object.values(m.s.answers || {}).reduce((n, a) => n + Object.keys(a).length, 0) : 0,
          submitted: m ? Object.keys(m.s.submitted || {}).length > 0 : false,
          released: m?.fb ? Object.values(m.fb.released || {}).some(Boolean) : false };
      });
      const teachers = {}; tl.blobs.forEach((b) => (teachers[b.key.slice(2)] = true));
      return { students, teachers };
    }
    // 명단 올리기·고치기: 있는 학생은 준 칸만 고치고, 없는 학생은 새로 넣는다.
    // 이름 없이 반·번호·가내신만 오면 가내신만 바꾼다. gpa가 ""이면 가내신을 지운다.
    if (action === "adminSaveRoster") {
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 800) : [];
      let added = 0, updated = 0, skipped = 0;
      for (const row of rows) {
        const cls = Number(row.cls), num = Number(row.num);
        if (!(cls >= 1 && cls <= 20) || !(num >= 1 && num <= 50)) { skipped++; continue; }
        const key = `${cls}-${num}`, name = String(row.name ?? "").trim().slice(0, 20), birth = String(row.birth ?? "").trim();
        const cur = roster[key];
        if (!cur && !name) { skipped++; continue; }
        const next = cur ? { name: cur.name, birth: cur.birth || "", ...(cur.hash && !cur.birth ? { hash: cur.hash, salt: cur.salt } : {}) } : { name, birth: "" };
        if (name) next.name = name;
        if (/^\d{6}$/.test(birth)) { next.birth = birth; delete next.hash; delete next.salt; }
        roster[key] = next; cur ? updated++ : added++;
        if (row.gpa !== undefined && row.gpa !== null) putGpa(key, row.gpa, "");
      }
      await store.setJSON("roster", roster);
      await store.setJSON("gpa", gpa);
      return { count: Object.keys(roster).length, added, updated, skipped };
    }
    if (action === "adminSetTeacher") {
      const cls = Number(body.cls), pass = String(body.pass || "");
      if (!(cls >= 1 && cls <= 20)) throw new Http("반을 확인하세요.");
      if (!pass) { await store.delete("t/" + cls); return {}; }
      if (pass.length < 4) throw new Http("비밀번호는 4자 이상이어야 합니다.");
      await store.setJSON("t/" + cls, { ...newHash(pass), setAt: new Date().toISOString() });
      return {};
    }
    const key = String(body.key || "");
    if (!validKey(key)) throw new Http("학생을 찾을 수 없습니다.");
    if (action === "adminResetStudent") {
      const s = await store.get("s/" + key, { type: "json" });
      if (s) { delete s.pinHash; delete s.salt; await store.setJSON("s/" + key, s); }
      return {};
    }
    if (action === "adminRemoveStudent") {
      delete roster[key]; await store.setJSON("roster", roster);
      if (body.withData) { await store.delete("s/" + key); await store.delete("f/" + key); delete gpa[key]; await store.setJSON("gpa", gpa); }
      return {};
    }
    throw new Http("알 수 없는 요청입니다.");
  }

  /* ---------- 담임 로그인 (반마다 따로) ---------- */
  if (action === "teacherLogin") {
    return { who: await teacherAuth(store, body.auth) };
  }

  if (action && action.startsWith("teacher")) {
    const who = await teacherAuth(store, body.auth);

    if (action === "teacherChangePass") {
      if (who.scope === "all") throw new Http("관리자 코드는 Netlify 환경변수에서 바꿉니다.");
      const np = String(body.newPass || "");
      if (np.length < 4) throw new Http("비밀번호는 4자 이상이어야 합니다.");
      await store.setJSON("t/" + who.scope, { ...newHash(np), setAt: new Date().toISOString() });
      return {};
    }

    if (action === "teacherList") {
      const prefix = who.scope === "all" ? "s/" : `s/${who.scope}-`;
      const [{ blobs }, roster, gpa] = await Promise.all([store.list({ prefix }), store.get("roster", { type: "json" }), store.get("gpa", { type: "json" })]);
      const map = {};
      await Promise.all(blobs.map(async (b) => {
        const key = b.key.slice(2);
        const [st, fb] = await Promise.all([store.get(b.key, { type: "json" }), store.get("f/" + key, { type: "json" })]);
        if (st) map[key] = { key, name: st.name, student: publicStudent(st), feedback: { ...emptyFb(), ...(fb || {}) } };
      }));
      for (const [key, r] of Object.entries(roster || {})) {
        if (!inScope(who, key)) continue;
        if (map[key]) map[key].name = r.name; else map[key] = { key, name: r.name, student: null, feedback: emptyFb() };
      }
      for (const row of Object.values(map)) row.gpa = (gpa || {})[row.key] || null;
      return { rows: Object.values(map) };
    }

    if (action === "teacherSaveFeedback" || action === "teacherResetPin") {
      const key = String(body.key || "");
      if (!validKey(key) || !inScope(who, key)) throw new Http("우리 반 학생이 아닙니다.", 403);
      if (action === "teacherSaveFeedback") {
        const fb = body.feedback || {};
        const clean = { items: fb.items || {}, note: fb.note || {}, released: fb.released || {}, extra: fb.extra || {}, updatedAt: new Date().toISOString() };
        if (JSON.stringify(clean).length > 300000) throw new Http("첨삭 내용이 너무 깁니다.", 413);
        await store.setJSON("f/" + key, clean);
        return {};
      }
      const s = await store.get("s/" + key, { type: "json" });
      if (!s) throw new Http("학생을 찾을 수 없습니다.");
      delete s.pinHash; delete s.salt;
      await store.setJSON("s/" + key, s);
      return {};
    }

    /* 질문 관리: 학교 한 곳 또는 공통 질문을 통째로 저장 */
    if (action === "teacherSaveSchool" || action === "teacherSaveCommon") {
      const isCommon = action === "teacherSaveCommon";
      const id = isCommon ? "" : String(body.id || "");
      if (!isCommon && !validId(id)) throw new Http("학교 id가 올바르지 않습니다.");
      const root = who.scope === "all" ? "cfg/" : `cfg/c/${who.scope}/`; // 담임이 고치면 자기 반 몫으로만 저장
      const path = root + (isCommon ? "common" : "s/" + id);
      const data = body.data;
      if (!data || typeof data !== "object") throw new Http("저장할 내용이 없습니다.");
      if (JSON.stringify(data).length > 80000) throw new Http("내용이 너무 깁니다.", 413);
      const cur = await store.get(path, { type: "json" });
      if ((cur?.rev || 0) !== (Number(body.rev) || 0)) throw new Http("다른 선생님이 방금 이 내용을 고쳤습니다. '새로 고침'을 누른 뒤 다시 고쳐 주세요.", 409);
      const saved = { ...data, ...(isCommon ? {} : { id }), rev: (cur?.rev || 0) + 1, updatedBy: who.label, updatedAt: new Date().toISOString() };
      await store.setJSON(path, saved);
      return { saved };
    }
    if (action === "teacherResetSchool") {
      const id = String(body.id || "");
      if (id !== "common" && !validId(id)) throw new Http("학교 id가 올바르지 않습니다.");
      const root = who.scope === "all" ? "cfg/" : `cfg/c/${who.scope}/`;
      await store.delete(root + (id === "common" ? "common" : "s/" + id));
      return {};
    }
  }
  throw new Http("알 수 없는 요청입니다.");
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, message: "POST 요청만 받습니다." }, 405);
  let body;
  try {
    const raw = await req.text();
    if (raw.length > 400000) return json({ ok: false, message: "내용이 너무 깁니다." }, 413);
    body = JSON.parse(raw);
  } catch { return json({ ok: false, message: "요청 형식이 올바르지 않습니다." }, 400); }
  try {
    return json({ ok: true, ...(await handle(body, getStore("interview"))) });
  } catch (e) {
    if (e instanceof Http) return json({ ok: false, message: e.message, ...e.extra }, e.status);
    console.error(e);
    return json({ ok: false, message: "서버에서 문제가 생겼습니다. 잠시 뒤 다시 시도하세요." }, 500);
  }
};

export const config = { path: "/api/interview" };
