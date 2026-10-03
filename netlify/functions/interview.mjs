// 면접 준비 노트 - 점검 중 (통합 사이트로 옮기는 동안 모든 요청을 막습니다)
// 저장된 자료는 그대로 있습니다. 내보내기(export.mjs)는 따로 동작합니다.
// 되돌리려면 GitHub의 History에서 이 파일을 이전 내용으로 돌리면 됩니다.
export const config = { path: "/api/interview" };

const MESSAGE = "지금은 사이트 점검 중입니다. 화면을 새로 고침해 주세요.";
export default async () => new Response(JSON.stringify({ ok: false, v: 13, message: MESSAGE }), {
  status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
