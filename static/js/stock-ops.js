/* ═══════════════════════════════════════
   📈 주식운영 (stock-ops)
   — 별도 파일로 분리. 주식운영 관련 로직은 여기에 추가.
   — 의존: common 함수 (esc, fmtKRW, fmtRel, authHeaders 등)는 app.js에 정의돼 있음.
   — 로드 순서: app.js → stock-ops.js (index.html에서 script 순서)
═══════════════════════════════════════ */

async function loadStockOps() {
  const ts = document.getElementById('stock-ops-last-update');
  if (ts) ts.textContent = '갱신: ' + new Date().toLocaleTimeString('ko-KR');
  // TODO: 주식운영 데이터 로드 — 엔드포인트 연결 시 여기에 구현
}
window.loadStockOps = loadStockOps;
