// ==========================================
// 개발용 chrome.* API 셰임 — 이 파일은 "확장 프로그램이 아닌 일반
// 웹페이지"에서 background.js/main.js를 그대로 실행하기 위한 것이다.
// 실제 유튜브 데이터를 보기 위해, fetch는 가로채지 않고 전부 진짜
// 네트워크로 내보낸다(Gemini/YouTube API 호출 포함). 인증만 크롬 확장
// 전용 API(chrome.identity) 대신 구글 신원 서비스(GIS)로 대체한다.
//
// 크롬 확장과 다른 점(알고 써야 하는 한계):
// - chrome.identity는 로그인 상태를 브라우저 수준에서 계속 캐시해 주지만,
//   GIS 액세스 토큰은 보통 1시간 후 만료되고 별도 리프레시 토큰 없이는
//   자동 재발급이 안 된다 — 만료되면 다시 로그인 버튼을 눌러야 한다.
// - declarativeNetRequest(유튜브 임베드 재생시 referer 헤더 조작)는
//   일반 웹페이지에서 쓸 수 없는 API라 아무 동작도 안 한다 — 인앱 재생
//   화면에서 영상이 안 나올 수 있다(다른 기능엔 영향 없음).
// ==========================================
(function () {
  const cfg = window.YTPL_DEV_CONFIG || {};
  // config.example.js의 자리표시 문자열("여기에_...")이 그대로 남아있으면
  // 진짜 값처럼 오인해서 구글에 잘못된 client_id로 로그인 팝업을 띄우는
  // 일이 없도록, 꼴이 실제 클라이언트 ID(...apps.googleusercontent.com)와
  // 다르면 빈 값과 동일하게 취급한다.
  const rawClientId = typeof cfg.oauthWebClientId === "string" ? cfg.oauthWebClientId.trim() : "";
  const hasValidClientId = /^[\w-]+\.apps\.googleusercontent\.com$/.test(rawClientId);
  if (!hasValidClientId) {
    cfg.oauthWebClientId = "";
    console.warn(
      "[dev] YTPL_DEV_CONFIG.oauthWebClientId가 없거나 형식이 올바르지 않습니다. " +
      "dev/config.example.js를 dev/config.local.js로 복사하고 Web용 OAuth 클라이언트 ID를 넣은 뒤 dev/build.cjs를 다시 실행하세요. " +
      "(값이 없거나 잘못돼 있는 동안은 로그인 시도 시 바로 오류를 던지고, 구글 팝업은 띄우지 않습니다.)",
    );
  }

  const SCOPES = [
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" ");

  const TOKEN_STORAGE_KEY = "ytplDevOauthTokenV1";

  function loadStoredToken() {
    try {
      const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.token && parsed.expiresAt > Date.now() + 30000) {
        return parsed.token;
      }
    } catch (_error) {
      // 무시 — 캐시 없는 것으로 취급.
    }
    return null;
  }

  function storeToken(token, expiresInSec) {
    try {
      localStorage.setItem(
        TOKEN_STORAGE_KEY,
        JSON.stringify({ token: token, expiresAt: Date.now() + (Number(expiresInSec) || 3600) * 1000 }),
      );
    } catch (_error) {
      // 무시.
    }
  }

  function clearStoredToken() {
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (_error) {
      // 무시.
    }
  }

  let tokenClient = null;
  let gisReadyPromise = null;

  function ensureGis() {
    if (gisReadyPromise) return gisReadyPromise;
    gisReadyPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = () => {
        if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
          reject(new Error("Google Identity Services 초기화에 실패했습니다."));
          return;
        }
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: cfg.oauthWebClientId || "",
          scope: SCOPES,
          callback: () => {}, // requestAccessToken()을 부를 때마다 아래에서 실제 콜백으로 바꿔 끼운다.
        });
        resolve();
      };
      script.onerror = () => reject(new Error("Google Identity Services 스크립트를 불러오지 못했습니다."));
      document.head.appendChild(script);
    });
    return gisReadyPromise;
  }

  async function requestToken(interactive) {
    const cached = loadStoredToken();
    if (cached) return cached;
    if (!interactive) {
      throw new Error("캐시된 토큰이 없습니다.");
    }
    if (!cfg.oauthWebClientId) {
      throw new Error("YTPL_DEV_CONFIG.oauthWebClientId가 설정되지 않았습니다. dev/config.local.js를 확인하세요.");
    }
    await ensureGis();
    return new Promise((resolve, reject) => {
      tokenClient.callback = (resp) => {
        if (resp && resp.access_token) {
          storeToken(resp.access_token, resp.expires_in);
          resolve(resp.access_token);
        } else {
          reject(new Error((resp && resp.error_description) || (resp && resp.error) || "로그인이 취소되었거나 실패했습니다."));
        }
      };
      tokenClient.requestAccessToken({ prompt: "" });
    });
  }

  // 정의하지 않은 chrome.* API가 호출돼도 서비스워커 전용 코드가 그 자리에서
  // 죽지 않도록, 어디까지 들어가도 함수처럼 호출되는 빈 프록시를 돌려준다.
  function deepNoop() {
    return new Proxy(function () {}, {
      get: (target, prop) => (prop === "then" ? undefined : deepNoop()),
      apply: () => Promise.resolve(),
    });
  }

  // 실제 chrome.storage.local은 콜백을 주면 콜백 방식으로, 안 주면 Promise를
  // 돌려주는 두 방식을 다 지원한다. main.js/background.js 코드도 자리에 따라
  // 둘을 섞어 쓰므로(예: proceedPastAuth는 콜백 방식), 여기서도 반드시 둘 다
  // 지원해야 한다 — Promise만 돌려주면 콜백 쪽 호출은 그 콜백이 영영 안
  // 불려서 呼출부가 조용히 멈춰버린다(실제로 이 문제로 온보딩 화면이 계속
  // 안 뜨는 버그가 있었다).
  const withCb = (fn) => (...args) => {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
    const result = fn(...args);
    if (cb) {
      result.then(cb);
      return undefined;
    }
    return result;
  };

  const storageLocal = {
    get: withCb((keys) => new Promise((resolve) => {
      const out = {};
      const list = keys == null ? Object.keys(localStorage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      list.forEach((key) => {
        const raw = localStorage.getItem(key);
        if (raw !== null) {
          try {
            out[key] = JSON.parse(raw);
          } catch (_error) {
            // 무시 — JSON이 아닌 값은 건너뛴다.
          }
        }
      });
      resolve(out);
    })),
    set: withCb((obj) => new Promise((resolve) => {
      Object.keys(obj).forEach((key) => localStorage.setItem(key, JSON.stringify(obj[key])));
      resolve();
    })),
    remove: withCb((keys) => new Promise((resolve) => {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => localStorage.removeItem(key));
      resolve();
    })),
    clear: withCb(() => new Promise((resolve) => {
      localStorage.clear();
      resolve();
    })),
  };

  let messageListener = null;

  window.chrome = new Proxy(
    {
      storage: {
        local: storageLocal,
        sync: {
          get: withCb(() => Promise.resolve({})),
          set: withCb(() => Promise.resolve()),
          remove: withCb(() => Promise.resolve()),
          clear: withCb(() => Promise.resolve()),
        },
        onChanged: { addListener() {} },
      },
      identity: {
        getAuthToken: (opts) => requestToken(!opts || opts.interactive !== false).then((token) => ({ token: token })),
        removeCachedAuthToken: () => { clearStoredToken(); return Promise.resolve(); },
      },
      runtime: {
        id: "dev-web",
        lastError: undefined,
        getURL: (path) => "/" + String(path || "").replace(/^\//, ""),
        onMessage: { addListener: (fn) => { messageListener = fn; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        sendMessage: (message, cb) => {
          const promise = new Promise((resolve) => {
            if (!messageListener) { resolve(undefined); return; }
            const keepChannelOpen = messageListener(message, {}, resolve);
            if (!keepChannelOpen) resolve(undefined);
          });
          if (typeof cb === "function") {
            promise.then((result) => setTimeout(() => cb(result), 0));
            return undefined;
          }
          return promise;
        },
      },
      // 인앱 재생 화면에서 새 탭으로 열어야 하는 경우만 실제로 동작시키고,
      // 그 외 탭 조작(query/update)은 개발 중 크게 중요하지 않아 결과 없는
      // 성공으로 처리한다.
      tabs: {
        create: (opts) => { window.open(opts && opts.url, "_blank"); return Promise.resolve({}); },
        update: () => Promise.resolve({}),
        query: () => Promise.resolve([]),
      },
      action: { onClicked: { addListener() {} } },
      sidePanel: { setPanelBehavior: async () => {}, setOptions: async () => {}, open: async () => {} },
      declarativeNetRequest: { updateDynamicRules: async () => {}, getDynamicRules: async () => [] },
    },
    { get: (target, prop) => (prop in target ? target[prop] : deepNoop()) },
  );

  window.__ytplDevAuth = { requestToken: requestToken, clearStoredToken: clearStoredToken };
})();
