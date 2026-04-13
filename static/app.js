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
        { id: 'stock-dashboard', label: '📊 대시보드', page: 'page-stock-ops', stockOpsPane: 'dashboard' },
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
     최저가 비교
  ═══════════════════════════════════════ */
  const qInput    = document.getElementById('queryInput');
  const searchBtn = document.getElementById('searchBtn');
  const pStatus   = document.getElementById('price-status');
  const pResults  = document.getElementById('price-results');
  const histWrap  = document.getElementById('historyWrap');

  let searchHistory = JSON.parse(localStorage.getItem('searchHistory') || '[]');
  renderHistory();

  qInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  function renderHistory() {
    histWrap.innerHTML = '';
    searchHistory.slice(0, 8).forEach(q => {
      const tag = document.createElement('span');
      tag.className = 'history-tag';
      tag.textContent = q;
      tag.onclick = () => { qInput.value = q; doSearch(); };
      histWrap.appendChild(tag);
    });
  }

  function saveHistory(q) {
    searchHistory = [q, ...searchHistory.filter(h => h !== q)].slice(0, 8);
    localStorage.setItem('searchHistory', JSON.stringify(searchHistory));
    renderHistory();
  }

  async function doSearch() {
    const query = qInput.value.trim();
    if (!query) { qInput.focus(); return; }
    searchBtn.disabled = true;
    pStatus.innerHTML = '<span class="spinner"></span> 네이버 · 다나와 동시 조회 중...';
    pResults.innerHTML = '';
    try {
      const res  = await fetch('/search', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({query}) });
      const data = await res.json();
      pStatus.innerHTML = '';
      if (data.error) { pResults.innerHTML = `<div class="error-box">${data.error}</div>`; return; }
      saveHistory(query);
      renderPriceResults(data);
    } catch (e) {
      pStatus.innerHTML = '';
      pResults.innerHTML = `<div class="error-box">서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.</div>`;
    } finally {
      searchBtn.disabled = false;
    }
  }

  function fmt(n) { return Number(n).toLocaleString('ko-KR'); }
  function sourceLabel(s) {
    if (s === '네이버쇼핑') return {cls:'source-naver', icon:'🟢', text:'네이버쇼핑'};
    if (s === '다나와')     return {cls:'source-danawa', icon:'🔴', text:'다나와'};
    return {cls:'', icon:'⚪', text:s};
  }
  function rankCls(i) { return ['rank-1','rank-2','rank-3'][i] ?? 'rank-3'; }
  function rankIcon(i) { return ['🥇','🥈','🥉'][i] ?? (i+1); }
  function imgHtml(r) {
    if (r.image) return `<img class="card-img" src="${r.image}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'card-img-placeholder',textContent:'🛒'}))">`;
    return `<div class="card-img-placeholder">🛒</div>`;
  }

  function renderPriceResults({query, results}) {
    if (!results || results.length === 0) { pResults.innerHTML = `<div class="error-box">검색 결과가 없습니다.</div>`; return; }
    let html = `<div class="result-title"><strong>"${esc(query)}"</strong> 검색 결과 ${results.length}건</div><div class="cards">`;
    results.forEach((r, i) => {
      const s = sourceLabel(r.source);
      html += `
        <div class="card ${i===0?'best':''}">
          <div class="rank ${rankCls(i)}">${rankIcon(i)}</div>
          ${imgHtml(r)}
          <div class="card-body">
            <div class="card-top">
              <span class="card-source ${s.cls}">${s.icon} ${s.text}</span>
              ${r.category ? `<span class="card-category">${esc(r.category)}</span>` : ''}
            </div>
            <div class="card-product">${esc(r.product_name) || '-'}</div>
            <div class="card-meta">
              ${r.mall_name ? `<span class="card-mall">📦 ${esc(r.mall_name)}</span>` : ''}
              ${r.link ? `<a class="card-link" href="${encodeURI(r.link)}" target="_blank" rel="noopener">상품 바로가기 ↗</a>` : ''}
            </div>
          </div>
          <div class="card-price">
            <div class="price-value">${fmt(r.lowest_price)}</div>
            <div class="price-unit">원</div>
          </div>
        </div>`;
    });
    html += '</div>';
    if (results.length >= 2) {
      const diff = results[results.length-1].lowest_price - results[0].lowest_price;
      html += `<div class="diff-banner">💡 <strong>${results[0].source}</strong>이(가) <strong>${fmt(diff)}원</strong> 더 저렴합니다</div>`;
    }
    pResults.innerHTML = html;
  }

  /* ═══════════════════════════════════════
     일자별 뉴스 요약
  ═══════════════════════════════════════ */
  const newsDateInput = document.getElementById('newsDate');
  const newsLoadBtn   = document.getElementById('newsLoadBtn');
  const newsStat      = document.getElementById('news-status');
  const newsResults   = document.getElementById('news-results');

  // 오늘 날짜 기본값 설정
  (() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth()+1).padStart(2,'0');
    const d = String(now.getDate()).padStart(2,'0');
    newsDateInput.value = `${y}-${m}-${d}`;
    newsDateInput.max   = `${y}-${m}-${d}`;
  })();

  let selectedCategory = '전체';

  document.getElementById('catTabs').addEventListener('click', e => {
    const btn = e.target.closest('.cat-btn');
    if (!btn) return;
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedCategory = btn.dataset.cat;
  });

  async function loadNews() {
    const date = newsDateInput.value;
    newsLoadBtn.disabled = true;
    newsStat.innerHTML = '<span class="spinner"></span> 뉴스를 불러오는 중...';
    newsResults.innerHTML = '';

    try {
      const params = new URLSearchParams({ date, category: selectedCategory });
      const res  = await fetch(`/news?${params}`);
      const data = await res.json();
      newsStat.innerHTML = '';
      if (data.error) { newsResults.innerHTML = `<div class="error-box">${data.error}</div>`; return; }
      renderNews(data);
    } catch (e) {
      newsStat.innerHTML = '';
      newsResults.innerHTML = `<div class="error-box">서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.</div>`;
    } finally {
      newsLoadBtn.disabled = false;
    }
  }

  function renderNews({date, category, items}) {
    if (!items || items.length === 0) {
      newsResults.innerHTML = `
        <div class="news-empty">
          <span class="icon">📭</span>
          <strong>${date}</strong> ${category} 카테고리의 뉴스가 없습니다.<br>
          날짜나 카테고리를 변경해 다시 시도해 보세요.
        </div>`;
      return;
    }

    let html = `
      <div class="news-date-header">
        📅 <span>${date}</span> · ${category}
        <span class="news-count-badge">${items.length}건</span>
      </div>
      <div class="news-cards">`;

    items.forEach((item, i) => {
      html += `
        <div class="news-card">
          <div class="news-card-top">
            <div class="news-num">${i+1}</div>
            <div class="news-title">
              <a href="${encodeURI(item.link)}" target="_blank" rel="noopener">${esc(item.title)}</a>
            </div>
          </div>
          ${item.description ? `<div class="news-desc">${esc(item.description)}</div>` : ''}
          <div class="news-footer">
            <span class="news-time">🕐 ${item.pub_date}</span>
            <a class="news-link" href="${item.link}" target="_blank" rel="noopener">기사 보기 ↗</a>
          </div>
        </div>`;
    });

    html += '</div>';
    newsResults.innerHTML = html;
  }

  // 뉴스 페이지는 1차 nav 에서 숨김 — 자동 로드 트리거 제거.
  // (page-news DOM/loadNews 함수는 보존, 나중에 sub-tab 추가 시 onActivate 로 재연결)

  /* ═══════════════════════════════════════
     부동산 실거래가
  ═══════════════════════════════════════ */
  const REGIONS = {
    "서울": {
      "종로구":"11110","중구":"11140","용산구":"11170","성동구":"11200","광진구":"11215",
      "동대문구":"11230","중랑구":"11260","성북구":"11290","강북구":"11305","도봉구":"11320",
      "노원구":"11350","은평구":"11380","서대문구":"11410","마포구":"11440","양천구":"11470",
      "강서구":"11500","구로구":"11530","금천구":"11545","영등포구":"11560","동작구":"11590",
      "관악구":"11620","서초구":"11650","강남구":"11680","송파구":"11710","강동구":"11740"
    },
    "부산": {
      "중구":"26110","서구":"26140","동구":"26170","영도구":"26200","부산진구":"26230",
      "동래구":"26260","남구":"26290","북구":"26320","해운대구":"26350","사하구":"26380",
      "금정구":"26410","강서구":"26440","연제구":"26470","수영구":"26500","사상구":"26530","기장군":"26710"
    },
    "대구": {
      "중구":"27110","동구":"27140","서구":"27170","남구":"27200","북구":"27230",
      "수성구":"27260","달서구":"27290","달성군":"27710"
    },
    "인천": {
      "중구":"28110","동구":"28140","미추홀구":"28177","연수구":"28185","남동구":"28200",
      "부평구":"28237","계양구":"28245","서구":"28260","강화군":"28710","옹진군":"28720"
    },
    "광주": {
      "동구":"29110","서구":"29140","남구":"29155","북구":"29170","광산구":"29200"
    },
    "대전": {
      "동구":"30110","중구":"30140","서구":"30170","유성구":"30200","대덕구":"30230"
    },
    "울산": {
      "중구":"31110","남구":"31140","동구":"31170","북구":"31200","울주군":"31710"
    },
    "세종": { "세종시":"36110" },
    "경기": {
      "수원 장안구":"41111","수원 권선구":"41113","수원 팔달구":"41115","수원 영통구":"41117",
      "성남 수정구":"41131","성남 중원구":"41133","성남 분당구":"41135","의정부시":"41150",
      "안양 만안구":"41171","안양 동안구":"41173","부천시":"41190","광명시":"41210",
      "평택시":"41220","동두천시":"41250","안산 상록구":"41271","안산 단원구":"41273",
      "고양 덕양구":"41281","고양 일산동구":"41285","고양 일산서구":"41287","과천시":"41290",
      "구리시":"41310","남양주시":"41360","오산시":"41370","시흥시":"41390","군포시":"41410",
      "의왕시":"41430","하남시":"41450","용인 처인구":"41461","용인 기흥구":"41463","용인 수지구":"41465",
      "파주시":"41480","이천시":"41500","안성시":"41550","김포시":"41570","화성시":"41590",
      "광주시":"41610","양주시":"41630","포천시":"41650","여주시":"41670",
      "연천군":"41800","가평군":"41820","양평군":"41830"
    },
    "강원": {
      "춘천시":"42110","원주시":"42130","강릉시":"42150","동해시":"42170","태백시":"42190",
      "속초시":"42210","삼척시":"42230","홍천군":"42720","횡성군":"42730","영월군":"42750",
      "평창군":"42760","정선군":"42770","철원군":"42780","화천군":"42790","양구군":"42800",
      "인제군":"42810","고성군":"42820","양양군":"42830"
    },
    "충북": {
      "청주 상당구":"43111","청주 서원구":"43112","청주 흥덕구":"43113","청주 청원구":"43114",
      "충주시":"43130","제천시":"43150","보은군":"43720","옥천군":"43730","영동군":"43740",
      "증평군":"43745","진천군":"43750","괴산군":"43760","음성군":"43770","단양군":"43800"
    },
    "충남": {
      "천안 동남구":"44131","천안 서북구":"44133","공주시":"44150","보령시":"44180",
      "아산시":"44200","서산시":"44210","논산시":"44230","계룡시":"44250","당진시":"44270",
      "금산군":"44710","부여군":"44760","서천군":"44770","청양군":"44790",
      "홍성군":"44800","예산군":"44810","태안군":"44825"
    },
    "전북": {
      "전주 완산구":"45111","전주 덕진구":"45113","군산시":"45130","익산시":"45140",
      "정읍시":"45180","남원시":"45190","김제시":"45210","완주군":"45710","진안군":"45720",
      "무주군":"45730","장수군":"45740","임실군":"45750","순창군":"45770","고창군":"45790","부안군":"45800"
    },
    "전남": {
      "목포시":"46110","여수시":"46130","순천시":"46150","나주시":"46170","광양시":"46230",
      "담양군":"46710","곡성군":"46720","구례군":"46730","고흥군":"46770","보성군":"46780",
      "화순군":"46790","장흥군":"46800","강진군":"46810","해남군":"46820","영암군":"46830",
      "무안군":"46840","함평군":"46860","영광군":"46870","장성군":"46880","완도군":"46890",
      "진도군":"46900","신안군":"46910"
    },
    "경북": {
      "포항 남구":"47111","포항 북구":"47113","경주시":"47130","김천시":"47150","안동시":"47170",
      "구미시":"47190","영주시":"47210","영천시":"47230","상주시":"47250","문경시":"47280",
      "경산시":"47290","군위군":"47720","의성군":"47730","청송군":"47750","영양군":"47760",
      "영덕군":"47770","청도군":"47820","고령군":"47830","성주군":"47840","칠곡군":"47850",
      "예천군":"47900","봉화군":"47920","울진군":"47930","울릉군":"47940"
    },
    "경남": {
      "창원 의창구":"48121","창원 성산구":"48123","창원 마산합포구":"48125","창원 마산회원구":"48127","창원 진해구":"48129",
      "진주시":"48170","통영시":"48220","사천시":"48240","김해시":"48250","밀양시":"48270",
      "거제시":"48310","양산시":"48330","의령군":"48720","함안군":"48730","창녕군":"48740",
      "고성군":"48820","남해군":"48840","하동군":"48850","산청군":"48860","함양군":"48870",
      "거창군":"48880","합천군":"48890"
    },
    "제주": {
      "제주시":"50110","서귀포시":"50130"
    },
  };

  const reSido    = document.getElementById('reSido');
  const reGungu   = document.getElementById('reGungu');
  const reMonth   = document.getElementById('reMonth');
  const reSearchBtn = document.getElementById('reSearchBtn');
  const reStat    = document.getElementById('re-status');
  const reResults = document.getElementById('re-results');

  // 기본 년월: 이번 달
  (() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth()+1).padStart(2,'0');
    reMonth.value = `${y}-${m}`;
    reMonth.max   = `${y}-${m}`;
  })();

  function updateGungu() {
    const sido = reSido.value;
    reGungu.innerHTML = '';
    if (!sido || !REGIONS[sido]) {
      reGungu.innerHTML = '<option value="">시/도 먼저 선택</option>';
      return;
    }
    Object.entries(REGIONS[sido]).forEach(([name, code], i) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = name;
      if (i === 0) opt.selected = true;
      reGungu.appendChild(opt);
    });
  }

  let reData = [];
  let sortKey = 'price';
  let sortDir = -1; // -1: 내림차순

  async function loadRealestate() {
    const lawd_cd  = reGungu.value;
    const monthVal = reMonth.value; // YYYY-MM
    if (!lawd_cd)  { showModal('구/군을 선택해주세요.'); return; }
    if (!monthVal) { showModal('년월을 선택해주세요.'); return; }

    const deal_ymd = monthVal.replace('-', '');
    reSearchBtn.disabled = true;
    reStat.innerHTML = '<span class="spinner"></span> 실거래 데이터 조회 중...';
    reResults.innerHTML = '';

    try {
      const res  = await fetch(`/realestate?lawd_cd=${lawd_cd}&deal_ymd=${deal_ymd}`);
      const data = await res.json();
      reStat.innerHTML = '';
      if (data.error) { reResults.innerHTML = `<div class="error-box">${data.error}</div>`; return; }
      reData = data.items || [];
      sortKey = 'price'; sortDir = -1;
      renderReTable(data);
    } catch (e) {
      reStat.innerHTML = '';
      reResults.innerHTML = `<div class="error-box">서버 오류가 발생했습니다.</div>`;
    } finally {
      reSearchBtn.disabled = false;
    }
  }

  function fmtPrice(만원) {
    if (!만원) return '-';
    if (만원 >= 10000) {
      const 억 = Math.floor(만원 / 10000);
      const 나머지 = 만원 % 10000;
      return 나머지 > 0 ? `${억}억 ${나머지.toLocaleString()}만` : `${억}억`;
    }
    return `${만원.toLocaleString()}만`;
  }

  function renderReTable({ deal_ymd, total, items }) {
    if (!items || items.length === 0) {
      reResults.innerHTML = `
        <div class="news-empty">
          <span class="icon">🏘️</span>
          해당 기간 실거래 데이터가 없습니다.
        </div>`;
      return;
    }

    const prices   = items.map(i => i.price).filter(p => p > 0);
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const avgPrice = Math.round(prices.reduce((a,b)=>a+b,0)/prices.length);
    const ym = `${deal_ymd.slice(0,4)}년 ${deal_ymd.slice(4)}월`;

    let html = `
      <div style="font-size:0.85rem;color:#64748b;margin-bottom:16px;">
        📍 ${ym} 실거래 <span style="color:#e2e8f0;font-weight:600">${total}건</span>
      </div>
      <div class="re-summary">
        <div class="re-stat"><div class="re-stat-label">최고 거래가</div><div class="re-stat-value best">${fmtPrice(maxPrice)}</div></div>
        <div class="re-stat"><div class="re-stat-label">최저 거래가</div><div class="re-stat-value low">${fmtPrice(minPrice)}</div></div>
        <div class="re-stat"><div class="re-stat-label">평균 거래가</div><div class="re-stat-value avg">${fmtPrice(avgPrice)}</div></div>
        <div class="re-stat"><div class="re-stat-label">총 거래 건수</div><div class="re-stat-value">${total}건</div></div>
      </div>
      <div class="re-sort-bar">
        <span class="re-sort-label">정렬:</span>
        <button class="sort-btn active" data-key="price">거래금액</button>
        <button class="sort-btn" data-key="date">계약일</button>
        <button class="sort-btn" data-key="area">전용면적</button>
        <button class="sort-btn" data-key="floor">층수</button>
      </div>
      <div class="re-table-wrap">
        <table class="re-table">
          <thead>
            <tr>
              <th>#</th>
              <th>아파트명</th>
              <th>동</th>
              <th>법정동</th>
              <th>층</th>
              <th>전용면적(㎡)</th>
              <th>거래금액</th>
              <th>계약일</th>
              <th>건축년도</th>
              <th>거래유형</th>
            </tr>
          </thead>
          <tbody id="reTableBody"></tbody>
        </table>
      </div>`;

    reResults.innerHTML = html;

    document.querySelectorAll('.sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (sortKey === key) { sortDir *= -1; }
        else { sortKey = key; sortDir = key === 'price' ? -1 : 1; }
        document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fillTableBody();
      });
    });

    // 동 필터 드롭다운 채우기
    const dongs = [...new Set(reData.map(i => i.dong).filter(Boolean))].sort();
    const dongSel = document.getElementById('dongFilter');
    if (dongSel) {
      dongSel.innerHTML = '<option value="">전체 동</option>';
      dongs.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d; dongSel.appendChild(o); });
    }

    fillTableBody();
  }

  function fillTableBody() {
    const dongVal = (document.getElementById('dongFilter')?.value || '').trim();
    const aptVal  = (document.getElementById('aptSearch')?.value || '').trim().toLowerCase();

    const filtered = reData.filter(r => {
      if (dongVal && r.dong !== dongVal) return false;
      if (aptVal  && !(r.apt_name || '').toLowerCase().includes(aptVal)) return false;
      return true;
    });

    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === 'price') return (a.price - b.price) * sortDir;
      if (sortKey === 'area')  return (parseFloat(a.area) - parseFloat(b.area)) * sortDir;
      if (sortKey === 'floor') return (parseInt(a.floor) - parseInt(b.floor)) * sortDir;
      if (sortKey === 'date')  return (`${a.year}${String(a.month).padStart(2,'0')}${String(a.day).padStart(2,'0')}` > `${b.year}${String(b.month).padStart(2,'0')}${String(b.day).padStart(2,'0')}` ? 1 : -1) * sortDir;
      return 0;
    });

    const prices = filtered.map(i=>i.price).filter(p=>p>0);
    const max = prices.length ? Math.max(...prices) : 0;
    const min = prices.length ? Math.min(...prices) : 0;

    const tbody = document.getElementById('reTableBody');
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:32px;color:#475569;">검색 결과가 없습니다.</td></tr>`;
      return;
    }
    tbody.innerHTML = sorted.map((r, i) => {
      const isTop = r.price === max;
      const isLow = r.price === min;
      const priceClass = isTop ? 'rank-top' : isLow ? 'rank-low' : '';
      return `
        <tr>
          <td style="color:#475569">${i+1}</td>
          <td style="font-weight:600;color:#e2e8f0">${r.apt_name || '-'}</td>
          <td>${r.apt_dong?.trim() || '-'}</td>
          <td>${r.dong || '-'}</td>
          <td>${r.floor || '-'}층</td>
          <td>${parseFloat(r.area || 0).toFixed(2)}</td>
          <td class="price-cell ${priceClass}">${fmtPrice(r.price)}</td>
          <td>${r.year}.${String(r.month).padStart(2,'0')}.${String(r.day).padStart(2,'0')}</td>
          <td>${r.build_year || '-'}</td>
          <td>${r.deal_type ? `<span class="deal-badge">${r.deal_type}</span>` : '-'}</td>
        </tr>`;
    }).join('');
  }

  /* ═══════════════════════════════════════
     단위 변환기
  ═══════════════════════════════════════ */
  const UNIT_CATEGORIES = {
    "길이": {
      units: ["mm","cm","m","km","inch","feet","yard","mile"],
      labels: {"mm":"밀리미터(mm)","cm":"센티미터(cm)","m":"미터(m)","km":"킬로미터(km)","inch":"인치(inch)","feet":"피트(feet)","yard":"야드(yard)","mile":"마일(mile)"},
      toBase: {"mm":0.001,"cm":0.01,"m":1,"km":1000,"inch":0.0254,"feet":0.3048,"yard":0.9144,"mile":1609.344},
      quick: [["1 inch","2.54 cm"],["1 feet","30.48 cm"],["1 mile","1.609 km"],["1 yard","91.44 cm"],["100 cm","1 m"],["1 km","0.621 mile"]]
    },
    "무게": {
      units: ["mg","g","kg","t","oz","lbs","근"],
      labels: {"mg":"밀리그램(mg)","g":"그램(g)","kg":"킬로그램(kg)","t":"톤(t)","oz":"온스(oz)","lbs":"파운드(lbs)","근":"근(600g)"},
      toBase: {"mg":0.000001,"g":0.001,"kg":1,"t":1000,"oz":0.028349,"lbs":0.453592,"근":0.6},
      quick: [["1 lbs","453.6 g"],["1 oz","28.35 g"],["1 kg","2.205 lbs"],["1 t","1,000 kg"],["1 근","600 g"],["100 g","0.22 lbs"]]
    },
    "온도": {
      units: ["°C","°F","K"],
      labels: {"°C":"섭씨(°C)","°F":"화씨(°F)","K":"켈빈(K)"},
      toBase: null,
      quick: [["0 °C","32 °F"],["100 °C","212 °F"],["37 °C","98.6 °F"],["20 °C","68 °F"],["0 K","-273.15 °C"],["25 °C","77 °F"]]
    },
    "넓이": {
      units: ["mm²","cm²","m²","km²","평","acre","ha"],
      labels: {"mm²":"제곱밀리미터","cm²":"제곱센티미터","m²":"제곱미터(m²)","km²":"제곱킬로미터","평":"평(坪)","acre":"에이커","ha":"헥타르"},
      toBase: {"mm²":0.000001,"cm²":0.0001,"m²":1,"km²":1000000,"평":3.30579,"acre":4046.86,"ha":10000},
      quick: [["1 평","3.306 m²"],["1 acre","4,047 m²"],["1 ha","10,000 m²"],["330 m²","약 100평"],["1 km²","100 ha"],["1 ha","2.471 acre"]]
    }
  };

  let unitCurrentCat = "길이";

  function unitConvertTemp(val, from, to) {
    let celsius;
    if (from === "°C") celsius = val;
    else if (from === "°F") celsius = (val - 32) * 5/9;
    else celsius = val - 273.15;
    if (to === "°C") return celsius;
    if (to === "°F") return celsius * 9/5 + 32;
    return celsius + 273.15;
  }

  function unitConvert(val, from, to) {
    if (from === to) return val;
    if (unitCurrentCat === "온도") return unitConvertTemp(val, from, to);
    const tb = UNIT_CATEGORIES[unitCurrentCat].toBase;
    return val * tb[from] / tb[to];
  }

  function unitFormatNum(n) {
    if (n === "" || isNaN(n)) return "";
    const abs = Math.abs(n);
    if (abs === 0) return "0";
    if (abs < 0.0001) return n.toExponential(4);
    if (abs < 1) return parseFloat(n.toFixed(6)).toString();
    if (abs < 10000) return parseFloat(n.toFixed(4)).toString();
    return parseFloat(n.toFixed(2)).toLocaleString();
  }

  const unitFromEl    = document.getElementById("unitFrom");
  const unitToEl      = document.getElementById("unitTo");
  const unitFromInput = document.getElementById("unitFromInput");
  const unitToInput   = document.getElementById("unitToInput");
  const unitSwapBtn   = document.getElementById("unitSwap");
  const unitTabsEl    = document.getElementById("unitTabs");
  const unitRefGrid   = document.getElementById("unitRefGrid");

  function unitBuildOptions(sel, units, labels, selected) {
    sel.innerHTML = "";
    units.forEach(u => {
      const opt = document.createElement("option");
      opt.value = u; opt.textContent = labels[u];
      if (u === selected) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function unitBuildQuickRef() {
    const quicks = UNIT_CATEGORIES[unitCurrentCat].quick;
    unitRefGrid.innerHTML = "";
    quicks.forEach(([f, t]) => {
      const el = document.createElement("div");
      el.className = "unit-ref-item";
      el.innerHTML = `<span class="unit-ref-from">${f}</span><span class="unit-ref-arrow">→</span><span class="unit-ref-to">${t}</span>`;
      unitRefGrid.appendChild(el);
    });
  }

  function unitBuildTabs() {
    unitTabsEl.innerHTML = "";
    Object.keys(UNIT_CATEGORIES).forEach(cat => {
      const btn = document.createElement("button");
      btn.className = "unit-tab" + (cat === unitCurrentCat ? " active" : "");
      btn.textContent = cat;
      btn.onclick = () => {
        unitCurrentCat = cat;
        const cd = UNIT_CATEGORIES[cat];
        unitBuildTabs();
        unitBuildOptions(unitFromEl, cd.units, cd.labels, cd.units[0]);
        unitBuildOptions(unitToEl,   cd.units, cd.labels, cd.units[1]);
        unitFromInput.value = "1";
        unitDoConvert();
        unitBuildQuickRef();
      };
      unitTabsEl.appendChild(btn);
    });
  }

  function unitDoConvert() {
    const val = parseFloat(unitFromInput.value);
    if (isNaN(val)) { unitToInput.value = ""; return; }
    unitToInput.value = unitFormatNum(unitConvert(val, unitFromEl.value, unitToEl.value));
  }

  unitFromInput.addEventListener("input", unitDoConvert);
  unitFromEl.addEventListener("change", unitDoConvert);
  unitToEl.addEventListener("change", unitDoConvert);
  unitSwapBtn.addEventListener("click", () => {
    const tmp = unitFromEl.value;
    unitFromEl.value = unitToEl.value;
    unitToEl.value = tmp;
    unitDoConvert();
  });

  // 단위 변환기 — 즉시 초기화 (이전엔 nav 클릭 lazy 였으나 nav 재구성으로 셀렉터 무효화됨)
  (function initUnitConverter() {
    if (!unitTabsEl) return;
    unitBuildTabs();
    const init = UNIT_CATEGORIES[unitCurrentCat];
    unitBuildOptions(unitFromEl, init.units, init.labels, init.units[0]);
    unitBuildOptions(unitToEl,   init.units, init.labels, init.units[1]);
    unitFromInput.value = "1";
    unitDoConvert();
    unitBuildQuickRef();
  })();

  /* ═══════════════════════════════════════
     AI 뉴스 요약
  ═══════════════════════════════════════ */
  let aiSelectedCat = 'AI 동향';
  const aiGenBtn  = document.getElementById('aiGenBtn');
  const aiStatus  = document.getElementById('ai-status');
  const aiResults = document.getElementById('ai-results');

  document.querySelectorAll('.ai-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ai-cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      aiSelectedCat = btn.dataset.aicat;
    });
  });

  function sentimentClass(s) {
    if (s === '긍정') return 'sentiment-pos';
    if (s === '부정') return 'sentiment-neg';
    return 'sentiment-neu';
  }
  function sentimentIcon(s) {
    if (s === '긍정') return '▲';
    if (s === '부정') return '▼';
    return '─';
  }

  async function loadAiNews() {
    aiGenBtn.disabled = true;
    aiStatus.innerHTML = '<span class="spinner"></span> Gemini AI가 뉴스를 분석하는 중... (10~20초 소요)';
    aiResults.innerHTML = '';
    try {
      const res  = await fetch(`/ai-news?category=${encodeURIComponent(aiSelectedCat)}`, { headers: await authHeaders() });
      const data = await res.json();
      aiStatus.innerHTML = '';
      if (data.error) { aiResults.innerHTML = `<div class="error-box">${data.error}</div>`; return; }
      renderAiNews(data);
    } catch (e) {
      aiStatus.innerHTML = '';
      aiResults.innerHTML = `<div class="error-box">서버 오류가 발생했습니다.</div>`;
    } finally {
      aiGenBtn.disabled = false;
    }
  }

  /* ═══════════════════════════════════════
     주식 추천
  ═══════════════════════════════════════ */
  let stockData = [];
  let stockSortKey = 'per';
  let stockSortDir = 1;

  async function loadStockRecommend() {
    const market = document.getElementById('stockMarket').value;
    const [perMin, perMax] = document.getElementById('stockPer').value.split('-').map(Number);
    const [pbrMin, pbrMax] = document.getElementById('stockPbr').value.split('-').map(Number);
    const btn = document.getElementById('stockSearchBtn');
    const stat = document.getElementById('stock-status');
    const results = document.getElementById('stock-results');

    btn.disabled = true;
    stat.innerHTML = '<span class="spinner"></span> KIS API에서 종목 데이터를 조회 중... (최대 30초)';
    results.innerHTML = '';

    try {
      const params = new URLSearchParams({ market, per_min: perMin, per_max: perMax, pbr_min: pbrMin, pbr_max: pbrMax });
      const res = await fetch(`/stock-recommend?${params}`, { headers: await authHeaders() });
      const data = await res.json();
      stat.innerHTML = '';
      if (data.error) { results.innerHTML = `<div class="error-box">${data.error}</div>`; return; }
      stockData = data.items || [];
      stockSortKey = 'per'; stockSortDir = 1;
      renderStockResults(data);
      btn.disabled = false;

      // 백그라운드: AI 감성분석 요청
      if (stockData.length) {
        stat.innerHTML = '<span class="spinner"></span> AI 판정 분석 중...';
        try {
          const aiRes = await fetch('/stock-ai', {
            method: 'POST',
            headers: {'Content-Type':'application/json', ...(await authHeaders())},
            body: JSON.stringify(stockData)
          });
          const aiData = await aiRes.json();
          if (aiData.items) {
            stockData = aiData.items;
            fillStockTableBody();
          }
        } catch(e) {}
        stat.innerHTML = '';
      }
    } catch (e) {
      stat.innerHTML = '';
      results.innerHTML = `<div class="error-box">서버 오류가 발생했습니다.</div>`;
      btn.disabled = false;
    }
  }

  function renderStockResults({ market, total, pool_size, items }) {
    if (!items || items.length === 0) {
      document.getElementById('stock-results').innerHTML = `<div class="error-box">조건에 맞는 종목이 없습니다. (조회 풀: ${pool_size || 0}개)</div>`;
      return;
    }

    const avgPer = (items.reduce((s, i) => s + i.per, 0) / items.length).toFixed(1);
    const avgPbr = (items.reduce((s, i) => s + i.pbr, 0) / items.length).toFixed(2);
    const lowestPer = items.reduce((a, b) => a.per < b.per ? a : b);

    let html = `
      <div style="font-size:0.85rem;color:#64748b;margin-bottom:16px;">
        📈 ${market} 거래량 상위 ${pool_size}개 중 필터 결과 <span style="color:#e2e8f0;font-weight:600">${total}건</span>
      </div>
      <div class="re-summary">
        <div class="re-stat"><div class="re-stat-label">필터 종목 수</div><div class="re-stat-value">${total}건</div></div>
        <div class="re-stat"><div class="re-stat-label">평균 PER</div><div class="re-stat-value avg">${avgPer}</div></div>
        <div class="re-stat"><div class="re-stat-label">평균 PBR</div><div class="re-stat-value low">${avgPbr}</div></div>
        <div class="re-stat"><div class="re-stat-label">최저 PER</div><div class="re-stat-value best">${lowestPer.stock_name} (${lowestPer.per})</div></div>
      </div>
      <div class="re-sort-bar">
        <span class="re-sort-label">정렬:</span>
        <button class="sort-btn active" data-skey="per">PER</button>
        <button class="sort-btn" data-skey="pbr">PBR</button>
        <button class="sort-btn" data-skey="current_price">현재가</button>
        <button class="sort-btn" data-skey="change_rate">등락률</button>
        <button class="sort-btn" data-skey="volume">거래량</button>
        <button class="sort-btn" data-skey="market_cap">시가총액</button>
      </div>
      <div class="re-table-wrap">
        <table class="re-table">
          <thead>
            <tr>
              <th>#</th>
              <th>종목명</th>
              <th>현재가</th>
              <th>거래량</th>
              <th>기술적 지표</th>
              <th>AI 판정</th>
            </tr>
          </thead>
          <tbody id="stockTableBody"></tbody>
        </table>
      </div>`;

    document.getElementById('stock-results').innerHTML = html;

    document.querySelectorAll('[data-skey]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.skey;
        if (stockSortKey === key) { stockSortDir *= -1; }
        else { stockSortKey = key; stockSortDir = key === 'change_rate' ? -1 : 1; }
        document.querySelectorAll('[data-skey]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fillStockTableBody();
      });
    });

    fillStockTableBody();
  }

  function fillStockTableBody() {
    const sorted = [...stockData].sort((a, b) => (a[stockSortKey] - b[stockSortKey]) * stockSortDir);
    const tbody = document.getElementById('stockTableBody');
    if (!sorted.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:#475569;">데이터가 없습니다.</td></tr>`;
      return;
    }
    const fmtVol = v => v >= 1000000 ? (v/1000000).toFixed(1)+'백만' : v >= 10000 ? (v/10000).toFixed(1)+'만' : v.toLocaleString();
    const rsiCls = v => !v ? '' : v <= 30 ? 'per-low' : v >= 70 ? 'per-high' : 'per-mid';
    const rsiLabel = v => !v ? '-' : v <= 30 ? '과매도' : v >= 70 ? '과매수' : '';
    const maCls = s => s === '골든크로스' ? 'golden' : s === '크로스임박' ? 'imminent' : s === '상승추세' ? 'uptrend' : s === '데드크로스' ? 'dead' : 'downtrend';
    const decCls = d => d === '강력매수' ? 'strong-buy' : d === '매수고려' ? 'buy' : d === '매수보류' ? 'avoid' : 'hold';
    const scoreFill = sc => sc >= 65 ? '#f87171' : sc >= 55 ? '#fbbf24' : sc >= 40 ? '#94a3b8' : '#60a5fa';

    tbody.innerHTML = sorted.map((s, i) => {
      const chgCls = s.change_rate > 0 ? 'change-up' : s.change_rate < 0 ? 'change-down' : '';
      const chgSign = s.change_rate > 0 ? '+' : '';
      const rsi = s.rsi;
      const maSignal = s.ma_signal || '없음';
      const decision = s.decision || '관망';
      const score = s.score || 50;
      const signals = s.signals || [];
      const reason = s.reason || '';
      const risk = s.risk || '';
      return `
        <tr>
          <td style="color:#475569">${i+1}</td>
          <td><a class="stock-link" style="font-weight:600" onclick="openStockNews('${esc(s.stock_name)}','${esc(s.stock_code)}')">${esc(s.stock_name)}</a><br><span style="font-size:0.72rem;color:#475569">${esc(s.stock_code)} · PER ${s.per.toFixed(1)} · PBR ${s.pbr.toFixed(2)}</span></td>
          <td>${s.current_price.toLocaleString()}원<br><span class="${chgCls}" style="font-size:0.78rem">${chgSign}${s.change_rate.toFixed(2)}%</span></td>
          <td>${fmtVol(s.volume)}${s.vol_surge ? '<br><span style="color:#f87171;font-size:0.68rem;font-weight:700">🔥 급증</span>' : (s.vol_ratio ? `<br><span style="font-size:0.68rem;color:#475569">${s.vol_ratio}배</span>` : '')}</td>
          <td style="font-size:0.78rem;line-height:1.8">
            <span class="${rsiCls(rsi)}">RSI ${rsi != null ? rsi.toFixed(1) : '-'}</span>${rsiLabel(rsi) ? ` <span style="font-size:0.68rem">(${rsiLabel(rsi)})</span>` : ''}<br>
            <span class="ma-signal ${maCls(maSignal)}">${maSignal}</span> <span style="font-size:0.68rem;color:#475569">간격${Math.abs(s.ma_gap||0).toFixed(1)}%</span><br>
            <span style="color:${s.macd_trend==='매수신호'||s.macd_trend==='상승모멘텀'?'#34d399':'#f87171'}">MACD ${s.macd_trend||'없음'}</span><br>
            <span style="color:${s.bb_position==='하단돌파'||s.bb_position==='하단근접'?'#34d399':s.bb_position==='상단돌파'||s.bb_position==='상단근접'?'#f87171':'#94a3b8'}">BB ${s.bb_position||'없음'}</span> <span style="font-size:0.68rem;color:#475569">%B:${(s.bb_pct_b||0.5).toFixed(2)}</span>
          </td>
          <td>
            <span class="decision-badge ${decCls(decision)}">${decision}</span> <span style="font-size:0.68rem;color:#64748b">[${s.confidence||''}]</span>
            <div style="font-size:0.72rem;color:#64748b;margin-top:3px">${score}점 <span class="score-bar"><span class="score-fill" style="width:${score}%;background:${scoreFill(score)}"></span></span></div>
            ${s.stop_loss && s.target_price ? `<div style="font-size:0.72rem;margin-top:4px"><span style="color:#60a5fa">손절 ${s.stop_loss.toLocaleString()}</span> · <span style="color:#f87171">목표 ${s.target_price.toLocaleString()}</span></div>` : ''}
            ${reason ? `<div class="sentiment-reason" style="margin-top:4px">${esc(reason)}</div>` : ''}
            ${risk ? `<div style="font-size:0.68rem;color:#f87171;margin-top:2px">⚠ ${esc(risk)}</div>` : ''}
            ${signals.length ? `<div class="signal-tags">${signals.map(t=>`<span class="signal-tag">${t}</span>`).join('')}</div>` : ''}
          </td>
        </tr>`;
    }).join('');
  }

  function renderAiNews({ category, summary, articles, article_count }) {
    const { headline, points, outlook } = summary;
    let html = `
      <div class="ai-headline">
        <div class="ai-headline-label">📡 ${category} · 오늘의 동향</div>
        <div class="ai-headline-text">${esc(headline)}</div>
      </div>
      <div class="ai-points">`;

    points.forEach((p, i) => {
      const cls  = sentimentClass(p.sentiment);
      const icon = sentimentIcon(p.sentiment);
      const linkBtn = p.link ? `<a href="${p.link}" target="_blank" rel="noopener" class="ai-point-link">기사 원문 ↗</a>` : '';
      html += `
        <div class="ai-point-card">
          <div class="ai-point-top">
            <span class="ai-point-num">${i+1}</span>
            <span class="ai-sentiment ${cls}">${icon} ${p.sentiment}</span>
            <span class="ai-point-title">${esc(p.title)}</span>
          </div>
          <div class="ai-point-body">${esc(p.summary)}</div>
          ${linkBtn}
        </div>`;
    });

    html += `</div>
      <div class="ai-outlook">
        <div class="ai-outlook-icon">🔭</div>
        <div>
          <div class="ai-outlook-label">전망 & 시사점</div>
          <div class="ai-outlook-text">${esc(outlook)}</div>
        </div>
      </div>
      <div class="ai-meta">분석 기사 ${article_count}건 중 상위 ${points.length}건 선별 · Powered by Gemini 2.5 Flash</div>`;

    aiResults.innerHTML = html;
  }

  /* ═══════════════════════════════════════
     종목 뉴스 모달
  ═══════════════════════════════════════ */
  async function openStockNews(name, code) {
    const overlay = document.getElementById('stockNewsModal');
    const content = document.getElementById('stockNewsContent');
    overlay.classList.add('active');
    content.innerHTML = '<div style="text-align:center;padding:40px"><span class="spinner"></span> AI가 뉴스를 분석하는 중... (10~20초)</div>';

    try {
      const params = new URLSearchParams({ name, code });
      const res = await fetch(`/stock-news?${params}`, { headers: await authHeaders() });
      const data = await res.json();
      if (data.error) { content.innerHTML = `<div class="error-box">${data.error}</div>`; return; }
      renderStockNewsModal(data);
    } catch (e) {
      content.innerHTML = `<div class="error-box">뉴스 분석 중 오류가 발생했습니다.</div>`;
    }
  }

  function renderStockNewsModal({ name, code, articles, summary }) {
    const s = summary || {};
    const impCls = v => v === '긍정' ? 'pos' : v === '부정' ? 'neg' : 'neu';
    const gradeColor = g => g === '매우긍정' || g === '긍정' ? '#34d399' : g === '부정' || g === '매우부정' ? '#f87171' : '#94a3b8';

    let html = `
      <div class="modal-title">${name} (${code})</div>
      <div class="modal-subtitle">AI 뉴스 감성분석 · ${articles?.length || 0}건 기사 분석${s.sentiment_score ? ` · <span style="color:${gradeColor(s.sentiment_grade)};font-weight:700">${s.sentiment_grade} ${s.sentiment_score}점</span>` : ''}</div>
      <div class="modal-headline">${esc(s.headline) || '요약 없음'}</div>`;

    if (s.key_issues?.length) {
      html += '<div style="font-size:0.82rem;font-weight:600;color:#94a3b8;margin-bottom:10px">📌 핵심 이슈</div>';
      s.key_issues.forEach(issue => {
        html += `<div class="modal-issue">
          <div class="modal-issue-title">${esc(issue.title)}<span class="modal-impact ${impCls(issue.impact)}">${esc(issue.impact)}</span></div>
          <div class="modal-issue-body">${esc(issue.summary)}</div>
        </div>`;
      });
    }

    if (s.outlook) {
      html += `<div class="modal-outlook">
        <div class="modal-outlook-label">🔭 전망</div>
        <div class="modal-outlook-text">${esc(s.outlook)}</div>
      </div>`;
    }
    if (s.risk_factors) {
      html += `<div style="margin-top:10px;font-size:0.8rem;color:#f87171">⚠️ ${esc(s.risk_factors)}</div>`;
    }

    if (articles?.length) {
      html += `<div class="modal-articles"><div class="modal-articles-title">📰 원문 기사 (${articles.length}건)</div>`;
      articles.forEach(a => {
        html += `<div class="modal-article">
          <span class="modal-article-title">${esc(a.title)}</span>
          <a href="${a.link}" target="_blank" rel="noopener" class="modal-article-link">원문 ↗</a>
        </div>`;
      });
      html += '</div>';
    }

    document.getElementById('stockNewsContent').innerHTML = html;
  }

  function closeStockNews() {
    document.getElementById('stockNewsModal').classList.remove('active');
  }
  document.getElementById('stockNewsModal')?.addEventListener('click', e => {
    if (e.target.id === 'stockNewsModal') closeStockNews();
  });

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

  // ── loadOps: 5개 API 병렬 호출 + 갱신 시각 + stale 경고 + 자동 새로고침 ──
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
