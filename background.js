// background.js - 크롬 네이티브 사이드 패널(Side Panel) 연동, 도메인 필터링 및 탭별 트래킹 데이터 관리

const DEFAULT_ALLOWED_DOMAINS = [];
const TAB_LOGS = new Map(); // tabId -> Array of log items
const TAB_HOVER = new Map(); // tabId -> latest hover payload
const POPUP_OWNER_TAB = new Map(); // popupTabId -> parent(owner) tabId
const MAX_LOGS_PER_TAB = 200;

let allowedDomains = [...DEFAULT_ALLOWED_DOMAINS];
let preserveLog = false; // 크롬 DevTools Preserve log (기본값: OFF - 화면 이동 시 자동 리셋)
let lastActiveWebTabId = null;
const activeSidePanelPorts = new Set();

function isSidePanelOpen() {
  return activeSidePanelPorts.size > 0;
}

function broadcastSidePanelState(open) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs || []) {
      if (tab.id != null) {
        chrome.tabs
          .sendMessage(
            tab.id,
            {
              type: 'URL_TRACKER_SIDEPANEL_STATE',
              open
            },
            { frameId: 0 }
          )
          .catch(() => {});
      }
    }
  });
}

if (chrome.runtime?.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'url-tracker-sidepanel') {
      activeSidePanelPorts.add(port);
      broadcastSidePanelState(true);
      port.onDisconnect.addListener(() => {
        activeSidePanelPorts.delete(port);
        broadcastSidePanelState(isSidePanelOpen());
      });
    }
  });
}

function initSidePanelBehavior() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  }
}

function loadAllowedDomains() {
  chrome.storage.local.get(['ut_allowedDomains', 'ut_preserveLog'], (res) => {
    if (Array.isArray(res.ut_allowedDomains)) {
      allowedDomains = res.ut_allowedDomains;
    } else {
      allowedDomains = [...DEFAULT_ALLOWED_DOMAINS];
      chrome.storage.local.set({ ut_allowedDomains: allowedDomains });
    }
    if (typeof res.ut_preserveLog === 'boolean') {
      preserveLog = res.ut_preserveLog;
    }
  });
}

initSidePanelBehavior();
loadAllowedDomains();
chrome.runtime.onInstalled.addListener(() => {
  initSidePanelBehavior();
  loadAllowedDomains();
});
chrome.runtime.onStartup.addListener(() => {
  initSidePanelBehavior();
  loadAllowedDomains();
});

function extractHostname(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.hostname.toLowerCase();
    }
  } catch {}
  return '';
}

function checkDomainMatch(hostname, domains = allowedDomains) {
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

function isTrackableWebUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

function getTabLogs(tabId) {
  if (!TAB_LOGS.has(tabId)) {
    TAB_LOGS.set(tabId, []);
  }
  return TAB_LOGS.get(tabId);
}

function broadcastToSidePanel(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {}
}

function notifyActiveTabToSidePanel(tab) {
  if (!tab || tab.id == null) return;
  const hostname = extractHostname(tab.url);
  if (isTrackableWebUrl(tab.url)) {
    lastActiveWebTabId = tab.id;
  }
  broadcastToSidePanel({
    type: 'URL_TRACKER_ACTIVE_TAB_CHANGED',
    tabId: tab.id,
    hostname,
    isDomainAllowed: checkDomainMatch(hostname),
    allowedDomains,
    logs: getTabLogs(tab.id),
    hover: TAB_HOVER.get(tab.id) || null
  });
}

async function isPopupWindowTab(tab) {
  if (!tab || tab.id == null) return false;
  if (POPUP_OWNER_TAB.has(tab.id)) return true;
  if (tab.windowId != null && chrome.windows?.get) {
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win?.type === 'popup') {
        const ownerId = tab.openerTabId ?? lastActiveWebTabId;
        if (ownerId != null && ownerId !== tab.id) {
          POPUP_OWNER_TAB.set(tab.id, ownerId);
        }
        return true;
      }
    } catch {}
  }
  return false;
}

if (chrome.tabs?.onCreated) {
  chrome.tabs.onCreated.addListener(async (tab) => {
    await isPopupWindowTab(tab);
  });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return;
    // 팝업창이 포커스될 때는 부모 창의 사이드 패널을 빈 탭으로 전환하지 않음
    if (await isPopupWindowTab(tab)) return;
    notifyActiveTabToSidePanel(tab);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (await isPopupWindowTab(tab)) {
    return;
  }
  // 로그 보관(Preserve log) OFF 상태에서 새로고침(F5) 또는 주소창 직접 이동 시 이전 로그 리셋
  if (changeInfo.status === 'loading' && !preserveLog) {
    const logs = getTabLogs(tabId);
    const latest = logs[0];
    const isRecentNavEvent =
      latest &&
      ['PAGE_MOVE', 'FORM_SUBMIT', 'IFRAME_NAV', 'POPUP'].includes(latest.kind) &&
      Date.now() - (latest.timestamp || 0) < 2000;
    if (logs.length > 0 && !isRecentNavEvent) {
      TAB_LOGS.set(tabId, []);
      broadcastToSidePanel({
        type: 'URL_TRACKER_LOGS_CLEARED',
        tabId
      });
    }
  }
  if (tab?.active && (changeInfo.status === 'complete' || changeInfo.url)) {
    notifyActiveTabToSidePanel(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  TAB_LOGS.delete(tabId);
  TAB_HOVER.delete(tabId);
  POPUP_OWNER_TAB.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTab = sender.tab;
  const rawTabId = senderTab?.id ?? message?.tabId ?? null;
  const senderHost = extractHostname(senderTab?.url || sender.url || '');

  // 팝업창 내부에서 발생한 이벤트는 부모(메인) 탭의 사이드 패널 로그로 통합 라우팅
  let tabId = rawTabId;
  let isFromPopup = false;
  if (rawTabId != null) {
    if (POPUP_OWNER_TAB.has(rawTabId)) {
      tabId = POPUP_OWNER_TAB.get(rawTabId);
      isFromPopup = true;
    } else if (message?.payload?.isPopupWindow) {
      const ownerId = senderTab?.openerTabId ?? lastActiveWebTabId;
      if (ownerId != null && ownerId !== rawTabId) {
        POPUP_OWNER_TAB.set(rawTabId, ownerId);
        tabId = ownerId;
      }
      isFromPopup = true;
    }
  }

  // 1) 새로운 페이지 이동 / IFRAME 전환 / 팝업 / Ajax 이벤트 수신 (허용된 도메인만 기록)
  if (message?.type === 'URL_TRACKER_EVENT' && tabId != null) {
    if (!checkDomainMatch(senderHost)) {
      sendResponse({ ok: false, ignored: true });
      return false;
    }

    if (!isFromPopup) {
      lastActiveWebTabId = tabId;
    }

    const entry = {
      ...message.payload,
      tabId,
      frameId: sender.frameId ?? 0,
      frameUrl: sender.url || message.payload?.frameUrl || ''
    };

    if (isFromPopup && entry.badge && !entry.badge.includes('팝업')) {
      entry.badge = `[팝업] ${entry.badge}`;
    }

    const logs = getTabLogs(tabId);

    // 부모창에서 이미 window.open/팝업 폼 전송으로 기록된 직후(3초 이내) 팝업창 초기 로드 중복 이벤트가 오면 무시
    if (entry.isPopupInitialLoad) {
      const hasRecentPopup = logs.some(
        (x) =>
          x.kind === 'POPUP' &&
          (x.displayUrl === entry.displayUrl ||
            x.displayUrl?.split('?')[0] === entry.displayUrl?.split('?')[0]) &&
          Math.abs((entry.timestamp || Date.now()) - (x.timestamp || 0)) < 3000
      );
      if (hasRecentPopup) {
        sendResponse({ ok: true, deduplicated: true });
        return false;
      }
    }

    // 부모창 iframe.src 변경과 자식 프레임 navigate 이벤트가 동시에 발생할 때 중복 방지 (800ms 이내 동일 URL)
    const latest = logs[0];
    if (
      latest &&
      latest.kind === entry.kind &&
      ['IFRAME_NAV', 'PAGE_MOVE', 'POPUP'].includes(entry.kind) &&
      latest.displayUrl === entry.displayUrl &&
      Math.abs((entry.timestamp || Date.now()) - (latest.timestamp || 0)) < 800
    ) {
      sendResponse({ ok: true, deduplicated: true });
      return false;
    }

    // 로그 보관(Preserve log) OFF일 때 메인 화면 전환(페이지 이동 / 폼 전송 / IFRAME 전환) 발생 시 이전 로그 리셋 (팝업 오픈은 기존 로그 유지 또는 리셋 대상 제외)
    if (
      !preserveLog &&
      !isFromPopup &&
      ['PAGE_MOVE', 'FORM_SUBMIT', 'IFRAME_NAV'].includes(entry.kind)
    ) {
      logs.length = 0;
      broadcastToSidePanel({
        type: 'URL_TRACKER_LOGS_CLEARED',
        tabId
      });
    }

    const existingIdx = logs.findIndex((x) => x.id === entry.id);
    if (existingIdx >= 0) {
      logs[existingIdx] = { ...logs[existingIdx], ...entry };
    } else {
      logs.unshift(entry);
      if (logs.length > MAX_LOGS_PER_TAB) {
        logs.length = MAX_LOGS_PER_TAB;
      }
    }

    broadcastToSidePanel({
      type: 'URL_TRACKER_NEW_ENTRY',
      tabId,
      entry
    });

    if (entry.displayUrl) {
      chrome.tabs
        .sendMessage(
          tabId,
          {
            type: 'URL_TRACKER_QUICKBAR_UPDATE',
            url: entry.displayUrl,
            badge: entry.badge || entry.method || '호출'
          },
          { frameId: 0 }
        )
        .catch(() => {});
    }

    sendResponse({ ok: true });
    return false;
  }

  // 2) 응답 상태코드/소요시간 업데이트
  if (message?.type === 'URL_TRACKER_EVENT_UPDATE' && tabId != null) {
    if (!checkDomainMatch(senderHost)) {
      sendResponse({ ok: false });
      return false;
    }
    const patch = message.payload;
    if (patch?.id) {
      const logs = getTabLogs(tabId);
      const target = logs.find((x) => x.id === patch.id);
      if (target) {
        Object.assign(target, patch);
      }
      broadcastToSidePanel({
        type: 'URL_TRACKER_UPDATE_ENTRY',
        tabId,
        payload: patch
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  // 3) 실시간 마우스 호버(Hover) 정보 업데이트
  if (message?.type === 'URL_TRACKER_HOVER' && tabId != null) {
    if (!checkDomainMatch(senderHost)) {
      sendResponse({ ok: false });
      return false;
    }
    TAB_HOVER.set(tabId, message.payload);
    broadcastToSidePanel({
      type: 'URL_TRACKER_HOVER_UPDATED',
      tabId,
      payload: message.payload
    });
    const firstHoverUrl = message.payload?.candidates?.[0]?.displayUrl;
    if (firstHoverUrl) {
      chrome.tabs
        .sendMessage(
          tabId,
          {
            type: 'URL_TRACKER_QUICKBAR_UPDATE',
            url: firstHoverUrl,
            badge: '호버'
          },
          { frameId: 0 }
        )
        .catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  // 4) 사이드 패널 초기 로드 시 현재 활성 탭 데이터 및 도메인 허용 여부 전달
  if (message?.type === 'URL_TRACKER_INIT_SIDEPANEL') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs?.[0];
      const rawId = activeTab?.id ?? lastActiveWebTabId;
      const targetId = rawId != null && POPUP_OWNER_TAB.has(rawId) ? POPUP_OWNER_TAB.get(rawId) : rawId;
      const hostname = extractHostname(activeTab?.url || '');
      sendResponse({
        tabId: targetId,
        hostname,
        isDomainAllowed: checkDomainMatch(hostname),
        allowedDomains,
        preserveLog,
        logs: targetId != null ? getTabLogs(targetId) : [],
        hover: targetId != null ? TAB_HOVER.get(targetId) || null : null
      });
    });
    return true;
  }

  // 5) 현재 탭 로그 비우기
  if (message?.type === 'URL_TRACKER_CLEAR_TAB_LOGS') {
    const targetId = message.tabId ?? tabId ?? lastActiveWebTabId;
    if (targetId != null) {
      TAB_LOGS.set(targetId, []);
      broadcastToSidePanel({
        type: 'URL_TRACKER_LOGS_CLEARED',
        tabId: targetId
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  // 6) 단축키(Alt+Q) 또는 우측 하단 퀵 바 '트래커 열기 / 닫기' 버튼 요청
  if (message?.type === 'URL_TRACKER_OPEN_SIDEPANEL') {
    if (isFromPopup && tabId != null) {
      chrome.tabs
        .get(tabId)
        .then((ownerTab) => {
          if (ownerTab?.windowId != null && chrome.sidePanel?.open) {
            chrome.sidePanel.open({ windowId: ownerTab.windowId }).catch(() => {});
          }
        })
        .catch(() => {});
    } else {
      const winId = senderTab?.windowId;
      if (winId != null && chrome.sidePanel?.open) {
        chrome.sidePanel.open({ windowId: winId }).catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'URL_TRACKER_CLOSE_SIDEPANEL') {
    for (const port of activeSidePanelPorts) {
      try {
        port.postMessage({ type: 'URL_TRACKER_CLOSE_SIDEPANEL' });
      } catch {}
    }
    broadcastToSidePanel({ type: 'URL_TRACKER_CLOSE_SIDEPANEL' });
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'URL_TRACKER_GET_UI_STATE') {
    isPopupWindowTab(senderTab).then((popup) => {
      sendResponse({
        isPopupWindow: Boolean(popup || isFromPopup),
        sidePanelOpen: isSidePanelOpen()
      });
    });
    return true;
  }

  // 7) 설정 변경(호버 ON/OFF, 일시정지, 로그 보관, 허용 도메인 목록) 브로드캐스트
  if (message?.type === 'URL_TRACKER_BROADCAST_SETTINGS') {
    if (Array.isArray(message.settings?.allowedDomains)) {
      allowedDomains = message.settings.allowedDomains;
      chrome.storage.local.set({ ut_allowedDomains: allowedDomains });
    }
    if (typeof message.settings?.preserveLog === 'boolean') {
      preserveLog = message.settings.preserveLog;
      chrome.storage.local.set({ ut_preserveLog: preserveLog });
    }
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id != null) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'URL_TRACKER_SETTINGS_UPDATED',
            settings: message.settings
          }).catch(() => {});
        }
      }
    });
    broadcastToSidePanel({
      type: 'URL_TRACKER_SETTINGS_UPDATED',
      settings: message.settings
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === 'toggle-panel' && tab.windowId != null && chrome.sidePanel?.open) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  } else if (command === 'toggle-hover' && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'URL_TRACKER_TOGGLE_HOVER' }).catch(() => {});
  }
});
