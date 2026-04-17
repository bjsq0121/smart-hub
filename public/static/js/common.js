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
      { id: 'config',  label: '🔧 전략 설정', page: 'page-ops', opsPane: 'config' },
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
      { id: 'stock-trade',   label: '💱 매매',    page: 'page-stock-ops', stockOpsPane: 'trade' },
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
  if (opsPane === 'config' && typeof _loadEngineConfig === 'function') _loadEngineConfig();
}

function setStockOpsPane(pane) {
  document.querySelectorAll('#page-stock-ops .stock-ops-pane').forEach(p => {
    p.classList.toggle('active', p.id === 'stock-ops-pane-' + pane);
  });
  if (pane === 'trade' && typeof loadStockTrade === 'function') loadStockTrade();
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
// ── Tailwind 뱃지 (운영 대시보드 리디자인) ──
// 색상 토큰: emerald=ok/win/long, rose=fail/loss/short, amber=partial/active, sky=candidate, violet=ready, slate=excluded/default
function _badge(color, label, size) {
  const sizeCls = size === 'lg'
    ? 'px-3 py-1 text-sm'
    : size === 'sm'
    ? 'px-1.5 py-0.5 text-[10px]'
    : 'px-2 py-0.5 text-xs';
  return `<span class="inline-flex items-center rounded-md font-semibold ${sizeCls} bg-${color}-500/10 text-${color}-400 border border-${color}-500/30">${label}</span>`;
}

function syncBadge(status) {
  const map = { ok:'emerald', partial:'amber', failed:'rose' };
  return _badge(map[status] || 'slate', esc(status || '-'));
}
function itemStatusBadge(status) {
  const map = {
    candidate:['sky','후보'], trade_ready:['violet','매매 후보'], entered:['violet','진입'],
    expired:['slate','만료'], rejected:['rose','거절'], open:['amber','진행 중'], closed:['slate','종료'],
  };
  const [color, label] = map[status] || ['slate', status || '-'];
  return _badge(color, label);
}
function pnlColor(pct) { return pct > 0 ? 'text-emerald-400' : pct < 0 ? 'text-rose-400' : 'text-slate-500'; }
function resultBadge(r) {
  if (r === 'win') return '<span class="inline-flex items-center justify-center w-6 h-6 rounded bg-emerald-500/15 text-emerald-400 font-bold text-xs">W</span>';
  if (r === 'loss') return '<span class="inline-flex items-center justify-center w-6 h-6 rounded bg-rose-500/15 text-rose-400 font-bold text-xs">L</span>';
  return '<span class="text-slate-600">-</span>';
}
function sysStatusBadge(s) {
  const map = { normal:['emerald','정상'], caution:['amber','주의'], pause:['rose','중단'] };
  const [color, label] = map[s] || ['slate', s || '-'];
  return _badge(color, label, 'lg');
}
function directionBadge(dir) {
  if (dir === 'long') return '<span class="inline-flex items-center gap-1 text-emerald-400 font-bold text-sm">▲ Long</span>';
  if (dir === 'short') return '<span class="inline-flex items-center gap-1 text-rose-400 font-bold text-sm">▼ Short</span>';
  if (dir === 'no_trade') return '<span class="text-slate-500 font-semibold text-sm">제외</span>';
  return '<span class="text-slate-600">-</span>';
}
function stageBadge(stage) {
  const map = { candidate:['sky','감시'], trade_ready:['violet','매매 후보'] };
  const [color, label] = map[stage] || ['sky', '감시'];
  return _badge(color, label);
}
function emptyState(type, extra) {
  const msgs = {
    noData:    ['📭', '데이터 없음', extra || 'n8n에서 해당 kind를 보내면 여기에 표시됩니다.'],
    noIndex:   ['🔧', '인덱스 필요', extra || 'Firestore에 복합 인덱스를 생성해야 합니다.'],
    authFail:  ['🔒', '인증 실패', extra || '로그인 세션이 만료되었습니다. 다시 로그인하세요.'],
    apiFail:   ['⚠️', 'API 오류', extra || '서버 응답을 받지 못했습니다.'],
  };
  const [icon, title, desc] = msgs[type] || msgs.noData;
  return `
    <div class="flex flex-col items-center justify-center py-12 px-4 rounded-xl border border-dashed border-slate-700/60 bg-slate-800/20">
      <div class="text-3xl mb-2">${icon}</div>
      <div class="text-slate-300 font-semibold mb-1">${title}</div>
      <div class="text-slate-500 text-sm text-center max-w-md">${desc}</div>
    </div>`;
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
