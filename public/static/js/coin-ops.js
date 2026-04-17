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
window.setPnlSymbolFilter = (v) => { opsPnlSymbol = v; renderPnlChart(); };
window.saveEngineConfig = saveEngineConfig;
window.addEngineConfigRow = addEngineConfigRow;
window.removeEngineConfigNewRow = removeEngineConfigNewRow;
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
window.runSweep = async () => {
  const btn = document.getElementById('bt-sweep-btn');
  const msg = document.getElementById('bt-sweep-msg');
  if (!btn || btn.disabled) return;
  const market = document.getElementById('bt-market')?.value || 'KRW-BTC';
  const startDate = document.getElementById('bt-start')?.value || '';
  const endDate = document.getElementById('bt-end')?.value || '';
  const cutoffStr = (document.getElementById('bt-sweep-cutoffs')?.value || '').trim();
  if (!startDate || !endDate) { if (msg) { msg.style.color = '#f87171'; msg.textContent = '시작일/종료일을 선택하세요'; } return; }
  const scoreCutoffs = cutoffStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 0 && n <= 100);
  if (!scoreCutoffs.length || scoreCutoffs.length > 10) { if (msg) { msg.style.color = '#f87171'; msg.textContent = '콤마로 구분한 cutoff를 1~10개 입력하세요'; } return; }
  btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = 'Sweep 실행 중...';
  if (msg) { msg.style.color = '#94a3b8'; msg.textContent = `${scoreCutoffs.length}개 cutoff 실행 중...`; }
  try {
    const hdrs = await authHeaders();
    hdrs['Content-Type'] = 'application/json';
    const r = await fetch('/api/backtest/sweep', { method: 'POST', headers: hdrs, body: JSON.stringify({ market, startDate, endDate, scoreCutoffs }) });
    const d = await r.json();
    if (d.ok) {
      const ok = (d.results || []).filter(r => r.ok).length;
      const fail = (d.results || []).filter(r => !r.ok).length;
      if (msg) { msg.style.color = '#34d399'; msg.textContent = `완료 — 성공 ${ok}, 실패 ${fail}. 결과 로딩 중...`; }
      setTimeout(() => { loadOps(); }, 3000);
    } else {
      if (msg) { msg.style.color = '#f87171'; msg.textContent = d.error || '실패'; }
    }
  } catch (e) {
    if (msg) { msg.style.color = '#f87171'; msg.textContent = '네트워크 오류'; }
  }
  setTimeout(() => { if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Sweep 실행'; } }, 15000);
};
window.toggleSweepMode = () => {
  const single = document.getElementById('bt-single-mode');
  const sweep = document.getElementById('bt-sweep-mode');
  const toggle = document.getElementById('bt-sweep-toggle');
  if (!single || !sweep || !toggle) return;
  const isSweep = toggle.checked;
  single.style.display = isSweep ? 'none' : 'flex';
  sweep.style.display = isSweep ? 'flex' : 'none';
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
let opsPnlSymbol = '';          // PnL 차트 종목 필터: '' | 'BTC' | 'ETH' 등
let _pnlChartInstance = null;   // Chart.js 인스턴스 (메모리 릭 방지)
let _engineConfigNewRows = 0;   // 엔진 설정 신규 행 카운터

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
    live:     ['emerald', '실전 후보', '⚡'],
    research: ['sky', '연구', '🔬'],
    excluded: ['slate', '제외', '⏸'],
  };
  const [color, label, icon] = map[status] || map.research;
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-${color}-500/10 text-${color}-400 border border-${color}-500/30">${icon} ${label}</span>`;
}
function actionBadge(status) {
  const map = {
    live:     ['emerald', '진입 후보'],
    research: ['amber', '관찰'],
    excluded: ['slate', '무시'],
  };
  const [color, label] = map[status] || map.research;
  return `<span class="text-xs font-semibold text-${color}-400">${label}</span>`;
}
const OPS_STALE_MS = 5 * 60 * 1000; // 5분
const OPS_REFRESH_MS = 30 * 1000;   // 30초

// 포맷/뱃지 함수는 common.js 에 정의됨 (fmtKRW, fmtPct, fmtRel, fmtHold,
//   syncBadge, itemStatusBadge, pnlColor, resultBadge, sysStatusBadge,
//   directionBadge, stageBadge, emptyState, diagnose)

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

    // 종목 비교 + PnL 시계열 API source 파라미터
    let bySymQ = '/api/performance/by-symbol';
    let pnlQ = '/api/trade-results/pnl-series?limit=500';
    if (opsPerfSource) {
      bySymQ += '?source=' + opsPerfSource;
      pnlQ += '&source=' + opsPerfSource;
    }
    if (opsPnlSymbol) pnlQ += '&symbol=' + opsPnlSymbol;

    const [sig, tr, res, perf, sys, hb, bySym, pnlSeries] = await Promise.all([
      safe(fetch('/api/signals?limit=50',                    { headers: hdrs })),
      safe(fetch('/api/paper-trades?status=open',            { headers: hdrs })),
      safe(fetch(resQ,                                       { headers: hdrs })),
      safe(fetch(perfQ,                                      { headers: hdrs })),
      safe(fetch('/api/system-status',                       { headers: hdrs })),
      safe(fetch('/api/system/heartbeat',                    { headers: hdrs })),
      safe(fetch(bySymQ,                                     { headers: hdrs })),
      safe(fetch(pnlQ,                                       { headers: hdrs })),
    ]);
    opsData = { signals: sig, trades: tr, results: res, perf, system: sys, heartbeat: hb, bySymbol: bySym, pnlSeries };
  } catch (e) {
    opsData = {};
  }
  opsLastLoadTime = Date.now();
  updateOpsTimestamp();
  renderStrategyBar();
  renderSignals();
  renderTrades();
  renderResults();
  renderSymbolCompare();
  renderPnlChart();
  renderPerf();
  renderEngineConfig();
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
      warn.className = 'mb-4 flex items-center gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2.5';
      warn.innerHTML = `
        <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold bg-rose-500/30 text-rose-300">STALE</span>
        <span class="text-sm text-rose-200">마지막 갱신이 5분 이상 경과했습니다. 자동 새로고침이 동작 중이 아니거나 네트워크 문제일 수 있습니다.</span>`;
    } else {
      warn.className = 'hidden';
    }
  }
}

// ── Tailwind 공용 UI 헬퍼 ──
function chip(active, onclick, color, content) {
  const base = 'px-3 py-1 rounded-full text-xs font-semibold border transition whitespace-nowrap';
  const activeCls = color
    ? `bg-${color}-500/20 border-${color}-500/60 text-${color}-300`
    : 'bg-violet-500/20 border-violet-500/60 text-violet-200';
  const idleCls = color
    ? `border-${color}-500/25 text-${color}-400 hover:bg-${color}-500/10`
    : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500';
  return `<button onclick="${onclick}" class="${base} ${active ? activeCls : idleCls}">${content}</button>`;
}
function card(children, extra) {
  return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4 ${extra||''}">${children}</div>`;
}
function cardLabel(text, color) {
  const c = color ? `text-${color}-400` : 'text-slate-400';
  return `<div class="text-[11px] font-semibold uppercase tracking-wider ${c} mb-1.5">${text}</div>`;
}

function renderStrategyBar() {
  const bar = document.getElementById('ops-strategy-bar');
  if (!bar) return;
  const allItems = [
    ...(opsData.signals?.items || []),
    ...(opsData.trades?.items || []),
    ...(opsData.results?.items || []),
  ];
  const keys = [...new Set(allItems.map(i => getStrategyKey(i.symbol, i.direction)).filter(k => k && !k.startsWith('_')))].sort();
  const live = keys.filter(k => getStrategyStatus(k.split('_')[0], k.split('_')[1]) === 'live');
  const research = keys.filter(k => getStrategyStatus(k.split('_')[0], k.split('_')[1]) === 'research');
  const excluded = keys.filter(k => getStrategyStatus(k.split('_')[0], k.split('_')[1]) === 'excluded');

  const sep = '<span class="w-px h-5 bg-slate-700/50 mx-1"></span>';

  bar.innerHTML = `
    <div class="flex flex-wrap items-center gap-2">
      ${chip(!opsStrategy, "setStrategy('')", null, '<span class="font-bold">전체 전략</span>')}
      ${live.length ? sep : ''}
      ${live.map(k => chip(opsStrategy === k, `setStrategy('${k}')`, 'emerald', `⚡ ${k.replace('_',' ')}`)).join('')}
      ${research.length ? sep : ''}
      ${research.map(k => chip(opsStrategy === k, `setStrategy('${k}')`, 'sky', `🔬 ${k.replace('_',' ')}`)).join('')}
      ${excluded.length ? sep : ''}
      ${excluded.map(k => chip(opsStrategy === k, `setStrategy('${k}')`, 'slate', `⏸ ${k.replace('_',' ')}`)).join('')}
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


// ── Tailwind 테이블 공용 ──
const TABLE_CLS = 'min-w-full text-sm';
const THEAD_CLS = 'bg-slate-900/60 text-[11px] uppercase tracking-wider text-slate-500 font-semibold';
const TH_CLS = 'px-3 py-2.5 text-left whitespace-nowrap';
const TBODY_CLS = 'divide-y divide-slate-800/50';
const TR_CLS = 'hover:bg-slate-800/30 transition';
const TD_CLS = 'px-3 py-3 whitespace-nowrap';

// ── 1. 신호 후보 ──
function renderSignals() {
  const el = document.getElementById('ops-signals-content'); if (!el) return;
  const d = opsData.signals || {};
  const diag = diagnose(d);
  if (diag) { el.innerHTML = emptyState(diag, d.error); return; }
  let allItems = d.items || [];
  if (opsStrategy) allItems = allItems.filter(s => getStrategyKey(s.symbol, s.direction) === opsStrategy);
  if (!opsStrategy) allItems = allItems.filter(s => getStrategyStatus(s.symbol, s.direction, s) !== 'excluded');
  if (!allItems.length) {
    const msg = opsStrategy
      ? `${opsStrategy.replace('_',' ')} — 현재 발생한 신호가 없습니다.`
      : '신호 대기 중… score 65+ 달성 시 매매 후보로 자동 표시됩니다.';
    el.innerHTML = emptyState('noData', msg); return;
  }

  const cntCandidate = allItems.filter(s => (s.stage || 'candidate') === 'candidate' && s.direction !== 'no_trade').length;
  const cntReady = allItems.filter(s => s.stage === 'trade_ready').length;
  const cntNoTrade = allItems.filter(s => s.direction === 'no_trade').length;

  let stageFiltered = allItems;
  if (opsStageFilter === 'candidate') stageFiltered = allItems.filter(s => (s.stage || 'candidate') === 'candidate' && s.direction !== 'no_trade');
  else if (opsStageFilter === 'trade_ready') stageFiltered = allItems.filter(s => s.stage === 'trade_ready');
  else if (opsStageFilter === 'no_trade') stageFiltered = allItems.filter(s => s.direction === 'no_trade');

  const symbols = [...new Set(stageFiltered.map(s => s.symbol).filter(Boolean))].sort();
  const items = opsSignalFilter ? stageFiltered.filter(s => s.symbol === opsSignalFilter) : stageFiltered;

  const stageHtml = `
    <div class="flex flex-wrap gap-2 mb-3">
      ${chip(!opsStageFilter, "setStageFilter('')", null, `전체 (${allItems.length})`)}
      ${chip(opsStageFilter === 'candidate', "setStageFilter('candidate')", 'sky', `감시 (${cntCandidate})`)}
      ${chip(opsStageFilter === 'trade_ready', "setStageFilter('trade_ready')", 'violet', `매매 후보 (${cntReady})`)}
      ${chip(opsStageFilter === 'no_trade', "setStageFilter('no_trade')", 'slate', `제외 (${cntNoTrade})`)}
    </div>`;

  const symbolHtml = symbols.length > 1 ? `
    <div class="flex flex-wrap gap-2 mb-4">
      ${chip(!opsSignalFilter, "setSignalFilter('')", null, '전체 종목')}
      ${symbols.map(sym => chip(opsSignalFilter === sym, `setSignalFilter('${sym}')`, null, esc(sym))).join('')}
    </div>` : '';

  function renderFactors(s) {
    if (!s.factors || typeof s.factors !== 'object') return '<div class="text-xs text-slate-600">분석 팩터 없음</div>';
    const labels = { trend:'추세', rsi:'RSI', timing:'진입 타이밍', volume:'거래량', riskReward:'R:R' };
    return `<div class="grid gap-2" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));">
      ${Object.entries(s.factors).map(([k,v]) => {
        const val = typeof v === 'object' && v !== null ? v : { value: v };
        const sc = val.score || 0;
        const scoreColor = sc >= 7 ? 'emerald' : sc >= 4 ? 'amber' : 'rose';
        return `<div class="rounded-lg border border-slate-700/50 bg-slate-800/40 px-3 py-2">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">${esc(labels[k] || k)}</div>
          <div class="text-sm font-bold text-slate-100">${esc(String(val.value != null ? val.value : '-'))}</div>
          ${val.score != null ? `<div class="text-[10px] text-${scoreColor}-400">점수 ${val.score}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  }

  function reasonCell(s) {
    let html = `<span class="text-slate-400 text-xs">${esc(s.scoreReason || '')}</span>`;
    if (s.direction === 'no_trade' && s.noTradeReason) {
      html += `<div class="mt-1 text-[11px] text-rose-400 border-l-2 border-rose-500/60 pl-2">제외: ${esc(s.noTradeReason)}</div>`;
    }
    return html;
  }

  if (!items.length) {
    const stageLabel = { candidate:'감시 후보', trade_ready:'매매 후보', no_trade:'제외' }[opsStageFilter] || '';
    el.innerHTML = stageHtml + symbolHtml + emptyState('noData', stageLabel ? `현재 ${stageLabel} 신호가 없습니다.` : '필터에 해당하는 신호가 없습니다.');
    return;
  }

  el.innerHTML = stageHtml + symbolHtml + `
    <div class="overflow-x-auto rounded-xl border border-slate-800/60 bg-slate-900/30">
      <table class="${TABLE_CLS}">
        <thead class="${THEAD_CLS}"><tr>
          <th class="${TH_CLS}">종목</th><th class="${TH_CLS}">단계</th><th class="${TH_CLS}">점수</th>
          <th class="${TH_CLS}">사유</th><th class="${TH_CLS}">진입가</th><th class="${TH_CLS}">손절</th>
          <th class="${TH_CLS}">방향</th><th class="${TH_CLS}">상태</th><th class="${TH_CLS}">생성</th>
        </tr></thead>
        <tbody class="${TBODY_CLS}">
          ${items.map((s, idx) => {
            const scoreColor = s.score >= 70 ? 'text-emerald-400' : s.score >= 40 ? 'text-amber-400' : 'text-rose-400';
            const isNoTrade = s.direction === 'no_trade';
            const sid = String(s.signalId || s.id || idx).replace(/[^a-zA-Z0-9_-]/g, '_');
            const sStatus = getStrategyStatus(s.symbol, s.direction, s);
            const rowCls = isNoTrade ? 'opacity-50 hover:bg-slate-800/30 cursor-pointer' : 'hover:bg-slate-800/30 cursor-pointer';
            return `<tr class="${rowCls}" onclick="toggleFactors('${sid}')">
              <td class="${TD_CLS}">
                <div class="font-bold text-slate-100 flex items-center gap-1">${esc(s.symbol)} <span class="text-xs text-slate-600">▾</span></div>
                <div class="mt-1">${strategyBadge(sStatus)}</div>
              </td>
              <td class="${TD_CLS}"><div>${stageBadge(s.stage || 'candidate')}</div><div class="mt-1">${actionBadge(sStatus)}</div></td>
              <td class="${TD_CLS}"><span class="${scoreColor} font-bold text-base">${s.score}</span></td>
              <td class="${TD_CLS} max-w-[240px] whitespace-normal">${reasonCell(s)}</td>
              <td class="${TD_CLS} text-slate-300">${isNoTrade ? '-' : fmtKRW(s.entryPrice)}</td>
              <td class="${TD_CLS} text-slate-300">${isNoTrade ? '-' : fmtKRW(s.stopLoss)}</td>
              <td class="${TD_CLS}">${directionBadge(s.direction)}</td>
              <td class="${TD_CLS}">${itemStatusBadge(s.status)}</td>
              <td class="${TD_CLS} text-xs text-slate-500">${fmtRel(s.created_at)}</td>
            </tr>
            <tr id="factors-${sid}" style="display:none;" class="bg-slate-900/50">
              <td colspan="9" class="px-4 py-3">${renderFactors(s)}</td>
            </tr>`;
          }).join('')}
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
      : '열린 포지션 없음. score 65+ 달성 시 자동 진입됩니다.';
    el.innerHTML = emptyState('noData', msg); return;
  }
  el.innerHTML = `
    <div class="overflow-x-auto rounded-xl border border-slate-800/60 bg-slate-900/30">
      <table class="${TABLE_CLS}">
        <thead class="${THEAD_CLS}"><tr>
          <th class="${TH_CLS}">종목</th><th class="${TH_CLS}">방향</th><th class="${TH_CLS}">진입가</th>
          <th class="${TH_CLS}">현재가</th><th class="${TH_CLS}">손익</th>
          <th class="${TH_CLS}">최대유리</th><th class="${TH_CLS}">최대불리</th>
          <th class="${TH_CLS}">보유</th><th class="${TH_CLS}">상태</th>
          <th class="${TH_CLS}">진입</th><th class="${TH_CLS}">갱신</th>
        </tr></thead>
        <tbody class="${TBODY_CLS}">
          ${items.map(t => `<tr class="${TR_CLS}">
            <td class="${TD_CLS}">
              <div class="font-bold text-slate-100">${esc(t.symbol)}</div>
              <div class="mt-1">${strategyBadge(getStrategyStatus(t.symbol, t.direction, t))}</div>
            </td>
            <td class="${TD_CLS}">${directionBadge(t.direction)}</td>
            <td class="${TD_CLS} text-slate-300">${fmtKRW(t.entryPrice)}</td>
            <td class="${TD_CLS} text-slate-100 font-semibold">${fmtKRW(t.currentPrice)}</td>
            <td class="${TD_CLS}"><span class="${pnlColor(t.pnlPercent)} font-bold text-base">${fmtPct(t.pnlPercent)}</span></td>
            <td class="${TD_CLS} text-emerald-400 text-xs">${fmtPct(t.maxFavorable)}</td>
            <td class="${TD_CLS} text-rose-400 text-xs">${fmtPct(t.maxAdverse)}</td>
            <td class="${TD_CLS} text-slate-300">${fmtHold(t.holdTimeMin)}</td>
            <td class="${TD_CLS}">${itemStatusBadge(t.status)}</td>
            <td class="${TD_CLS} text-xs text-slate-500">${fmtRel(t.created_at)}</td>
            <td class="${TD_CLS} text-xs text-sky-400">${fmtRel(t.updated_at)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── 3. 종료 결과 ──
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
      : '종료된 실전 거래가 없습니다.';
    el.innerHTML = emptyState('noData', msg); return;
  }

  const wins = allItems.filter(r => r.result === 'win').length;
  const losses = allItems.filter(r => r.result === 'loss').length;
  const longs = allItems.filter(r => (r.direction || 'long') === 'long').length;
  const shorts = allItems.filter(r => r.direction === 'short').length;
  const liveCnt = allItems.filter(r => (r.source || 'n8n') !== 'backtest').length;
  const btCnt = allItems.filter(r => r.source === 'backtest').length;

  let filtered = allItems;
  if (opsResultSource) filtered = filtered.filter(r => (r.source || 'n8n') === opsResultSource);
  if (opsResultFilter) filtered = filtered.filter(r => r.result === opsResultFilter);
  if (opsResultDirFilter) filtered = filtered.filter(r => (opsResultDirFilter === 'long' ? (r.direction || 'long') === 'long' : r.direction === opsResultDirFilter));

  const sep = '<span class="w-px h-5 bg-slate-700/50 mx-1"></span>';
  const filterHtml = `
    <div class="flex flex-wrap items-center gap-2 mb-4">
      ${chip(!opsResultSource, "setResultSource('')", null, `전체 (${allItems.length})`)}
      ${chip(opsResultSource === 'n8n', "setResultSource('n8n')", 'sky', `실전 (${liveCnt})`)}
      ${chip(opsResultSource === 'backtest', "setResultSource('backtest')", 'amber', `백테스트 (${btCnt})`)}
      ${sep}
      ${chip(!opsResultFilter, "setResultFilter('')", null, 'W/L')}
      ${chip(opsResultFilter === 'win', "setResultFilter('win')", 'emerald', `W (${wins})`)}
      ${chip(opsResultFilter === 'loss', "setResultFilter('loss')", 'rose', `L (${losses})`)}
      ${sep}
      ${chip(!opsResultDirFilter, "setResultDirFilter('')", null, '방향')}
      ${chip(opsResultDirFilter === 'long', "setResultDirFilter('long')", 'emerald', `Long (${longs})`)}
      ${chip(opsResultDirFilter === 'short', "setResultDirFilter('short')", 'rose', `Short (${shorts})`)}
    </div>`;

  if (!filtered.length) {
    el.innerHTML = filterHtml + emptyState('noData', '필터에 해당하는 결과가 없습니다.');
    return;
  }

  el.innerHTML = filterHtml + `
    <div class="overflow-x-auto rounded-xl border border-slate-800/60 bg-slate-900/30">
      <table class="${TABLE_CLS}">
        <thead class="${THEAD_CLS}"><tr>
          <th class="${TH_CLS}"></th><th class="${TH_CLS}">종목</th><th class="${TH_CLS}">방향</th>
          <th class="${TH_CLS}">손익</th><th class="${TH_CLS}">최대유리</th><th class="${TH_CLS}">최대불리</th>
          <th class="${TH_CLS}">보유</th><th class="${TH_CLS}">종료 사유</th>
          <th class="${TH_CLS}">진입가</th><th class="${TH_CLS}">종료가</th><th class="${TH_CLS}">시각</th>
        </tr></thead>
        <tbody class="${TBODY_CLS}">
          ${filtered.map(r => {
            const isBT = r.source === 'backtest';
            return `<tr class="${TR_CLS} ${isBT ? 'opacity-80' : ''}">
              <td class="${TD_CLS}">${resultBadge(r.result)}${isBT ? ' <span class="ml-1 text-[9px] font-bold text-amber-400">BT</span>' : ''}</td>
              <td class="${TD_CLS} font-bold text-slate-100">${esc(r.symbol)}${r.confidence ? ` <span class="ml-1 text-[10px] text-slate-500">${r.confidence}</span>` : ''}</td>
              <td class="${TD_CLS}">${directionBadge(r.direction)}</td>
              <td class="${TD_CLS}"><span class="${pnlColor(r.pnlPercent)} font-bold text-base">${fmtPct(r.pnlPercent)}</span></td>
              <td class="${TD_CLS} text-emerald-400 text-xs">${r.maxFavorable ? fmtPct(r.maxFavorable) : '-'}</td>
              <td class="${TD_CLS} text-rose-400 text-xs">${r.maxAdverse ? fmtPct(r.maxAdverse) : '-'}</td>
              <td class="${TD_CLS} text-xs text-slate-400">${r.holdTimeMin ? fmtHold(r.holdTimeMin) : '-'}</td>
              <td class="${TD_CLS} text-xs text-slate-400">${esc(r.exitReason)}</td>
              <td class="${TD_CLS} text-slate-300">${fmtKRW(r.entryPrice)}</td>
              <td class="${TD_CLS} text-slate-300">${fmtKRW(r.exitPrice)}</td>
              <td class="${TD_CLS} text-xs text-slate-500">${fmtRel(r.exitAt || r.created_at)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── 4a. 종목 비교 테이블 ──
function renderSymbolCompare() {
  const el = document.getElementById('ops-symbol-compare'); if (!el) return;
  const d = opsData.bySymbol || {};
  if (d.error) {
    console.warn('[by-symbol] fetch error:', d.error);
    el.innerHTML = ''; return;
  }
  const items = d.items || [];
  if (!items.length) {
    el.innerHTML = `<div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4 text-sm text-slate-500">종목별 비교 데이터가 없습니다.</div>`;
    return;
  }
  const verdictChip = (v) => {
    const map = { '검토 가능': 'emerald', '경계': 'amber', '보류': 'rose' };
    const color = map[v] || 'slate';
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-${color}-500/10 text-${color}-400 border border-${color}-500/30">${esc(v || '—')}</span>`;
  };
  el.innerHTML = `
    <div class="rounded-xl border border-slate-800/60 bg-slate-900/30 overflow-x-auto">
      <table class="${TABLE_CLS}">
        <thead class="${THEAD_CLS}"><tr>
          <th class="${TH_CLS}">종목</th><th class="${TH_CLS}">방향</th><th class="${TH_CLS}">승률</th>
          <th class="${TH_CLS}">기대값</th><th class="${TH_CLS}">최대낙폭</th><th class="${TH_CLS}">건수</th>
          <th class="${TH_CLS}">판정</th>
        </tr></thead>
        <tbody class="${TBODY_CLS}">
          ${items.map(r => {
            const isEmpty = !r.total || r.total === 0;
            const rowCls = isEmpty ? 'opacity-50' : TR_CLS;
            const wrColor = (r.winRate || 0) >= 0.4 ? 'text-emerald-400' : 'text-rose-400';
            const expColor = (r.expectation || 0) > 0 ? 'text-emerald-400' : (r.expectation || 0) < 0 ? 'text-rose-400' : 'text-slate-400';
            return `<tr class="${rowCls}">
              <td class="${TD_CLS} font-bold text-slate-100">${esc(r.symbol || '—')}</td>
              <td class="${TD_CLS}">${r.direction ? directionBadge(r.direction) : '<span class="text-slate-600">—</span>'}</td>
              <td class="${TD_CLS} ${wrColor}">${isEmpty ? '—' : ((r.winRate || 0) * 100).toFixed(0) + '%'}</td>
              <td class="${TD_CLS} ${expColor}">${isEmpty ? '—' : ((r.expectation || 0) >= 0 ? '+' : '') + (r.expectation || 0).toFixed(2) + '%'}</td>
              <td class="${TD_CLS} text-rose-400">${isEmpty ? '—' : (r.maxDrawdownPct || 0).toFixed(1) + '%'}</td>
              <td class="${TD_CLS} text-slate-300">${isEmpty ? '<span class="text-slate-600">(new)</span>' : r.total}</td>
              <td class="${TD_CLS}">${isEmpty ? '<span class="text-slate-600">—</span>' : verdictChip(r.verdict)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── 4b. 누적 PnL 차트 ──
function renderPnlChart() {
  const wrap = document.getElementById('ops-pnl-chart-wrap'); if (!wrap) return;
  // destroy previous chart instance
  if (_pnlChartInstance) { _pnlChartInstance.destroy(); _pnlChartInstance = null; }

  const d = opsData.pnlSeries || {};
  if (d.error) {
    console.warn('[pnl-series] fetch error:', d.error);
    wrap.innerHTML = ''; return;
  }
  const series = d.series || [];

  // symbol filter chips
  const symbols = [...new Set(series.map(s => s.symbol).filter(Boolean))].sort();
  const filterHtml = symbols.length > 1 ? `
    <div class="flex flex-wrap gap-2 mb-3">
      ${chip(!opsPnlSymbol, "setPnlSymbolFilter('')", null, '전체')}
      ${symbols.map(sym => chip(opsPnlSymbol === sym, `setPnlSymbolFilter('${sym}')`, null, esc(sym))).join('')}
    </div>` : '';

  if (!series.length) {
    wrap.innerHTML = filterHtml + `<div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4 text-sm text-slate-500">거래 내역이 없습니다.</div>`;
    return;
  }

  wrap.innerHTML = filterHtml + `
    <div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
      <div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">누적 PnL</div>
      <div style="position:relative;height:220px;"><canvas id="ops-pnl-canvas"></canvas></div>
    </div>`;

  const canvas = document.getElementById('ops-pnl-canvas');
  if (!canvas || typeof Chart === 'undefined') { console.warn('[pnl-chart] Chart.js 미로드'); return; }

  const labels = series.map(s => s.date || '');
  const data = series.map(s => s.cumulativePnlPct);

  // gradient fill: green above zero, red below
  const ctx = canvas.getContext('2d');

  _pnlChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: '#94a3b8',
        borderWidth: 1.5,
        pointRadius: 2,
        pointHoverRadius: 5,
        pointBackgroundColor: series.map(s => s.result === 'win' ? '#34d399' : '#f87171'),
        fill: {
          target: 'origin',
          above: 'rgba(52,211,153,0.08)',
          below: 'rgba(248,113,113,0.08)',
        },
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0]?.dataIndex;
              if (i == null) return '';
              const s = series[i];
              return s.date || '';
            },
            label: (item) => {
              const s = series[item.dataIndex];
              if (!s) return '';
              return `${s.symbol || ''} ${s.result === 'win' ? 'W' : 'L'} ${(s.pnlPct || 0) >= 0 ? '+' : ''}${(s.pnlPct || 0).toFixed(2)}% (누적 ${(s.cumulativePnlPct || 0).toFixed(2)}%)`;
            },
          },
          backgroundColor: '#1e293b',
          titleColor: '#e2e8f0',
          bodyColor: '#cbd5e1',
          borderColor: '#334155',
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          ticks: { color: '#475569', font: { size: 10 }, maxTicksLimit: 12 },
          grid: { color: 'rgba(51,65,85,0.3)' },
        },
        y: {
          ticks: { color: '#475569', font: { size: 10 }, callback: (v) => v.toFixed(1) + '%' },
          grid: { color: 'rgba(51,65,85,0.3)' },
        },
      },
    },
  });
}

// ── 4c. 전략 설정 (engine-config) ──
function renderEngineConfig() {
  const el = document.getElementById('ops-engine-config'); if (!el) return;
  // lazy load — only fetch when config tab is visible
  const pane = document.getElementById('ops-pane-config');
  if (!pane || !pane.classList.contains('active')) return;
  _loadEngineConfig();
}

async function _loadEngineConfig() {
  const el = document.getElementById('ops-engine-config'); if (!el) return;
  try {
    const hdrs = await authHeaders();
    const r = await fetch('/api/coin/engine-config', { headers: hdrs });
    if (r.status === 403) { el.innerHTML = '<div class="text-sm text-rose-400">권한이 없습니다 (admin only).</div>'; return; }
    const d = await r.json();
    if (!d.ok) { el.innerHTML = `<div class="text-sm text-rose-400">${esc(d.error || 'engine-config 로드 실패')}</div>`; return; }
    _renderEngineConfigUI(d.config || {});
  } catch (e) {
    console.warn('[engine-config] fetch error:', e);
    el.innerHTML = '<div class="text-sm text-slate-500">전략 설정 로드 실패</div>';
  }
}

function _renderEngineConfigUI(config) {
  const el = document.getElementById('ops-engine-config'); if (!el) return;
  const symbols = config.symbols || {};
  const entries = Object.entries(symbols);
  _engineConfigNewRows = 0;

  const statusOpts = (cur) => ['live', 'research', 'excluded'].map(s =>
    `<option value="${s}" ${s === cur ? 'selected' : ''}>${s}</option>`
  ).join('');

  const statusColor = (s) => ({ live: 'emerald', research: 'amber', excluded: 'slate' })[s] || 'slate';

  const row = (sym, cfg, idx) => `
    <tr class="${TR_CLS}" data-cfg-sym="${esc(sym)}">
      <td class="${TD_CLS} font-bold text-slate-100">${esc(sym)}</td>
      <td class="${TD_CLS}">
        <select id="cfg-status-${idx}" data-cfg-field="status" class="rounded-md border border-slate-700 bg-slate-900 text-xs px-2 py-1 text-${statusColor(cfg.status)}-400">
          ${statusOpts(cfg.status)}
        </select>
      </td>
      <td class="${TD_CLS}"><input id="cfg-cutoff-${idx}" data-cfg-field="cutoff" type="number" min="0" max="100" value="${cfg.cutoff ?? ''}" class="w-14 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1 text-center"></td>
      <td class="${TD_CLS}"><input id="cfg-target-${idx}" data-cfg-field="targetPct" type="number" min="0.1" max="10" step="0.1" value="${cfg.targetPct ?? ''}" class="w-16 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1 text-center"></td>
      <td class="${TD_CLS}"><input id="cfg-minrr-${idx}" data-cfg-field="minRR" type="number" min="0.5" max="5" step="0.1" value="${cfg.minRR ?? ''}" class="w-16 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1 text-center"></td>
    </tr>`;

  el.innerHTML = `
    <div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
      <div class="flex items-center justify-between mb-3">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">종목별 전략 설정</div>
        ${config.updated_at ? `<span class="text-[10px] text-slate-600">갱신 ${esc(new Date(config.updated_at).toLocaleString('ko-KR'))}</span>` : ''}
      </div>
      <div class="overflow-x-auto rounded-xl border border-slate-800/60 bg-slate-900/30">
        <table class="${TABLE_CLS}">
          <thead class="${THEAD_CLS}"><tr>
            <th class="${TH_CLS}">종목</th><th class="${TH_CLS}">상태</th><th class="${TH_CLS}">Cutoff</th>
            <th class="${TH_CLS}">Target%</th><th class="${TH_CLS}">MinRR</th>
          </tr></thead>
          <tbody id="cfg-tbody" class="${TBODY_CLS}">
            ${entries.map(([sym, cfg], i) => row(sym, cfg, i)).join('')}
          </tbody>
        </table>
      </div>
      <div class="flex items-center gap-3 mt-3">
        <button onclick="addEngineConfigRow()" class="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-400 text-xs hover:bg-slate-800 transition">+ 종목 추가</button>
        <button onclick="saveEngineConfig()" id="cfg-save-btn" class="px-4 py-1.5 rounded-lg border border-violet-500/40 bg-violet-500/15 text-violet-300 text-xs font-semibold hover:bg-violet-500/25 transition">저장</button>
        <span id="cfg-save-msg" class="text-xs"></span>
      </div>
    </div>`;
}

function addEngineConfigRow() {
  const tbody = document.getElementById('cfg-tbody'); if (!tbody) return;
  _engineConfigNewRows++;
  const idx = 'new' + _engineConfigNewRows;
  const tr = document.createElement('tr');
  tr.className = TR_CLS;
  tr.dataset.cfgSym = '';
  tr.dataset.cfgNew = '1';
  tr.id = 'cfg-new-row-' + _engineConfigNewRows;
  tr.innerHTML = `
    <td class="${TD_CLS}"><input id="cfg-sym-${idx}" data-cfg-field="symbol" type="text" placeholder="BTC" class="w-16 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1 text-center uppercase"></td>
    <td class="${TD_CLS}">
      <select id="cfg-status-${idx}" data-cfg-field="status" class="rounded-md border border-slate-700 bg-slate-900 text-xs px-2 py-1 text-amber-400">
        <option value="research" selected>research</option><option value="live">live</option><option value="excluded">excluded</option>
      </select>
    </td>
    <td class="${TD_CLS}"><input id="cfg-cutoff-${idx}" data-cfg-field="cutoff" type="number" min="0" max="100" value="60" class="w-14 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1 text-center"></td>
    <td class="${TD_CLS}"><input id="cfg-target-${idx}" data-cfg-field="targetPct" type="number" min="0.1" max="10" step="0.1" value="1.5" class="w-16 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1 text-center"></td>
    <td class="${TD_CLS}">
      <div class="flex items-center gap-1">
        <input id="cfg-minrr-${idx}" data-cfg-field="minRR" type="number" min="0.5" max="5" step="0.1" value="1.5" class="w-16 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1 text-center">
        <button onclick="removeEngineConfigNewRow(${_engineConfigNewRows})" class="text-rose-400 hover:text-rose-300 text-xs px-1">✕</button>
      </div>
    </td>`;
  tbody.appendChild(tr);
}

function removeEngineConfigNewRow(n) {
  const row = document.getElementById('cfg-new-row-' + n);
  if (row) row.remove();
}

async function saveEngineConfig() {
  const btn = document.getElementById('cfg-save-btn');
  const msg = document.getElementById('cfg-save-msg');
  if (!btn) return;
  btn.disabled = true; btn.style.opacity = '0.5';
  if (msg) { msg.style.color = '#94a3b8'; msg.textContent = '저장 중...'; }

  const tbody = document.getElementById('cfg-tbody');
  if (!tbody) return;
  const payload = {};
  const rows = tbody.querySelectorAll('tr');
  let valid = true;

  rows.forEach(tr => {
    const isNew = tr.dataset.cfgNew === '1';
    const symInput = tr.querySelector('[data-cfg-field="symbol"]');
    const sym = isNew ? (symInput?.value || '').trim().toUpperCase() : tr.dataset.cfgSym;
    if (!sym) { if (isNew) valid = false; return; }

    const statusEl = tr.querySelector('[data-cfg-field="status"]');
    const cutoffEl = tr.querySelector('[data-cfg-field="cutoff"]');
    const targetEl = tr.querySelector('[data-cfg-field="targetPct"]');
    const minrrEl = tr.querySelector('[data-cfg-field="minRR"]');

    const entry = {};
    if (statusEl) entry.status = statusEl.value;
    if (cutoffEl && cutoffEl.value !== '') {
      const v = parseInt(cutoffEl.value);
      if (v < 0 || v > 100) { valid = false; return; }
      entry.cutoff = v;
    }
    if (targetEl && targetEl.value !== '') {
      const v = parseFloat(targetEl.value);
      if (v < 0.1 || v > 10) { valid = false; return; }
      entry.targetPct = v;
    }
    if (minrrEl && minrrEl.value !== '') {
      const v = parseFloat(minrrEl.value);
      if (v < 0.5 || v > 5) { valid = false; return; }
      entry.minRR = v;
    }
    if (Object.keys(entry).length) payload[sym] = entry;
  });

  if (!valid) {
    if (msg) { msg.style.color = '#f87171'; msg.textContent = '입력값 범위를 확인하세요 (cutoff 0~100, target 0.1~10, minRR 0.5~5)'; }
    btn.disabled = false; btn.style.opacity = '1'; return;
  }

  if (!Object.keys(payload).length) {
    if (msg) { msg.style.color = '#fbbf24'; msg.textContent = '변경 사항 없음'; }
    btn.disabled = false; btn.style.opacity = '1'; return;
  }

  try {
    const hdrs = await authHeaders();
    hdrs['Content-Type'] = 'application/json';
    const r = await fetch('/api/coin/engine-config', { method: 'POST', headers: hdrs, body: JSON.stringify({ symbols: payload }) });
    const d = await r.json();
    if (d.ok) {
      if (msg) { msg.style.color = '#34d399'; msg.textContent = '저장 완료'; }
      _renderEngineConfigUI(d.config || {});
    } else {
      if (msg) { msg.style.color = '#f87171'; msg.textContent = d.error || '저장 실패'; }
    }
  } catch (e) {
    if (msg) { msg.style.color = '#f87171'; msg.textContent = '네트워크 오류'; }
  }
  btn.disabled = false; btn.style.opacity = '1';
  setTimeout(() => { if (msg) msg.textContent = ''; }, 5000);
}

// ── 4. 성과 요약 ──
function renderPerf() {
  const el = document.getElementById('ops-perf-content'); if (!el) return;
  const d = opsData.perf || {};
  const diag = diagnose(d);
  if (diag) { el.innerHTML = emptyState(diag, d.error); return; }

  const isBt = opsPerfSource === 'backtest';
  const sep = '<span class="w-px h-5 bg-slate-700/50 mx-1"></span>';
  const sourceChipHtml = `
    <div class="flex flex-wrap items-center gap-2 mb-4">
      ${chip(!opsPerfSource, "setPerfSource('')", null, '전체')}
      ${chip(opsPerfSource === 'n8n', "setPerfSource('n8n')", 'sky', '실전 (live)')}
      ${chip(isBt, "setPerfSource('backtest')", 'amber', '백테스트')}
      ${isBt ? sep +
        chip(opsBtPeriod === '', "setBtPeriod('')", null, '전체 기간') +
        chip(opsBtPeriod === '1m', "setBtPeriod('1m')", null, '1개월') +
        chip(opsBtPeriod === '3m', "setBtPeriod('3m')", null, '3개월') +
        chip(opsBtPeriod === '6m', "setBtPeriod('6m')", null, '6개월')
       : ''}
    </div>`;

  let modeBanner = '';
  if (isBt) {
    modeBanner = `
      <div class="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-300">
        🟠 백테스트 성과 — 과거 시뮬레이션이며 실전 결과가 아닙니다
      </div>
      <div class="mb-4 rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
        <div class="flex items-center justify-between mb-3">
          <div class="text-xs font-semibold text-slate-400">백테스트 실행</div>
          <label class="flex items-center gap-2 text-[11px] text-slate-500 cursor-pointer">
            <span>Sweep 모드</span>
            <input id="bt-sweep-toggle" type="checkbox" onchange="toggleSweepMode()" class="rounded border-slate-600 bg-slate-800">
          </label>
        </div>
        <div class="flex flex-wrap items-end gap-3 mb-3">
          <label class="text-[11px] text-slate-500">코인
            <select id="bt-market" class="block mt-1 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1.5">
              <option value="KRW-BTC">BTC</option><option value="KRW-ETH">ETH</option><option value="KRW-XRP">XRP</option>
              <option value="KRW-ETC">ETC</option><option value="KRW-TRX">TRX</option><option value="KRW-DOGE">DOGE</option>
            </select>
          </label>
          <label class="text-[11px] text-slate-500">시작일
            <input id="bt-start" type="date" class="block mt-1 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1.5">
          </label>
          <label class="text-[11px] text-slate-500">종료일
            <input id="bt-end" type="date" class="block mt-1 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1.5">
          </label>
        </div>
        <div id="bt-single-mode" class="flex flex-wrap items-end gap-3">
          <label class="text-[11px] text-slate-500">진입 기준
            <input id="bt-cutoff" type="number" value="60" min="0" max="100" class="block mt-1 w-16 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1.5">
          </label>
          <button id="bt-run-btn" onclick="runBacktest()" class="px-4 py-1.5 rounded-lg border border-amber-500/50 bg-amber-500/20 text-amber-300 text-xs font-semibold hover:bg-amber-500/30 transition">실행</button>
          <span id="bt-run-msg" class="text-xs"></span>
        </div>
        <div id="bt-sweep-mode" class="flex flex-wrap items-end gap-3" style="display:none;">
          <label class="text-[11px] text-slate-500">Cutoff 목록 (콤마 구분)
            <input id="bt-sweep-cutoffs" type="text" placeholder="50,55,60,65" class="block mt-1 w-48 rounded-md border border-slate-700 bg-slate-900 text-slate-200 text-xs px-2 py-1.5">
          </label>
          <button id="bt-sweep-btn" onclick="runSweep()" class="px-4 py-1.5 rounded-lg border border-violet-500/50 bg-violet-500/20 text-violet-300 text-xs font-semibold hover:bg-violet-500/30 transition">Sweep 실행</button>
          <span id="bt-sweep-msg" class="text-xs"></span>
        </div>
      </div>`;
  } else if (opsPerfSource === 'n8n') {
    modeBanner = `<div class="mb-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-sm text-sky-300">🟢 실전 성과 — 실제 거래 기반</div>`;
  }

  if (opsStrategy) {
    const sKey = opsStrategy;
    const sStatus = STRATEGY_STATUS[sKey] || 'research';
    modeBanner += `<div class="mb-3 flex items-center gap-2 rounded-xl border border-slate-700/50 bg-slate-800/40 px-4 py-2 text-sm">
      ${strategyBadge(sStatus)} <span class="text-slate-100 font-semibold">${sKey.replace('_',' ')}</span> <span class="text-slate-500">전략 성과</span>
    </div>`;
  }

  if (!d.total) {
    const stratLabel = opsStrategy ? opsStrategy.replace('_', ' ') + ' — ' : '';
    const msg = isBt
      ? `${stratLabel}백테스트 결과가 없습니다. 위 실행 폼에서 백테스트를 돌려보세요.`
      : opsPerfSource === 'n8n'
        ? `${stratLabel}실전 거래 결과가 없습니다.`
        : `${stratLabel}거래 결과가 쌓이면 자동으로 성과가 계산됩니다.`;
    el.innerHTML = sourceChipHtml + modeBanner + emptyState('noData', msg); return;
  }
  const p = d;
  const safeRatio = (v) => (v == null || !isFinite(v)) ? '0' : String(v);

  // 실전 검토 판정
  let verdict, verdictColor, verdictDesc;
  if (p.total < 10) {
    verdict = '판단 보류'; verdictColor = 'slate';
    verdictDesc = `검증 데이터 축적 중 (${p.total}/10건) — 10건 이상 쌓여야 판정 가능`;
  } else if (p.expectation > 0 && p.winRate >= 0.4 && p.maxConsecutiveLoss <= 5 && p.maxDrawdownPercent <= 15) {
    verdict = '검토 가능'; verdictColor = 'emerald';
    verdictDesc = '기대값 양수, 승률/낙폭 허용 범위 내';
  } else if (p.expectation <= 0 || p.maxDrawdownPercent > 20 || p.maxConsecutiveLoss > 7) {
    verdict = '보류'; verdictColor = 'rose';
    verdictDesc = p.expectation <= 0 ? '기대값이 음수입니다' : p.maxDrawdownPercent > 20 ? '최대낙폭 20% 초과' : '연속손실 7회 초과';
  } else {
    verdict = '경계'; verdictColor = 'amber';
    verdictDesc = '일부 지표가 경계 수준 — 추가 데이터 필요';
  }

  const toggleHtml = `
    <div class="flex items-center gap-2 mb-4">
      <span class="text-xs text-slate-500 mr-1">기준:</span>
      ${chip(opsPerfCount === 20, "setPerfCount(20)", null, '최근 20건')}
      ${chip(opsPerfCount === 50, "setPerfCount(50)", null, '최근 50건')}
    </div>`;

  const verdictCard = `
    <div class="rounded-xl border border-${verdictColor}-500/40 bg-${verdictColor}-500/10 p-4 md:col-span-2 lg:col-span-3">
      ${cardLabel('실전 검토 판정', verdictColor)}
      <div class="flex items-center gap-3 flex-wrap">
        <span class="inline-flex items-center rounded-lg px-4 py-1.5 text-sm font-bold bg-${verdictColor}-500/20 text-${verdictColor}-300 border border-${verdictColor}-500/50">${verdict}</span>
        <span class="text-sm text-slate-300">${verdictDesc}</span>
      </div>
      <div class="text-[11px] text-slate-500 mt-2">기준: 기대값 > 0, 승률 ≥ 40%, 연속손실 ≤ 5, 낙폭 ≤ 15%</div>
    </div>`;

  const statCard = (label, value, sub, color) => `
    <div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
      ${cardLabel(label)}
      <div class="text-2xl font-bold ${color || 'text-slate-100'}">${value}</div>
      <div class="text-xs text-slate-500 mt-1">${sub}</div>
    </div>`;

  const winRateColor = p.winRate >= 0.5 ? 'text-emerald-400' : 'text-rose-400';
  const expectColor = p.expectation > 0 ? 'text-emerald-400' : p.expectation < 0 ? 'text-rose-400' : 'text-slate-400';

  el.innerHTML = sourceChipHtml + modeBanner + toggleHtml + `
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      ${verdictCard}
      ${statCard('승률', `<span class="${winRateColor}">${(p.winRate * 100).toFixed(1)}%</span>`, `${p.wins}승 ${p.losses}패 / 최근 ${p.total}건`)}
      ${statCard('평균 손익비', safeRatio(p.avgPnlRatio), `평균 수익 ${fmtPct(p.avgWinPercent)} / 평균 손실 -${p.avgLossPercent || 0}%`)}
      ${statCard('기대값', `<span class="${expectColor}">${fmtPct(p.expectation)}</span>`, '건당 기대 수익률')}
      ${statCard('최대 연속손실', `<span class="text-rose-400">${p.maxConsecutiveLoss || 0}</span>`, '연속 패배 횟수')}
      ${statCard('최대낙폭', `<span class="text-rose-400">${p.maxDrawdownPercent || 0}%</span>`, '누적 PnL 고점 대비')}
    </div>`;

  // 방향별 성과
  const byDir = p.byDirection || {};
  const lp = byDir.long || {};
  const sp = byDir.short || {};
  if (lp.total > 0 || sp.total > 0) {
    const dirCard = (label, color, d) => `
      <div class="rounded-xl border border-${color}-500/30 bg-${color}-500/5 p-4">
        ${cardLabel(label, color)}
        <div class="text-2xl font-bold text-slate-100">${d.total}<span class="text-sm font-normal text-slate-500 ml-1">건</span></div>
        <div class="text-xs text-slate-400 mt-2">승률 ${((d.winRate||0)*100).toFixed(1)}% · ${d.wins||0}승 ${d.losses||0}패</div>
        <div class="text-xs text-slate-400">기대값 ${fmtPct(d.expectation||0)} · 손익비 ${d.avgPnlRatio||0}</div>
      </div>`;
    el.innerHTML += `
      <div class="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">방향별 성과</div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        ${lp.total > 0 ? dirCard('LONG', 'emerald', lp) : ''}
        ${sp.total > 0 ? dirCard('SHORT', 'rose', sp) : ''}
      </div>`;
  }
}

// ── Heartbeat 카드 (system-heartbeat-001 감시) ──
// 응답 shape: _workspace/api_shape_heartbeat.md
// 소비 필드: status, lastHeartbeatAt, ageSec(참고), recentCount1h, expectedPerHour, source, error
// 미사용 필드: thresholds.*, serverNow (클라이언트 보간 미구현 — ageSec 은 서버값만 표기)
function renderHeartbeatCard(hb) {
  // fetch 실패/누락 — placeholder + 콘솔 경고
  if (!hb || hb.error) {
    if (hb && hb.error) console.warn('[heartbeat] fetch error:', hb.error);
    else console.warn('[heartbeat] 응답 없음');
    return `
      <div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4 mb-4">
        ${cardLabel('💓 Heartbeat')}
        <div class="flex items-center gap-3 flex-wrap">
          ${_badge('slate', 'unknown')}
          <span class="text-sm text-slate-500">— (응답 없음${hb && hb.error ? ': ' + esc(hb.error) : ''})</span>
        </div>
      </div>`;
  }

  const status = hb.status || 'unknown';
  const last = hb.lastHeartbeatAt;
  const cnt = (typeof hb.recentCount1h === 'number') ? hb.recentCount1h : null;
  const expected = (typeof hb.expectedPerHour === 'number') ? hb.expectedPerHour : 60;
  const src = hb.source || 'system-heartbeat-001';

  // 필드 누락 경고
  if (last === undefined) console.warn('[heartbeat] lastHeartbeatAt 필드 누락');
  if (cnt === null) console.warn('[heartbeat] recentCount1h 필드 누락');

  // status → color (기존 팔레트 재사용, 작은 배지만 사용)
  const colorMap = { live: 'emerald', lagging: 'amber', stale: 'rose', unknown: 'slate' };
  const labelMap = { live: 'live', lagging: 'lagging', stale: 'stale', unknown: 'unknown' };
  const color = colorMap[status] || 'slate';
  const badge = _badge(color, labelMap[status] || status);

  // 마지막 수신: 상대시간 + 절대시각 툴팁
  let lastCell;
  if (last) {
    const absStr = new Date(last).toLocaleString('ko-KR');
    lastCell = `<span title="${esc(absStr)}">${fmtRel(last) || absStr}</span>`;
  } else {
    lastCell = '<span class="text-slate-600">—</span>';
  }

  // 1h 카운트 vs 기대치
  const cntCell = (cnt === null)
    ? '<span class="text-slate-600">—</span>'
    : `<span class="${cnt === 0 ? 'text-rose-400' : cnt < expected * 0.9 ? 'text-amber-400' : 'text-slate-300'}">${cnt}</span><span class="text-slate-500"> / ${expected}</span>`;

  return `
    <div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4 mb-4">
      ${cardLabel('💓 Heartbeat')}
      <div class="flex items-center gap-3 flex-wrap">
        ${badge}
        <span class="text-xs text-slate-500">${esc(src)}</span>
      </div>
      <div class="mt-2 text-xs text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
        <span>마지막 수신: ${lastCell}</span>
        <span>1h 수신: ${cntCell}</span>
      </div>
    </div>`;
}

// ── 5. 시스템 상태 ──
function renderSystem() {
  const el = document.getElementById('ops-system-content'); if (!el) return;
  const d = opsData.system || {};
  const diag = diagnose(d);
  if (diag) { el.innerHTML = emptyState(diag, d.error); return; }

  const sys = d.system;
  const bal = d.balance;
  const wfs = d.workflows || [];

  let html = '';

  // 시스템 상태 카드
  html += `
    <div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4 mb-4">
      ${cardLabel('시스템 상태')}
      <div class="flex items-center gap-3 flex-wrap">
        ${sys ? sysStatusBadge(sys.status) : sysStatusBadge('normal')}
        <span class="text-sm text-slate-300">${sys ? esc(sys.reason) : '상태 정보 없음 — kind=system_status 를 보내면 반영됩니다.'}</span>
      </div>
      ${sys && sys.lastSyncFailure ? `<div class="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"><strong>동기화 실패:</strong> ${esc(sys.lastSyncFailure)}</div>` : ''}
      ${sys && sys.lastCollectFailure ? `<div class="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"><strong>수집 실패:</strong> ${esc(sys.lastCollectFailure)}</div>` : ''}
      ${sys && sys.updated_at ? `<div class="text-[11px] text-slate-500 mt-2">마지막 상태 업데이트: ${fmtRel(sys.updated_at)}</div>` : ''}
    </div>`;

  // Heartbeat (system-heartbeat-001 감시) — 작은 카드 1개, 동등 가중
  html += renderHeartbeatCard(opsData.heartbeat);

  // 잔고 — 원가 + 평가
  if (bal) {
    const coinCost = Number(bal.totalCostKRW) || 0;
    const cash = Number(bal.cashKRW) || 0;
    const coinMarket = Number(bal.totalMarketValue) || 0;
    const hasMarket = coinMarket > 0;

    html += '<div class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">투입 원가 <span class="normal-case text-[10px] text-slate-600">(내가 넣은 돈)</span></div>';
    html += `<div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
      <div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
        ${cardLabel('💵 KRW 현금')}
        <div class="text-2xl font-bold text-slate-100">${fmtKRW(cash)}</div>
        <div class="text-xs text-slate-500 mt-1 flex items-center gap-1">매수 안 쓴 현금 · ${syncBadge(bal.syncStatus)}</div>
      </div>
      <div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
        ${cardLabel('📊 코인 매수 원가')}
        <div class="text-2xl font-bold text-slate-100">${fmtKRW(coinCost)}</div>
        <div class="text-xs text-slate-500 mt-1">매수 평균가 × 수량 · 종목 ${(bal.perCoin || []).length}개</div>
      </div>
      <div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
        ${cardLabel('🟰 투입 합계')}
        <div class="text-2xl font-bold text-slate-100">${fmtKRW(coinCost + cash)}</div>
        <div class="text-xs text-slate-500 mt-1">현금 + 매수 원가 (시세 아님)</div>
      </div>
    </div>`;

    if (hasMarket) {
      const totalEval = coinMarket + cash;
      const pnl = coinMarket - coinCost;
      const pnlPct = coinCost > 0 ? (pnl / coinCost * 100) : 0;
      const pnlClr = pnl > 0 ? 'emerald' : pnl < 0 ? 'rose' : 'slate';
      const pnlSign = pnl >= 0 ? '+' : '';

      html += '<div class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">현재 평가 <span class="normal-case text-[10px] text-slate-600">(지금 시세 기준)</span></div>';
      html += `<div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <div class="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
          ${cardLabel('💰 코인 평가액')}
          <div class="text-2xl font-bold text-slate-100">${fmtKRW(coinMarket)}</div>
          <div class="text-xs text-slate-500 mt-1">현재가 × 보유수량</div>
        </div>
        <div class="rounded-xl border border-violet-500/40 bg-violet-500/5 p-4">
          ${cardLabel('🟰 총 평가자산', 'violet')}
          <div class="text-2xl font-bold text-slate-100">${fmtKRW(totalEval)}</div>
          <div class="text-xs text-slate-500 mt-1">현금 + 코인 평가액 = 내 계좌 현재 가치</div>
        </div>
        <div class="rounded-xl border border-${pnlClr}-500/40 bg-${pnlClr}-500/10 p-4">
          ${cardLabel('📈 평가손익', pnlClr)}
          <div class="text-2xl font-bold text-${pnlClr}-400">${pnlSign}${fmtKRW(pnl)}</div>
          <div class="text-xs text-${pnlClr}-400 mt-1">${pnlSign}${pnlPct.toFixed(2)}% (코인 평가액 − 매수 원가)</div>
        </div>
      </div>`;
    }

    html += `
      <div class="flex items-center gap-3 flex-wrap mb-4 text-xs text-slate-500">
        <span>🏦 계좌 ${bal.accountCount || 0}개 · 마지막 수신 ${fmtRel(bal.created_at)}</span>
        <button id="bal-refresh-btn" onclick="refreshBalance()" class="px-3 py-1 rounded-lg border border-indigo-500/40 bg-indigo-500/10 text-indigo-300 text-xs hover:bg-indigo-500/20 transition">잔고 새로고침</button>
        <span id="bal-refresh-msg" class="text-xs"></span>
        ${!hasMarket ? '<span class="text-amber-400">⚠️ 현재가 미수신 — 위 숫자는 매수 원가이며 현재 시세가 아닙니다</span>' : ''}
        ${bal.errorType ? `<span class="text-rose-400">${esc(bal.errorType)}</span>` : ''}
      </div>`;
  } else {
    html += `<div class="mb-4">${emptyState('noData', 'balance webhook 대기 중')}</div>`;
  }

  // 워크플로
  html += '<div class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">워크플로 상태</div>';
  if (wfs.length) {
    const failed = wfs.filter(r => r.status === 'failed');
    if (failed.length) {
      html += `<div class="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300">
        <strong>${failed.length}개 워크플로 실패</strong>: ${failed.map(f => esc(f.workflow || '?')).join(', ')}
        ${failed[0].errorType ? ` (${esc(failed[0].errorType)})` : ''}
      </div>`;
    }
    html += '<div class="space-y-2">';
    html += wfs.map(r => {
      const dotColor = r.status==='ok' ? 'bg-emerald-400' : r.status==='failed' ? 'bg-rose-400' : 'bg-amber-400';
      return `
        <div class="flex items-start gap-3 rounded-lg border border-slate-700/50 bg-slate-800/40 px-4 py-3">
          <div class="w-2 h-2 ${dotColor} rounded-full mt-1.5"></div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-semibold text-slate-200">${esc(r.workflow || '(unknown)')}</span>
              ${syncBadge(r.status)}
              ${r.errorType ? `<span class="text-[11px] text-rose-400">${esc(r.errorType)}</span>` : ''}
            </div>
            <div class="text-[11px] text-slate-500 mt-1">
              마지막 실행 ${fmtRel(r.created_at)}
              ${r.durationMs != null ? ' · ' + r.durationMs + 'ms' : ''}
              ${r.eventCount ? ' · ' + r.eventCount + '건' : ''}
            </div>
          </div>
        </div>`;
    }).join('');
    html += '</div>';
  } else {
    html += emptyState('noData', '워크플로 실행 기록이 없습니다.');
  }

  el.innerHTML = html;
}
