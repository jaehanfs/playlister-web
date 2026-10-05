"use strict";

const YOUTUBE_API_BASE_URL = "https://www.googleapis.com/youtube/v3";
const LIBRARY_CACHE_TTL_MS = 60 * 1000;
const LIBRARY_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const LIBRARY_CACHE_STORAGE_KEY = "ytplLibraryCacheV1";
const PLAYLIST_ITEMS_CACHE_STORAGE_KEY = "ytplPlaylistItemsCacheV1";
const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// "gemini-2.0-flash"/"gemini-2.5-flash"는 2026-08-16 기준 이 계정에서
// "no longer available" 404로 막혀있는 걸 실제 API 호출로 확인했다(콘솔에
// 새로 발급한 키도 마찬가지) — 응답이 !response.ok라 조용히 null을
// 반환하고 Nano로 폴백해버려서, 클라우드 키를 등록해도 계속 느린 Nano만
// 쓰이고 있었다. "-latest" 별칭 모델(현재 gemini-3.5-flash-lite로 연결됨)로
// 바꾸면 Google이 모델을 교체해도 계속 유효한 별칭을 따라가므로 이런
// 종류의 재발을 막을 수 있다.
const GEMINI_DUPLICATE_MODEL = "gemini-flash-lite-latest";
const USER_GEMINI_API_KEY_STORAGE_KEY = "ytplUserGeminiApiKey";
const PLAYLIST_INFO_RECOMMEND_COUNT = 5;
let libraryIndexCache = null;

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(function () {});

const YOUTUBE_EMBED_REFERER_RULE_ID = 1;

function registerYouTubeEmbedRefererRule() {
  chrome.declarativeNetRequest
    .updateDynamicRules({
      removeRuleIds: [YOUTUBE_EMBED_REFERER_RULE_ID],
      addRules: [
        {
          id: YOUTUBE_EMBED_REFERER_RULE_ID,
          condition: {
            initiatorDomains: [chrome.runtime.id],
            requestDomains: ["www.youtube.com", "www.youtube-nocookie.com"],
            resourceTypes: ["sub_frame"],
          },
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              {
                header: "referer",
                value: chrome.runtime.id,
                operation: "set",
              },
            ],
          },
        },
      ],
    })
    .catch(function () {});
}

registerYouTubeEmbedRefererRule();

chrome.action.onClicked.addListener(async function (tab) {
  if (tab?.id) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (_error) {
      // 사이드패널을 열 수 없는 탭(예: chrome:// 페이지)일 수 있습니다.
    }
  }

  const isYouTubeTab = /^https:\/\/(?:www\.)?youtube\.com\//i.test(
    tab?.url || "",
  );

  if (isYouTubeTab) {
    return;
  }

  // 로그인해서 메인 화면에 들어가기 전(온보딩 화면1/화면2)에는 굳이 현재
  // 탭을 유튜브로 강제 이동시키지 않는다 — 아직 로그인도 안 한 상태에서
  // 탭을 바꿔버리면 온보딩 화면과 상관없는 유튜브 페이지만 덩그러니 뜨게
  // 된다. 캐시된 토큰이 있는지만 조용히(interactive:false) 확인한다.
  const status = await checkAuthStatus();
  if (!status.authenticated) {
    return;
  }

  try {
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { url: "https://www.youtube.com/" });
    } else {
      await chrome.tabs.create({ url: "https://www.youtube.com/" });
    }
  } catch (_error) {
    // 탭 이동에 실패해도 사이드패널 자체는 이미 열려 있을 수 있습니다.
  }
});

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  const handlers = {
    "ytpl:getLibrary": function () {
      return getLibrary(Boolean(message.forceRefresh));
    },
    "ytpl:getPlaylistItems": function () {
      return getPlaylistItems(message.playlistId, Boolean(message.forceRefresh));
    },
    "ytpl:getDuplicateGroups": function () {
      return getDuplicateGroups(Boolean(message.forceRefresh));
    },
    "ytpl:getUnavailableItems": function () {
      return getUnavailableItems(Boolean(message.forceRefresh));
    },
    "ytpl:searchLibrary": function () {
      return searchLibrary(message.query);
    },
    "ytpl:deletePlaylistItem": function () {
      return deletePlaylistItem(message.playlistItemId);
    },
    "ytpl:playVideo": function () {
      return playVideoInTab(message.videoId, message.playlistId, _sender);
    },
    "ytpl:recommendPlaylistInfo": function () {
      return recommendPlaylistInfo(
        message.playlistTitle,
        message.playlistDesc,
        message.videoTitles,
      );
    },
    "ytpl:warmupPlaylistInfoAi": function () {
      return warmupPlaylistInfoAi();
    },
    "ytpl:classifyVideoTags": function () {
      return classifyVideoTags(message.videos);
    },
    "ytpl:standardizeVideoTitles": function () {
      return standardizeVideoTitles(message.videos);
    },
    // ---- 관리자 화면 ----
    // getAdminStatus만 일반 사용자에게도 열려 있다(헤더의 "관리자" 버튼을
    // 보일지 정하는 용도, 결과는 true/false와 본인 이메일뿐). 나머지는 전부
    // 함수 안에서 requireAdmin()으로 다시 검사한다.
    "ytpl:getAdminStatus": function () {
      return getAdminStatus();
    },
    "ytpl:getPromptStore": function () {
      return getPromptStoreForAdmin();
    },
    "ytpl:savePromptDraft": function () {
      return savePromptDraft(message.promptType, message.text);
    },
    "ytpl:applyPrompt": function () {
      return applyPrompt(message.promptType, message.text);
    },
    "ytpl:resetPrompt": function () {
      return resetPrompt(message.promptType);
    },
    "ytpl:runAdminCommand": function () {
      return runAdminCommand(message.instruction);
    },
    "ytpl:getAdminUsers": function () {
      return getAdminUsers();
    },
    "ytpl:addAdminUser": function () {
      return addAdminUser(message.email);
    },
    "ytpl:updateAdminUser": function () {
      return updateAdminUser(message.email, message.newEmail);
    },
    "ytpl:removeAdminUser": function () {
      return removeAdminUser(message.email);
    },
    "ytpl:getAdminLogs": function () {
      return getAdminLogs();
    },
    "ytpl:clearAdminLogs": function () {
      return clearAdminLogs();
    },
    "ytpl:getAdminLogSettings": function () {
      return getAdminLogSettings();
    },
    "ytpl:setAdminLogSettings": function () {
      return setAdminLogSettings(message.enabled);
    },
    "ytpl:getDataOverview": function () {
      return getDataOverview();
    },
    "ytpl:exportAdminData": function () {
      return exportAdminData();
    },
    "ytpl:importAdminData": function () {
      return importAdminData(message.data);
    },
    "ytpl:analyzePlaylistWithPrompt": function () {
      return analyzePlaylistWithPrompt(message.prompt, message.videoTitles);
    },
    "ytpl:mergePlaylistInto": function () {
      return mergePlaylistInto(message.sourcePlaylistId, message.targetPlaylistId, message.selectedPlaylistItemIds);
    },
    "ytpl:checkAuthStatus": function () {
      return checkAuthStatus();
    },
    "ytpl:connectAccount": function () {
      return connectAccount();
    },
    "ytpl:logout": function () {
      return performFullLogout();
    },
  };
  const handler = handlers[message.type];

  if (!handler) {
    return false;
  }

  Promise.resolve()
    .then(handler)
    .then(function (data) {
      sendResponse({ ok: true, data: data });
    })
    .catch(function (error) {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    });

  return true;
});

// 사이드패널이 보낸 메시지의 sender.tab이 항상 채워진다는 보장이 없어서
// (Chrome 버전/상황에 따라 비어있는 경우가 있었음), 현재 창에서 활성 탭을
// 조회하는 방식으로도 한 번 더 시도한다.
async function resolveAssociatedTabId(sender) {
  if (sender?.tab?.id) {
    return sender.tab.id;
  }
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return activeTab?.id || null;
  } catch (_error) {
    return null;
  }
}

async function playVideoInTab(videoId, playlistId, sender) {
  if (!videoId) {
    throw new Error("영상 ID가 없습니다.");
  }
  const query = new URLSearchParams({ v: videoId });
  if (playlistId) {
    query.set("list", playlistId);
  }
  const url = `https://www.youtube.com/watch?${query.toString()}`;
  const tabId = await resolveAssociatedTabId(sender);

  if (tabId) {
    try {
      await chrome.tabs.update(tabId, { url: url, active: true });
      return { ok: true };
    } catch (_error) {
      // 그 탭이 이미 없어졌을 수 있음 — 아래에서 새 탭을 연다.
    }
  }

  await chrome.tabs.create({ url: url });
  return { ok: true };
}


async function getLibrary(forceRefresh) {
  if (!forceRefresh) {
    const cached = await readLibraryCache();
    if (cached) {
      return cached;
    }
  }

  const token = await getAccessToken();
  const profile = await getGoogleProfile(token);
  const playlists = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({
      part: "snippet,contentDetails,status",
      mine: "true",
      maxResults: "50",
    });

    if (pageToken) {
      query.set("pageToken", pageToken);
    }

    const data = await fetchYouTubeApi(
      `${YOUTUBE_API_BASE_URL}/playlists?${query.toString()}`,
      token,
    );
    playlists.push(...(Array.isArray(data.items) ? data.items : []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  const normalizedPlaylists = playlists.map(normalizePlaylist);

  // "좋아요 표시한 동영상"을 채널의 특수 재생목록 ID로 찾아서 일반
  // 재생목록처럼 추가해봤지만, YouTube Data API가 그 재생목록의 실제
  // 영상 목록(playlistItems.list) 조회는 서드파티 앱에 막아놔서
  // "playlist ... cannot be found" 오류로 항상 실패한다 — 재생목록
  // 메타데이터(channels.list/playlists.list?id=)는 내려주면서 정작 내용은
  // 못 가져오는, API 자체의 제약이라 우회할 방법이 없다. 되돌림.
  const result = {
    profile: profile,
    playlists: normalizedPlaylists,
  };

  // 방금 새로 읽은 재생목록 목록과 어긋나지 않도록, 파생된 중복/검색 인덱스는
  // 다음 요청에서 다시 만들어지게 무효화합니다.
  libraryIndexCache = null;
  await writeLibraryCache(result);

  return result;
}

async function readLibraryCache() {
  const stored = await chrome.storage.local.get(LIBRARY_CACHE_STORAGE_KEY);
  const cache = stored[LIBRARY_CACHE_STORAGE_KEY];
  if (!cache || Date.now() - cache.createdAt >= LIBRARY_LIST_CACHE_TTL_MS) {
    return null;
  }
  return { profile: cache.profile, playlists: cache.playlists };
}

async function writeLibraryCache(result) {
  await chrome.storage.local.set({
    [LIBRARY_CACHE_STORAGE_KEY]: {
      createdAt: Date.now(),
      profile: result.profile,
      playlists: result.playlists,
    },
  });
}

async function clearLibraryCache() {
  await chrome.storage.local.remove(LIBRARY_CACHE_STORAGE_KEY);
}

async function getPlaylistItems(playlistId, forceRefresh) {
  if (!playlistId) {
    throw new Error("재생목록 ID가 없습니다.");
  }

  if (!forceRefresh) {
    const cached = await readPlaylistItemsCache(playlistId);
    if (cached) {
      return cached;
    }
  }

  const token = await getAccessToken();
  const playlistItems = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({
      part: "snippet,contentDetails,status",
      playlistId: playlistId,
      maxResults: "50",
    });

    if (pageToken) {
      query.set("pageToken", pageToken);
    }

    const data = await fetchYouTubeApi(
      `${YOUTUBE_API_BASE_URL}/playlistItems?${query.toString()}`,
      token,
    );
    playlistItems.push(...(Array.isArray(data.items) ? data.items : []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  const videoIds = Array.from(
    new Set(
      playlistItems
        .map(function (item) {
          return (
            item.contentDetails?.videoId ||
            item.snippet?.resourceId?.videoId ||
            ""
          );
        })
        .filter(Boolean),
    ),
  );
  const videoDetails = await getVideoDetails(videoIds, token);

  const normalizedItems = playlistItems.map(function (item) {
    return normalizePlaylistItem(item, videoDetails);
  });

  await writePlaylistItemsCache(playlistId, normalizedItems);

  return normalizedItems;
}

async function readPlaylistItemsCache(playlistId) {
  try {
    const stored = await chrome.storage.local.get(PLAYLIST_ITEMS_CACHE_STORAGE_KEY);
    const cacheMap = stored[PLAYLIST_ITEMS_CACHE_STORAGE_KEY] || {};
    const entry = cacheMap[playlistId];
    if (!entry || Date.now() - entry.createdAt >= LIBRARY_LIST_CACHE_TTL_MS) {
      return null;
    }
    return entry.items;
  } catch (_error) {
    return null;
  }
}

async function writePlaylistItemsCache(playlistId, items) {
  try {
    const stored = await chrome.storage.local.get(PLAYLIST_ITEMS_CACHE_STORAGE_KEY);
    const cacheMap = stored[PLAYLIST_ITEMS_CACHE_STORAGE_KEY] || {};
    cacheMap[playlistId] = { createdAt: Date.now(), items: items };
    await chrome.storage.local.set({
      [PLAYLIST_ITEMS_CACHE_STORAGE_KEY]: cacheMap,
    });
  } catch (_error) {
    // 저장 용량 초과 등으로 실패해도 기능엔 지장 없음 — 다음에 다시 받아올 뿐이다.
  }
}

async function clearPlaylistItemsCache(playlistId) {
  try {
    const stored = await chrome.storage.local.get(PLAYLIST_ITEMS_CACHE_STORAGE_KEY);
    const cacheMap = stored[PLAYLIST_ITEMS_CACHE_STORAGE_KEY] || {};
    if (playlistId) {
      delete cacheMap[playlistId];
    } else {
      Object.keys(cacheMap).forEach(function (key) {
        delete cacheMap[key];
      });
    }
    await chrome.storage.local.set({
      [PLAYLIST_ITEMS_CACHE_STORAGE_KEY]: cacheMap,
    });
  } catch (_error) {
    // 무시
  }
}

let duplicateGroupsCache = null;

async function getDuplicateGroups(forceRefresh) {
  if (
    !forceRefresh &&
    duplicateGroupsCache &&
    Date.now() - duplicateGroupsCache.createdAt < LIBRARY_LIST_CACHE_TTL_MS
  ) {
    return duplicateGroupsCache.groups;
  }

  const groups = await computeDuplicateGroups(forceRefresh);
  duplicateGroupsCache = { createdAt: Date.now(), groups: groups };
  return groups;
}

// 중복 판정은 영상 ID(videoId)가 완전히 같은 경우만 잡는다 — 제목 유사도
// 추정이나 AI(썸네일/자막/LLM) 호출은 쓰지 않는다. 그래서 재업로드나 다른
// 채널의 같은 내용 영상처럼 videoId 자체가 다른 경우는 잡히지 않는다
// (이는 의도된 동작이다 — [[중복영상]] 프롬프트 유형은 그래서 더 이상
// 쓰이지 않는다).
async function computeDuplicateGroups(forceRefresh) {
  const index = await getIndexedLibrary(forceRefresh);
  const items = index.items;
  const exactByVideoId = new Map();
  items.forEach(function (item) {
    if (!item.videoId) {
      return;
    }
    if (!exactByVideoId.has(item.videoId)) {
      exactByVideoId.set(item.videoId, []);
    }
    exactByVideoId.get(item.videoId).push(item);
  });

  const exactGroups = Array.from(exactByVideoId.entries())
    .filter(function (entry) {
      return entry[1].length > 1;
    })
    .map(function ([videoId, group]) {
      const seenPlaylistIds = new Set();
      const hasSamePlaylistDuplicate = group.some(function (item, index) {
        return group.slice(0, index).some(function (candidate) {
          return candidate.sourcePlaylist?.id === item.sourcePlaylist?.id;
        });
      });
      return group.map(function (item) {
        const playlistId = item.sourcePlaylist?.id || "";
        const deleteRecommended = seenPlaylistIds.has(playlistId);
        seenPlaylistIds.add(playlistId);
        return {
          ...item,
          duplicateGroupKind: hasSamePlaylistDuplicate
            ? "confirmed"
            : "cross-playlist",
          deleteRecommended: deleteRecommended,
          duplicateMatch: {
            confidence: 100,
            reason: deleteRecommended
              ? "같은 재생목록의 동일 영상"
              : "동일 YouTube 영상 ID",
            exact: true,
            method: "exact",
          },
        };
      });
    });

  return exactGroups.sort(function (groupA, groupB) {
    const rank = { confirmed: 0, "cross-playlist": 1 };
    const rankDifference =
      rank[groupA[0]?.duplicateGroupKind] - rank[groupB[0]?.duplicateGroupKind];
    return rankDifference || groupB.length - groupA.length;
  });
}

function isDuplicateAiSupported() {
  return typeof LanguageModel !== "undefined";
}

function sanitizeAiPromptText(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 300) : "(없음)";
}

// ==========================================
// 클라우드 Gemini(BYOK) — 설정 탭에서 사용자가 자신의 Gemini API Key를
// 등록하면, 태그/표준제목/재생목록 추천/목록 분석 등 각 AI 기능이 기기
// 내장 Gemini Nano 대신 이 클라우드 모델을 우선 사용한다.
// ==========================================
async function getUserGeminiApiKey() {
  try {
    const stored = await chrome.storage.local.get(USER_GEMINI_API_KEY_STORAGE_KEY);
    const key = stored && stored[USER_GEMINI_API_KEY_STORAGE_KEY];
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch (_error) {
    return null;
  }
}

// ==========================================
// 재생목록 이름/설명 AI 추천 — "재생목록 수정" 모달의 "내용 AI 추천" 버튼.
// 등록된 Gemini API Key가 있으면 클라우드로, 없으면 기기 내장 Gemini
// Nano로 폴백한다(둘 다 안 되면 명확한 오류를 던진다 — 예전엔 존재하지
// 않는 /api/recommend-playlist-info를 호출해서 조용히 실패했었다).
// ==========================================
// 1개를 먼저 빠르게 만들고 나머지를 뒤에서 이어 만드는 2단계 방식을
// 시도해봤지만, 같은 세션에서 짧은 간격으로 prompt()를 두 번 연달아 부르니
// (대화 맥락이 계속 누적되는 멀티턴 세션이라) Nano가 가끔 응답을 아예 못
// 만들어내는 경우가 생겨서 오히려 불안정해졌다. 한 번의 호출로
// PLAYLIST_INFO_RECOMMEND_COUNT개를 통째로 받는 방식으로 되돌린다 — 느리지만
// 안정적으로 항상 결과가 나온다.
function buildPlaylistInfoPrompt(playlistTitle, playlistDesc, videoTitles, instructionText) {
  // 온디바이스 Nano는 생성 속도가 느려서, 굳이 필요 이상으로 긴 입력을
  // 주면 처리할 토큰만 늘어나고 체감 속도가 나빠진다. 20개면 재생목록의
  // 성격을 파악하기에 충분하다.
  const sampleTitles = (Array.isArray(videoTitles) ? videoTitles : []).slice(0, 20);
  // {{COUNT}}는 추천 개수로 치환한다(관리자가 프롬프트를 고쳐도 개수 표기가
  // 실제 요청 개수와 어긋나지 않게).
  const instruction = (instructionText || PROMPT_TYPE_MAP.playlistInfo.defaultText).replace(
    /\{\{COUNT\}\}/g,
    String(PLAYLIST_INFO_RECOMMEND_COUNT),
  );
  const lines = [
    instruction,
    'Respond with JSON only, matching this shape: {"titles": ["...", "...", "..."], "descriptions": ["...", "...", "..."]}.',
    "",
    `Current playlist title: ${sanitizeAiPromptText(playlistTitle)}`,
    `Current playlist description: ${sanitizeAiPromptText(playlistDesc)}`,
    "",
    "Video titles in this playlist:",
  ];
  sampleTitles.forEach(function (title, index) {
    lines.push(`${index + 1}. ${sanitizeAiPromptText(title)}`);
  });
  return lines.join("\n");
}

function normalizePlaylistInfoResult(parsed) {
  if (!parsed) {
    return null;
  }
  const titles = Array.isArray(parsed.titles)
    ? parsed.titles.filter((t) => typeof t === "string" && t.trim()).slice(0, PLAYLIST_INFO_RECOMMEND_COUNT)
    : [];
  const descriptions = Array.isArray(parsed.descriptions)
    ? parsed.descriptions.filter((d) => typeof d === "string" && d.trim()).slice(0, PLAYLIST_INFO_RECOMMEND_COUNT)
    : [];
  if (titles.length === 0 && descriptions.length === 0) {
    return null;
  }
  return { titles: titles, descriptions: descriptions };
}

async function recommendPlaylistInfoWithGeminiCloud(
  apiKey,
  playlistTitle,
  playlistDesc,
  videoTitles,
  instructionText,
) {
  const promptText = buildPlaylistInfoPrompt(playlistTitle, playlistDesc, videoTitles, instructionText);
  const requestBody = {
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          titles: { type: "ARRAY", items: { type: "STRING" } },
          descriptions: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["titles", "descriptions"],
      },
    },
  };

  // 네트워크가 느리거나 응답이 없으면 무한정 기다리지 않고 20초 뒤에는
  // 포기하고 Nano(온디바이스) 경로로 넘어가도록 타임아웃을 둔다.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(
      `${GEMINI_API_BASE_URL}/models/${GEMINI_DUPLICATE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return null;
    }
    return normalizePlaylistInfoResult(JSON.parse(text));
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

let playlistInfoAiSessionPromise = null;

async function ensurePlaylistInfoAiSession() {
  if (!isDuplicateAiSupported()) {
    return null;
  }
  if (!playlistInfoAiSessionPromise) {
    playlistInfoAiSessionPromise = (async function () {
      try {
        const availability = await LanguageModel.availability();
        if (availability !== "available") {
          return null;
        }
        return await LanguageModel.create({
          initialPrompts: [
            {
              role: "system",
              content:
                "You help users write short, catchy Korean titles and 1-2 sentence Korean descriptions for their personal YouTube playlists, based on the video titles the playlist actually contains. Always respond with data matching the requested JSON schema, and write only in Korean.",
            },
          ],
        });
      } catch (_error) {
        return null;
      }
    })();
  }
  const session = await playlistInfoAiSessionPromise;
  if (!session) {
    playlistInfoAiSessionPromise = null;
  }
  return session;
}

async function recommendPlaylistInfoWithNano(
  session,
  playlistTitle,
  playlistDesc,
  videoTitles,
  instructionText,
) {
  const schema = {
    type: "object",
    properties: {
      titles: { type: "array", items: { type: "string" } },
      descriptions: { type: "array", items: { type: "string" } },
    },
    required: ["titles", "descriptions"],
  };
  const promptText = buildPlaylistInfoPrompt(playlistTitle, playlistDesc, videoTitles, instructionText);

  try {
    const response = await session.prompt(promptText, { responseConstraint: schema });
    const parsed = typeof response === "string" ? JSON.parse(response) : response;
    return normalizePlaylistInfoResult(parsed);
  } catch (_error) {
    return null;
  }
}

async function recommendPlaylistInfo(playlistTitle, playlistDesc, videoTitles) {
  const { text: instructionText, custom } = await resolvePrompt("playlistInfo");
  const detail = `영상 제목 ${Array.isArray(videoTitles) ? videoTitles.length : 0}개 기준`;
  const logBase = {
    instruction: instructionText,
    provided: {
      "재생목록 제목": playlistTitle || "",
      "재생목록 설명": playlistDesc || "",
      "영상 제목": Array.isArray(videoTitles) ? videoTitles : [],
    },
    prompt: buildPlaylistInfoPrompt(playlistTitle, playlistDesc, videoTitles, instructionText),
  };

  const apiKey = await getUserGeminiApiKey();
  if (apiKey) {
    const cloudResult = await recommendPlaylistInfoWithGeminiCloud(
      apiKey,
      playlistTitle,
      playlistDesc,
      videoTitles,
      instructionText,
    );
    if (cloudResult) {
      logAiRun("재생목록 추천", detail, AI_ENGINE_CLOUD, custom, { ...logBase, result: cloudResult });
      return cloudResult;
    }
  }

  const session = await ensurePlaylistInfoAiSession();
  if (session) {
    const nanoResult = await recommendPlaylistInfoWithNano(
      session,
      playlistTitle,
      playlistDesc,
      videoTitles,
      instructionText,
    );
    if (nanoResult) {
      logAiRun("재생목록 추천", detail, AI_ENGINE_NANO, custom, { ...logBase, result: nanoResult });
      return nanoResult;
    }
  }

  logAiRun("재생목록 추천", `${detail} (실패)`, AI_ENGINE_NONE, custom, { ...logBase, result: AI_LOG_NO_RESULT });
  throw new Error(
    "AI를 사용할 수 없습니다. 설정 탭에서 Gemini API Key를 등록하거나, Chrome의 내장 AI(Gemini Nano) 지원 여부를 확인해주세요.",
  );
}

// 재생목록 수정 모달을 여는 시점에 미리 호출해서, 사용자가 "내용 AI 추천"을
// 누르기 전에 Nano 세션 생성(모델 가용성 확인 + 세션 준비)이 백그라운드에서
// 미리 끝나 있게 한다 — 실제 버튼을 눌렀을 때는 프롬프트 생성만 기다리면
// 되므로 체감 대기 시간이 줄어든다. Cloud 키가 있으면 Nano를 아예 쓰지
// 않으니 워밍업도 건너뛴다.
async function warmupPlaylistInfoAi() {
  const apiKey = await getUserGeminiApiKey();
  if (apiKey) {
    return { warmed: false };
  }
  const session = await ensurePlaylistInfoAiSession();
  return { warmed: Boolean(session) };
}

// ==========================================
// 영상별 기본 태그 AI 분류 — 제목/채널명에 장르 단어가 직접 없어도(예:
// "Sintel" by "Blender Foundation") 실제 내용을 추론해서 구체적이고 서로
// 다양한 태그를 붙인다. 규칙 기반 키워드 매칭(프론트엔드의
// generateDefaultTagsForVideo)의 한계를 보완하는 용도라, 실패하면 그냥
// null을 반환하고 프론트엔드가 기존 규칙 기반 기본 태그를 그대로 쓴다.
// ==========================================
// instructionText는 관리자 화면에서 관리하는 "지시문 본문"(PROMPT_TYPES.tag)이고,
// 출력 형식과 영상 목록은 여기서 뒤에 붙인다.
function buildVideoTagsPrompt(videos, instructionText) {
  const lines = [
    instructionText || PROMPT_TYPE_MAP.tag.defaultText,
    'Respond with JSON only, matching this shape: [{"id": "<video id exactly as given>", "tags": ["...", "..."]}, ...], with exactly one entry per video listed below, in the same order.',
  ];
  lines.push("", "Videos:");
  videos.forEach((v, index) => {
    lines.push(`${index + 1}. id="${v.id}" title="${sanitizeAiPromptText(v.title)}" channel="${sanitizeAiPromptText(v.channel)}"`);
  });
  return lines.join("\n");
}

// videos를 함께 받아서, AI가 지시를 무시하고 태그로 제목을 그대로(혹은 거의
// 그대로) 돌려준 경우를 한 번 더 걸러낸다 — 프롬프트만으로는 100% 보장되지
// 않기 때문에 결과 검증 단계에서도 같은 규칙을 적용한다.
function normalizeVideoTagsResult(parsed, videos) {
  if (!Array.isArray(parsed)) {
    return null;
  }
  const titleById = {};
  (Array.isArray(videos) ? videos : []).forEach((v) => {
    if (v && typeof v.id === "string") {
      titleById[v.id] = String(v.title || "").trim().toLowerCase();
    }
  });

  const tags = {};
  parsed.forEach((entry) => {
    if (!entry || typeof entry.id !== "string") return;
    const normalizedTitle = titleById[entry.id] || "";
    const cleanTags = Array.isArray(entry.tags)
      ? [...new Set(
          entry.tags
            .filter((t) => typeof t === "string" && t.trim())
            .map((t) => t.trim().slice(0, 20))
            .filter((t) => !normalizedTitle || t.toLowerCase() !== normalizedTitle),
        )].slice(0, 4)
      : [];
    if (cleanTags.length > 0) {
      tags[entry.id] = cleanTags;
    }
  });
  if (Object.keys(tags).length === 0) {
    return null;
  }
  return { tags: tags };
}

const VIDEO_TAGS_RESPONSE_SCHEMA_JSON = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "STRING" },
      tags: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["id", "tags"],
  },
};

async function classifyVideoTagsWithGeminiCloud(apiKey, videos, instructionText) {
  const promptText = buildVideoTagsPrompt(videos, instructionText);
  const requestBody = {
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: VIDEO_TAGS_RESPONSE_SCHEMA_JSON,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(
      `${GEMINI_API_BASE_URL}/models/${GEMINI_DUPLICATE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return null;
    }
    return normalizeVideoTagsResult(JSON.parse(text), videos);
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

let videoTagsAiSessionPromise = null;

async function ensureVideoTagsAiSession() {
  if (!isDuplicateAiSupported()) {
    return null;
  }
  if (!videoTagsAiSessionPromise) {
    videoTagsAiSessionPromise = (async function () {
      try {
        const availability = await LanguageModel.availability();
        if (availability !== "available") {
          return null;
        }
        return await LanguageModel.create({
          initialPrompts: [
            {
              role: "system",
              content:
                "You classify YouTube videos into concise Korean genre/theme tags based on their title and channel name, inferring the genre even when it isn't literally written in them. Always respond with data matching the requested JSON schema, and write tag text only in Korean.",
            },
          ],
        });
      } catch (_error) {
        return null;
      }
    })();
  }
  const session = await videoTagsAiSessionPromise;
  if (!session) {
    videoTagsAiSessionPromise = null;
  }
  return session;
}

async function classifyVideoTagsWithNano(session, videos, instructionText) {
  const schema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id", "tags"],
    },
  };
  const promptText = buildVideoTagsPrompt(videos, instructionText);

  try {
    const response = await session.prompt(promptText, { responseConstraint: schema });
    const parsed = typeof response === "string" ? JSON.parse(response) : response;
    return normalizeVideoTagsResult(parsed, videos);
  } catch (_error) {
    return null;
  }
}

// 한 번의 요청에 너무 많은 영상을 넣으면 응답이 느려지고 실패 확률도
// 올라가므로 상한을 둔다. 나머지는 프론트엔드가 다음 로드 때 이어서
// 처리한다(이미 분류된 영상은 로컬 오버라이드로 저장되어 다시 요청되지
// 않는다).
const VIDEO_TAGS_MAX_BATCH = 25;

async function classifyVideoTags(videos) {
  const list = (Array.isArray(videos) ? videos : [])
    .filter((v) => v && typeof v.id === "string" && v.title)
    .slice(0, VIDEO_TAGS_MAX_BATCH);
  if (list.length === 0) {
    return null;
  }

  const { text: instructionText, custom } = await resolvePrompt("tag");
  const detail = `영상 ${list.length}개`;
  const logBase = {
    instruction: instructionText,
    provided: { "영상 목록": list.map((v) => ({ id: v.id, title: v.title, channel: v.channel || "" })) },
    prompt: buildVideoTagsPrompt(list, instructionText),
  };

  const apiKey = await getUserGeminiApiKey();
  if (apiKey) {
    const cloudResult = await classifyVideoTagsWithGeminiCloud(apiKey, list, instructionText);
    if (cloudResult) {
      logAiRun("태그 분류", detail, AI_ENGINE_CLOUD, custom, { ...logBase, result: cloudResult });
      return cloudResult;
    }
  }

  const session = await ensureVideoTagsAiSession();
  if (session) {
    const nanoResult = await classifyVideoTagsWithNano(session, list, instructionText);
    if (nanoResult) {
      logAiRun("태그 분류", detail, AI_ENGINE_NANO, custom, { ...logBase, result: nanoResult });
      return nanoResult;
    }
  }

  logAiRun("태그 분류", `${detail} (규칙 기반 태그 유지)`, AI_ENGINE_NONE, custom, { ...logBase, result: AI_LOG_NO_RESULT });

  return null;
}

// ==========================================
// 프롬프트 저장소 + 관리자 체계
//
// 앱이 AI에게 보내는 모든 프롬프트(표준제목, 태그, 중복영상, 재생목록 추천,
// 목록 분석, 일반 요청 해석)의 "지시문 본문"을 PROMPT_TYPES 한곳에서
// 관리한다. 출력 형식(JSON 모양)과 영상 목록·사용자 요청 같은 실제 데이터는
// 코드가 지시문 뒤에 자동으로 붙이므로, 관리자가 고치는 건 지시문 본문뿐이다.
//
// 유형마다 "저장된 초안(draft)"과 "적용 중인 프롬프트(applied)"를 따로 든다.
// 저장하기는 초안만 남기고, 적용하기를 눌러야 실제 AI 호출에 쓰인다.
// applied가 없으면 기본값(defaultText)이 쓰인다.
//
// 관리자 판별은 로그인한 구글 계정 이메일 기준이며, 프롬프트/사용자 관리/
// 로그/데이터 기능은 화면에서 숨기는 것뿐 아니라 여기서도 매번 다시
// 검사한다(requireAdmin). 관리자 목록 전체(코드에 박힌 기본 관리자 포함)는
// ADMINS_KEY 하나로 이 브라우저(chrome.storage.local)에 저장되고, 사용자
// 관리 화면에서 기본 관리자를 포함해 누구든 수정/삭제할 수 있다 — 다른
// 사람의 기기에서는 이 저장소가 비어 있으므로 BUILT_IN_ADMIN_EMAILS(시드값)로
// 다시 채워진다. 즉 "관리자 전원 삭제"는 이 브라우저 안에서만 유효하고,
// 다른 브라우저에서 처음 열면 시드값이 다시 관리자가 된다.
// ==========================================
const BUILT_IN_ADMIN_EMAILS = ["jaehanfs@gmail.com", "eeesub@gmail.com"];
const ADMINS_KEY = "ytplAdminEmailsV1";
// 예전(관리자 전원 통합 이전) 버전이 "추가 관리자만" 저장하던 키 — 처음 읽을
// 때 BUILT_IN_ADMIN_EMAILS와 합쳐 ADMINS_KEY로 이관하고 지운다.
const EXTRA_ADMINS_KEY = "ytplExtraAdminEmailsV1";
const PROMPT_STORE_KEY = "ytplPromptStoreV1";
const ADMIN_LOG_KEY = "ytplAdminLogV1";
// main.js의 LIST_SCALE_STORAGE_KEY와 반드시 같은 값이어야 한다.
const LIST_SCALE_STORAGE_KEY = "ytplListScaleV1";
// 프롬프트 화면의 "선택 안함" 모드에서 저장하기로 보관한 질문 문장. main.js의
// ADMIN_REQUEST_DRAFT_KEY와 반드시 같은 값이어야 한다.
const ADMIN_REQUEST_DRAFT_KEY = "ytplAdminRequestDraftV1";
// 예전(관리자 프롬프트 1세대)에 "추가 지시문"으로 저장하던 키 — 처음 읽을 때
// 새 저장소의 적용본으로 옮기고 지운다.
const LEGACY_PROMPT_KEYS = {
  tag: "ytplAdminTagPromptV1",
  standardTitle: "ytplAdminStandardTitlePromptV1",
};
const PROMPT_MAX_LENGTH = 6000;
const ADMIN_LOG_MAX_ENTRIES = 100;
// AI 호출 로그는 "AI에게 실제로 보낸 프롬프트 전문 / 지시 / 제공 정보 / 결과"를
// 요약 없이 그대로 남긴다. 필드가 너무 길면 이 길이에서 잘라 "N자 중 앞부분만
// 저장됨"이라고 적는다. 그만큼 용량이 커지므로 로그 보관 건수는 100건으로 둔다.
const AI_LOG_FIELD_MAX_LENGTH = 20000;
// AI 응답이 없을 때 로그의 "결과" 칸에 적는 문구
const AI_LOG_NO_RESULT = "(AI 응답 없음 — 클라우드·기기 내장 모델 모두 결과를 만들지 못함)";
// 관리자 로그를 기록할지 말지를 정하는 설정(체크박스 하나). 값이 없으면 기록함.
const ADMIN_LOG_SETTINGS_KEY = "ytplAdminLogSettingsV1";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 기본 프롬프트 문구를 바꿀 때마다 올린다. 화면(main.js의 EXPECTED_PROMPT_DEFAULTS_VERSION)이
// 이 값을 보고, 확장 프로그램을 새로고침하지 않아 백그라운드가 옛 코드로 남아 있는지 알려 준다.
const PROMPT_DEFAULTS_VERSION = 11;

const PROMPT_TYPES = [
  {
    id: "standardTitle",
    label: "표준제목",
    usage: "- 용도: 영상 제목 정리\n- 실행: '자동제목정리'를 켤 때\n- 결과: 제목 + 부가 내용으로 나눠 저장",
    fixedNote: "- 자동 첨부: 출력 형식(JSON), 영상 목록",
    defaultText: "영상 제목을 깔끔하게 정리해 주세요.\n\n- '공식', '최초 공개' 같은 홍보 문구, 이모지, #해시태그, 4K·MV 같은 화질이나 영상 종류 표시는 빼 주세요.\n- 정리한 제목은 title에 적어 주세요.\n- 가수 이름이나 덧붙은 설명이 있으면 content에 따로 적어 주세요. 없으면 비워 두세요.\n- 원래 제목에 없는 말은 지어내지 마세요. 이미 깔끔한 제목은 그대로 두세요.",
  },
  {
    id: "tag",
    label: "태그",
    usage: "- 용도: 영상별 기본 태그 분류\n- 실행: 재생목록을 처음 불러올 때\n- 결과: 영상마다 태그 표시",
    fixedNote: "- 자동 첨부: 출력 형식(JSON), 영상 목록",
    defaultText: "영상마다 어울리는 한국어 태그를 2~4개씩 붙여 주세요.\n\n- 장르, 주제, 형식, 분위기를 나타내는 태그로 해 주세요.\n- 제목에 장르가 안 나와 있어도 내용을 보고 짐작해서 붙여 주세요.\n- 내용이 다른 영상은 태그도 다르게 붙여 주세요.\n- 제목 그대로(또는 제목의 일부)는 태그로 쓰지 말고, 같은 태그를 두 번 쓰지 마세요.",
  },
  {
    id: "playlistInfo",
    label: "재생목록 추천",
    usage: "- 용도: 재생목록 제목·설명 추천\n- 실행: 재생목록 수정 화면의 '내용 AI 추천'을 누를 때\n- 결과: 추천 후보를 눌러 입력칸에 채움",
    fixedNote: "- {{COUNT}}: 추천 개수로 자동 변경\n- 자동 첨부: 현재 제목·설명, 영상 제목 목록, 출력 형식(JSON)",
    defaultText: "이 재생목록의 영상 제목을 보고, 어울리는 재생목록 제목과 설명을 한국어로 추천해 주세요.\n\n- 제목 {{COUNT}}개와 설명 {{COUNT}}개를 추천해 주세요.\n- 제목은 25자 이내로 짧게 써 주세요.\n- 설명은 1~2문장으로 써 주세요.\n- 추천마다 분위기를 다르게 써 주세요.",
  },
  {
    id: "playlistAnalysis",
    label: "목록 분석",
    usage: "- 용도: 재생목록 분석 질문 처리\n- 실행: '목록 분석'에서 질문을 입력할 때\n- 질문 종류\n  · 찾기: 조건에 맞는 영상만 보여줌\n  · 나누기: 그룹으로 정리\n  · 일반 질문: 목록을 보고 답변",
    fixedNote: "- 자동 첨부: 입력한 질문, 출력 형식(JSON), 영상 목록",
    defaultText: "아래 요청대로 재생목록을 살펴봐 주세요. 요청 종류에 따라 mode 값이 달라집니다.\n\n- 영상을 찾아 달라는 요청이면 mode는 \"search\"로 하고, 조건에 맞는 영상 번호만 matches에 적어 주세요.\n- 나누거나 정리해 달라는 요청이면 mode는 \"group\"으로 하고, 모든 영상을 groups에 나눠 담아 주세요. 그룹 이름은 12자 이내로 짓고, 애매한 영상은 \"기타\"로 묶어 주세요.\n- 목록에 대한 일반 질문(예: \"이 목록 어떤 것 같아?\")이면 mode는 \"answer\"로 하고, 영상 제목을 근거로 answer에 답해 주세요. 답은 \"- \"로 시작하는 짧은 3~5줄로 써 주세요.\n- 쓰지 않는 matches나 groups는 빈 칸([])으로 두고, 결과 요약은 summary에 한 줄로 적어 주세요.",
  },
  {
    id: "adminCommand",
    label: "일반 요청 해석",
    usage: "- 용도: 문장으로 쓴 요청을 AI가 알아서 실행\n- 실행: 위 선택 상자를 '선택 안함'으로 두고 \"적용하기\" 클릭\n- 가능한 일\n  · 화면 크기 조절\n  · AI 기능에 지시 추가\n  · 설정 되돌리기\n- \"저장하기\": 질문만 보관 (실행 안 함)",
    fixedNote: "- 자동 첨부: 입력한 요청 문장\n- 주의: 잘못 고치면 일반 요청이 동작하지 않을 수 있음\n- 복구: '선택 안함'에서 \"프롬프트를 원래대로 되돌려줘\" 입력",
    defaultText: "관리자가 쓴 요청을 읽고, 아래 네 가지 중 가장 가까운 동작 하나로 해석해 주세요. 돌려 말해도 속뜻을 헤아려 주세요.\n\n1. 화면 크기 조절 (action은 \"resize\")\n   - target에 바꿀 대상을 적어 주세요: \"thumbnail\"(썸네일), \"text\"(제목 글자), \"button\"(전체 재생·목록 분석 같은 주요 버튼), \"both\"(썸네일+글자, 재생목록·영상 목록 얘기일 때만)\n   - 버튼 얘기는 항상 \"button\"으로 해 주세요.\n   - scaleDelta에 변화 비율을 적어 주세요: 20% 키우면 0.2, 15% 줄이면 -0.15. 숫자 없이 \"크게\"면 0.2, \"작게\"면 -0.2\n\n2. AI 기능에 지시 추가 (action은 \"set_prompt\")\n   - promptCategory에 대상 기능을 적어 주세요: \"tag\"(태그), \"standardTitle\"(표준제목), \"playlistInfo\"(재생목록 추천), \"playlistAnalysis\"(목록 분석)\n   - promptText에는 그 기능의 프롬프트 끝에 붙일 한국어 지시문을 적어 주세요. 관리자에게 하는 대답이 아니라, 그것만 읽어도 뜻이 통하는 지시문이어야 합니다.\n   - 중복 영상 판정은 영상 ID만 보고 하며 프롬프트를 쓰지 않으므로, 중복 판정에 관한 요청은 \"unsupported\"로 처리해 주세요.\n\n3. 되돌리기 (action은 \"reset\")\n   - resetTarget에 \"prompts\"(프롬프트만), \"scale\"(크기만), \"all\"(둘 다) 중 하나를 적어 주세요. 잘 모르겠으면 \"all\"로 해 주세요.\n\n4. 지원하지 않는 요청 (action은 \"unsupported\")\n   - 위에 없는 요청이면 이것으로 하고, 되는 것과 안 되는 것을 summary에 짧게 설명해 주세요.\n\n어떤 경우든 이해한 내용을 한국어 한 문장으로 summary에 적고, JSON으로만 답해 주세요.",
  },
];

const PROMPT_TYPE_MAP = Object.fromEntries(PROMPT_TYPES.map((info) => [info.id, info]));
// 일반 요청(AI)이 "지시문 추가"로 손댈 수 있는 유형 — 요청 해석기 자신은 제외한다.
const AI_SETTABLE_PROMPT_TYPES = PROMPT_TYPES.map((info) => info.id).filter((id) => id !== "adminCommand");

function normalizePromptText(value) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim().slice(0, PROMPT_MAX_LENGTH) : "";
}

function promptStoreEntry(store, type) {
  const entry = store && store[type];
  return {
    draft: entry && typeof entry.draft === "string" ? entry.draft : null,
    applied: entry && typeof entry.applied === "string" ? entry.applied : null,
  };
}

async function readPromptStore() {
  const legacyKeys = Object.values(LEGACY_PROMPT_KEYS);
  const stored = await chrome.storage.local.get([PROMPT_STORE_KEY].concat(legacyKeys));
  const raw = stored[PROMPT_STORE_KEY];
  const store = raw && typeof raw === "object" ? raw : {};

  let hasLegacy = false;
  Object.keys(LEGACY_PROMPT_KEYS).forEach((type) => {
    const legacyKey = LEGACY_PROMPT_KEYS[type];
    if (!(legacyKey in stored)) {
      return;
    }
    hasLegacy = true;
    const legacyText = normalizePromptText(stored[legacyKey]);
    const entry = promptStoreEntry(store, type);
    if (legacyText && entry.applied === null) {
      entry.applied = `${PROMPT_TYPE_MAP[type].defaultText}\n${legacyText}`;
    }
    store[type] = entry;
  });
  if (hasLegacy) {
    await chrome.storage.local.set({ [PROMPT_STORE_KEY]: store });
    await chrome.storage.local.remove(legacyKeys);
  }
  return store;
}

async function writePromptStore(store) {
  await chrome.storage.local.set({ [PROMPT_STORE_KEY]: store });
}

function requirePromptType(type) {
  const info = PROMPT_TYPE_MAP[type];
  if (!info) {
    throw new Error("알 수 없는 프롬프트 유형입니다.");
  }
  return info;
}

// 실제 AI 호출에 쓸 프롬프트 지시문을 돌려준다. custom은 관리자가 적용한
// 값이 쓰이고 있는지(로그에 "사용자 지정/기본"으로 남기기 위함).
async function resolvePrompt(type) {
  const info = requirePromptType(type);
  const store = await readPromptStore();
  const applied = promptStoreEntry(store, type).applied;
  const custom = applied !== null && applied.trim() !== "";
  return { text: custom ? applied : info.defaultText, custom: custom };
}

function describePromptSource(custom) {
  return custom ? "사용자 지정 프롬프트" : "기본 프롬프트";
}

const AI_ENGINE_CLOUD = "Gemini(클라우드)";
const AI_ENGINE_NANO = "Nano(기기 내장)";
const AI_ENGINE_NONE = "AI 사용 불가/실패";

// AI 기능이 한 번 돌 때마다 로그 탭에 한 줄 남긴다("어떤 기능이, 어떤 엔진으로,
// 어떤 프롬프트로 돌았는지"). extra로 입력값/출력값/실제 프롬프트 내용을
// 함께 남길 수 있다 — 관리자가 직접 요청한 것이라, 영상 제목처럼 실제
// 콘텐츠가 로그에 그대로 들어간다(예전엔 의도적으로 남기지 않았다).
const AI_FEATURE_DESCRIPTIONS = {
  "표준제목": "영상 제목을 '제목 + 부가 내용'으로 깔끔하게 정리",
  "태그 분류": "영상마다 장르·분위기 같은 태그를 붙임",
  "재생목록 추천": "재생목록의 제목·설명 후보를 추천",
  "목록 분석": "재생목록에서 영상을 찾거나, 그룹으로 나누거나, 질문에 답함",
};
const AI_ENGINE_DESCRIPTIONS = {
  [AI_ENGINE_CLOUD]: "Gemini 클라우드 AI (등록한 API 키로 인터넷을 통해 호출)",
  [AI_ENGINE_NANO]: "기기 내장 AI(Nano) (클라우드를 못 써서 이 기기 안에서 처리)",
  [AI_ENGINE_NONE]: "AI를 쓰지 못함 (클라우드·기기 내장 모두 결과를 못 만듦)",
};

// detail은 "영상 3개" 또는 "영상 3개 (실패)"처럼 끝에 괄호 설명이 붙을 수 있다.
// 로그 한 줄은 그 자체로 읽히는 문장으로 쓰고, 항목별 설명은 info로 따로 남긴다.
function buildAiLogTitle(featureLabel, detail, engine, custom) {
  const noteMatch = /\s*\(([^()]+)\)\s*$/.exec(detail);
  const note = noteMatch && noteMatch[1] !== "실패" ? noteMatch[1] : "";
  const target = noteMatch ? detail.slice(0, noteMatch.index) : detail;
  const succeeded = engine !== AI_ENGINE_NONE;
  const aiShort = engine === AI_ENGINE_CLOUD ? "Gemini 클라우드 AI" : engine === AI_ENGINE_NANO ? "기기 내장 AI(Nano)" : "AI 사용 못 함";
  const text = `${featureLabel} ${succeeded ? "성공" : "실패"} — ${target} 처리 · ${aiShort} · ${describePromptSource(custom)}${note ? " · " + note : ""}`;
  const info = {
    "기능": featureLabel + (AI_FEATURE_DESCRIPTIONS[featureLabel] ? " — " + AI_FEATURE_DESCRIPTIONS[featureLabel] : ""),
    "처리 대상": target,
    "사용한 AI": AI_ENGINE_DESCRIPTIONS[engine] || engine,
    "프롬프트": describePromptSource(custom) + (custom ? " (관리자 화면에서 고쳐 적용한 지시문)" : " (앱에 기본으로 들어 있는 지시문)"),
    "결과": succeeded ? "성공" : "실패" + (note ? " — " + note : ""),
  };
  return { text: text, info: info };
}

function logAiRun(featureLabel, detail, engine, custom, extra) {
  const title = buildAiLogTitle(featureLabel, detail, engine, custom);
  return appendAdminLog("ai", title.text, Object.assign({}, extra, { info: title.info }));
}

// 예전 형식("기능 · 영상 N개 · 엔진 · 프롬프트")으로 저장된 AI 호출 기록을 새 제목 형식으로 바꾼다.
// 알아볼 수 없는 모양이면 그대로 둔다.
function upgradeLegacyAiLogTitle(entry) {
  if (!entry || entry.kind !== "ai" || entry.info || typeof entry.text !== "string") {
    return entry;
  }
  const parts = entry.text.split(" · ");
  if (parts.length !== 4 || !AI_ENGINE_DESCRIPTIONS[parts[2]]) {
    return entry;
  }
  const title = buildAiLogTitle(parts[0], parts[1], parts[2], parts[3].indexOf("사용자 지정") === 0);
  return Object.assign({}, entry, { text: title.text, info: title.info });
}

// ---- 관리자 판별 ----
function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// 관리자 목록 전체(기본 관리자 포함)를 돌려준다. 저장소가 비어 있으면(최초
// 실행, 또는 예전 버전의 "추가 관리자만" 저장하던 키만 있는 경우) 기본
// 관리자 시드값 + 예전 목록을 합쳐 ADMINS_KEY를 새로 만든다 — 이후로는
// 이 저장소가 유일한 기준이고, 시드값은 다시 쓰이지 않는다(비워도 그대로
// 빈 채로 남는다).
async function getAdminEmails() {
  const stored = await chrome.storage.local.get([ADMINS_KEY, EXTRA_ADMINS_KEY]);
  const list = stored[ADMINS_KEY];
  if (Array.isArray(list)) {
    return Array.from(new Set(list.map(normalizeEmail))).filter((email) => EMAIL_PATTERN.test(email));
  }
  const legacyExtra = Array.isArray(stored[EXTRA_ADMINS_KEY]) ? stored[EXTRA_ADMINS_KEY] : [];
  const seeded = Array.from(new Set(BUILT_IN_ADMIN_EMAILS.concat(legacyExtra).map(normalizeEmail))).filter(
    (email) => EMAIL_PATTERN.test(email),
  );
  await chrome.storage.local.set({ [ADMINS_KEY]: seeded });
  if (EXTRA_ADMINS_KEY in stored) {
    await chrome.storage.local.remove(EXTRA_ADMINS_KEY);
  }
  return seeded;
}

async function getAdminIdentity() {
  let email = "";
  try {
    const token = await getAccessToken(false);
    const profile = await getGoogleProfile(token);
    email = normalizeEmail(profile && profile.email);
  } catch (_error) {
    email = "";
  }
  if (!email) {
    return { email: "", isAdmin: false };
  }
  const isAdmin = (await getAdminEmails()).includes(email);
  return { email: email, isAdmin: isAdmin };
}

async function requireAdmin() {
  const identity = await getAdminIdentity();
  if (!identity.isAdmin) {
    throw new Error("관리자만 사용할 수 있는 기능입니다.");
  }
  return identity;
}

async function getAdminStatus() {
  const identity = await getAdminIdentity();
  return { isAdmin: identity.isAdmin, email: identity.email };
}

// ---- 로그 ----
// 호출이 겹쳐도(재생목록 여러 개를 동시에 불러오는 등) 읽고-쓰는 사이에
// 서로 덮어쓰지 않도록 한 줄로 세워서 처리한다. 영상 제목 같은 내용은
// 남기지 않고, 어떤 기능이 어떤 방식으로 동작했는지만 기록한다.
let adminLogQueue = Promise.resolve();

// 로그 필드 값을 읽기 좋은 글로 바꿔 돌려준다. 객체는 들여쓰기 2칸의 JSON으로,
// 문자열은 그대로 쓰고, 한도를 넘으면 잘라낸 사실을 글 끝에 밝힌다.
// 값이 없으면 빈 문자열(그 필드는 로그에 아예 붙이지 않는다).
function formatLogField(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch (_error) {
      text = String(value);
    }
  }
  if (text.length <= AI_LOG_FIELD_MAX_LENGTH) {
    return text;
  }
  return text.slice(0, AI_LOG_FIELD_MAX_LENGTH) + "\n… (전체 " + text.length.toLocaleString("ko-KR") + "자 중 앞 " + AI_LOG_FIELD_MAX_LENGTH.toLocaleString("ko-KR") + "자만 저장됨)";
}

// 저장된 설정을 { enabled: true/false }로 돌려준다. 없거나 깨진 값은 "기록함"이다.
async function readAdminLogSettings() {
  const stored = await chrome.storage.local.get(ADMIN_LOG_SETTINGS_KEY);
  const raw = stored[ADMIN_LOG_SETTINGS_KEY];
  return { enabled: !(raw && raw.enabled === false) };
}


function appendAdminLog(kind, text, extra) {
  adminLogQueue = adminLogQueue.then(async function () {
    try {
      // 기록이 꺼져 있으면(체크 해제) 아무것도 남기지 않는다.
      const settings = await readAdminLogSettings();
      if (!settings.enabled) {
        return;
      }
      const stored = await chrome.storage.local.get(ADMIN_LOG_KEY);
      const list = Array.isArray(stored[ADMIN_LOG_KEY]) ? stored[ADMIN_LOG_KEY] : [];
      const entry = { ts: Date.now(), kind: kind, text: String(text).slice(0, 300) };
      if (extra && typeof extra === "object") {
        // instruction: 지시문 / provided: AI에게 제공한 정보 / result: AI의 결과 /
        // prompt: 코드가 만들어 AI에게 실제로 보낸 최종 프롬프트 전문
        if (extra.info && typeof extra.info === "object") {
          const info = {};
          Object.keys(extra.info).forEach(function (key) {
            info[key] = String(extra.info[key]).slice(0, 300);
          });
          entry.info = info;
        }
        ["instruction", "provided", "result", "prompt"].forEach(function (field) {
          const text = formatLogField(extra[field]);
          if (text) entry[field] = text;
        });
      }
      list.push(entry);
      const kept = list.slice(-ADMIN_LOG_MAX_ENTRIES);
      try {
        await chrome.storage.local.set({ [ADMIN_LOG_KEY]: kept });
      } catch (_quotaError) {
        // 저장 공간이 모자라면(웹 버전의 localStorage 등) 오래된 기록을 줄여 한 번 더 시도한다.
        await chrome.storage.local.set({ [ADMIN_LOG_KEY]: kept.slice(-10) });
      }
    } catch (_error) {
      // 로그 기록 실패가 본 기능을 막으면 안 된다.
    }
  });
  return adminLogQueue;
}

// 제공 정보·결과 칸이 JSON으로 남지 않은 옛 기록(예전 input/output 형식, 제공 정보가
// 없는 AI 호출 기록)을 가려낸다. 길어서 잘린 기록은 잘린 표시를 떼고 JSON인지 본다.
function isLegacyLogEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return true;
  }
  if (entry.input !== undefined || entry.output !== undefined) {
    return true;
  }
  if (entry.provided === undefined) {
    return entry.kind === "ai";
  }
  const withoutTruncationNote = String(entry.provided).replace(/\n… \(전체 [\s\S]*$/, "");
  try {
    JSON.parse(withoutTruncationNote);
    return false;
  } catch (_error) {
    return String(entry.provided) === withoutTruncationNote;
  }
}

async function purgeLegacyAdminLogs() {
  adminLogQueue = adminLogQueue.then(async function () {
    try {
      const stored = await chrome.storage.local.get(ADMIN_LOG_KEY);
      const list = Array.isArray(stored[ADMIN_LOG_KEY]) ? stored[ADMIN_LOG_KEY] : [];
      let upgraded = false;
      const kept = list.filter(function (entry) { return !isLegacyLogEntry(entry); }).map(function (entry) {
        const next = upgradeLegacyAiLogTitle(entry);
        if (next !== entry) {
          upgraded = true;
        }
        return next;
      });
      if (kept.length !== list.length || upgraded) {
        await chrome.storage.local.set({ [ADMIN_LOG_KEY]: kept });
      }
    } catch (_error) {
      // 정리 실패가 로그 조회를 막으면 안 된다.
    }
  });
  return adminLogQueue;
}

async function getAdminLogs() {
  await requireAdmin();
  await purgeLegacyAdminLogs();
  const stored = await chrome.storage.local.get(ADMIN_LOG_KEY);
  const list = Array.isArray(stored[ADMIN_LOG_KEY]) ? stored[ADMIN_LOG_KEY] : [];
  return { logs: list.slice().reverse(), settings: await readAdminLogSettings() };
}

async function getAdminLogSettings() {
  await requireAdmin();
  return readAdminLogSettings();
}

async function setAdminLogSettings(enabled) {
  const identity = await requireAdmin();
  const next = { enabled: Boolean(enabled) };
  // 끌 때는 "껐다"는 기록이 마지막으로 남도록 저장 전에, 켤 때는 저장 후에 남긴다.
  if (!next.enabled) {
    await appendAdminLog("admin", `로그 기록을 껐습니다. (${identity.email})`);
  }
  await chrome.storage.local.set({ [ADMIN_LOG_SETTINGS_KEY]: next });
  if (next.enabled) {
    await appendAdminLog("admin", `로그 기록을 켰습니다. (${identity.email})`);
  }
  return next;
}

async function clearAdminLogs() {
  const identity = await requireAdmin();
  await adminLogQueue;
  await chrome.storage.local.set({ [ADMIN_LOG_KEY]: [] });
  await appendAdminLog("admin", `로그를 모두 삭제했습니다. (${identity.email})`);
  return getAdminLogs();
}

// ---- 프롬프트 화면용 API ----
async function getPromptStoreForAdmin() {
  await requireAdmin();
  const store = await readPromptStore();
  return {
    defaultsVersion: PROMPT_DEFAULTS_VERSION,
    types: PROMPT_TYPES.map((info) => {
      const entry = promptStoreEntry(store, info.id);
      return {
        id: info.id,
        label: info.label,
        usage: info.usage,
        fixedNote: info.fixedNote,
        defaultText: info.defaultText,
        applied: entry.applied,
        draft: entry.draft,
      };
    }),
  };
}

function requireNonEmptyPromptText(text) {
  const normalized = normalizePromptText(text);
  if (!normalized) {
    throw new Error("프롬프트 내용이 비어 있습니다. 원래대로 되돌리려면 '선택 안함'에서 \"프롬프트를 원래대로 되돌려줘\"라고 요청하세요.");
  }
  return normalized;
}

async function savePromptDraft(type, text) {
  const identity = await requireAdmin();
  const info = requirePromptType(type);
  const normalized = requireNonEmptyPromptText(text);
  const store = await readPromptStore();
  const entry = promptStoreEntry(store, type);
  store[type] = { draft: normalized, applied: entry.applied };
  await writePromptStore(store);
  appendAdminLog("prompt", `[${info.label}] 프롬프트 초안 저장 (${identity.email})`, { instruction: normalized, provided: { "프롬프트 유형": info.label, "계정": identity.email, "저장 방식": "초안(아직 AI에 반영 안 됨)" } });
  return { type: type, draft: normalized, applied: entry.applied };
}

async function applyPrompt(type, text) {
  const identity = await requireAdmin();
  const info = requirePromptType(type);
  const normalized = requireNonEmptyPromptText(text);
  const store = await readPromptStore();
  // 기본값과 똑같으면 "사용자 지정"으로 남기지 않는다 — 나중에 기본 프롬프트가
  // 개선됐을 때 그 개선이 그대로 반영되도록.
  const applied = normalized === info.defaultText ? null : normalized;
  store[type] = { draft: null, applied: applied };
  await writePromptStore(store);
  appendAdminLog("prompt", `[${info.label}] 프롬프트 적용 → ${applied === null ? "기본값과 동일" : "사용자 지정"} (${identity.email})`, { instruction: normalized, provided: { "프롬프트 유형": info.label, "계정": identity.email, "적용 결과": applied === null ? "기본값과 동일" : "사용자 지정" } });
  return { type: type, draft: null, applied: applied };
}

async function resetPrompt(type) {
  const identity = await requireAdmin();
  const info = requirePromptType(type);
  const store = await readPromptStore();
  delete store[type];
  await writePromptStore(store);
  appendAdminLog("prompt", `[${info.label}] 프롬프트를 기본값으로 되돌림 (${identity.email})`);
  return { type: type, draft: null, applied: null };
}

async function resetAllPrompts() {
  await writePromptStore({});
}

// 일반 요청(AI)이 "이런 지시를 더해줘"라고 할 때 — 적용 중인 프롬프트(없으면
// 기본값) 끝에 한 줄로 덧붙인다. 이미 같은 문장이 들어 있으면 중복해서
// 붙이지 않는다.
async function appendToAppliedPrompt(type, addition) {
  requirePromptType(type);
  const text = normalizePromptText(addition).slice(0, 2000);
  if (!text) {
    return;
  }
  const store = await readPromptStore();
  const entry = promptStoreEntry(store, type);
  const base = entry.applied !== null ? entry.applied : PROMPT_TYPE_MAP[type].defaultText;
  if (base.includes(text)) {
    return;
  }
  store[type] = { draft: entry.draft, applied: `${base}\n${text}`.slice(0, PROMPT_MAX_LENGTH) };
  await writePromptStore(store);
}

// ---- 사용자 관리 ----
// seeded: BUILT_IN_ADMIN_EMAILS(코드 시드값)에 있던 이메일인지 — 화면에
// "기본 관리자" 배지를 보여주기 위한 정보일 뿐, 이제는 수정/삭제를 막지 않는다.
async function buildAdminUsersView(meEmail) {
  const admins = await getAdminEmails();
  return {
    me: meEmail,
    admins: admins.map((email) => ({ email: email, seeded: BUILT_IN_ADMIN_EMAILS.includes(email) })),
  };
}

async function getAdminUsers() {
  const identity = await requireAdmin();
  return buildAdminUsersView(identity.email);
}

async function addAdminUser(email) {
  const identity = await requireAdmin();
  const target = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(target)) {
    throw new Error("올바른 이메일 주소를 입력해주세요.");
  }
  const admins = await getAdminEmails();
  if (admins.includes(target)) {
    throw new Error("이미 관리자로 지정된 사용자입니다.");
  }
  admins.push(target);
  await chrome.storage.local.set({ [ADMINS_KEY]: admins });
  appendAdminLog("admin", `관리자 지정: ${target} (by ${identity.email})`);
  return buildAdminUsersView(identity.email);
}

async function updateAdminUser(email, nextEmail) {
  const identity = await requireAdmin();
  const target = normalizeEmail(email);
  const next = normalizeEmail(nextEmail);
  if (!EMAIL_PATTERN.test(next)) {
    throw new Error("올바른 이메일 주소를 입력해주세요.");
  }
  if (target === identity.email) {
    throw new Error("본인의 이메일은 스스로 수정할 수 없습니다.");
  }
  const admins = await getAdminEmails();
  const index = admins.indexOf(target);
  if (index === -1) {
    throw new Error("관리자 목록에 없는 사용자입니다.");
  }
  if (next === target) {
    return buildAdminUsersView(identity.email);
  }
  if (admins.includes(next)) {
    throw new Error("이미 관리자로 지정된 사용자입니다.");
  }
  admins[index] = next;
  await chrome.storage.local.set({ [ADMINS_KEY]: admins });
  appendAdminLog("admin", `관리자 이메일 수정: ${target} → ${next} (by ${identity.email})`);
  return buildAdminUsersView(identity.email);
}

async function removeAdminUser(email) {
  const identity = await requireAdmin();
  const target = normalizeEmail(email);
  if (target === identity.email) {
    throw new Error("본인의 관리자 권한은 스스로 해제할 수 없습니다.");
  }
  const admins = await getAdminEmails();
  if (!admins.includes(target)) {
    throw new Error("관리자 목록에 없는 사용자입니다.");
  }
  await chrome.storage.local.set({ [ADMINS_KEY]: admins.filter((item) => item !== target) });
  appendAdminLog("admin", `관리자 해제: ${target} (by ${identity.email})`);
  return buildAdminUsersView(identity.email);
}

// ---- 데이터 관리(앱이 알고 있는 모든 데이터 보기) ----
// 이 확장 프로그램이 이 브라우저에 가지고 있는 데이터를 한 번에 모아 돌려준다.
// 읽기 전용이며, 액세스 토큰·Gemini API 키 같은 비밀 값은 "있다/없다"와 크기만
// 알려주고 값 자체는 어디에도 담지 않는다.
const DATA_OVERVIEW_KEYS = {
  frontendLibrary: "ytplFrontendLibraryCacheV1",
  localVideoOverrides: "ytplLocalVideoOverridesV1",
  videoOrderOverrides: "ytplVideoOrderOverridesV1",
  playlistOrderOverride: "ytplPlaylistOrderOverrideV1",
  playlistInfoOverrides: "ytplPlaylistInfoOverridesV1",
  darkMode: "ytplDarkModeEnabled",
  zoom: "ytplUiZoomLevel",
  onboardingDone: "ytplOnboardingApiKeyStepDoneV1",
};

function measureStoredBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch (_error) {
    return 0;
  }
}

async function getDataOverview() {
  const identity = await requireAdmin();
  const all = await chrome.storage.local.get(null);
  const keys = DATA_OVERVIEW_KEYS;

  // 1) 재생목록과 동영상 — 사이드패널이 마지막으로 그린 스냅샷 기준(영상은 한 번이라도
  // 열어본 재생목록만 들어 있다).
  const frontend = all[keys.frontendLibrary];
  const order = frontend && Array.isArray(frontend.order) ? frontend.order : [];
  const data = (frontend && frontend.data) || {};
  const playlists = order.filter((id) => data[id]).map((id) => {
    const p = data[id];
    const videos = Array.isArray(p.videos) ? p.videos : [];
    return {
      id: id,
      title: p.title || "",
      description: p.desc || "",
      itemCount: Number(p.itemCount) || videos.length,
      privacyStatus: p.privacyStatus || "",
      publishedAt: p.publishedAt || "",
      videosLoaded: Boolean(p.videosLoaded),
      videos: videos.map((v) => ({
        id: v.id || "",
        title: v.title || "",
        channel: v.channel || "",
        duration: v.duration || "",
        views: v.views || "",
        privacyStatus: v.privacyStatus || "",
        unavailable: Boolean(v.isUnavailable),
        tags: Array.isArray(v.tags) ? v.tags : [],
        contentNote: v.contentNote || "",
      })),
    };
  });

  // 2) 이 앱에서만 쓰는 사용자 지정 값
  const videoOverrides = all[keys.localVideoOverrides] || {};
  const overrideList = Object.keys(videoOverrides);
  const customTagCount = overrideList.filter((id) => videoOverrides[id] && Array.isArray(videoOverrides[id].tags) && videoOverrides[id].tags.length > 0).length;
  const cleanedTitleCount = overrideList.filter((id) => videoOverrides[id] && videoOverrides[id].contentNote).length;

  // 3) 설정
  const listScale = all[LIST_SCALE_STORAGE_KEY] || {};
  const settings = {
    darkMode: all[keys.darkMode] === true,
    zoomLevel: all[keys.zoom] === undefined ? null : all[keys.zoom],
    listScale: { thumb: listScale.thumb || 1, text: listScale.text || 1, button: listScale.button || 1 },
    onboardingApiKeyStepDone: Boolean(all[keys.onboardingDone]),
    geminiApiKeyRegistered: typeof all[USER_GEMINI_API_KEY_STORAGE_KEY] === "string" && all[USER_GEMINI_API_KEY_STORAGE_KEY].length > 0,
  };

  // 4) 관리자 정보
  const promptStore = await readPromptStore();
  const logSettings = await readAdminLogSettings();
  const logList = Array.isArray(all[ADMIN_LOG_KEY]) ? all[ADMIN_LOG_KEY] : [];
  const admin = {
    me: identity.email,
    admins: await getAdminEmails(),
    logEnabled: logSettings.enabled,
    logCount: logList.length,
    prompts: PROMPT_TYPES.map((info) => {
      const entry = promptStoreEntry(promptStore, info.id);
      return {
        id: info.id,
        label: info.label,
        source: entry.applied !== null ? "사용자 지정" : "기본",
        hasDraft: entry.draft !== null,
      };
    }),
  };

  // 5) 저장소 현황 — 키별 대략 용량(비밀 값은 크기만).
  const storage = Object.keys(all)
    .filter((key) => key.indexOf("ytpl") === 0)
    .map((key) => ({ key: key, bytes: measureStoredBytes(all[key]) }))
    .sort((a, c) => c.bytes - a.bytes);
  const totalBytes = storage.reduce((sum, item) => sum + item.bytes, 0);

  return {
    generatedAt: Date.now(),
    account: identity.email,
    playlists: playlists,
    totals: {
      playlistCount: playlists.length,
      loadedPlaylistCount: playlists.filter((p) => p.videosLoaded).length,
      videoCount: playlists.reduce((sum, p) => sum + p.videos.length, 0),
    },
    customData: {
      videosWithOverrides: overrideList.length,
      customTagVideos: customTagCount,
      cleanedTitleVideos: cleanedTitleCount,
      reorderedPlaylists: Object.keys(all[keys.videoOrderOverrides] || {}).length,
      playlistOrderCustomized: Array.isArray(all[keys.playlistOrderOverride]) && all[keys.playlistOrderOverride].length > 0,
      playlistInfoOverrides: Object.keys(all[keys.playlistInfoOverrides] || {}).length,
    },
    settings: settings,
    admin: admin,
    storage: storage,
    totalBytes: totalBytes,
  };
}

// ---- 데이터 내보내기 / 가져오기 ----
// 관리자 설정(적용 중인 프롬프트, 추가 관리자, 목록/버튼 크기)을 JSON 파일로
// 백업하고, 다른 브라우저/기기에서 그대로 불러올 수 있게 한다.
const ADMIN_DATA_FORMAT = "ytpl-admin-data";

async function exportAdminData() {
  const identity = await requireAdmin();
  const store = await readPromptStore();
  const prompts = {};
  PROMPT_TYPES.forEach((info) => {
    const applied = promptStoreEntry(store, info.id).applied;
    if (applied !== null) {
      prompts[info.id] = applied;
    }
  });
  const scaleStored = await chrome.storage.local.get(LIST_SCALE_STORAGE_KEY);
  const data = {
    format: ADMIN_DATA_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    prompts: prompts,
    admins: await getAdminEmails(),
    listScale: scaleStored[LIST_SCALE_STORAGE_KEY] || null,
  };
  appendAdminLog("data", `관리자 설정 내보내기 — 프롬프트 ${Object.keys(prompts).length}개 (${identity.email})`);
  return data;
}

function sanitizeListScale(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const result = {};
  ["thumb", "text", "button"].forEach((key) => {
    const number = Number(value[key]);
    if (Number.isFinite(number)) {
      result[key] = Math.max(0.6, Math.min(2, number));
    }
  });
  return Object.keys(result).length > 0 ? result : null;
}

async function importAdminData(data) {
  const identity = await requireAdmin();
  if (!data || typeof data !== "object" || data.format !== ADMIN_DATA_FORMAT) {
    throw new Error("이 앱에서 내보낸 관리자 설정 파일이 아닙니다.");
  }

  const summary = { prompts: 0, admins: 0, listScale: null };

  if (data.prompts && typeof data.prompts === "object") {
    const store = await readPromptStore();
    PROMPT_TYPES.forEach((info) => {
      if (typeof data.prompts[info.id] !== "string") {
        return;
      }
      const text = normalizePromptText(data.prompts[info.id]);
      if (!text) {
        return;
      }
      store[info.id] = { draft: null, applied: text === info.defaultText ? null : text };
      summary.prompts += 1;
    });
    await writePromptStore(store);
  }

  // "admins"는 현재 형식, "extraAdmins"는 예전(기본 관리자 통합 이전) 내보내기 파일과의 호환용.
  const importedAdmins = Array.isArray(data.admins) ? data.admins : Array.isArray(data.extraAdmins) ? data.extraAdmins : null;
  if (importedAdmins) {
    const admins = await getAdminEmails();
    importedAdmins.map(normalizeEmail).forEach((email) => {
      if (EMAIL_PATTERN.test(email) && !admins.includes(email)) {
        admins.push(email);
        summary.admins += 1;
      }
    });
    await chrome.storage.local.set({ [ADMINS_KEY]: admins });
  }

  const listScale = sanitizeListScale(data.listScale);
  if (listScale) {
    const current = (await chrome.storage.local.get(LIST_SCALE_STORAGE_KEY))[LIST_SCALE_STORAGE_KEY] || {};
    const merged = { thumb: 1, text: 1, button: 1, ...current, ...listScale };
    await chrome.storage.local.set({ [LIST_SCALE_STORAGE_KEY]: merged });
    summary.listScale = merged;
  }

  appendAdminLog(
    "data",
    `관리자 설정 가져오기 — 프롬프트 ${summary.prompts}개, 추가 관리자 ${summary.admins}명${listScale ? ", 화면 크기 설정 포함" : ""} (${identity.email})`,
  );
  return summary;
}

// ==========================================
// AI 표준제목 — "자동제목정리"가 규칙 기반(구분자/별표/따옴표 앞부분을
// 제목으로 간주)으로 처리하지 못하는 제목까지 의미를 이해해서 정리한다.
// handleAutoTitleCleanup()이 먼저 이 기능을 시도하고, AI를 쓸 수 없거나
// 실패한 영상만 기존 규칙 기반 파서로 폴백한다.
// ==========================================
function buildStandardTitlePrompt(videos, instructionText) {
  const lines = [
    instructionText || PROMPT_TYPE_MAP.standardTitle.defaultText,
    'Respond with JSON only, matching this shape: [{"id": "<video id exactly as given>", "title": "...", "content": "..."}, ...], with exactly one entry per video listed below, in the same order.',
  ];
  lines.push("", "Videos:");
  videos.forEach((v, index) => {
    lines.push(`${index + 1}. id="${v.id}" title="${sanitizeAiPromptText(v.title)}" channel="${sanitizeAiPromptText(v.channel)}"`);
  });
  return lines.join("\n");
}

function normalizeStandardTitleResult(parsed) {
  if (!Array.isArray(parsed)) {
    return null;
  }
  const titles = {};
  parsed.forEach((entry) => {
    if (!entry || typeof entry.id !== "string") return;
    const title = typeof entry.title === "string" ? entry.title.trim().slice(0, 150) : "";
    if (!title) return;
    const content = typeof entry.content === "string" ? entry.content.trim().slice(0, 300) : "";
    titles[entry.id] = { title: title, content: content };
  });
  if (Object.keys(titles).length === 0) {
    return null;
  }
  return { titles: titles };
}

const STANDARD_TITLE_RESPONSE_SCHEMA_JSON = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "STRING" },
      title: { type: "STRING" },
      content: { type: "STRING" },
    },
    required: ["id", "title"],
  },
};

async function standardizeVideoTitlesWithGeminiCloud(apiKey, videos, instructionText) {
  const promptText = buildStandardTitlePrompt(videos, instructionText);
  const requestBody = {
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: STANDARD_TITLE_RESPONSE_SCHEMA_JSON,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(
      `${GEMINI_API_BASE_URL}/models/${GEMINI_DUPLICATE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return null;
    }
    return normalizeStandardTitleResult(JSON.parse(text));
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

let standardTitleAiSessionPromise = null;

async function ensureStandardTitleAiSession() {
  if (!isDuplicateAiSupported()) {
    return null;
  }
  if (!standardTitleAiSessionPromise) {
    standardTitleAiSessionPromise = (async function () {
      try {
        const availability = await LanguageModel.availability();
        if (availability !== "available") {
          return null;
        }
        return await LanguageModel.create({
          initialPrompts: [
            {
              role: "system",
              content:
                "You clean up messy YouTube video titles into a short standard title plus a separate leftover content note, based on the title and channel name. Always respond with data matching the requested JSON schema.",
            },
          ],
        });
      } catch (_error) {
        return null;
      }
    })();
  }
  const session = await standardTitleAiSessionPromise;
  if (!session) {
    standardTitleAiSessionPromise = null;
  }
  return session;
}

async function standardizeVideoTitlesWithNano(session, videos, instructionText) {
  const schema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["id", "title"],
    },
  };
  const promptText = buildStandardTitlePrompt(videos, instructionText);

  try {
    const response = await session.prompt(promptText, { responseConstraint: schema });
    const parsed = typeof response === "string" ? JSON.parse(response) : response;
    return normalizeStandardTitleResult(parsed);
  } catch (_error) {
    return null;
  }
}

// 태그 분류와 같은 이유로 배치 상한을 둔다.
const STANDARD_TITLE_MAX_BATCH = 25;

async function standardizeVideoTitles(videos) {
  const list = (Array.isArray(videos) ? videos : [])
    .filter((v) => v && typeof v.id === "string" && v.title)
    .slice(0, STANDARD_TITLE_MAX_BATCH);
  if (list.length === 0) {
    return null;
  }

  const { text: instructionText, custom } = await resolvePrompt("standardTitle");
  const detail = `영상 ${list.length}개`;
  const logBase = {
    instruction: instructionText,
    provided: { "영상 목록": list.map((v) => ({ id: v.id, title: v.title, channel: v.channel || "" })) },
    prompt: buildStandardTitlePrompt(list, instructionText),
  };

  const apiKey = await getUserGeminiApiKey();
  if (apiKey) {
    const cloudResult = await standardizeVideoTitlesWithGeminiCloud(apiKey, list, instructionText);
    if (cloudResult) {
      logAiRun("표준제목", detail, AI_ENGINE_CLOUD, custom, { ...logBase, result: cloudResult });
      return cloudResult;
    }
  }

  const session = await ensureStandardTitleAiSession();
  if (session) {
    const nanoResult = await standardizeVideoTitlesWithNano(session, list, instructionText);
    if (nanoResult) {
      logAiRun("표준제목", detail, AI_ENGINE_NANO, custom, { ...logBase, result: nanoResult });
      return nanoResult;
    }
  }

  logAiRun("표준제목", `${detail} (규칙 기반 정리로 대체)`, AI_ENGINE_NONE, custom, { ...logBase, result: AI_LOG_NO_RESULT });
  return null;
}

// ==========================================
// 관리자 일반 명령 실행기 — 관리자 프롬프트 팝업의 "일반 요청" 입력란에서
// 자유 문장으로 들어오는 요청("중복 영상을 최대한 정확히 잡아줘", "재생목록/
// 영상 목록을 좀 더 크게 해줘" 등)을, 미리 정해둔 몇 가지 실행 가능한
// 액션(action) 중 하나로 AI가 분류/해석하게 한 뒤 그대로 수행한다.
// 완전히 자유로운 코드 실행이 아니라 "정해진 액션 목록 + 자연어 라우팅"
// 방식이다 — 지원하지 않는 요청이면 unsupported로 솔직하게 알려준다.
// 프롬프트/태그 관련 액션은 여기서 바로 저장까지 끝내고, 화면 크기 조절
// 액션은 실제 DOM을 만지는 프론트엔드(main.js)가 처리하도록 구조만
// 돌려준다.
// ==========================================
const ADMIN_COMMAND_RESPONSE_SCHEMA_JSON = {
  type: "OBJECT",
  properties: {
    action: { type: "STRING", enum: ["resize", "set_prompt", "reset", "unsupported"] },
    target: { type: "STRING", enum: ["thumbnail", "text", "button", "both"] },
    scaleDelta: { type: "NUMBER" },
    promptCategory: { type: "STRING", enum: AI_SETTABLE_PROMPT_TYPES },
    promptText: { type: "STRING" },
    resetTarget: { type: "STRING", enum: ["all", "prompts", "scale"] },
    summary: { type: "STRING" },
  },
  required: ["action", "summary"],
};

// promptText는 관리자 화면에서 관리하는 "지시문 본문"(PROMPT_TYPES.adminCommand)이고,
// 방금 입력된 요청 문장만 여기서 뒤에 붙인다.
function buildAdminCommandPrompt(instruction, promptText) {
  return [
    promptText || PROMPT_TYPE_MAP.adminCommand.defaultText,
    "",
    `Admin's request: ${sanitizeAiPromptText(instruction)}`,
  ].join("\n");
}

function normalizeAdminCommandResult(parsed) {
  if (!parsed || typeof parsed.action !== "string") {
    return null;
  }
  const summary = typeof parsed.summary === "string" && parsed.summary.trim()
    ? parsed.summary.trim().slice(0, 300)
    : "요청을 처리했습니다.";

  if (parsed.action === "resize") {
    const target = ["thumbnail", "text", "button", "both"].includes(parsed.target) ? parsed.target : "both";
    const scaleDelta = Number(parsed.scaleDelta);
    if (!Number.isFinite(scaleDelta) || scaleDelta === 0) {
      return null;
    }
    return { action: "resize", target: target, scaleDelta: Math.max(-0.5, Math.min(0.5, scaleDelta)), summary: summary };
  }

  if (parsed.action === "set_prompt") {
    if (!AI_SETTABLE_PROMPT_TYPES.includes(parsed.promptCategory) || typeof parsed.promptText !== "string" || !parsed.promptText.trim()) {
      return null;
    }
    return {
      action: "set_prompt",
      promptCategory: parsed.promptCategory,
      promptText: parsed.promptText.trim().slice(0, PROMPT_MAX_LENGTH),
      summary: summary,
    };
  }

  if (parsed.action === "reset") {
    const resetTarget = ["all", "prompts", "scale"].includes(parsed.resetTarget) ? parsed.resetTarget : "all";
    return { action: "reset", resetTarget: resetTarget, summary: summary };
  }

  return { action: "unsupported", summary: summary };
}

async function runAdminCommandWithGeminiCloud(apiKey, instruction, promptText) {
  const requestBody = {
    contents: [{ role: "user", parts: [{ text: buildAdminCommandPrompt(instruction, promptText) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: ADMIN_COMMAND_RESPONSE_SCHEMA_JSON,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(
      `${GEMINI_API_BASE_URL}/models/${GEMINI_DUPLICATE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return null;
    }
    return normalizeAdminCommandResult(JSON.parse(text));
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

let adminCommandAiSessionPromise = null;

async function ensureAdminCommandAiSession() {
  if (!isDuplicateAiSupported()) {
    return null;
  }
  if (!adminCommandAiSessionPromise) {
    adminCommandAiSessionPromise = (async function () {
      try {
        const availability = await LanguageModel.availability();
        if (availability !== "available") {
          return null;
        }
        return await LanguageModel.create({
          initialPrompts: [
            {
              role: "system",
              content:
                "You route a YouTube playlist manager app admin's free-form Korean request to one of a small fixed set of supported actions, and always respond with data matching the requested JSON schema.",
            },
          ],
        });
      } catch (_error) {
        return null;
      }
    })();
  }
  const session = await adminCommandAiSessionPromise;
  if (!session) {
    adminCommandAiSessionPromise = null;
  }
  return session;
}

async function runAdminCommandWithNano(session, instruction, promptText) {
  const schema = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["resize", "set_prompt", "reset", "unsupported"] },
      target: { type: "string", enum: ["thumbnail", "text", "button", "both"] },
      scaleDelta: { type: "number" },
      promptCategory: { type: "string", enum: AI_SETTABLE_PROMPT_TYPES },
      promptText: { type: "string" },
      resetTarget: { type: "string", enum: ["all", "prompts", "scale"] },
      summary: { type: "string" },
    },
    required: ["action", "summary"],
  };

  try {
    const response = await session.prompt(buildAdminCommandPrompt(instruction, promptText), { responseConstraint: schema });
    const parsed = typeof response === "string" ? JSON.parse(response) : response;
    return normalizeAdminCommandResult(parsed);
  } catch (_error) {
    return null;
  }
}

async function runAdminCommand(instruction) {
  // 화면에서 버튼을 숨기는 것과 별개로, 실제 실행 전에 항상 다시 검사한다.
  const identity = await requireAdmin();

  const text = typeof instruction === "string" ? instruction.trim() : "";
  if (!text) {
    return { action: "unsupported", summary: "요청 내용이 비어 있습니다." };
  }

  const { text: routerPrompt } = await resolvePrompt("adminCommand");
  let result = null;
  const apiKey = await getUserGeminiApiKey();
  if (apiKey) {
    result = await runAdminCommandWithGeminiCloud(apiKey, text, routerPrompt);
  }
  if (!result) {
    const session = await ensureAdminCommandAiSession();
    if (session) {
      result = await runAdminCommandWithNano(session, text, routerPrompt);
    }
  }
  if (!result) {
    appendAdminLog("error", `일반 요청 해석 실패 — AI 사용 불가: "${text.slice(0, 80)}" (${identity.email})`, { instruction: routerPrompt, provided: { "관리자 요청": text }, prompt: buildAdminCommandPrompt(text, routerPrompt), result: AI_LOG_NO_RESULT });
    return {
      action: "unsupported",
      summary: "AI를 사용할 수 없습니다. 설정에서 Gemini API Key를 등록하거나 기기 내장 AI 지원 여부를 확인해주세요.",
    };
  }

  // "set_prompt": 해당 유형의 적용 중인 프롬프트(없으면 기본값) 끝에 지시를
  // 덧붙여 바로 적용한다 — 프롬프트 화면에서 그 유형을 열면 덧붙은 내용이
  // 그대로 보인다.
  if (result.action === "set_prompt") {
    await appendToAppliedPrompt(result.promptCategory, result.promptText);
  }

  // "reset"의 프롬프트 쪽은 여기서 모든 유형을 기본값으로 되돌린다. 화면
  // 크기(scale) 쪽은 main.js가 저장하고 있는 상태라 프론트엔드가 resetTarget을
  // 보고 직접 초기화한다.
  if (result.action === "reset" && (result.resetTarget === "all" || result.resetTarget === "prompts")) {
    await resetAllPrompts();
  }

  appendAdminLog("admin", `일반 요청 실행 [${result.action}] "${text.slice(0, 80)}" (${identity.email})`, { instruction: routerPrompt, provided: { "관리자 요청": text }, prompt: buildAdminCommandPrompt(text, routerPrompt), result: result });
  return result;
}

// ==========================================
// 재생목록 분석 — "목록 분석" 모달에서 사용자가 직접 입력한 프롬프트로
// 재생목록을 원하는 방식대로 새로 그룹핑해서 분석한다(기존 장르 자동
// 분류와는 별개로, 사용자가 원하는 기준을 직접 지정할 수 있게 하는 기능).
// ==========================================
const PLAYLIST_ANALYSIS_MAX_TITLES = 60;

function buildCustomAnalysisPrompt(userPrompt, videoTitles, instructionText) {
  // Nano는 느려서 너무 긴 입력을 주면 체감 속도가 나빠진다 — 60개면
  // 대부분의 개인 재생목록 전체를 커버하면서도 적당한 길이다.
  const sampleTitles = (Array.isArray(videoTitles) ? videoTitles : []).slice(0, PLAYLIST_ANALYSIS_MAX_TITLES);
  const lines = [
    instructionText || PROMPT_TYPE_MAP.playlistAnalysis.defaultText,
    "",
    `User's instruction: ${sanitizeAiPromptText(userPrompt)}`,
    'Respond with JSON only, matching this shape: {"mode": "search" | "group" | "answer", "summary": "...", "answer": "...", "matches": [1, 2], "groups": [{"name": "...", "videoIndexes": [1, 2]}]}.',
    'If the instruction is a general question or comment about the playlist (neither finding specific videos nor splitting them into groups), use mode "answer": put a helpful reply in Korean in "answer", written as 3-5 short bullet lines (each line starts with "- " and is a brief noun-ending or "~함" phrase, not a full sentence; separate lines with \\n; based on the video titles below), and leave "matches" and "groups" as empty arrays.',
    "",
    "Videos in this playlist (1-based numbering):",
  ];
  sampleTitles.forEach(function (title, index) {
    lines.push(`${index + 1}. ${sanitizeAiPromptText(title)}`);
  });
  return lines.join("\n");
}

function normalizeCustomAnalysisResult(parsed, videoCount) {
  if (!parsed) {
    return null;
  }

  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 300)
      : "";

  const matches = Array.isArray(parsed.matches)
    ? parsed.matches
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= videoCount)
    : [];

  const groups = Array.isArray(parsed.groups)
    ? parsed.groups
        .map(function (group) {
          const name =
            typeof group?.name === "string" && group.name.trim()
              ? group.name.trim().slice(0, 30)
              : "기타";
          const videoIndexes = Array.isArray(group?.videoIndexes)
            ? group.videoIndexes
                .map((n) => Number(n))
                .filter((n) => Number.isInteger(n) && n >= 1 && n <= videoCount)
            : [];
          return { name: name, videoIndexes: videoIndexes };
        })
        .filter((group) => group.videoIndexes.length > 0)
    : [];

  const answer =
    typeof parsed.answer === "string" && parsed.answer.trim()
      ? parsed.answer.trim().slice(0, 1500)
      : "";

  // 영상을 찾거나 나누는 요청이 아닌 일반 질문 — 답변 글만 돌려준다.
  // (answer가 비어 있으면 summary라도 답으로 쓴다.)
  if (parsed.mode === "answer") {
    const text = answer || summary;
    return text ? { mode: "answer", summary: "", answer: text, matches: [], groups: [] } : null;
  }

  // mode가 명확하지 않게 와도(모델이 지시를 안 따른 경우), 실제로 채워진
  // 필드를 보고 최대한 합리적으로 판단한다.
  const isSearchMode = parsed.mode === "search" || (parsed.mode !== "group" && matches.length > 0 && groups.length === 0);

  if (isSearchMode) {
    if (matches.length === 0) {
      // 조건에 맞는 영상이 하나도 없다는 설명이 있으면 오류로 버리지 않고 답변으로 보여준다.
      const text = answer || summary;
      return text ? { mode: "answer", summary: "", answer: text, matches: [], groups: [] } : null;
    }
    return { mode: "search", summary: summary, matches: matches, groups: [] };
  }

  if (groups.length === 0) {
    const text = answer || summary;
    return text ? { mode: "answer", summary: "", answer: text, matches: [], groups: [] } : null;
  }

  return { mode: "group", summary: summary, matches: [], groups: groups };
}

const CUSTOM_ANALYSIS_CLOUD_SCHEMA = {
  type: "OBJECT",
  properties: {
    mode: { type: "STRING" },
    summary: { type: "STRING" },
    answer: { type: "STRING" },
    matches: { type: "ARRAY", items: { type: "INTEGER" } },
    groups: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          videoIndexes: { type: "ARRAY", items: { type: "INTEGER" } },
        },
        required: ["name", "videoIndexes"],
      },
    },
  },
  required: ["mode", "summary", "matches", "groups"],
};

const CUSTOM_ANALYSIS_NANO_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string" },
    summary: { type: "string" },
    answer: { type: "string" },
    matches: { type: "array", items: { type: "integer" } },
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          videoIndexes: { type: "array", items: { type: "integer" } },
        },
        required: ["name", "videoIndexes"],
      },
    },
  },
  required: ["mode", "summary", "matches", "groups"],
};

async function analyzePlaylistWithGeminiCloud(apiKey, userPrompt, videoTitles, instructionText) {
  const promptText = buildCustomAnalysisPrompt(userPrompt, videoTitles, instructionText);
  const requestBody = {
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: CUSTOM_ANALYSIS_CLOUD_SCHEMA,
    },
  };

  // 네트워크가 느리거나 응답이 없으면 무한정 기다리지 않고 20초 뒤에는
  // 포기하고 Nano(온디바이스) 경로로 넘어가도록 타임아웃을 둔다.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(
      `${GEMINI_API_BASE_URL}/models/${GEMINI_DUPLICATE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return null;
    }
    return normalizeCustomAnalysisResult(
      JSON.parse(text),
      Array.isArray(videoTitles) ? videoTitles.length : 0,
    );
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

let playlistAnalysisAiSessionPromise = null;

async function ensurePlaylistAnalysisAiSession() {
  if (!isDuplicateAiSupported()) {
    return null;
  }
  if (!playlistAnalysisAiSessionPromise) {
    playlistAnalysisAiSessionPromise = (async function () {
      try {
        const availability = await LanguageModel.availability();
        if (availability !== "available") {
          return null;
        }
        return await LanguageModel.create({
          initialPrompts: [
            {
              role: "system",
              content:
                "You group a user's personal YouTube playlist videos according to their own custom instruction, and always respond with data matching the requested JSON schema, writing only in Korean.",
            },
          ],
        });
      } catch (_error) {
        return null;
      }
    })();
  }
  const session = await playlistAnalysisAiSessionPromise;
  if (!session) {
    playlistAnalysisAiSessionPromise = null;
  }
  return session;
}

async function analyzePlaylistWithNano(session, userPrompt, videoTitles, instructionText) {
  const promptText = buildCustomAnalysisPrompt(userPrompt, videoTitles, instructionText);

  try {
    const response = await session.prompt(promptText, {
      responseConstraint: CUSTOM_ANALYSIS_NANO_SCHEMA,
    });
    const parsed = typeof response === "string" ? JSON.parse(response) : response;
    return normalizeCustomAnalysisResult(
      parsed,
      Array.isArray(videoTitles) ? videoTitles.length : 0,
    );
  } catch (_error) {
    return null;
  }
}

async function analyzePlaylistWithPrompt(userPrompt, videoTitles) {
  if (!userPrompt || !String(userPrompt).trim()) {
    throw new Error("분석 방식을 입력해주세요.");
  }

  const { text: instructionText, custom } = await resolvePrompt("playlistAnalysis");
  const detail = `영상 ${Array.isArray(videoTitles) ? videoTitles.length : 0}개`;
  const logBase = {
    instruction: instructionText,
    provided: { "사용자 요청": String(userPrompt), "영상 제목": Array.isArray(videoTitles) ? videoTitles : [] },
    prompt: buildCustomAnalysisPrompt(userPrompt, videoTitles, instructionText),
  };

  const apiKey = await getUserGeminiApiKey();
  if (apiKey) {
    const cloudResult = await analyzePlaylistWithGeminiCloud(apiKey, userPrompt, videoTitles, instructionText);
    if (cloudResult) {
      logAiRun("목록 분석", detail, AI_ENGINE_CLOUD, custom, { ...logBase, result: cloudResult });
      return cloudResult;
    }
  }

  const session = await ensurePlaylistAnalysisAiSession();
  if (session) {
    const nanoResult = await analyzePlaylistWithNano(session, userPrompt, videoTitles, instructionText);
    if (nanoResult) {
      logAiRun("목록 분석", detail, AI_ENGINE_NANO, custom, { ...logBase, result: nanoResult });
      return nanoResult;
    }
  }

  logAiRun("목록 분석", `${detail} (실패)`, AI_ENGINE_NONE, custom, { ...logBase, result: AI_LOG_NO_RESULT });
  throw new Error(
    "AI를 사용할 수 없습니다. 설정 탭에서 Gemini API Key를 등록하거나, Chrome의 내장 AI(Gemini Nano) 지원 여부를 확인해주세요.",
  );
}


// 상시 백그라운드 사전 생성(chrome.alarms로 30분마다 깨어나 미리 생성)을
// 시도해봤지만 체감 속도 개선이 없어서 되돌렸다 — 재생목록별 캐시(main.js의
// AI_RECOMMEND_CACHE_KEY, "내용 AI 추천"을 한 번 누르면 저장 전까지 계속
// 남아있음)만으로 충분하다고 판단. manifest.json에서 "alarms" 권한도 함께
// 제거했으므로, chrome.alarms API 자체를 더 이상 호출하지 않는다(권한 없이
// 호출하면 chrome.alarms가 undefined라 서비스워커가 즉시 크래시한다).

async function getUnavailableItems(forceRefresh) {
  const index = await getIndexedLibrary(forceRefresh);
  return index.items.filter(function (item) {
    return item.unavailable;
  });
}

async function searchLibrary(query) {
  const rawQuery = String(query || "").normalize("NFKC").toLowerCase();
  const duplicatesOnly = rawQuery.includes("중복");
  const searchTerm = normalizeSearchQuery(query);

  if (!searchTerm && !duplicatesOnly) {
    return [];
  }

  const index = await getIndexedLibrary();
  let candidates = index.items;

  if (duplicatesOnly) {
    const duplicateGroups = await getDuplicateGroups();
    candidates = duplicateGroups.flat();
  }

  return candidates.filter(function (item) {
    if (!searchTerm) {
      return true;
    }

    const searchableText = [
      item.title,
      item.channelTitle,
      item.description,
      item.sourcePlaylist?.title,
    ]
      .join(" ")
      .normalize("NFKC")
      .toLowerCase();

    return searchableText.includes(searchTerm);
  });
}

async function getIndexedLibrary(forceRefresh) {
  if (
    !forceRefresh &&
    libraryIndexCache &&
    Date.now() - libraryIndexCache.createdAt < LIBRARY_CACHE_TTL_MS
  ) {
    return libraryIndexCache;
  }

  const library = await getLibrary(forceRefresh);
  const items = [];

  for (const playlist of library.playlists) {
    let playlistItems;
    try {
      playlistItems = await getPlaylistItems(playlist.id, forceRefresh);
    } catch (_error) {
      // 재생목록 하나의 영상 목록을 못 가져와도(예: API가 접근을 막아둔
      // 특수 재생목록), 나머지 재생목록의 중복검사/청소 기능까지 전부
      // 멈추지 않도록 그 재생목록만 건너뛴다.
      continue;
    }
    playlistItems.forEach(function (item) {
      items.push({
        ...item,
        sourcePlaylist: playlist,
      });
    });
  }

  libraryIndexCache = {
    createdAt: Date.now(),
    playlists: library.playlists,
    items: items,
  };

  return libraryIndexCache;
}

function normalizeSearchQuery(query) {
  return String(query || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/중복(?:된)?/g, " ")
    .replace(
      /(?:영상|동영상|목록)(?:을|만)?\s*(?=찾아|검색|보여|출력|$)/g,
      " ",
    )
    .replace(
      /(찾아\s*줘|검색해\s*줘|보여\s*줘|출력해\s*줘)/g,
      " ",
    )
    .replace(/([^\s])만(?=\s|$)/g, "$1")
    .replace(/[?!.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getVideoDetails(videoIds, token) {
  const details = new Map();

  if (videoIds.length === 0) {
    return details;
  }

  for (let index = 0; index < videoIds.length; index += 50) {
    const ids = videoIds.slice(index, index + 50);
    const query = new URLSearchParams({
      part: "snippet,contentDetails,statistics,status",
      id: ids.join(","),
      maxResults: "50",
    });
    const data = await fetchYouTubeApi(
      `${YOUTUBE_API_BASE_URL}/videos?${query.toString()}`,
      token,
    );

    for (const item of data.items || []) {
      details.set(item.id, item);
    }
  }

  return details;
}

// 캐싱 전략: 클라이언트가 실제로 서버(YouTube) 데이터를 바꾸는 작업(영상
// 삭제, 재생목록 삭제/영상 추가) 뒤에는, 어떤 캐시가 영향을 받았는지
// 하나하나 따지는 대신 서버 쪽 캐시를 전부 비운다 — 다음 조회부터는
// 무조건 서버에서 새로 받아와서, 부분 무효화 누락으로 인한 낡은 데이터
// 노출을 원천적으로 막는다.
async function invalidateAllServerCaches() {
  libraryIndexCache = null;
  duplicateGroupsCache = null;
  await clearLibraryCache();
  await clearPlaylistItemsCache();
}

async function deletePlaylistItem(playlistItemId) {
  if (!playlistItemId) {
    throw new Error("삭제할 영상 항목 ID가 없습니다.");
  }

  const token = await getAccessToken();
  const query = new URLSearchParams({ id: playlistItemId });
  const response = await fetch(
    `${YOUTUBE_API_BASE_URL}/playlistItems?${query.toString()}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!response.ok) {
    throw await createApiError(response);
  }

  // 삭제로 재생목록별 영상 개수/목록이 바뀌었으므로, 캐시된 데이터를 그대로
  // 두면 다음에 열었을 때 삭제 전 상태가 그대로 보이게 된다.
  await invalidateAllServerCaches();
  return { playlistItemId: playlistItemId };
}

async function addVideoToPlaylist(playlistId, videoId) {
  if (!playlistId || !videoId) {
    throw new Error("재생목록 또는 영상 정보가 없습니다.");
  }

  const token = await getAccessToken();
  const response = await fetch(`${YOUTUBE_API_BASE_URL}/playlistItems?part=snippet`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      snippet: {
        playlistId: playlistId,
        resourceId: { kind: "youtube#video", videoId: videoId },
      },
    }),
  });

  if (!response.ok) {
    throw await createApiError(response);
  }

  return response.json();
}

async function deletePlaylist(playlistId) {
  if (!playlistId) {
    throw new Error("삭제할 재생목록 ID가 없습니다.");
  }

  const token = await getAccessToken();
  const query = new URLSearchParams({ id: playlistId });
  const response = await fetch(`${YOUTUBE_API_BASE_URL}/playlists?${query.toString()}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw await createApiError(response);
  }
}

// "앨범통합" — 원본 재생목록의 영상을 지정한 대상 재생목록으로 옮긴다.
// selectedPlaylistItemIds를 안 주면(또는 빈 배열) 원본의 전체 영상을
// 대상으로 하고, 다 옮겨지면 이제 빈 원본 재생목록 자체도 삭제한다
// (기존 "앨범 전체 통합" 동작). 특정 항목만 골라서 주면 그 영상들만
// 옮기고(원본에서는 개별 삭제), 원본에 남은 영상이 있으면 원본
// 재생목록 자체는 그대로 둔다.
//
// YouTube Data API는 "이동"을 직접 지원하지 않아 추가(playlistItems.insert)
// + 원본에서 삭제(playlistItems.delete / 필요시 playlists.delete)로
// 구현한다. 영상 하나가 실패해도 나머지는 계속 진행하되, 하나라도
// 옮기지 못한 영상이 있으면 데이터 유실을 막기 위해 원본 재생목록
// 자체는 삭제하지 않는다(사용자가 실패 목록을 보고 다시 시도할 수 있게
// 남겨둔다).
async function mergePlaylistInto(sourcePlaylistId, targetPlaylistId, selectedPlaylistItemIds) {
  if (!sourcePlaylistId || !targetPlaylistId) {
    throw new Error("통합할 재생목록 정보가 없습니다.");
  }
  if (sourcePlaylistId === targetPlaylistId) {
    throw new Error("같은 재생목록으로는 통합할 수 없습니다.");
  }

  const items = await getPlaylistItems(sourcePlaylistId, true);
  const selectedSet =
    Array.isArray(selectedPlaylistItemIds) && selectedPlaylistItemIds.length > 0
      ? new Set(selectedPlaylistItemIds)
      : null; // null = 원본 전체
  const targetItems = selectedSet
    ? items.filter((item) => selectedSet.has(item.playlistItemId))
    : items;
  const isFullMerge = targetItems.length === items.length;

  let movedCount = 0;
  const failedTitles = [];

  for (const item of targetItems) {
    if (!item.videoId) {
      // 이미 삭제되었거나 접근할 수 없는 영상은 애초에 옮길 방법이 없다.
      continue;
    }
    try {
      await addVideoToPlaylist(targetPlaylistId, item.videoId);
      if (!isFullMerge) {
        // 원본 재생목록 전체를 삭제할 게 아니라면, 옮긴 영상은 원본에서도
        // 개별적으로 지워야 "이동"이 된다(전체 삭제일 땐 아래에서
        // playlists.delete로 한 번에 정리되므로 따로 지울 필요 없다).
        await deletePlaylistItem(item.playlistItemId);
      }
      movedCount += 1;
    } catch (_error) {
      failedTitles.push(item.title || item.videoId);
    }
  }

  let deleted = false;
  if (isFullMerge && failedTitles.length === 0) {
    await deletePlaylist(sourcePlaylistId);
    deleted = true;
  }

  await invalidateAllServerCaches();

  return { movedCount: movedCount, failedTitles: failedTitles, deleted: deleted };
}

// interactive:true로 chrome.identity.getAuthToken()을 연달아 여러 번 호출하면
// (예: 계정 연결 직후 곧바로 재생목록을 불러올 때) 방금 발급받은 토큰이 캐시에
// 반영되기 전에 두 번째 호출이 겹쳐서, 크롬이 그걸 재사용하지 않고 동의 화면을
// 한 번 더 띄우는 문제가 있었다. interactive 요청 전에 항상 먼저 조용히
// (interactive:false) 캐시된 토큰이 있는지 확인해서, 있으면 팝업 없이 바로
// 그걸 쓰고, 없을 때만 실제 로그인/동의 화면을 띄운다.
async function getAccessToken(interactive = true) {
  if (interactive) {
    try {
      const silentResult = await chrome.identity.getAuthToken({ interactive: false });
      const silentToken = typeof silentResult === "string" ? silentResult : silentResult?.token;
      if (silentToken) {
        return silentToken;
      }
    } catch (_silentError) {
      // 캐시된 토큰이 없다는 뜻 — 아래에서 실제로 로그인/동의 화면을 띄운다.
    }
  }

  const result = await chrome.identity.getAuthToken({ interactive: interactive });
  const token = typeof result === "string" ? result : result?.token;

  if (!token) {
    throw new Error("Google 계정 인증이 필요합니다.");
  }

  return token;
}

// 온보딩 화면 1(계정 연결)에서 쓰는 조용한 인증 상태 확인 — 캐시된 토큰이
// 있으면 팝업 없이 바로 성공하고, 없으면 즉시 실패해서 "연결 필요" 화면을
// 보여줄 수 있게 한다(자동으로 로그인 팝업을 띄우지 않기 위해 interactive:false).
// 패널을 열 때마다(대부분 이미 로그인된 재방문 사용자) 실행되므로, 프로필
// 조회(userinfo 네트워크 호출)는 생략하고 토큰 캐시 여부만 빠르게 확인한다.
async function checkAuthStatus() {
  try {
    await getAccessToken(false);
    return { authenticated: true };
  } catch (_error) {
    return { authenticated: false };
  }
}

// 온보딩 화면 1의 "Google 계정으로 계속하기" 버튼 — 캐시된 토큰이 없으면
// 여기서 실제로 구글 계정 선택/동의 화면을 띄운다(interactive:true).
async function connectAccount() {
  const token = await getAccessToken(true);
  const profile = await getGoogleProfile(token);
  return { profile: profile };
}

/**
 * 확장 프로그램을 완전한 초기 상태로 되돌리는 로그아웃 함수
 */
async function performFullLogout() {
  try {
    // 1. 현재 토큰 가져오기 (MV3 환경에서 await 지원)
    // 크롬 버전에 따라 문자열 또는 객체({token: string})를 반환할 수 있으므로 분기 처리
    const authResult = await chrome.identity.getAuthToken({ interactive: false });
    const token = typeof authResult === "string" ? authResult : authResult?.token;

    if (token) {
      // 2. 구글 서버에 토큰 무효화(Revoke) 요청
      const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
        method: "POST",
        headers: { "Content-type": "application/x-www-form-urlencoded" },
      });

      if (response.ok) {
        console.log("구글 서버 권한 철회 완료");
      } else {
        console.error("권한 철회 실패:", response.statusText);
      }

      // 3. 브라우저에 캐시된 토큰 삭제
      await chrome.identity.removeCachedAuthToken({ token });
      console.log("캐시된 토큰 삭제 완료");
    }
  } catch (error) {
    // 이미 로그아웃 상태이거나 토큰이 없을 때 발생하는 에러 처리
    console.warn("토큰이 없거나 접근할 수 없음:", error.message);
  } finally {
    // 4. 토큰 유무나 통신 에러와 관계없이 스토리지는 항상 강제 초기화
    await clearStorage();
  }

  // 서비스 워커 메모리에 남아있는 인덱스 캐시도 함께 비운다 — 안 비우면
  // 스토리지는 초기화됐는데 메모리 캐시는 이전 계정 데이터를 계속 들고 있게 된다.
  libraryIndexCache = null;
  duplicateGroupsCache = null;
}

/**
 * 스토리지 초기화 헬퍼 함수
 */
// 관리자 프롬프트(및 그 프롬프트 명령으로 만들어진 결과인 목록 크기 설정)는
// 특정 구글 계정에 딸린 데이터가 아니라 이 확장 프로그램 자체의 설정이라,
// 로그아웃한다고 사라지면 안 된다 — 로그아웃 후 다시 로그인하면 관리자
// 프롬프트로 만든 결과(저장된 프롬프트, 화면 크기)가 원상태로 되돌아가
// 있던 버그의 원인이 이 목록을 빼놓지 않고 전부 지우던 것이었다.
// LIST_SCALE_STORAGE_KEY 값은 main.js의 동일 이름 상수와 반드시 같아야 한다.
const STORAGE_KEYS_PRESERVED_ON_LOGOUT = [
  ADMIN_LOG_SETTINGS_KEY,
  PROMPT_STORE_KEY,
  ADMINS_KEY,
  EXTRA_ADMINS_KEY,
  ADMIN_LOG_KEY,
  LIST_SCALE_STORAGE_KEY,
  ADMIN_REQUEST_DRAFT_KEY,
].concat(Object.values(LEGACY_PROMPT_KEYS));

async function clearStorage() {
  const preserved = await chrome.storage.local.get(STORAGE_KEYS_PRESERVED_ON_LOGOUT);

  // sync와 local 스토리지를 모두 비워 잔여 데이터를 확실히 제거
  await chrome.storage.sync.clear();
  await chrome.storage.local.clear();

  const toRestore = {};
  STORAGE_KEYS_PRESERVED_ON_LOGOUT.forEach((key) => {
    if (preserved && Object.prototype.hasOwnProperty.call(preserved, key)) {
      toRestore[key] = preserved[key];
    }
  });
  if (Object.keys(toRestore).length > 0) {
    await chrome.storage.local.set(toRestore);
  }

  console.log("모든 스토리지 데이터(API 키, 설정 등) 초기화 완료 (관리자 프롬프트/화면 크기 설정은 유지)");
}

// chrome.identity.getProfileUserInfo()는 email/id만 주고 이름·프로필
// 사진은 안 준다. 헤더에 구글 계정 아바타(이니셜 또는 사진)를 보여주려면
// 이름/사진이 필요해서, 이미 요청해둔 userinfo.profile/userinfo.email
// 스코프를 이용해 실제 userinfo 엔드포인트를 호출한다.
async function getGoogleProfile(token) {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return {
      email: data.email || "",
      name: data.name || "",
      picture: data.picture || "",
    };
  } catch (_error) {
    return null;
  }
}

async function fetchYouTubeApi(url, token) {
  let response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token: token });
    const refreshedToken = await getAccessToken();
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${refreshedToken}` },
    });
  }

  if (!response.ok) {
    throw await createApiError(response);
  }

  return response.json();
}

async function createApiError(response) {
  let message = `YouTube API 요청 실패 (${response.status})`;

  try {
    const data = await response.json();
    if (data?.error?.message) {
      message = data.error.message;
    }
  } catch (_error) {
    // Keep the status-based message.
  }

  return new Error(message);
}

function normalizePlaylist(playlist) {
  const snippet = playlist.snippet || {};
  return {
    id: playlist.id,
    etag: playlist.etag || "",
    title: snippet.title || "제목 없는 재생목록",
    description: snippet.description || "",
    thumbnailUrl: getBestThumbnail(snippet.thumbnails || {}),
    itemCount: Number(playlist.contentDetails?.itemCount || 0),
    privacyStatus: playlist.status?.privacyStatus || "",
    publishedAt: snippet.publishedAt || "",
  };
}

function normalizePlaylistItem(item, details) {
  const snippet = item.snippet || {};
  const videoId =
    item.contentDetails?.videoId || snippet.resourceId?.videoId || "";
  const detail = details.get(videoId) || {};
  const detailSnippet = detail.snippet || {};
  const ownPrivacyStatus =
    detail.status?.privacyStatus || item.status?.privacyStatus || "";

  // "비공개"와 "삭제됨"을 구분해야 두 메뉴로 나눌 수 있다.
  // - videos.list가 아예 아무것도 못 돌려주면(detail.id 없음): 진짜 삭제됐거나,
  //   내 소유가 아닌 남의 비공개 영상이라 접근 자체가 막힌 경우. 이때
  //   playlistItems 쪽 snippet.title에 YouTube가 "Private video"라는
  //   고정 문구를 그대로 내려주는 경우가 많아 그걸로 비공개를 가려낸다
  //   (그 외엔 삭제된 것으로 취급).
  // - detail.id는 있는데 privacyStatus가 private이면: 내가 소유한 영상이라
  //   상세 정보는 보이지만, 비공개라 실제 재생/임베드는 불가능한 경우.
  let unavailableReason = null;
  if (!detail.id) {
    unavailableReason = snippet.title === "Private video" ? "private" : "deleted";
  } else if (ownPrivacyStatus === "private") {
    unavailableReason = "private";
  }

  return {
    playlistItemId: item.id,
    videoId: videoId,
    title: detailSnippet.title || snippet.title || "삭제되었거나 비공개 영상",
    description: detailSnippet.description || snippet.description || "",
    channelTitle:
      detailSnippet.channelTitle ||
      snippet.videoOwnerChannelTitle ||
      "채널 정보 없음",
    thumbnailUrl: getBestThumbnail(
      detailSnippet.thumbnails || snippet.thumbnails || {},
    ),
    publishedAt:
      detailSnippet.publishedAt ||
      item.contentDetails?.videoPublishedAt ||
      "",
    duration: detail.contentDetails?.duration || "",
    viewCount: Number(detail.statistics?.viewCount || 0),
    likeCount: Number(detail.statistics?.likeCount || 0),
    privacyStatus: ownPrivacyStatus,
    unavailable: Boolean(unavailableReason),
    unavailableReason: unavailableReason,
  };
}

function getBestThumbnail(thumbnails) {
  return (
    thumbnails.maxres?.url ||
    thumbnails.standard?.url ||
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    ""
  );
}

chrome.runtime.onInstalled.addListener(function () {
  console.info("YouTube Playlister가 설치 또는 업데이트되었습니다.");
  registerYouTubeEmbedRefererRule();
});
