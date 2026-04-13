// 코인운영 5판 — 의존: common.js (먼저 로드 필요)

/* ── 필터/토글 글로벌 노출 ── */
window.setSignalFilter = (v) => { opsSignalFilter = v; renderSignals(); };
window.setResultFilter = (v) => { opsResultFilter = v; renderResults(); };
window.setPerfCount = (v) => { opsPerfCount = v; loadOps(); };
window.setStageFilter = (v) => { opsStageFilter = v; renderSignals(); };
window.setResultDirFilter = (v) => { opsResultDirFilter = v; renderResults(); };
window.setResultSource = (v) => { opsResultSource = v; renderResults(); };
window.setStrategy = (v) => { opsStrategy = v; renderSignals(); renderTrades(); renderResults(); renderPerf(); };
window.setPerfSource = (v) => { opsPerfSource = v; loadOps(); };
window.setBtPeriod = (v) => { opsBtPeriod = v; loadOps(); };
window.runBacktest = async () => {
  const btn = document.getElementById('bt-run-btn');
  const msg = document.getElementById('bt-run-msg');
  if (!btn || btn.disabled) return;
  const market = document.getElementById('bt-market')?.value || 'KRW-BTC';
  const startDate = document.getElementById('bt-start')?.value || '';
  const endDate = document.getElementById('bt-end')?.value || '';
  const scoreCutoff = parseInt(document.getElementById('bt-cutoff')?.value || '60');
  if (!startDate || !endDate) { if (msg) { msg.style.color = '#f87171'; msg.textContent = '시작일/종료일을 선택하세요'; } return; }
  btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '실행 중...';
  if (msg) { msg.style.color = '#94a3b8'; msg.textContent = ''; }
  try {
    const hdrs = await authHeaders();
    hdrs['Content-Type'] = 'application/json';
    const r = await fetch('/api/backtest/run', { method: 'POST', headers: hdrs, body: JSON.stringify({ market, startDate, endDate, scoreCutoff }) });
    const d = await r.json();
    if (d.ok) {
      if (msg) { msg.style.color = '#34d399'; msg.textContent = '완료 — 결과 로딩 중...'; }
      setTimeout(() => { loadOps(); }, 3000);
    } else {
      if (msg) { msg.style.color = '#f87171'; msg.textContent = d.error || '실패'; }
    }
  } catch (e) {
    if (msg) { msg.style.color = '#f87171'; msg.textContent = '네트워크 오류'; }
  }
  setTimeout(() => { if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '실행'; } }, 10000);
};
window.toggleFactors = (id) => {
  const r = document.getElementById('factors-' + id);
  if (r) r.style.display = r.style.display === 'none' ? 'table-row' : 'none';
};

// 잔고 새로고침 (n8n 트리거 → 재조회, 60초 쿨다운)
let _balRefreshCooldown = false;
window.refreshBalance = async () => {
  const btn = document.getElementById('bal-refresh-btn');
  const msg = document.getElementById('bal-refresh-msg');
  if (_balRefreshCooldown || !btn) return;
  _balRefreshCooldown = true;
  btn.disabled = true;
  btn.style.opacity = '0.5';
  btn.textContent = '요청 중...';
  if (msg) { msg.style.color = '#94a3b8'; msg.textContent = ''; }
  try {
    const hdrs = await authHeaders();
    const r = await fetch('/api/balances/refresh', { method: 'POST', headers: hdrs });
    const d = await r.json();
    if (d.ok) {
      if (msg) { msg.style.color = '#34d399'; msg.textContent = '요청 완료 — 수초 후 반영'; }
      setTimeout(() => { loadOps(); }, 5000);
    } else if (d.cooldown) {
      if (msg) { msg.style.color = '#fbbf24'; msg.textContent = d.error || '잠시 후 재시도'; }
    } else {
      if (msg) { msg.style.color = '#f87171'; msg.textContent = d.error || '실패'; }
    }
  } catch (e) {
    if (msg) { msg.style.color = '#f87171'; msg.textContent = '네트워크 오류'; }
  }
  // 60초 쿨다운 (n8n 쿨다운과 동기화)
  let remaining = 60;
  btn.textContent = `${remaining}초`;
  const timer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(timer);
      _balRefreshCooldown = false;
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.textContent = '잔고 새로고침';
      if (msg) msg.textContent = '';
    } else {
      btn.textContent = `${remaining}초`;
    }
  }, 1000);
};

/* ═══════════════════════════════════════
   📊 Crypto 검증 허브 (5판)
   신호 / 검증 중 / 결과 / 성과 / 시스템
═══════════════════════════════════════ */
let opsData = {};
let opsLastLoadTime = null;
let opsAutoRefreshTimer = null;
let opsPerfCount = 50;          // 성과 20/50 토글
let opsSignalFilter = '';       // 신호 종목 필터
let opsResultFilter = '';       // 결과 W/L 필터
let opsStageFilter = '';        // 신호 stage 필터: '' | 'candidate' | 'trade_ready' | 'no_trade'
let opsResultDirFilter = '';    // 결과 방향 필터: '' | 'long' | 'short'
let opsPerfSource = '';         // 성과 source 필터: '' | 'n8n' | 'backtest'
let opsResultSource = '';       // 결과 source 필터: '' | 'n8n' | 'backtest'
let opsBtPeriod = '';           // 백테스트 기간: '' | '1m' | '3m' | '6m'
let opsStrategy = '';           // 전략 필터 (코인+방향): '' | 'XRP_SHORT' | 'BTC_LONG' 등

// ── 전략 분류 (코인+방향 → 상태) ──
const STRATEGY_STATUS = {
  'XRP_SHORT':  'live',      // 실전 후보
  'BTC_LONG':   'research',  // 연구용
  'ETH_LONG':   'research',  // 연구용
  'SOL_LONG':   'excluded',  // 제외
  'SOL_SHORT':  'excluded',
  'DOGE_LONG':  'excluded',
  'DOGE_SHORT': 'excluded',
};
function getStrategyKey(symbol, direction) {
  const sym = (symbol || '').replace(/\/KRW|KRW-/gi, '').toUpperCase();
  const dir = (direction || 'long').toUpperCase();
  return sym + '_' + dir;
}
function getStrategyStatus(symbol, direction, item) {
  // n8n이 보내는 strategyStatus 우선, 없으면 로컬 맵 참조
  if (item && item.strategyStatus) return item.strategyStatus;
  return STRATEGY_STATUS[getStrategyKey(symbol, direction)] || 'research';
}
function strategyBadge(status) {
  const map = {
    live:     ['#34d399', '실전 후보', '⚡'],
    research: ['#60a5fa', '연구', '🔬'],
    excluded: ['#64748b', '제외', '⏸'],
  };
  const [c, label, icon] = map[status] || map.research;
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.65rem;font-weight:700;background:${c}18;color:${c};border:1px solid ${c}44;">${icon} ${label}</span>`;
}
function actionBadge(status) {
  const map = {
    live:     ['#34d399', '진입 후보'],
    research: ['#fbbf24', '관찰'],
    excluded: ['#64748b', '무시'],
  };
  const [c, label] = map[status] || map.research;
  return `<span style="font-size:0.68rem;color:${c};font-weight:600;">${label}</span>`;
}
const OPS_STALE_MS = 5 * 60 * 1000; // 5분
const OPS_REFRESH_MS = 30 * 1000;   // 30초

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

// ── ── loadOps: 5개 API 병렬 호출 + 갱신 시각 + stale 경고 + 자동 새로고침 ──
async function loadOps() {
  const hdrs = await authHeaders();
  async function safe(p) {
    try {
      const r = await p;
      const body = await r.json().catch(() => ({}));
      if (r.status === 401) return { error: '인증 실패 (401)' };
      if (!r.ok) return { error: body.detail || body.error || `HTTP ${r.status}` };
      return body;
    } catch (e) { return { error: '네트워크 오류' }; }
  }
  try {
    // 성과/결과 source + 전략 + 기간 파라미터
    let perfQ = '/api/performance?count=' + opsPerfCount;
    let resQ = '/api/trade-results?limit=100';
    if (opsPerfSource) { perfQ += '&source=' + opsPerfSource; resQ += '&source=' + opsPerfSource; }
    if (opsStrategy) {
      const [sym, dir] = opsStrategy.split('_');
      if (sym) perfQ += '&symbol=' + sym;
      if (dir) perfQ += '&direction=' + dir;
    } else {
      // "전체" 모드: 제외 전략 자동 제외
      const excludedSyms = [...new Set(Object.entries(STRATEGY_STATUS)
        .filter(([,v]) => v === 'excluded')
        .map(([k]) => k.split('_')[0]))];
      if (excludedSyms.length) perfQ += '&excludeSymbols=' + excludedSyms.join(',');
    }
    if (opsPerfSource === 'backtest' && opsBtPeriod) {
      const now = new Date();
      const months = { '1m': 1, '3m': 3, '6m': 6 }[opsBtPeriod] || 0;
      if (months) { const d = new Date(now); d.setMonth(d.getMonth() - months); perfQ += '&after=' + d.toISOString(); resQ += '&after=' + d.toISOString(); }
    }

    const [sig, tr, res, perf, sys] = await Promise.all([
      safe(fetch('/api/signals?limit=50',                    { headers: hdrs })),
      safe(fetch('/api/paper-trades?status=open',            { headers: hdrs })),
      safe(fetch(resQ,                                       { headers: hdrs })),
      safe(fetch(perfQ,                                      { headers: hdrs })),
      safe(fetch('/api/system-status',                       { headers: hdrs })),
    ]);
    opsData = { signals: sig, trades: tr, results: res, perf, system: sys };
  } catch (e) {
    opsData = {};
  }
  opsLastLoadTime = Date.now();
  updateOpsTimestamp();
  renderStrategyBar();
  renderSignals();
  renderTrades();
  renderResults();
  renderPerf();
  renderSystem();
  startOpsAutoRefresh();
}

function updateOpsTimestamp() {
  const el = document.getElementById('ops-last-update');
  const warn = document.getElementById('ops-stale-warning');
  if (el && opsLastLoadTime) {
    el.textContent = '갱신 ' + new Date(opsLastLoadTime).toLocaleTimeString('ko-KR');
  }
  if (warn) {
    if (opsLastLoadTime && (Date.now() - opsLastLoadTime > OPS_STALE_MS)) {
      warn.style.display = 'block';
      warn.className = 'ops-banner';
      warn.innerHTML = `<span class="ops-banner-pill" style="background:rgba(248,113,113,0.18);color:#f87171;">STALE</span>
        <span class="ops-banner-text">마지막 갱신이 5분 이상 경과했습니다. 자동 새로고침이 동작 중이 아니거나 네트워크 문제일 수 있습니다.</span>`;
    } else {
      warn.style.display = 'none';
    }
  }
}

function renderStrategyBar() {
  const bar = document.getElementById('ops-strategy-bar');
  if (!bar) return;
  // 모든 데이터에서 전략 키 수집
  const allItems = [
    ...(opsData.signals?.items || []),
    ...(opsData.trades?.items || []),
    ...(opsData.results?.items || []),
  ];
  const keys = [...new Set(allItems.map(i => getStrategyKey(i.symbol, i.direction)).filter(k => k && !k.startsWith('_')))].sort();

  const live = keys.filter(k => getStrategyStatus(k.split('_')[0], k.split('_')[1]) === 'live');
  const research = keys.filter(k => getStrategyStatus(k.split('_')[0], k.split('_')[1]) === 'research');
  const excluded = keys.filter(k => getStrategyStatus(k.split('_')[0], k.split('_')[1]) === 'excluded');

  bar.innerHTML = `<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;align-items:center;">
    <button class="ops-chip${!opsStrategy?' active':''}" onclick="setStrategy('')" style="font-weight:700;">전체 전략</button>
    ${live.length ? '<span style="border-left:1px solid rgba(52,211,153,0.3);margin:0 2px;"></span>' : ''}
    ${live.map(k => `<button class="ops-chip${opsStrategy===k?' active':''}" onclick="setStrategy('${k}')" style="color:#34d399;font-weight:700;">⚡ ${k.replace('_',' ')}</button>`).join('')}
    ${research.length ? '<span style="border-left:1px solid rgba(96,165,250,0.3);margin:0 2px;"></span>' : ''}
    ${research.map(k => `<button class="ops-chip${opsStrategy===k?' active':''}" onclick="setStrategy('${k}')" style="color:#60a5fa;">🔬 ${k.replace('_',' ')}</button>`).join('')}
    ${excluded.length ? '<span style="border-left:1px solid rgba(100,116,139,0.3);margin:0 2px;"></span>' : ''}
    ${excluded.map(k => `<button class="ops-chip${opsStrategy===k?' active':''}" onclick="setStrategy('${k}')" style="color:#64748b;">⏸ ${k.replace('_',' ')}</button>`).join('')}
  </div>`;
}

function startOpsAutoRefresh() {
  if (opsAutoRefreshTimer) clearInterval(opsAutoRefreshTimer);
  opsAutoRefreshTimer = setInterval(() => {
    const opsPage = document.getElementById('page-ops');
    if (opsPage && opsPage.classList.contains('active')) {
      loadOps();
    }
  }, OPS_REFRESH_MS);
  // stale check 은 더 자주 (10초)
  setInterval(updateOpsTimestamp, 10000);
}

// ── 1. 신호 후보 (단계 필터 + 종목 필터 + 팩터 확장) ──
function renderSignals() {
  const el = document.getElementById('ops-signals-content'); if (!el) return;
  const d = opsData.signals || {};
  const diag = diagnose(d);
  if (diag) { el.innerHTML = emptyState(diag, d.error); return; }
  let allItems = d.items || [];
  // 전략 필터 적용
  if (opsStrategy) allItems = allItems.filter(s => getStrategyKey(s.symbol, s.direction) === opsStrategy);
  // 제외 전략 기본 숨김 (전략 필터 미선택 시)
  if (!opsStrategy) allItems = allItems.filter(s => getStrategyStatus(s.symbol, s.direction, s) !== 'excluded');
  if (!allItems.length) {
    const msg = opsStrategy
      ? `${opsStrategy.replace('_',' ')} — 현재 발생한 신호가 없습니다. 조건 충족 시 자동으로 나타납니다.`
      : '⚡ XRP SHORT: score 65 이상이면 매매 후보로 표시됩니다.\n🔬 BTC/ETH: 추세가 맞으면 연구용으로 기록됩니다.\n\n신호 대기 중... 1시간마다 스캔합니다.';
    el.innerHTML = emptyState('noData', msg); return;
  }

  // 단계/방향 기반 건수
  const cntCandidate = allItems.filter(s => (s.stage || 'candidate') === 'candidate' && s.direction !== 'no_trade').length;
  const cntReady = allItems.filter(s => s.stage === 'trade_ready').length;
  const cntNoTrade = allItems.filter(s => s.direction === 'no_trade').length;

  // 1) stage 필터 적용
  let stageFiltered = allItems;
  if (opsStageFilter === 'candidate') stageFiltered = allItems.filter(s => (s.stage || 'candidate') === 'candidate' && s.direction !== 'no_trade');
  else if (opsStageFilter === 'trade_ready') stageFiltered = allItems.filter(s => s.stage === 'trade_ready');
  else if (opsStageFilter === 'no_trade') stageFiltered = allItems.filter(s => s.direction === 'no_trade');

  // 2) 종목 필터 적용
  const symbols = [...new Set(stageFiltered.map(s => s.symbol).filter(Boolean))].sort();
  const items = opsSignalFilter ? stageFiltered.filter(s => s.symbol === opsSignalFilter) : stageFiltered;

  // 단계 필터 칩
  let stageHtml = `<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
    <button class="ops-chip${!opsStageFilter?' active':''}" onclick="setStageFilter('')">전체 (${allItems.length})</button>
    <button class="ops-chip${opsStageFilter==='candidate'?' active':''}" onclick="setStageFilter('candidate')" style="color:#60a5fa;">감시 (${cntCandidate})</button>
    <button class="ops-chip${opsStageFilter==='trade_ready'?' active':''}" onclick="setStageFilter('trade_ready')" style="color:#a78bfa;">매매 후보 (${cntReady})</button>
    <button class="ops-chip${opsStageFilter==='no_trade'?' active':''}" onclick="setStageFilter('no_trade')" style="color:#64748b;">제외 (${cntNoTrade})</button>
  </div>`;

  // 종목 필터 칩
  let symbolHtml = symbols.length > 1 ? `<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;">
    <button class="ops-chip${!opsSignalFilter?' active':''}" onclick="setSignalFilter('')">전체 종목</button>
    ${symbols.map(sym => `<button class="ops-chip${opsSignalFilter===sym?' active':''}" onclick="setSignalFilter('${sym}')">${esc(sym)}</button>`).join('')}
  </div>` : '';

  // 팩터 렌더 헬퍼
  function renderFactors(s) {
    if (!s.factors || typeof s.factors !== 'object') return '<div style="color:#475569;font-size:0.78rem;">분석 팩터 없음</div>';
    const labels = { trend:'추세', rsi:'RSI', timing:'진입 타이밍', volume:'거래량', riskReward:'R:R' };
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;">
      ${Object.entries(s.factors).map(([k,v]) => {
        const val = typeof v === 'object' && v !== null ? v : { value: v };
        const scoreColor = (val.score || 0) >= 7 ? '#34d399' : (val.score || 0) >= 4 ? '#fbbf24' : '#f87171';
        return `<div style="padding:6px 10px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
          <div style="font-size:0.68rem;color:#64748b;text-transform:uppercase;">${esc(labels[k] || k)}</div>
          <div style="font-size:0.85rem;color:#e2e8f0;font-weight:600;">${esc(String(val.value != null ? val.value : '-'))}</div>
          ${val.score != null ? `<div style="font-size:0.68rem;color:${scoreColor};">점수 ${val.score}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  }

  // 사유 표시 (no_trade면 제외 사유 함께)
  function reasonCell(s) {
    let html = `<span>${esc(s.scoreReason || '')}</span>`;
    if (s.direction === 'no_trade' && s.noTradeReason) {
      html += `<div style="margin-top:4px;font-size:0.72rem;color:#f87171;border-left:2px solid #f87171;padding-left:6px;">제외: ${esc(s.noTradeReason)}</div>`;
    }
    return html;
  }

  if (!items.length) {
    const stageLabel = { candidate:'감시 후보', trade_ready:'매매 후보', no_trade:'제외' }[opsStageFilter] || '';
    el.innerHTML = stageHtml + symbolHtml + emptyState('noData', stageLabel ? `현재 ${stageLabel} 신호가 없습니다.` : '필터에 해당하는 신호가 없습니다.');
    return;
  }

  el.innerHTML = stageHtml + symbolHtml + `
    <div class="ops-table-wrap">
      <table class="ops-table">
        <thead><tr><th>종목</th><th>단계</th><th>점수</th><th>사유</th><th>진입가</th><th>손절</th><th>방향</th><th>상태</th><th>생성</th></tr></thead>
        <tbody>${items.map((s, idx) => {
          const scoreCls = s.score >= 70 ? 'color:#34d399' : s.score >= 40 ? 'color:#fbbf24' : 'color:#f87171';
          const isNoTrade = s.direction === 'no_trade';
          const sid = String(s.signalId || s.id || idx).replace(/[^a-zA-Z0-9_-]/g, '_');
          const sStatus = getStrategyStatus(s.symbol, s.direction, s);
          return `<tr class="${isNoTrade ? 'no-trade' : ''}" style="cursor:pointer;" onclick="toggleFactors('${sid}')">
            <td style="font-weight:700;color:#e2e8f0;">${esc(s.symbol)} <span style="font-size:0.65rem;color:#475569;">&#9662;</span><br>${strategyBadge(sStatus)}</td>
            <td>${stageBadge(s.stage || 'candidate')}<br>${actionBadge(sStatus)}</td>
            <td style="${scoreCls};font-weight:700;">${s.score}</td>
            <td style="color:#94a3b8;font-size:0.78rem;max-width:240px;white-space:normal;">${reasonCell(s)}</td>
            <td>${isNoTrade ? '-' : fmtKRW(s.entryPrice)}</td>
            <td>${isNoTrade ? '-' : fmtKRW(s.stopLoss)}</td>
            <td>${directionBadge(s.direction)}</td>
            <td>${itemStatusBadge(s.status)}</td>
            <td style="font-size:0.72rem;color:#475569;">${fmtRel(s.created_at)}</td>
          </tr>
          <tr class="ops-factors-row" id="factors-${sid}" style="display:none;">
            <td colspan="9" style="padding:10px 16px;">${renderFactors(s)}</td>
          </tr>`}).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── 2. 검증 중 (paper trade) ──
function renderTrades() {
  const el = document.getElementById('ops-trades-content'); if (!el) return;
  const d = opsData.trades || {};
  const diag = diagnose(d);
  if (diag) { el.innerHTML = emptyState(diag, d.error); return; }
  let items = d.items || [];
  if (opsStrategy) items = items.filter(t => getStrategyKey(t.symbol, t.direction) === opsStrategy);
  if (!opsStrategy) items = items.filter(t => getStrategyStatus(t.symbol, t.direction, t) !== 'excluded');
  if (!items.length) {
    const msg = opsStrategy
      ? `${opsStrategy.replace('_',' ')} — 현재 열린 포지션이 없습니다.`
      : '열린 포지션 없음. XRP SHORT score 65+ 달성 시 자동 진입됩니다.';
    el.innerHTML = emptyState('noData', msg); return;
  }
  el.innerHTML = `
    <div class="ops-table-wrap">
      <table class="ops-table">
        <thead><tr><th>종목</th><th>방향</th><th>진입가</th><th>현재가</th><th>손익</th><th>최대유리</th><th>최대불리</th><th>보유시간</th><th>상태</th><th>진입</th><th>갱신</th></tr></thead>
        <tbody>${items.map(t => `<tr>
          <td style="font-weight:700;color:#e2e8f0;">${esc(t.symbol)}<br>${strategyBadge(getStrategyStatus(t.symbol, t.direction, t))}</td>
          <td>${directionBadge(t.direction)}</td>
          <td>${fmtKRW(t.entryPrice)}</td>
          <td>${fmtKRW(t.currentPrice)}</td>
          <td style="color:${pnlColor(t.pnlPercent)};font-weight:700;">${fmtPct(t.pnlPercent)}</td>
          <td style="color:#34d399;">${fmtPct(t.maxFavorable)}</td>
          <td style="color:#f87171;">${fmtPct(t.maxAdverse)}</td>
          <td>${fmtHold(t.holdTimeMin)}</td>
          <td>${itemStatusBadge(t.status)}</td>
          <td style="font-size:0.72rem;color:#475569;">${fmtRel(t.created_at)}</td>
          <td style="font-size:0.72rem;color:#60a5fa;">${fmtRel(t.updated_at)}</td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── 3. 종료 결과 (W/L 필터 + 방향 필터) ──
function renderResults() {
  const el = document.getElementById('ops-results-content'); if (!el) return;
  const d = opsData.results || {};
  const diag = diagnose(d);
  if (diag) { el.innerHTML = emptyState(diag, d.error); return; }
  let allItems = d.items || [];
  if (opsStrategy) allItems = allItems.filter(r => getStrategyKey(r.symbol, r.direction) === opsStrategy);
  if (!opsStrategy) allItems = allItems.filter(r => getStrategyStatus(r.symbol, r.direction, r) !== 'excluded');
  if (!allItems.length) {
    const msg = opsStrategy
      ? `${opsStrategy.replace('_',' ')} — 종료된 거래가 없습니다.`
      : '종료된 실전 거래가 없습니다. paper trade가 종료되면 여기에 쌓입니다.\n백테스트 결과는 위 필터에서 "백테스트"를 선택하세요.';
    el.innerHTML = emptyState('noData', msg); return;
  }

  const wins = allItems.filter(r => r.result === 'win').length;
  const losses = allItems.filter(r => r.result === 'loss').length;
  const longs = allItems.filter(r => (r.direction || 'long') === 'long').length;
  const shorts = allItems.filter(r => r.direction === 'short').length;

  // W/L + 방향 + source 필터 적용
  let filtered = allItems;
  if (opsResultSource) filtered = filtered.filter(r => (r.source || 'n8n') === opsResultSource);
  if (opsResultFilter) filtered = filtered.filter(r => r.result === opsResultFilter);
  if (opsResultDirFilter) filtered = filtered.filter(r => (opsResultDirFilter === 'long' ? (r.direction || 'long') === 'long' : r.direction === opsResultDirFilter));

  const liveCnt = allItems.filter(r => (r.source || 'n8n') !== 'backtest').length;
  const btCnt = allItems.filter(r => r.source === 'backtest').length;

  let filterHtml = `<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
    <button class="ops-chip${!opsResultSource?' active':''}" onclick="setResultSource('')">전체 (${allItems.length})</button>
    <button class="ops-chip${opsResultSource==='n8n'?' active':''}" onclick="setResultSource('n8n')" style="color:#60a5fa;">실전 (${liveCnt})</button>
    <button class="ops-chip${opsResultSource==='backtest'?' active':''}" onclick="setResultSource('backtest')" style="color:#fb923c;">백테스트 (${btCnt})</button>
    <span style="border-left:1px solid rgba(255,255,255,0.1);margin:0 4px;"></span>
    <button class="ops-chip${!opsResultFilter?' active':''}" onclick="setResultFilter('')">W/L</button>
    <button class="ops-chip${opsResultFilter==='win'?' active':''}" onclick="setResultFilter('win')" style="color:#34d399;">W (${wins})</button>
    <button class="ops-chip${opsResultFilter==='loss'?' active':''}" onclick="setResultFilter('loss')" style="color:#f87171;">L (${losses})</button>
    <span style="border-left:1px solid rgba(255,255,255,0.1);margin:0 4px;"></span>
    <button class="ops-chip${!opsResultDirFilter?' active':''}" onclick="setResultDirFilter('')">방향</button>
    <button class="ops-chip${opsResultDirFilter==='long'?' active':''}" onclick="setResultDirFilter('long')" style="color:#34d399;">Long (${longs})</button>
    <button class="ops-chip${opsResultDirFilter==='short'?' active':''}" onclick="setResultDirFilter('short')" style="color:#f87171;">Short (${shorts})</button>
  </div>`;

  if (!filtered.length) {
    el.innerHTML = filterHtml + emptyState('noData', '필터에 해당하는 결과가 없습니다.');
    return;
  }

  el.innerHTML = filterHtml + `
    <div class="ops-table-wrap">
      <table class="ops-table">
        <thead><tr><th></th><th>종목</th><th>방향</th><th>손익</th><th>최대유리</th><th>최대불리</th><th>보유</th><th>종료 사유</th><th>진입가</th><th>종료가</th><th>시각</th></tr></thead>
        <tbody>${filtered.map(r => {
          const isBT = r.source === 'backtest';
          return `<tr${isBT ? ' style="opacity:0.85;"' : ''}>
          <td>${resultBadge(r.result)}${isBT ? ' <span style="font-size:0.6rem;color:#fb923c;font-weight:700;">BT</span>' : ''}</td>
          <td style="font-weight:700;color:#e2e8f0;">${esc(r.symbol)}${r.confidence ? ` <span style="font-size:0.6rem;color:#94a3b8;">${r.confidence}</span>` : ''}</td>
          <td>${directionBadge(r.direction)}</td>
          <td style="color:${pnlColor(r.pnlPercent)};font-weight:700;">${fmtPct(r.pnlPercent)}</td>
          <td style="color:#34d399;font-size:0.78rem;">${r.maxFavorable ? fmtPct(r.maxFavorable) : '-'}</td>
          <td style="color:#f87171;font-size:0.78rem;">${r.maxAdverse ? fmtPct(r.maxAdverse) : '-'}</td>
          <td style="font-size:0.72rem;color:#94a3b8;">${r.holdTimeMin ? fmtHold(r.holdTimeMin) : '-'}</td>
          <td style="color:#94a3b8;font-size:0.78rem;">${esc(r.exitReason)}</td>
          <td>${fmtKRW(r.entryPrice)}</td>
          <td>${fmtKRW(r.exitPrice)}</td>
          <td style="font-size:0.72rem;color:#475569;">${fmtRel(r.exitAt || r.created_at)}</td>
        </tr>`}).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── 4. 성과 요약 (20/50 토글 + 실전 판정) ──
function renderPerf() {
  const el = document.getElementById('ops-perf-content'); if (!el) return;
  const d = opsData.perf || {};
  const diag = diagnose(d);
  if (diag) { el.innerHTML = emptyState(diag, d.error); return; }

  // 모드 칩 (0건이어도 표시해야 하므로 먼저 생성)
  const isBt = opsPerfSource === 'backtest';
  const sourceChipHtml = `<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;align-items:center;">
    <button class="ops-chip${!opsPerfSource?' active':''}" onclick="setPerfSource('')">전체</button>
    <button class="ops-chip${opsPerfSource==='n8n'?' active':''}" onclick="setPerfSource('n8n')" style="color:#60a5fa;">실전 (live)</button>
    <button class="ops-chip${isBt?' active':''}" onclick="setPerfSource('backtest')" style="color:#fb923c;">백테스트</button>
    ${isBt ? `<span style="border-left:1px solid rgba(255,255,255,0.1);margin:0 4px;"></span>
      <button class="ops-chip${opsBtPeriod===''?' active':''}" onclick="setBtPeriod('')">전체 기간</button>
      <button class="ops-chip${opsBtPeriod==='1m'?' active':''}" onclick="setBtPeriod('1m')">1개월</button>
      <button class="ops-chip${opsBtPeriod==='3m'?' active':''}" onclick="setBtPeriod('3m')">3개월</button>
      <button class="ops-chip${opsBtPeriod==='6m'?' active':''}" onclick="setBtPeriod('6m')">6개월</button>` : ''}
  </div>`;
  let modeBanner = '';
  if (isBt) {
    modeBanner = `<div style="padding:8px 14px;background:rgba(251,146,60,0.08);border:1px solid rgba(251,146,60,0.3);border-radius:10px;margin-bottom:12px;font-size:0.8rem;color:#fb923c;">🟠 백테스트 성과 — 과거 시뮬레이션이며 실전 결과가 아닙니다</div>
      <div style="padding:12px 16px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:10px;margin-bottom:14px;">
        <div style="font-size:0.78rem;color:#94a3b8;margin-bottom:8px;font-weight:600;">백테스트 실행</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;">
          <label style="font-size:0.72rem;color:#64748b;">코인<br>
            <select id="bt-market" style="padding:5px 8px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#1e293b;color:#e2e8f0;font-size:0.78rem;">
              <option value="KRW-BTC">BTC</option><option value="KRW-ETH">ETH</option><option value="KRW-XRP">XRP</option>
              <option value="KRW-ETC">ETC</option><option value="KRW-TRX">TRX</option><option value="KRW-DOGE">DOGE</option>
            </select></label>
          <label style="font-size:0.72rem;color:#64748b;">시작일<br>
            <input id="bt-start" type="date" style="padding:5px 8px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#1e293b;color:#e2e8f0;font-size:0.78rem;"></label>
          <label style="font-size:0.72rem;color:#64748b;">종료일<br>
            <input id="bt-end" type="date" style="padding:5px 8px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#1e293b;color:#e2e8f0;font-size:0.78rem;"></label>
          <label style="font-size:0.72rem;color:#64748b;">진입 기준<br>
            <input id="bt-cutoff" type="number" value="60" min="0" max="100" style="width:55px;padding:5px 8px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#1e293b;color:#e2e8f0;font-size:0.78rem;"></label>
          <button id="bt-run-btn" onclick="runBacktest()" style="padding:6px 16px;border-radius:14px;border:1px solid rgba(251,146,60,0.4);background:rgba(251,146,60,0.15);color:#fb923c;font-size:0.78rem;font-weight:600;cursor:pointer;">실행</button>
          <span id="bt-run-msg" style="font-size:0.72rem;"></span>
        </div>
      </div>`;
  } else if (opsPerfSource === 'n8n') {
    modeBanner = `<div style="padding:8px 14px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.3);border-radius:10px;margin-bottom:12px;font-size:0.8rem;color:#60a5fa;">🟢 실전 성과 — 실제 거래 기반</div>`;
  }

  // 전략 필터 배너
  if (opsStrategy) {
    const sKey = opsStrategy;
    const sStatus = STRATEGY_STATUS[sKey] || 'research';
    modeBanner += `<div style="padding:6px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;margin-bottom:10px;font-size:0.8rem;display:flex;align-items:center;gap:8px;">
      ${strategyBadge(sStatus)} <span style="color:#e2e8f0;font-weight:600;">${sKey.replace('_',' ')}</span> <span style="color:#64748b;">전략 성과</span>
    </div>`;
  }

  if (!d.total) {
    const stratLabel = opsStrategy ? opsStrategy.replace('_', ' ') + ' — ' : '';
    const msg = isBt
      ? `${stratLabel}백테스트 결과가 없습니다. 위 실행 폼에서 백테스트를 돌려보세요.`
      : opsPerfSource === 'n8n'
        ? `${stratLabel}실전 거래 결과가 없습니다. 검증 데이터 축적 중... score 65+ 진입 → 종료 후 자동 집계됩니다.`
        : `${stratLabel}거래 결과가 쌓이면 자동으로 성과가 계산됩니다.`;
    el.innerHTML = sourceChipHtml + modeBanner + emptyState('noData', msg); return;
  }
  const p = d;
  const safeRatio = (v) => (v == null || !isFinite(v)) ? '0' : String(v);
  const expectColor = p.expectation > 0 ? '#34d399' : p.expectation < 0 ? '#f87171' : '#64748b';

  // 실전 검토 판정 (규칙 기반)
  let verdict, verdictColor, verdictDesc;
  if (p.total < 10) {
    verdict = '판단 보류'; verdictColor = '#64748b';
    verdictDesc = `검증 데이터 축적 중 (${p.total}/10건) — 10건 이상 쌓여야 판정 가능`;
  } else if (p.expectation > 0 && p.winRate >= 0.4 && p.maxConsecutiveLoss <= 5 && p.maxDrawdownPercent <= 15) {
    verdict = '검토 가능'; verdictColor = '#34d399';
    verdictDesc = '기대값 양수, 승률/낙폭 허용 범위 내';
  } else if (p.expectation <= 0 || p.maxDrawdownPercent > 20 || p.maxConsecutiveLoss > 7) {
    verdict = '보류'; verdictColor = '#f87171';
    verdictDesc = p.expectation <= 0 ? '기대값이 음수입니다' : p.maxDrawdownPercent > 20 ? '최대낙폭 20% 초과' : '연속손실 7회 초과';
  } else {
    verdict = '경계'; verdictColor = '#fbbf24';
    verdictDesc = '일부 지표가 경계 수준 — 추가 데이터 필요';
  }

  // 20/50건 토글
  const toggleHtml = `<div style="display:flex;gap:6px;margin-bottom:14px;align-items:center;">
    <span style="font-size:0.78rem;color:#94a3b8;">기준:</span>
    <button class="ops-chip${opsPerfCount===20?' active':''}" onclick="setPerfCount(20)">최근 20건</button>
    <button class="ops-chip${opsPerfCount===50?' active':''}" onclick="setPerfCount(50)">최근 50건</button>
  </div>`;

  // 판정 카드
  const verdictCard = `
    <div class="ops-card" style="grid-column:1/-1;border-color:${verdictColor}55;background:${verdictColor}08;">
      <div class="ops-card-label">실전 검토 판정</div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:6px;">
        <span style="display:inline-block;padding:5px 16px;border-radius:12px;font-size:0.9rem;font-weight:700;background:${verdictColor}22;color:${verdictColor};border:1px solid ${verdictColor}55;">${verdict}</span>
        <span style="color:#94a3b8;font-size:0.82rem;">${verdictDesc}</span>
      </div>
      <div style="font-size:0.72rem;color:#475569;margin-top:6px;">기준: 기대값 > 0, 승률 >= 40%, 연속손실 <= 5, 낙폭 <= 15%</div>
    </div>`;

  el.innerHTML = sourceChipHtml + modeBanner + toggleHtml + `
    <div class="ops-cards">
      ${verdictCard}
      <div class="ops-card">
        <div class="ops-card-label">승률</div>
        <div class="ops-card-value" style="color:${p.winRate >= 0.5 ? '#34d399' : '#f87171'};">${(p.winRate * 100).toFixed(1)}%</div>
        <div class="ops-card-sub">${p.wins}승 ${p.losses}패 / 최근 ${p.total}건</div>
      </div>
      <div class="ops-card">
        <div class="ops-card-label">평균 손익비</div>
        <div class="ops-card-value">${safeRatio(p.avgPnlRatio)}</div>
        <div class="ops-card-sub">평균 수익 ${fmtPct(p.avgWinPercent)} / 평균 손실 -${p.avgLossPercent || 0}%</div>
      </div>
      <div class="ops-card">
        <div class="ops-card-label">기대값</div>
        <div class="ops-card-value" style="color:${expectColor};">${fmtPct(p.expectation)}</div>
        <div class="ops-card-sub">건당 기대 수익률</div>
      </div>
      <div class="ops-card">
        <div class="ops-card-label">최대 연속손실</div>
        <div class="ops-card-value" style="color:#f87171;">${p.maxConsecutiveLoss || 0}</div>
        <div class="ops-card-sub">연속 패배 횟수</div>
      </div>
      <div class="ops-card">
        <div class="ops-card-label">최대낙폭</div>
        <div class="ops-card-value" style="color:#f87171;">${p.maxDrawdownPercent || 0}%</div>
        <div class="ops-card-sub">누적 PnL 고점 대비</div>
      </div>
    </div>`;

  // 방향별 성과 (byDirection) — 0건인 방향은 카드 미표시
  const byDir = p.byDirection || {};
  const lp = byDir.long || {};
  const sp = byDir.short || {};
  if (lp.total > 0 || sp.total > 0) {
    let dirCards = '';
    if (lp.total > 0) {
      dirCards += `<div class="ops-card" style="border-color:rgba(52,211,153,0.3);">
          <div class="ops-card-label" style="color:#34d399;">LONG</div>
          <div class="ops-card-value">${lp.total}<span style="font-size:0.75rem;color:#94a3b8;">건</span></div>
          <div class="ops-card-sub">승률 ${((lp.winRate||0)*100).toFixed(1)}% · ${lp.wins||0}승 ${lp.losses||0}패</div>
          <div class="ops-card-sub">기대값 ${fmtPct(lp.expectation||0)} · 손익비 ${lp.avgPnlRatio||0}</div>
        </div>`;
    }
    if (sp.total > 0) {
      dirCards += `<div class="ops-card" style="border-color:rgba(248,113,113,0.3);">
          <div class="ops-card-label" style="color:#f87171;">SHORT</div>
          <div class="ops-card-value">${sp.total}<span style="font-size:0.75rem;color:#94a3b8;">건</span></div>
          <div class="ops-card-sub">승률 ${((sp.winRate||0)*100).toFixed(1)}% · ${sp.wins||0}승 ${sp.losses||0}패</div>
          <div class="ops-card-sub">기대값 ${fmtPct(sp.expectation||0)} · 손익비 ${sp.avgPnlRatio||0}</div>
        </div>`;
    }
    el.innerHTML += `
      <div style="font-size:0.82rem;color:#94a3b8;font-weight:600;margin:18px 0 8px;">방향별 성과</div>
      <div class="ops-cards">${dirCards}</div>`;
  }
}

// ── 5. 시스템 상태 (시스템 + 잔고 + 워크플로 + 실패 이력) ──
function renderSystem() {
  const el = document.getElementById('ops-system-content'); if (!el) return;
  const d = opsData.system || {};
  const diag = diagnose(d);
  if (diag) { el.innerHTML = emptyState(diag, d.error); return; }

  const sys = d.system;
  const bal = d.balance;
  const wfs = d.workflows || [];

  let html = '';

  // 시스템 상태 뱃지 + 실패 이유
  html += `<div class="ops-cards" style="margin-bottom:16px;">
    <div class="ops-card" style="grid-column:1/-1;">
      <div class="ops-card-label">시스템 상태</div>
      <div style="display:flex;gap:12px;align-items:center;margin-top:6px;">
        ${sys ? sysStatusBadge(sys.status) : sysStatusBadge('normal')}
        <span style="color:#94a3b8;font-size:0.85rem;">${sys ? esc(sys.reason) : '상태 정보 없음 — kind=system_status 를 보내면 반영됩니다.'}</span>
      </div>
      ${sys && sys.lastSyncFailure ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.2);border-radius:8px;font-size:0.78rem;color:#f87171;"><strong>동기화 실패:</strong> ${esc(sys.lastSyncFailure)}</div>` : ''}
      ${sys && sys.lastCollectFailure ? `<div style="margin-top:6px;padding:8px 12px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.2);border-radius:8px;font-size:0.78rem;color:#f87171;"><strong>수집 실패:</strong> ${esc(sys.lastCollectFailure)}</div>` : ''}
      ${sys && sys.updated_at ? `<div style="font-size:0.72rem;color:#475569;margin-top:8px;">마지막 상태 업데이트: ${fmtRel(sys.updated_at)}</div>` : ''}
    </div>
  </div>`;

  // 잔고 카드 — 원가 + 평가 분리 표시
  if (bal) {
    const coinCost = Number(bal.totalCostKRW) || 0;
    const cash = Number(bal.cashKRW) || 0;
    const coinMarket = Number(bal.totalMarketValue) || 0;
    const hasMarket = coinMarket > 0;

    // ── 원가 기준 ──
    html += '<div style="font-size:0.82rem;color:#94a3b8;font-weight:600;margin-bottom:8px;">투입 원가 <span style="font-weight:400;font-size:0.72rem;">(내가 넣은 돈)</span></div>';
    html += '<div class="ops-cards" style="margin-bottom:12px;">';
    html += `
      <div class="ops-card">
        <div class="ops-card-label">💵 KRW 현금</div>
        <div class="ops-card-value">${fmtKRW(cash)}</div>
        <div class="ops-card-sub">매수에 안 쓴 현금 · ${syncBadge(bal.syncStatus)}</div>
      </div>
      <div class="ops-card">
        <div class="ops-card-label">📊 코인 매수 원가</div>
        <div class="ops-card-value">${fmtKRW(coinCost)}</div>
        <div class="ops-card-sub">매수 평균가 × 수량 · 종목 ${(bal.perCoin || []).length}개</div>
      </div>
      <div class="ops-card">
        <div class="ops-card-label">🟰 투입 합계</div>
        <div class="ops-card-value">${fmtKRW(coinCost + cash)}</div>
        <div class="ops-card-sub">현금 + 매수 원가 (현재 시세 아님)</div>
      </div>`;
    html += '</div>';

    // ── 평가 기준 (시세가 있을 때만) ──
    if (hasMarket) {
      const totalEval = coinMarket + cash;
      const pnl = coinMarket - coinCost;
      const pnlPct = coinCost > 0 ? (pnl / coinCost * 100) : 0;
      const pnlColor_ = pnl > 0 ? '#34d399' : pnl < 0 ? '#f87171' : '#64748b';
      const pnlSign = pnl >= 0 ? '+' : '';

      html += '<div style="font-size:0.82rem;color:#94a3b8;font-weight:600;margin-bottom:8px;">현재 평가 <span style="font-weight:400;font-size:0.72rem;">(지금 시세 기준)</span></div>';
      html += '<div class="ops-cards" style="margin-bottom:12px;">';
      html += `
        <div class="ops-card">
          <div class="ops-card-label">💰 코인 평가액</div>
          <div class="ops-card-value">${fmtKRW(coinMarket)}</div>
          <div class="ops-card-sub">현재가 × 보유수량</div>
        </div>
        <div class="ops-card ops-card-sum">
          <div class="ops-card-label">🟰 총 평가자산</div>
          <div class="ops-card-value">${fmtKRW(totalEval)}</div>
          <div class="ops-card-sub">현금 + 코인 평가액 = 내 계좌 현재 가치</div>
        </div>
        <div class="ops-card" style="border-color:${pnlColor_}55;background:${pnlColor_}08;">
          <div class="ops-card-label">📈 평가손익</div>
          <div class="ops-card-value" style="color:${pnlColor_};">${pnlSign}${fmtKRW(pnl)}</div>
          <div class="ops-card-sub" style="color:${pnlColor_};">${pnlSign}${pnlPct.toFixed(2)}% (코인 평가액 − 매수 원가)</div>
        </div>`;
      html += '</div>';
    }

    html += `<div class="ops-meta-line" style="margin-bottom:16px;display:flex;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>🏦 계좌 ${bal.accountCount || 0}개 · 마지막 수신 ${fmtRel(bal.created_at)}</span>
      <button id="bal-refresh-btn" onclick="refreshBalance()" style="padding:4px 12px;border-radius:14px;border:1px solid rgba(99,102,241,0.4);background:rgba(99,102,241,0.1);color:#a5b4fc;font-size:0.72rem;cursor:pointer;">잔고 새로고침</button>
      <span id="bal-refresh-msg" style="font-size:0.72rem;"></span>
      ${!hasMarket ? '<span style="color:#fbbf24;">현재가 미수신 — 위 숫자는 매수 원가이며 현재 시세가 아닙니다</span>' : ''}
      ${bal.errorType ? `<span style="color:#f87171;">${esc(bal.errorType)}</span>` : ''}
    </div>`;
  } else {
    html += '<div class="ops-cards" style="margin-bottom:16px;">';
    html += `<div class="ops-card" style="grid-column:1/-1;">${emptyState('noData', 'balance webhook 대기 중')}</div>`;
    html += '</div>';
  }

  // 워크플로 상태 (최근 실패 강조)
  html += '<div style="font-size:0.82rem;color:#94a3b8;font-weight:600;margin-bottom:8px;">워크플로 상태</div>';
  if (wfs.length) {
    const failed = wfs.filter(r => r.status === 'failed');
    if (failed.length) {
      html += `<div style="padding:8px 12px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.2);border-radius:8px;margin-bottom:10px;font-size:0.78rem;color:#f87171;">
        <strong>${failed.length}개 워크플로 실패</strong>: ${failed.map(f => esc(f.workflow || '?')).join(', ')}
        ${failed[0].errorType ? ` (${esc(failed[0].errorType)})` : ''}
      </div>`;
    }
    html += wfs.map(r => `
      <div class="ops-event-row">
        <div class="ops-event-dot" style="background:${r.status==='ok'?'#34d399':r.status==='failed'?'#f87171':'#fbbf24'};"></div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <span style="font-weight:600;color:#e2e8f0;">${esc(r.workflow || '(unknown)')}</span>
            ${syncBadge(r.status)}
            ${r.errorType ? `<span style="font-size:0.7rem;color:#f87171;">${esc(r.errorType)}</span>` : ''}
          </div>
          <div style="font-size:0.72rem;color:#475569;margin-top:2px;">
            마지막 실행 ${fmtRel(r.created_at)}
            ${r.durationMs != null ? ' · ' + r.durationMs + 'ms' : ''}
            ${r.eventCount ? ' · ' + r.eventCount + '건' : ''}
          </div>
        </div>
      </div>
    `).join('');
  } else {
    html += emptyState('noData', '워크플로 실행 기록이 없습니다.');
  }

  el.innerHTML = html;
}
