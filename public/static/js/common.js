/* ═══════════════════════════════════════════════════════════════
   common.js — 공용 공유 모듈
   smart-hub 전체에서 사용되는 공통 함수 모음:
   - 커스텀 모달 (showModal)
   - XSS 방지 (esc)
   - 인증 헤더 헬퍼 (authHeaders)
   - 네비게이션 (NAV_GROUPS, navGoto, renderSubNav, 등)
   - 포맷/뱃지 유틸 (fmtKRW, fmtPct, fmtRel, fmtHold, syncBadge, pnlColor, 등)
   모든 함수는 최상위(top-level)로 선언되어 전역으로 사용 가능합니다.
═══════════════════════════════════════════════════════════════ */

/* ───────── 커스텀 모달 (confirm/alert 대체) ───────── */
function showModal(msg, isConfirm = false) {
  return new Promise(resolve => {
    const overlay = document.getElementById('customModal');
    const msgEl = document.getElementById('customModalMsg');
    const okBtn = document.getElementById('customModalOk');
    const cancelBtn = document.getElementById('customModalCancel');
    msgEl.textContent = msg;
    cancelBtn.style.display = isConfirm ? 'inline-block' : 'none';
    okBtn.textContent = isConfirm ? '확인' : '확인';
    overlay.classList.add('active');

    const cleanup = () => {
      overlay.classList.remove('active');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
    };
    okBtn.onclick = () => { cleanup(); resolve(true); };
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
    overlay.onclick = e => { if (e.target === overlay) { cleanup(); resolve(false); } };
  });
}

/* ───────── XSS 방지 ───────── */
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/* ───────── 인증 헤더 헬퍼 ───────── */
async function authHeaders() {
  if (typeof auth !== 'undefined' && auth.currentUser) {
    const token = await auth.currentUser.getIdToken();
    return { 'Authorization': 'Bearer ' + token };
  }
  return {};
}

/* ═══════════════════════════════════════
   네비게이션: 4그룹 + 그룹별 서브탭 (1차)
   - home / ops / research / tools / admin
   - 각 그룹 내부 서브탭이 sub-nav 바에 동적으로 그려짐
   - 서브탭 클릭 = .page 활성화. ops 그룹은 page-ops 내부 ops-pane 도 같이 활성화
═══════════════════════════════════════ */
const NAV_GROUPS = {
  home: {
    label: '🏠 홈',
    auth: false,
    subs: [], // 단일 페이지 — 서브탭 없음
    defaultPage: 'page-home',
  },
  ops: {
    label: '🪙 코인운영',
    auth: true,
    subs: [
      { id: 'signals', label: '🎯 신호',    page: 'page-ops', opsPane: 'signals' },
      { id: 'trades',  label: '📊 검증 중', page: 'page-ops', opsPane: 'trades' },
      { id: 'results', label: '📋 결과',    page: 'page-ops', opsPane: 'results' },
      { id: 'perf',    label: '📈 성과',    page: 'page-ops', opsPane: 'perf' },
      { id: 'system',  label: '⚙️ 시스템', page: 'page-ops', opsPane: 'system' },
    ],
    onEnter: () => { if (typeof loadOps === 'function') loadOps(); },
  },
  stockOps: {
    label: '📈 주식운영',
    auth: true,
    subs: [
      { id: 'stock-signals', label: '🎯 시그널',  page: 'page-stock-ops', stockOpsPane: 'signals' },
      { id: 'stock-alerts',  label: '🔔 알림',    page: 'page-stock-ops', stockOpsPane: 'alerts' },
      { id: 'stock-perf',    label: '📈 성과',    page: 'page-stock-ops', stockOpsPane: 'perf' },
    ],
    onEnter: () => { if (typeof loadStockOps === 'function') loadStockOps(); },
  },
  research: {
    label: '🔬 리서치',
    auth: true,
    subs: [
      { id: 'ainews',     label: '🤖 AI 뉴스 요약', page: 'page-ainews' },
      { id: 'stock',      label: '📈 주식 추천',    page: 'page-stock' },
      { id: 'coin-perf',  label: '코인 성과분석',   page: 'page-soon', soon: true,
        soonTitle: '코인 성과분석', soonDesc: '거래 이력 + 평균 단가 기반 누적 손익 분석. 2차 슬라이스에서 추가됩니다.' },
      { id: 'coin-replay',label: '코인 리플레이',   page: 'page-soon', soon: true,
        soonTitle: '코인 리플레이', soonDesc: '신호 발생 시점부터 후속 잔고 변화를 시간순 재생. 2차 슬라이스에서 추가됩니다.' },
    ],
  },
  tools: {
    label: '🧰 도구',
    auth: false,
    subs: [
      { id: 'price',      label: '🔍 최저가 비교',    page: 'page-price' },
      { id: 'realestate', label: '🏠 아파트 실거래가', page: 'page-realestate' },
      { id: 'unit',       label: '📐 단위 변환기',    page: 'page-unit' },
    ],
  },
  admin: {
    label: '⚙️ 관리',
    auth: true,
    subs: [
      { id: 'users',    label: '👥 사용자',    page: 'page-admin', adminPane: 'users',
        onActivate: () => { if (typeof loadAdminUsers === 'function') loadAdminUsers(); } },
      { id: 'password', label: '🔑 비밀번호', page: 'page-admin', adminPane: 'password',
        onActivate: () => { if (typeof initPasswordPane === 'function') initPasswordPane(); } },
    ],
  },
};

let currentGroup = 'home';
let currentSubByGroup = {};  // group → 마지막 서브탭 id 기억

function setOpsPane(opsPane) {
  document.querySelectorAll('#page-ops .ops-pane').forEach(p => {
    p.classList.toggle('active', p.id === 'ops-pane-' + opsPane);
  });
}

function setStockOpsPane(pane) {
  document.querySelectorAll('#page-stock-ops .stock-ops-pane').forEach(p => {
    p.classList.toggle('active', p.id === 'stock-ops-pane-' + pane);
  });
}

function renderSubNav(groupId) {
  const bar = document.getElementById('sub-nav');
  if (!bar) return;
  const g = NAV_GROUPS[groupId];
  if (!g || !g.subs.length) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = g.subs.map(s => `
    <button class="sub-tab${s.soon ? ' soon' : ''}" data-sub="${s.id}">
      ${s.label}${s.soon ? ' <span class="soon-tag">나중에</span>' : ''}
    </button>
  `).join('');
  // 활성 서브탭 표시
  const activeSub = currentSubByGroup[groupId] || g.subs[0].id;
  bar.querySelectorAll('.sub-tab').forEach(b => {
    if (b.dataset.sub === activeSub) b.classList.add('active');
  });
}

function navGoto(groupId, subId) {
  const g = NAV_GROUPS[groupId];
  if (!g) return;
  // 인증 필요 그룹인데 미로그인 → 로그인 모달
  if (g.auth && typeof auth !== 'undefined' && !auth.currentUser) {
    document.getElementById('login-screen').style.display = 'flex';
    return;
  }
  currentGroup = groupId;

  // 1) 상단 그룹 버튼 활성화
  document.querySelectorAll('.nav-group').forEach(b => {
    b.classList.toggle('active', b.dataset.group === groupId);
  });

  // 2) 서브탭 결정
  let sub = null;
  if (g.subs.length) {
    sub = g.subs.find(s => s.id === subId)
       || g.subs.find(s => s.id === currentSubByGroup[groupId])
       || g.subs[0];
    currentSubByGroup[groupId] = sub.id;
  }

  // 3) 서브 nav 그리기
  renderSubNav(groupId);

  // 4) 활성 .page 결정
  const targetPageId = sub ? sub.page : g.defaultPage;
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === targetPageId));

  // 5) 내부 pane (ops / admin)
  if (sub && sub.opsPane) setOpsPane(sub.opsPane);
  if (sub && sub.stockOpsPane) setStockOpsPane(sub.stockOpsPane);
  if (sub && sub.adminPane) {
    document.querySelectorAll('#page-admin .admin-pane').forEach(p => {
      p.classList.toggle('active', p.id === 'admin-pane-' + sub.adminPane);
    });
  }

  // 6) page-soon 메시지 커스터마이즈
  if (targetPageId === 'page-soon') {
    const t = document.getElementById('soon-title');
    const d = document.getElementById('soon-desc');
    if (t) t.textContent = (sub && sub.soonTitle) || '준비 중';
    if (d) d.textContent = (sub && sub.soonDesc) || '이 기능은 다음 슬라이스에서 추가됩니다.';
  }

  // 7) 그룹 진입 훅 + 서브탭 활성화 훅
  if (g.onEnter) g.onEnter();
  if (sub && sub.onActivate) sub.onActivate();
}
// 다른 모듈에서 호출할 수 있게 전역 노출
window.navGoto = navGoto;

// 상단 그룹 버튼 클릭
document.getElementById('nav-groups')?.addEventListener('click', e => {
  const btn = e.target.closest('.nav-group');
  if (!btn) return;
  navGoto(btn.dataset.group);
});
// 서브탭 클릭 (이벤트 위임)
document.getElementById('sub-nav')?.addEventListener('click', e => {
  const btn = e.target.closest('.sub-tab');
  if (!btn) return;
  navGoto(currentGroup, btn.dataset.sub);
});
// 초기 진입 — 홈
navGoto('home');

/* ═══════════════════════════════════════
   공용 포맷 / 뱃지 유틸
═══════════════════════════════════════ */

function fmtKRW(n) {
  if (n == null || isNaN(n)) return '-';
  return Number(n).toLocaleString('ko-KR') + '원';
}
function fmtPct(n) { return n == null || isNaN(n) ? '-' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function fmtRel(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60000) return '방금';
  if (diff < 3600000) return Math.floor(diff/60000) + '분 전';
  if (diff < 86400000) return Math.floor(diff/3600000) + '시간 전';
  return new Date(iso).toLocaleString('ko-KR');
}
function fmtHold(min) {
  if (!min || min < 1) return '-';
  if (min < 60) return min + '분';
  if (min < 1440) return Math.floor(min/60) + '시간 ' + (min%60) + '분';
  return Math.floor(min/1440) + '일 ' + Math.floor((min%1440)/60) + '시간';
}
// syncStatus 전용 뱃지 (ok/partial/failed — 동기화 상태)
function syncBadge(status) {
  const map = { ok:'#34d399', partial:'#fbbf24', failed:'#f87171' };
  const c = map[status] || '#64748b';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:700;background:${c}22;color:${c};border:1px solid ${c}55;">${esc(status||'-')}</span>`;
}
// signal/paper_trade 상태 전용 뱃지 (candidate/entered/expired/open/closed 등)
function itemStatusBadge(status) {
  const map = {
    candidate:['#60a5fa','후보'], trade_ready:['#a78bfa','매매 후보'], entered:['#a78bfa','진입'], expired:['#64748b','만료'],
    rejected:['#f87171','거절'], open:['#fbbf24','진행 중'], closed:['#94a3b8','종료'],
  };
  const [c, label] = map[status] || ['#64748b', status || '-'];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:700;background:${c}22;color:${c};border:1px solid ${c}55;">${label}</span>`;
}
function pnlColor(pct) { return pct > 0 ? '#34d399' : pct < 0 ? '#f87171' : '#64748b'; }
function resultBadge(r) {
  if (r === 'win') return '<span style="color:#34d399;font-weight:700;">W</span>';
  if (r === 'loss') return '<span style="color:#f87171;font-weight:700;">L</span>';
  return '<span style="color:#64748b;">-</span>';
}
function sysStatusBadge(s) {
  const map = { normal:['#34d399','정상'], caution:['#fbbf24','주의'], pause:['#f87171','중단'] };
  const [c, label] = map[s] || ['#64748b', s || '-'];
  return `<span style="display:inline-block;padding:4px 14px;border-radius:12px;font-size:0.85rem;font-weight:700;background:${c}22;color:${c};border:1px solid ${c}55;">${label}</span>`;
}
// 방향 뱃지 (long / short / no_trade)
function directionBadge(dir) {
  if (dir === 'long') return '<span style="color:#34d399;font-weight:700;">Long</span>';
  if (dir === 'short') return '<span style="color:#f87171;font-weight:700;">Short</span>';
  if (dir === 'no_trade') return '<span style="color:#64748b;font-weight:700;">제외</span>';
  return '<span style="color:#64748b;">-</span>';
}
// 단계 뱃지 (candidate / trade_ready)
function stageBadge(stage) {
  const map = { candidate:['#60a5fa','감시'], trade_ready:['#a78bfa','매매 후보'] };
  const [c, label] = map[stage] || ['#60a5fa', '감시'];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:700;background:${c}22;color:${c};border:1px solid ${c}55;">${label}</span>`;
}
// 빈 화면 구분 메시지
function emptyState(type, extra) {
  const msgs = {
    noData:    ['📭', '데이터 없음', extra || 'n8n에서 해당 kind를 보내면 여기에 표시됩니다.'],
    noIndex:   ['🔧', '인덱스 필요', extra || 'Firestore에 복합 인덱스를 생성해야 합니다. 콘솔 에러를 확인하세요.'],
    authFail:  ['🔒', '인증 실패', extra || '로그인 세션이 만료되었거나 권한이 없습니다. 다시 로그인하세요.'],
    apiFail:   ['⚠️', 'API 오류', extra || '서버 응답을 받지 못했습니다. 잠시 후 새로고침하세요.'],
  };
  const [icon, title, desc] = msgs[type] || msgs.noData;
  return `<div class="ops-empty"><div style="font-size:1.6rem;margin-bottom:6px;">${icon}</div><div style="color:#e2e8f0;font-weight:600;margin-bottom:4px;">${title}</div><div>${desc}</div></div>`;
}
// API 응답 상태 분석 — 빈 화면 구분용
function diagnose(data) {
  if (!data) return 'apiFail';
  if (data.error) {
    if (/인증|토큰|401/i.test(data.error)) return 'authFail';
    if (/인덱스|index/i.test(data.error)) return 'noIndex';
    return 'apiFail';
  }
  return null; // 정상
}

// ── 공용 함수 전역 노출 (stock-ops.js 등 외부 모듈에서 사용) ──
window.esc = esc;
window.fmtKRW = fmtKRW;
window.fmtRel = fmtRel;
window.fmtPct = fmtPct;
window.emptyState = emptyState;
window.diagnose = diagnose;
window.stageBadge = stageBadge;
window.directionBadge = directionBadge;
window.itemStatusBadge = itemStatusBadge;
