// tracker.js - 크롬 우측 네이티브 사이드 패널(Side Panel) 전용 컨트롤러 + 도메인 필터 관리

(function () {
  const DEFAULT_ALLOWED_DOMAINS = [];

  // 사이드 패널 열림/닫힘 상태를 background.js 및 하단 퀵 바와 실시간 동기화
  try {
    const sidePanelPort = chrome.runtime.connect({ name: 'url-tracker-sidepanel' });
    sidePanelPort.onMessage.addListener((msg) => {
      if (msg?.type === 'URL_TRACKER_CLOSE_SIDEPANEL') {
        window.close();
      }
    });
  } catch {}

  const btnToggleDomains = document.getElementById('btnToggleDomains');
  const btnToggleHover = document.getElementById('btnToggleHover');
  const btnTogglePause = document.getElementById('btnTogglePause');
  const btnClearLogs = document.getElementById('btnClearLogs');

  const domainPanel = document.getElementById('domainPanel');
  const btnQuickRegisterCurrent = document.getElementById('btnQuickRegisterCurrent');
  const domainChips = document.getElementById('domainChips');
  const domainInput = document.getElementById('domainInput');
  const btnAddDomain = document.getElementById('btnAddDomain');
  const unallowedBanner = document.getElementById('unallowedBanner');

  const hoverSection = document.getElementById('hoverSection');
  const hoverHistoryEl = document.getElementById('hoverHistory');
  const tabAll = document.getElementById('tabAll');
  const tabNav = document.getElementById('tabNav');
  const tabIframe = document.getElementById('tabIframe');
  const tabAjax = document.getElementById('tabAjax');
  const searchInput = document.getElementById('searchInput');
  const chkPreserveLog = document.getElementById('chkPreserveLog');
  const preserveLogLabel = document.getElementById('preserveLogLabel');
  const logList = document.getElementById('logList');

  const state = {
    activeTabId: null,
    currentHostname: '',
    isDomainAllowed: true,
    allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
    domainPanelOpen: false,
    logs: [],
    latestHover: null,
    hoverHistory: [],
    filterKind: 'ALL',
    searchQuery: '',
    expandedIds: new Set(),
    hoverEnabled: true,
    paused: false,
    preserveLog: false
  };

  function getItemCategory(item) {
    if (!item) return 'NAV';
    if (item.kind === 'IFRAME_NAV' || item.kind === 'IFRAME') return 'IFRAME';
    if (item.kind === 'AJAX') return 'AJAX';
    return 'NAV';
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeDomainInput(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let s = raw.trim().toLowerCase();
    if (!s) return '';
    try {
      if (s.startsWith('http://') || s.startsWith('https://')) {
        return new URL(s).hostname.toLowerCase();
      }
    } catch {}
    s = s.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].trim();
    return s;
  }

  function checkDomainMatch(hostname, domains = state.allowedDomains) {
    if (!hostname) return false;
    const h = String(hostname).toLowerCase();
    for (const raw of domains || []) {
      const d = String(raw || '').trim().toLowerCase();
      if (!d) continue;
      if (d === h) return true;
      if (d.startsWith('*.') && (h === d.slice(2) || h.endsWith('.' + d.slice(2)))) return true;
    }
    return false;
  }

  async function copyToClipboard(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  function flashButtonCopied(btn, label = '✅ 복사됨!') {
    const orig = btn.textContent;
    btn.classList.add('copied');
    btn.textContent = label;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = orig;
    }, 900);
  }

  function syncSettingsUI() {
    btnToggleDomains.classList.toggle('active', state.domainPanelOpen);
    domainPanel.classList.toggle('open', state.domainPanelOpen);

    btnToggleHover.textContent = state.hoverEnabled ? '🔍 호버 ON' : '🔍 호버 OFF';
    btnToggleHover.classList.toggle('active', state.hoverEnabled);

    btnTogglePause.textContent = state.paused ? '▶ 재개' : '⏸ 일시정지';
    btnTogglePause.classList.toggle('warn', state.paused);

    if (chkPreserveLog) chkPreserveLog.checked = Boolean(state.preserveLog);
    if (preserveLogLabel) preserveLogLabel.classList.toggle('active', Boolean(state.preserveLog));
  }

  function renderDomainManager() {
    if (state.allowedDomains.length === 0) {
      domainChips.innerHTML = `<span style="color:#94a3b8;font-size:11.5px;">등록된 도메인이 없습니다. 위 [⚡ 현재 접속 도메인 바로 등록] 버튼을 누르거나 직접 입력해 주세요.</span>`;
    } else {
      domainChips.innerHTML = state.allowedDomains
        .map(
          (d) => `
          <span class="dchip">
            <span>${escapeHtml(d)}</span>
            <button data-remove-domain="${escapeHtml(d)}" title="도메인 삭제">✕</button>
          </span>
        `
        )
        .join('');
    }

    domainChips.querySelectorAll('[data-remove-domain]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-remove-domain');
        const next = state.allowedDomains.filter((d) => d !== target);
        updateAllowedDomains(next);
      });
    });

    state.isDomainAllowed = checkDomainMatch(state.currentHostname, state.allowedDomains);

    if (btnQuickRegisterCurrent) {
      if (state.currentHostname) {
        if (state.isDomainAllowed) {
          btnQuickRegisterCurrent.textContent = `✅ 현재 접속 도메인 등록됨 (${state.currentHostname})`;
          btnQuickRegisterCurrent.classList.add('registered');
        } else {
          btnQuickRegisterCurrent.textContent = `⚡ 현재 접속 도메인 바로 등록 (${state.currentHostname})`;
          btnQuickRegisterCurrent.classList.remove('registered');
        }
      } else {
        btnQuickRegisterCurrent.textContent = `⚡ 현재 접속한 페이지 도메인 바로 등록`;
        btnQuickRegisterCurrent.classList.remove('registered');
      }
    }

    if (state.currentHostname && !state.isDomainAllowed) {
      unallowedBanner.classList.add('show');
      unallowedBanner.innerHTML = `
        <div>🚫 현재 사이트(<b>${escapeHtml(state.currentHostname)}</b>)는 등록된 허용 도메인이 아니므로 트래커가 비활성화되어 있습니다.</div>
        <button id="btnAllowCurrentSite" class="add-current-btn">⚡ 현재 접속 도메인 (${escapeHtml(
          state.currentHostname
        )}) 바로 등록하기</button>
      `;
      const addCurrentBtn = document.getElementById('btnAllowCurrentSite');
      if (addCurrentBtn) {
        addCurrentBtn.addEventListener('click', () => {
          registerCurrentPageDomain();
        });
      }
    } else if (!state.currentHostname && state.allowedDomains.length === 0) {
      unallowedBanner.classList.add('show');
      unallowedBanner.innerHTML = `
        <div>💡 추적할 웹사이트 탭으로 이동한 뒤 아래 버튼을 누르면 현재 접속한 도메인이 바로 등록됩니다.</div>
        <button id="btnAllowCurrentSite" class="add-current-btn">⚡ 현재 접속한 페이지 도메인 바로 등록</button>
      `;
      const addCurrentBtn = document.getElementById('btnAllowCurrentSite');
      if (addCurrentBtn) {
        addCurrentBtn.addEventListener('click', () => {
          registerCurrentPageDomain();
        });
      }
    } else {
      unallowedBanner.classList.remove('show');
      unallowedBanner.innerHTML = '';
    }
  }

  function registerCurrentPageDomain() {
    if (state.currentHostname) {
      addDomain(state.currentHostname);
      return;
    }
    if (chrome.tabs?.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs?.[0];
        const host = normalizeDomainInput(activeTab?.url || '');
        if (host) {
          state.currentHostname = host;
          addDomain(host);
        }
      });
    }
  }

  function addDomain(rawInput) {
    const clean = normalizeDomainInput(rawInput);
    if (!clean) return;
    if (!state.allowedDomains.includes(clean)) {
      updateAllowedDomains([...state.allowedDomains, clean]);
    }
    domainInput.value = '';
  }

  function updateAllowedDomains(nextDomains) {
    state.allowedDomains = nextDomains;
    state.isDomainAllowed = checkDomainMatch(state.currentHostname, state.allowedDomains);
    chrome.storage.local.set({ ut_allowedDomains: state.allowedDomains });
    chrome.runtime.sendMessage({
      type: 'URL_TRACKER_BROADCAST_SETTINGS',
      settings: { allowedDomains: state.allowedDomains }
    }).catch(() => {});
    renderDomainManager();
  }

  chrome.storage.local.get(
    ['ut_allowedDomains', 'ut_hoverEnabled', 'ut_paused', 'ut_preserveLog'],
    (res) => {
      if (Array.isArray(res.ut_allowedDomains)) {
        state.allowedDomains = res.ut_allowedDomains;
      }
      if (state.allowedDomains.length === 0) {
        state.domainPanelOpen = true;
      }
      if (typeof res.ut_hoverEnabled === 'boolean') state.hoverEnabled = res.ut_hoverEnabled;
      if (typeof res.ut_paused === 'boolean') state.paused = res.ut_paused;
      if (typeof res.ut_preserveLog === 'boolean') state.preserveLog = res.ut_preserveLog;
      syncSettingsUI();
      renderDomainManager();
    }
  );

  function updateSetting(patch) {
    Object.assign(state, patch);
    syncSettingsUI();
    const toStore = {};
    if ('hoverEnabled' in patch) toStore.ut_hoverEnabled = state.hoverEnabled;
    if ('paused' in patch) toStore.ut_paused = state.paused;
    if ('preserveLog' in patch) toStore.ut_preserveLog = state.preserveLog;
    chrome.storage.local.set(toStore);
    chrome.runtime.sendMessage({
      type: 'URL_TRACKER_BROADCAST_SETTINGS',
      settings: patch
    }).catch(() => {});
  }

  // 초기 데이터 로드
  chrome.runtime.sendMessage({ type: 'URL_TRACKER_INIT_SIDEPANEL' }, (res) => {
    if (!res) return;
    state.activeTabId = res.tabId ?? null;
    state.currentHostname = res.hostname || '';
    if (Array.isArray(res.allowedDomains)) {
      state.allowedDomains = res.allowedDomains;
    }
    if (state.allowedDomains.length === 0) {
      state.domainPanelOpen = true;
    }
    if (typeof res.preserveLog === 'boolean') {
      state.preserveLog = res.preserveLog;
    }
    state.isDomainAllowed = Boolean(res.isDomainAllowed);
    state.logs = Array.isArray(res.logs) ? res.logs : [];
    state.latestHover = res.hover || null;
    state.hoverHistory = Array.isArray(res.hoverHistory) ? res.hoverHistory : [];
    syncSettingsUI();
    renderDomainManager();
    renderHoverSection();
    renderHoverHistory();
    renderLogs();
  });

  // 상단 버튼 이벤트
  btnToggleDomains.addEventListener('click', () => {
    state.domainPanelOpen = !state.domainPanelOpen;
    syncSettingsUI();
  });

  if (btnQuickRegisterCurrent) {
    btnQuickRegisterCurrent.addEventListener('click', () => {
      registerCurrentPageDomain();
    });
  }

  btnAddDomain.addEventListener('click', () => {
    addDomain(domainInput.value);
  });

  domainInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addDomain(domainInput.value);
    }
  });

  btnToggleHover.addEventListener('click', () => {
    updateSetting({ hoverEnabled: !state.hoverEnabled });
  });

  btnTogglePause.addEventListener('click', () => {
    updateSetting({ paused: !state.paused });
  });

  btnClearLogs.addEventListener('click', () => {
    state.logs = [];
    state.hoverHistory = [];
    state.expandedIds.clear();
    chrome.runtime.sendMessage({
      type: 'URL_TRACKER_CLEAR_TAB_LOGS',
      tabId: state.activeTabId
    }).catch(() => {});
    renderLogs();
    renderHoverHistory();
  });

  [tabAll, tabNav, tabIframe, tabAjax].forEach((btn) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      state.filterKind = btn.getAttribute('data-filter') || 'ALL';
      [tabAll, tabNav, tabIframe, tabAjax].forEach(
        (b) => b && b.classList.toggle('active', b === btn)
      );
      renderLogs();
    });
  });

  if (chkPreserveLog) {
    chkPreserveLog.addEventListener('change', () => {
      updateSetting({ preserveLog: chkPreserveLog.checked });
    });
  }

  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value || '';
    renderLogs();
  });

  // 실시간 이벤트 수신
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'URL_TRACKER_CLOSE_SIDEPANEL') {
      window.close();
      return;
    }

    if (msg.type === 'URL_TRACKER_ACTIVE_TAB_CHANGED') {
      state.activeTabId = msg.tabId;
      state.currentHostname = msg.hostname || '';
      if (Array.isArray(msg.allowedDomains)) {
        state.allowedDomains = msg.allowedDomains;
      }
      state.isDomainAllowed = Boolean(msg.isDomainAllowed);
      state.logs = Array.isArray(msg.logs) ? msg.logs : [];
      state.latestHover = msg.hover || null;
      state.hoverHistory = Array.isArray(msg.hoverHistory) ? msg.hoverHistory : [];
      state.expandedIds.clear();
      renderDomainManager();
      renderHoverSection();
      renderHoverHistory();
      renderLogs();
      return;
    }

    if (msg.type === 'URL_TRACKER_NEW_ENTRY') {
      if (state.activeTabId == null) state.activeTabId = msg.tabId;
      if (msg.tabId === state.activeTabId && msg.entry) {
        const idx = state.logs.findIndex((x) => x.id === msg.entry.id);
        if (idx >= 0) {
          state.logs[idx] = { ...state.logs[idx], ...msg.entry };
        } else {
          state.logs.unshift(msg.entry);
          if (state.logs.length > 200) state.logs.length = 200;
        }
        renderLogs();
      }
      return;
    }

    if (msg.type === 'URL_TRACKER_UPDATE_ENTRY') {
      if (msg.tabId === state.activeTabId && msg.payload?.id) {
        const target = state.logs.find((x) => x.id === msg.payload.id);
        if (target) {
          Object.assign(target, msg.payload);
          renderLogs();
        }
      }
      return;
    }

    if (msg.type === 'URL_TRACKER_HOVER_UPDATED') {
      if (state.activeTabId == null) state.activeTabId = msg.tabId;
      if (msg.tabId === state.activeTabId) {
        state.latestHover = msg.payload;
        if (Array.isArray(msg.hoverHistory)) state.hoverHistory = msg.hoverHistory;
        renderHoverSection();
        renderHoverHistory();
      }
      return;
    }

    if (msg.type === 'URL_TRACKER_LOGS_CLEARED') {
      if (msg.tabId === state.activeTabId) {
        state.logs = [];
        renderLogs();
      }
      return;
    }

    if (msg.type === 'URL_TRACKER_SETTINGS_UPDATED' && msg.settings) {
      if (Array.isArray(msg.settings.allowedDomains)) {
        state.allowedDomains = msg.settings.allowedDomains;
        renderDomainManager();
      }
      if (typeof msg.settings.hoverEnabled === 'boolean') {
        state.hoverEnabled = msg.settings.hoverEnabled;
      }
      if (typeof msg.settings.paused === 'boolean') {
        state.paused = msg.settings.paused;
      }
      if (typeof msg.settings.preserveLog === 'boolean') {
        state.preserveLog = msg.settings.preserveLog;
      }
      syncSettingsUI();
    }
  });

  function renderHoverSection() {
    const info = state.latestHover;
    const candidate = info?.candidates?.[0];
    if (!info || !candidate) {
      hoverSection.innerHTML = `
        <div class="hover-head">
          <span class="hover-title">🎯 마우스 호버 URL 미리보기</span>
        </div>
        <div style="color:#64748b;font-size:11.5px;">웹 화면에서 버튼·메뉴·DataTables 목록 행에 마우스를 올리면 표시됩니다.</div>
      `;
      return;
    }

    const paramsObj = candidate.params || {};
    const pEntries = Object.entries(paramsObj);

    hoverSection.innerHTML = `
      <div class="hover-head">
        <div class="hover-title">
          <span>🎯 ${escapeHtml(info.element?.text || '요소')}</span>
          <span class="click-tag">${escapeHtml(candidate.kind)}</span>
        </div>
        <div class="mini-btns">
          <button class="mini-btn" data-copy="${escapeHtml(candidate.displayUrl)}">📋 URL 복사</button>
          ${
            pEntries.length > 0
              ? `<button class="mini-btn" data-copy="${escapeHtml(
                  JSON.stringify(paramsObj, null, 2)
                )}">📦 파라미터</button>`
              : ''
          }
        </div>
      </div>
      <div class="hover-url">${escapeHtml(candidate.displayUrl)}</div>
      ${
        pEntries.length > 0
          ? `<div class="preview-params">
              ${pEntries
                .slice(0, 6)
                .map(
                  ([k, v]) =>
                    `<span class="pchip" data-copy="${escapeHtml(`${k}=${v}`)}"><span class="k">${escapeHtml(
                      k
                    )}</span>=<span class="v">${escapeHtml(String(v).slice(0, 24))}</span></span>`
                )
                .join('')}
            </div>`
          : ''
      }
    `;

    bindCopyButtons(hoverSection);
  }

  function formatHoverTime(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':');
  }

  // 최근 마우스 탐색(호버) URL 5건: 행 클릭 시 해당 URL 복사
  function renderHoverHistory() {
    const items = state.hoverHistory || [];
    if (items.length === 0) {
      hoverHistoryEl.innerHTML = `
        <div class="hh-title">🕘 최근 탐색 (0)</div>
        <div class="hh-empty">아직 마우스로 훑어본 URL이 없습니다.</div>
      `;
      return;
    }

    hoverHistoryEl.innerHTML = `
      <div class="hh-title">🕘 최근 탐색 (${items.length})</div>
      ${items
        .map(
          (item, idx) => `
          <div class="hh-item${item.repeat > 0 ? ' repeated' : ''}" title="클릭하면 이 URL을 복사합니다: ${escapeHtml(item.url)}">
            <span class="hh-idx">#${idx + 1}</span>
            <span class="hh-el">🎯 ${escapeHtml(item.elementText || '요소')}</span>
            <span class="click-tag" title="${escapeHtml(item.kind || '호버')}">${escapeHtml(item.kind || '호버')}</span>
            <span class="hh-url">${escapeHtml(item.url)}</span>
            ${item.repeat > 0 ? `<span class="hh-repeat" title="포커스 아웃 후 다시 올린 횟수">(${item.repeat})</span>` : ''}
            <span class="time">${escapeHtml(formatHoverTime(item.timestamp))}</span>
            <button class="mini-btn" data-copy="${escapeHtml(item.url)}">📋</button>
          </div>
        `
        )
        .join('')}
    `;

    bindCopyButtons(hoverHistoryEl);
    hoverHistoryEl.querySelectorAll('.hh-item').forEach((row) => {
      row.addEventListener('click', () => {
        row.querySelector('[data-copy]')?.click();
      });
    });
  }

  function renderLogs() {
    const navCount = state.logs.filter((x) => getItemCategory(x) === 'NAV').length;
    const iframeCount = state.logs.filter((x) => getItemCategory(x) === 'IFRAME').length;
    const ajaxCount = state.logs.filter((x) => getItemCategory(x) === 'AJAX').length;

    tabAll.textContent = `전체 (${state.logs.length})`;
    tabNav.textContent = `🚀 페이지 이동 (${navCount})`;
    if (tabIframe) tabIframe.textContent = `🖼️ IFRAME 전환 (${iframeCount})`;
    tabAjax.textContent = `⚡ Ajax 호출 (${ajaxCount})`;

    const q = state.searchQuery.trim().toLowerCase();
    const filtered = state.logs.filter((item) => {
      if (state.filterKind !== 'ALL' && getItemCategory(item) !== state.filterKind) return false;
      if (!q) return true;
      const hay = [
        item.displayUrl,
        item.badge,
        item.clickContext?.text,
        JSON.stringify(item.queryParams || {}),
        JSON.stringify(item.bodyParams || {})
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });

    if (filtered.length === 0) {
      const domainDesc =
        state.allowedDomains.length > 0
          ? `등록된 도메인(${escapeHtml(state.allowedDomains.join(', '))})`
          : '상단 [🌐 도메인]에서 허용 도메인을 추가한 사이트';
      logList.innerHTML = `
        <div class="empty">
          기록된 페이지 이동이나 Ajax 호출이 없습니다.<br/>
          ${domainDesc}에서 메뉴·버튼·목록을 클릭하면 이곳에 실시간 표시됩니다.
        </div>
      `;
      return;
    }

    logList.innerHTML = filtered.map((item) => renderLogItemHtml(item)).join('');

    bindCopyButtons(logList);

    logList.querySelectorAll('[data-toggle-id]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('[data-copy]')) return;
        const id = el.getAttribute('data-toggle-id');
        if (state.expandedIds.has(id)) {
          state.expandedIds.delete(id);
        } else {
          state.expandedIds.add(id);
        }
        renderLogs();
      });
    });
  }

  function renderLogItemHtml(item) {
    const isExpanded = state.expandedIds.has(item.id);
    const cat = getItemCategory(item);
    const badgeClass =
      cat === 'IFRAME'
        ? 'iframe'
        : cat === 'NAV'
        ? 'nav'
        : item.method === 'POST'
        ? 'post'
        : 'ajax';

    const mergedParams = {
      ...(item.queryParams || {}),
      ...(item.bodyParams || {})
    };
    const paramEntries = Object.entries(mergedParams);

    const previewChips =
      paramEntries.length > 0
        ? `<div class="preview-params">
            ${paramEntries
              .slice(0, 6)
              .map(
                ([k, v]) =>
                  `<span class="pchip" data-copy="${escapeHtml(
                    `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`
                  )}" title="클릭하여 복사"><span class="k">${escapeHtml(
                    k
                  )}</span>=<span class="v">${escapeHtml(
                    String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 28)
                  )}</span></span>`
              )
              .join('')}
            ${
              paramEntries.length > 6
                ? `<span class="pchip" data-toggle-id="${escapeHtml(item.id)}">+${
                    paramEntries.length - 6
                  }개 더보기</span>`
                : ''
            }
          </div>`
        : '';

    let detailHtml = '';
    if (isExpanded) {
      const qEntries = Object.entries(item.queryParams || {});
      const bEntries = Object.entries(item.bodyParams || {});

      detailHtml = `
        <div class="details">
          ${
            qEntries.length > 0
              ? `<div class="detail-sec">
                  <div class="detail-title">
                    <span>🔹 Query 파라미터 (${qEntries.length})</span>
                    <button class="mini-btn" data-copy="${escapeHtml(
                      JSON.stringify(item.queryParams, null, 2)
                    )}">JSON 복사</button>
                  </div>
                  <table class="param-table">
                    ${qEntries
                      .map(
                        ([k, v]) =>
                          `<tr><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(
                            typeof v === 'object' ? JSON.stringify(v) : String(v)
                          )}</td></tr>`
                      )
                      .join('')}
                  </table>
                </div>`
              : ''
          }
          ${
            bEntries.length > 0
              ? `<div class="detail-sec">
                  <div class="detail-title">
                    <span>🔸 Body / Form 파라미터 (${bEntries.length})</span>
                    <button class="mini-btn" data-copy="${escapeHtml(
                      JSON.stringify(item.bodyParams, null, 2)
                    )}">JSON 복사</button>
                  </div>
                  <table class="param-table">
                    ${bEntries
                      .map(
                        ([k, v]) =>
                          `<tr><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(
                            typeof v === 'object' ? JSON.stringify(v) : String(v)
                          )}</td></tr>`
                      )
                      .join('')}
                  </table>
                </div>`
              : ''
          }
        </div>
      `;
    }

    return `
      <div class="log-item" data-id="${escapeHtml(item.id)}">
        <div class="item-head" data-toggle-id="${escapeHtml(item.id)}">
          <div class="badges">
            <span class="badge ${badgeClass}">${escapeHtml(item.badge)}</span>
            ${
              item.clickContext
                ? `<span class="click-tag">🖱️ ${escapeHtml(item.clickContext.text)}</span>`
                : ''
            }
            ${
              item.status
                ? `<span style="font-size:10.5px;color:#94a3b8;font-family:Consolas,monospace;">${escapeHtml(
                    item.status
                  )}</span>`
                : ''
            }
          </div>
          <span class="time">${escapeHtml(item.timeStr || '')} ${isExpanded ? '▲' : '▼'}</span>
        </div>
        <div class="url-row">
          <div class="url-text" data-toggle-id="${escapeHtml(
            item.id
          )}" title="클릭하여 파라미터 상세 펼치기/접기">${escapeHtml(item.displayUrl)}</div>
          <div class="mini-btns">
            <button class="mini-btn" data-copy="${escapeHtml(item.displayUrl)}">📋 URL 복사</button>
            ${
              paramEntries.length > 0
                ? `<button class="mini-btn" data-copy="${escapeHtml(
                    JSON.stringify(mergedParams, null, 2)
                  )}">📦 파라미터</button>`
                : ''
            }
          </div>
        </div>
        ${previewChips}
        ${detailHtml}
      </div>
    `;
  }

  function bindCopyButtons(container) {
    container.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const text = btn.getAttribute('data-copy');
        await copyToClipboard(text);
        flashButtonCopied(btn, '✅ 복사됨!');
      });
    });
  }

  // 사이드 패널에 포커스가 있을 때도 Alt+C 즉시 복사 지원
  window.addEventListener('keydown', async (e) => {
    if (e.altKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
      const hoverUrl = state.latestHover?.candidates?.[0]?.displayUrl;
      const fallbackUrl = state.logs?.[0]?.displayUrl;
      const targetUrl = hoverUrl || fallbackUrl;
      if (!targetUrl) return;
      e.preventDefault();
      await copyToClipboard(targetUrl);
      const hoverCopyBtn = hoverSection?.querySelector('[data-copy]');
      if (hoverCopyBtn && hoverUrl) {
        flashButtonCopied(hoverCopyBtn, '✅ 복사완료!');
      }
      if (state.activeTabId != null) {
        chrome.runtime
          .sendMessage({
            type: 'URL_TRACKER_QUICKBAR_COPIED',
            tabId: state.activeTabId,
            url: targetUrl
          })
          .catch(() => {});
      }
    }
  });
})();
