const DB_NAME = "family-memoir-local";
const DB_VERSION = 1;
const CACHE_PREFIX = "family-memoir-shell-";
const CHUNK_MS = 2000;

const app = document.getElementById("app");
const state = {
  db: null,
  questions: null,
  availableAudio: new Set(),
  profile: null,
  view: "loading",
  topicId: null,
  questionId: null,
  session: null,
  recorder: null,
  recordingState: "idle",
  activeClip: null,
  stream: null,
  currentAudio: null,
  stopPromise: null,
  timer: null,
  startedAtMs: 0,
  pausedAtMs: 0,
  pausedTotalMs: 0,
  deferredInstallPrompt: null,
  registration: null,
  updateReady: false,
  recovering: []
};

const icons = {
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"/><path d="m19.4 13.5 1.1.8-1.1 1.9-1.3-.5a7.3 7.3 0 0 1-1.5.9l-.2 1.4h-2.2l-.3-1.4a7.2 7.2 0 0 1-1.7 0l-.8 1.2-1.9-1.1.5-1.3a7.3 7.3 0 0 1-.9-1.5l-1.4-.2v-2.2l1.4-.3a7.2 7.2 0 0 1 0-1.7L5.9 8.7 7 6.8l1.3.5a7.3 7.3 0 0 1 1.5-.9l.2-1.4h2.2l.3 1.4a7.2 7.2 0 0 1 1.7 0l.8-1.2 1.9 1.1-.5 1.3a7.3 7.3 0 0 1 .9 1.5l1.4.2v2.2l-1.4.3a7.2 7.2 0 0 1 0 1.7Z" transform="translate(-1 -1) scale(1.08)"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7.5h16v12H4zM3 4.5h18v3H3zM9 11h6M9 14h6" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.8c0-.8.9-1.3 1.6-.9l9.1 6.1a1.2 1.2 0 0 1 0 2l-9.1 6.1a1.1 1.1 0 0 1-1.6-.9V5.8Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5.5h3.4v13H7zM13.6 5.5H17v13h-3.4z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 5-7 7 7 7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

app.addEventListener("click", handleClick);
app.addEventListener("change", handleChange);

init().catch((error) => {
  console.error("memoir app init failed", error);
  app.innerHTML = `<main class="app-shell"><section class="notice-card error"><strong>暂时打不开</strong><p>${escapeHtml(error.message || "请检查网络后重新打开。")}</p></section></main>`;
});

async function init() {
  state.db = await openDatabase();
  const response = await fetch("./questions.json", { cache: "no-cache" });
  if (!response.ok) throw new Error("问题库暂时没有加载成功，请联网后重试。");
  state.questions = await response.json();
  const audioManifest = await fetch("./audio/available.json", { cache: "no-cache" }).catch(() => null);
  if (audioManifest?.ok) {
    const available = await audioManifest.json().catch(() => ({}));
    if (Array.isArray(available.files)) state.availableAudio = new Set(available.files);
  }
  state.profile = await dbGet("settings", "profile");
  await markInterruptedSessions();
  await refreshSessions();
  state.view = state.profile ? "home" : "setup";
  registerServiceWorker();
  askForPersistentStorage();
  render();
  cacheQuestionAudio();
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    render();
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本机存储无法打开。"));
  });
}

function dbRequest(storeName, method, value) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, method === "get" || method === "getAll" ? "readonly" : "readwrite");
    const store = tx.objectStore(storeName);
    let request;
    if (method === "get") request = store.get(value);
    else if (method === "getAll") request = store.getAll();
    else if (method === "delete") request = store.delete(value);
    else request = store.put(value);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("保存失败，请检查手机空间。"));
    tx.onabort = () => reject(tx.error || new Error("保存失败，请检查手机空间。"));
  });
}

const dbGet = (store, key) => dbRequest(store, "get", key);
const dbGetAll = (store) => dbRequest(store, "getAll");
const dbPut = (store, value) => dbRequest(store, "put", value);
const dbDelete = (store, key) => dbRequest(store, "delete", key);

async function markInterruptedSessions() {
  const sessions = await dbGetAll("sessions");
  state.recovering = [];
  for (const session of sessions) {
    if (session.status === "recording" || session.status === "paused") {
      session.status = "interrupted";
      session.interruptedAt = new Date().toISOString();
      const activeClip = session.clips.find((clip) => clip.id === session.activeClipId);
      if (activeClip) {
        activeClip.interrupted = true;
        activeClip.state = "interrupted";
      }
      delete session.activeClipId;
      await dbPut("sessions", session);
    }
    if (session.status === "interrupted") state.recovering.push(session);
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).then((registration) => {
    state.registration = registration;
    cacheQuestionAudio();
    if (registration.waiting && navigator.serviceWorker.controller) state.updateReady = true;
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          state.updateReady = true;
          render();
        }
      });
    });
    render();
  }).catch((error) => console.warn("offline support unavailable", error));
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
}

async function askForPersistentStorage() {
  if (!navigator.storage?.persist) return;
  try { await navigator.storage.persist(); } catch { /* Browser may decline; user can still export manually. */ }
}

function cacheQuestionAudio() {
  const urls = [...state.availableAudio];
  const worker = navigator.serviceWorker?.controller || state.registration?.active;
  worker?.postMessage({ type: "CACHE_ASSETS", urls });
}

function render() {
  if (!state.questions) return;
  const status = state.updateReady ? renderUpdateBanner() : "";
  const install = state.deferredInstallPrompt && state.view !== "setup" ? renderInstallBanner() : "";
  const recover = state.recovering.length && state.view === "home" ? renderRecoveryBanner() : "";
  app.setAttribute("aria-busy", "false");
  app.innerHTML = `
    <div class="app-shell">
      <header class="site-header">
        <a class="brand" href="./" data-action="home" aria-label="回到话题列表">
          <span class="brand-mark" aria-hidden="true">时</span>
          <span class="brand-copy"><span class="brand-name">时光留声</span><span class="brand-note">慢慢讲，我们一直听</span></span>
        </a>
        ${state.profile ? `<div class="header-actions"><button class="icon-button" data-action="archive" aria-label="整理今天的回忆">${icons.archive}<span>今天的回忆</span></button><button class="icon-button header-settings" data-action="settings" aria-label="设置">${icons.settings}</button></div>` : ""}
      </header>
      ${status}${install}${recover}
      ${renderCurrentView()}
      <p class="footer-note">录音只保存在这部手机里 · 收到并备份后再清理</p>
    </div>`;
}

function renderCurrentView() {
  switch (state.view) {
    case "setup": return renderSetup(false);
    case "settings": return renderSetup(true);
    case "home": return renderHome();
    case "topic": return renderTopic();
    case "question": return renderQuestion();
    case "review": return renderReview();
    case "archive": return renderArchive();
    default: return renderHome();
  }
}

function renderSetup(isSettings) {
  const profile = state.profile || { label: "", voice: "female", autoSpeak: true };
  return `
    <main>
      ${isSettings ? `<button class="back-button" data-action="home">${icons.back} 返回话题</button>` : ""}
      <section class="hero-card setup-card">
        <p class="eyebrow">${isSettings ? "家人设置" : "欢迎回家"}</p>
        <h1>${isSettings ? "把陪伴调成喜欢的样子" : "把一家人的故事，慢慢留下来"}</h1>
        <p class="lead">${isSettings ? "这些设置只保存在这部手机。" : "每次聊一小段就好。想起什么，说什么，不着急。"}</p>
        <label class="field-label">这部手机由谁使用？</label>
        <div class="choice-grid" role="group" aria-label="选择老人称呼">
          ${["爷爷", "姥姥"].map((label) => `<button class="choice-button ${profile.label === label ? "selected" : ""}" data-action="choose-label" data-label="${label}" aria-pressed="${profile.label === label}">${label}</button>`).join("")}
        </div>
        <label class="field-label" for="voice-select">提问时的声音</label>
        <select class="select-input" id="voice-select" name="voice">
          <option value="female" ${profile.voice === "female" ? "selected" : ""}>温和女声</option>
          <option value="male" ${profile.voice === "male" ? "selected" : ""}>沉稳男声</option>
        </select>
        <div class="voice-preview-row" aria-label="试听提问声音">
          <button class="soft-button" data-action="preview-voice" data-voice="female">${icons.play}<span>试听女声</span></button>
          <button class="soft-button" data-action="preview-voice" data-voice="male">${icons.play}<span>试听男声</span></button>
        </div>
        <p class="small-note voice-preview-note">这是电脑生成的 Edge-TTS 样音；选好后，正式提问会使用对应的固定音频。</p>
        <div class="toggle-row">
          <div class="toggle-copy"><strong>打开问题时自动朗读</strong><span>随时可以再听一遍</span></div>
          <label class="switch"><span class="visually-hidden">打开问题时自动朗读</span><input type="checkbox" id="auto-speak" ${profile.autoSpeak ? "checked" : ""}><span class="switch-track"></span></label>
        </div>
        <div class="callout">手机桌面图标是可选的。也可以直接从浏览器打开这个网页。录音只保存在本机。</div>
        <button class="primary-button full-button" data-action="save-profile" ${!profile.label ? "disabled" : ""}>${isSettings ? "保存设置" : "开始聊聊"}</button>
      </section>
      ${!isSettings ? `<section class="notice-card"><strong>第一次使用</strong><p>请家人先在这部手机上完成称呼设置，并在首次录音时允许使用麦克风。</p></section>` : ""}
    </main>`;
}

function renderHome() {
  const today = localDateKey();
  const sessions = getCachedSessions().filter((session) => session.date === today && session.elderLabel === state.profile.label);
  const completedCount = sessions.reduce((sum, session) => sum + (session.clips?.length || 0), 0);
  return `
    <main>
      <section class="hero-card">
        <p class="eyebrow">${formatChineseDate(new Date())}</p>
        <h1>${state.profile.label}，<br>今天想聊聊什么？</h1>
        <p class="lead">一件往事、一张旧照片，想到哪里就说到哪里。我在这里陪您慢慢回忆。</p>
      </section>
      <div class="daily-strip">
        <span class="daily-icon">${icons.archive}</span>
        <div><strong>今天已留下 ${completedCount} 段声音</strong><span>录音先存在手机里，您可以随时回来继续。</span></div>
      </div>
      <div class="section-head"><h2>选一个想聊的话题</h2><span>${state.questions.topics.length} 个话题</span></div>
      <section class="topic-list" aria-label="话题列表">
        ${state.questions.topics.map((topic) => `<button class="topic-card" data-action="open-topic" data-topic="${escapeAttr(topic.id)}"><span class="topic-mark">${escapeHtml(topic.mark)}</span><span class="topic-copy"><strong>${escapeHtml(topic.title)}</strong><span>${escapeHtml(topic.subtitle)}</span></span><span class="row-arrow" aria-hidden="true">›</span></button>`).join("")}
      </section>
    </main>`;
}

function renderTopic() {
  const topic = getTopic(state.topicId);
  if (!topic) return renderHome();
  return `
    <main>
      <button class="back-button" data-action="home">${icons.back} 所有话题</button>
      <section class="page-heading"><p class="eyebrow">${escapeHtml(topic.mark)} · 慢慢回想</p><h1>${escapeHtml(topic.title)}</h1><p>${escapeHtml(topic.subtitle)}。挑一个问题开始就好。</p></section>
      <section class="question-list" aria-label="${escapeAttr(topic.title)}的问题">
        ${topic.questions.map((question, index) => `<button class="question-row" data-action="open-question" data-topic="${escapeAttr(topic.id)}" data-question="${escapeAttr(question.id)}"><span class="topic-mark">${String(index + 1).padStart(2, "0")}</span><span class="question-copy"><strong>${escapeHtml(question.text)}</strong><span>点开后会有人声把问题读给您听</span></span><span class="row-arrow" aria-hidden="true">›</span></button>`).join("")}
      </section>
    </main>`;
}

function renderQuestion() {
  const topic = getTopic(state.topicId);
  const question = getQuestion(state.topicId, state.questionId);
  if (!topic || !question) return renderHome();
  const active = state.recordingState === "recording" || state.recordingState === "paused";
  const statusClass = state.recordingState === "recording" ? "recording" : state.recordingState === "paused" ? "paused" : "";
  const statusText = state.recordingState === "recording" ? "正在录音，请慢慢讲" : state.recordingState === "paused" ? "录音已暂停，想好后再继续" : "准备好后，点下面的按钮开始讲述";
  return `
    <main>
      <button class="back-button" data-action="topic">${icons.back} ${escapeHtml(topic.title)}</button>
      <section class="question-card">
        <p class="question-number">${escapeHtml(topic.title)} · 回忆问题</p>
        <p class="question-text">${escapeHtml(question.text)}</p>
        <button class="listen-button" data-action="play-question" ${active ? "disabled" : ""}>${icons.play}<span>再听一遍</span></button>
        <p class="listen-note" id="listen-note" aria-live="polite">点“再听一遍”可重听问题；如果固定音频尚未生成，会用手机语音朗读。</p>
      </section>
      <section class="record-panel ${statusClass}" aria-label="录音控制">
        <div class="record-status"><span class="status-dot"></span><span>${statusText}</span></div>
        <div class="record-timer" id="record-timer" aria-live="off">${formatDuration(currentElapsed())}</div>
        ${active ? `<div class="button-row"><button class="secondary-button" data-action="${state.recordingState === "recording" ? "pause-recording" : "resume-recording"}">${state.recordingState === "recording" ? icons.pause : icons.play}<span>${state.recordingState === "recording" ? "暂停" : "继续讲"}</span></button><button class="primary-button" data-action="stop-recording">${icons.mic}<span>讲完了</span></button></div>` : `<button class="primary-button full-button" data-action="start-recording" ${!navigator.mediaDevices?.getUserMedia ? "disabled" : ""}>${icons.mic}<span>${state.session ? "再补充一段" : "开始讲述"}</span></button>`}
        ${!navigator.mediaDevices?.getUserMedia ? `<p class="small-note">当前浏览器没有麦克风权限，请在 HTTPS 网页或 localhost 打开。</p>` : ""}
      </section>
      ${state.session?.clips?.length ? renderClipList(state.session) : ""}
      <div class="callout">不需要一次讲完。可以暂停休息，讲完后还能回听和补充。</div>
    </main>`;
}

function renderReview() {
  const topic = getTopic(state.session?.topicId || state.topicId);
  const question = getQuestion(state.session?.topicId || state.topicId, state.session?.questionId || state.questionId);
  if (!topic || !question || !state.session) return renderHome();
  const interrupted = state.session.status === "interrupted";
  return `
    <main>
      <section class="page-heading"><p class="eyebrow">${interrupted ? "录音已恢复" : "刚才讲得真好"}</p><h1>${interrupted ? "上次录到这里" : "要不要再回听一下？"}</h1><p>${escapeHtml(question.text)}</p></section>
      ${interrupted ? `<section class="notice-card warning"><strong>已保留中断前录到的内容</strong><p>可以先试听这段，再补录。若播放不完整，也可以直接继续讲，原片段仍会保留。</p></section>` : `<section class="notice-card success"><strong>这段声音已保存在手机</strong><p>听听刚才说的内容。想起别的细节，可以再补充一段。</p></section>`}
      ${renderClipList(state.session)}
      <section class="record-panel">
        <button class="listen-button" data-action="play-supplement-prompt">${icons.play}<span>听听“还有补充吗？”</span></button>
        <p class="listen-note">${escapeHtml(state.questions.prompts.supplement)}</p>
        <div class="record-actions">
          <button class="secondary-button" data-action="record-supplement">${icons.mic}<span>我还想补充</span></button>
          <button class="primary-button" data-action="finish-question">没有补充了</button>
        </div>
      </section>
    </main>`;
}

function renderArchive() {
  const all = getCachedSessions().filter((session) => session.elderLabel === state.profile.label);
  const today = localDateKey();
  const todays = all.filter((session) => session.date === today);
  const clipCount = todays.reduce((sum, session) => sum + (session.clips?.length || 0), 0);
  return `
    <main>
      <button class="back-button" data-action="home">${icons.back} 返回话题</button>
      <section class="page-heading"><p class="eyebrow">本机整理</p><h1>今天的回忆</h1><p>${escapeHtml(state.profile.label)} · ${today}</p></section>
      <section class="archive-card">
        <div class="daily-strip" style="margin-top:0"><span class="daily-icon">${icons.archive}</span><div><strong>${todays.length} 道问题 · ${clipCount} 段录音</strong><span>生成一个 ZIP 后，用微信发给家人。</span></div></div>
        ${todays.length ? `<section class="session-list">${todays.map(renderSessionRow).join("")}</section>` : `<div class="empty-state">今天还没有录音。想起一件事时，回来选个话题就能开始。</div>`}
        <div class="archive-actions">
          <button class="primary-button full-button" data-action="export-today" ${clipCount ? "" : "disabled"}>生成今日 ZIP 并分享</button>
          <p class="small-note">如果手机不支持直接分享，会下载 ZIP。返回微信后，请确认文件已发送成功。</p>
        </div>
      </section>
      <section class="paper-card storage-card" style="margin-top:15px;padding:21px">
        <div class="section-head" style="margin:0"><h2>手机录音空间</h2><span id="storage-label">正在查看…</span></div>
        <div class="storage-meter" aria-hidden="true"><span id="storage-fill"></span></div>
        <p class="small-note">录音不会自动删除。请先在电脑或微信确认 ZIP 已收到并备份，再手动清理手机里的录音。</p>
        <button class="danger-button full-button" data-action="clear-exported" ${all.some((session) => session.exportedAt) ? "" : "disabled"}>手动清理已生成 ZIP 的录音</button>
      </section>
      ${all.some((session) => session.status === "interrupted") ? `<section class="notice-card warning"><strong>还有未完成的录音</strong><p>回到话题页后会提示恢复。未完成录音也会留在手机中。</p></section>` : ""}
    </main>`;
}

function renderClipList(session) {
  if (!session?.clips?.length) return "";
  const clips = session.clips.map((clip) => `<div class="clip-row"><button class="clip-play" data-action="play-clip" data-clip="${escapeAttr(clip.id)}" aria-label="播放${clip.kind === "supplement" ? "补充" : "回答"}录音">${icons.play}</button><span class="clip-copy"><strong>${clip.kind === "supplement" ? `补充 ${clip.order}` : "刚才的回答"}${clip.interrupted ? " · 中断前片段" : ""}</strong><span>${formatDuration(clip.durationMs || 0)} · ${formatTimeOfDay(clip.startedAt)}</span></span></div>`).join("");
  return `<section class="clip-list" aria-label="已录音频">${clips}</section>`;
}

function renderSessionRow(session) {
  const topic = getTopic(session.topicId);
  return `<div class="session-row"><span class="session-mark">${escapeHtml(topic?.mark || "回忆")}</span><span class="session-copy"><strong>${escapeHtml(topic?.title || session.topicTitle)} · ${session.clips?.length || 0} 段</strong><span>${escapeHtml(session.questionText)}</span></span><span class="row-arrow">${session.status === "interrupted" ? "待恢复" : session.exportedAt ? "已打包" : "已保存"}</span></div>`;
}

function renderUpdateBanner() {
  return `<section class="update-banner"><span class="banner-icon">↻</span><p>题目或网页有新版本，更新不会清除手机里的录音。</p><button data-action="apply-update">更新</button></section>`;
}

function renderInstallBanner() {
  return `<section class="install-banner"><span class="banner-icon">＋</span><p>可以把“时光留声”添加到桌面，之后像打开普通应用一样使用。</p><button data-action="install">添加</button></section>`;
}

function renderRecoveryBanner() {
  const session = state.recovering[0];
  return `<section class="recovery-banner"><span class="banner-icon">◷</span><p>发现 ${state.recovering.length} 段上次中断的录音，内容已保留。</p><button data-action="recover-session" data-session="${escapeAttr(session.id)}">查看恢复</button></section>`;
}

function handleChange(event) {
  if (event.target.id === "voice-select") {
    state.pendingVoice = event.target.value;
  }
  if (event.target.id === "auto-speak") {
    state.pendingAutoSpeak = event.target.checked;
  }
}

async function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (["home", "topic", "open-topic", "open-question", "settings", "archive"].includes(action) && ["recording", "paused", "stopping"].includes(state.recordingState)) {
      return toast("正在录音。请先暂停或点“讲完了”，保存后再离开。", 3800);
    }
    if (["home", "topic", "open-topic", "open-question", "settings", "archive", "finish-question"].includes(action)) stopAudio();
    if (action === "choose-label") {
      state.pendingLabel = button.dataset.label;
      document.querySelectorAll("[data-action='choose-label']").forEach((item) => {
        const selected = item.dataset.label === state.pendingLabel;
        item.classList.toggle("selected", selected);
        item.setAttribute("aria-pressed", String(selected));
      });
      const save = document.querySelector("[data-action='save-profile']");
      if (save) save.disabled = false;
    } else if (action === "save-profile") {
      const label = state.pendingLabel || state.profile?.label;
      const voice = state.pendingVoice || document.getElementById("voice-select")?.value || state.profile?.voice || "female";
      const autoSpeak = state.pendingAutoSpeak ?? document.getElementById("auto-speak")?.checked ?? state.profile?.autoSpeak ?? true;
      if (!label) return toast("请先选择这部手机由谁使用。");
      state.profile = { key: "profile", label, voice, autoSpeak, createdAt: state.profile?.createdAt || new Date().toISOString() };
      await dbPut("settings", state.profile);
      state.pendingLabel = null;
      state.pendingVoice = null;
      state.pendingAutoSpeak = null;
      state.view = "home";
      render();
      toast("设置已保存在这部手机里。");
      if (autoSpeak) playPrompt("welcome");
    } else if (action === "home") {
      state.view = "home";
      state.session = null;
      state.recordingState = "idle";
      render();
    } else if (action === "settings") {
      state.pendingLabel = state.profile.label;
      state.pendingVoice = state.profile.voice;
      state.pendingAutoSpeak = state.profile.autoSpeak;
      state.view = "settings";
      render();
    } else if (action === "archive") {
      state.view = "archive";
      render();
      updateStorageMeter();
    } else if (action === "open-topic") {
      state.topicId = button.dataset.topic;
      state.view = "topic";
      render();
    } else if (action === "topic") {
      state.view = "topic";
      state.session = null;
      state.recordingState = "idle";
      render();
    } else if (action === "open-question") {
      state.topicId = button.dataset.topic;
      state.questionId = button.dataset.question;
      state.session = null;
      state.recordingState = "idle";
      state.view = "question";
      render();
      if (state.profile.autoSpeak) playQuestion();
    } else if (action === "play-question") {
      playQuestion();
    } else if (action === "preview-voice") {
      await playVoicePreview(button.dataset.voice);
    } else if (action === "start-recording") {
      await startRecording("answer");
    } else if (action === "pause-recording") {
      pauseRecording();
    } else if (action === "resume-recording") {
      resumeRecording();
    } else if (action === "stop-recording") {
      const stopTask = stopRecording();
      if (state.profile.autoSpeak) playPrompt("supplement");
      await stopTask;
    } else if (action === "record-supplement") {
      state.view = "question";
      render();
      await startRecording("supplement");
    } else if (action === "finish-question") {
      await finishQuestion();
    } else if (action === "play-clip") {
      await playClip(button.dataset.clip);
    } else if (action === "play-supplement-prompt") {
      playPrompt("supplement");
    } else if (action === "recover-session") {
      const session = await dbGet("sessions", button.dataset.session);
      if (!session) return toast("没有找到这段录音，请重新打开话题列表。");
      state.session = session;
      state.topicId = session.topicId;
      state.questionId = session.questionId;
      state.view = "review";
      render();
    } else if (action === "export-today") {
      await exportToday();
    } else if (action === "clear-exported") {
      await clearExportedSessions();
    } else if (action === "install") {
      await installApp();
    } else if (action === "apply-update") {
      state.registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
    }
  } catch (error) {
    console.error("memoir action failed", action, error);
    toast(friendlyError(error));
  }
}

function getCachedSessions() {
  return state.sessionsCache || [];
}

async function refreshSessions() {
  state.sessionsCache = await dbGetAll("sessions");
  return state.sessionsCache;
}

async function startRecording(kind) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("这部手机的浏览器暂不支持录音，请换用安卓 Chrome 打开。");
  if (state.recorder && state.recorder.state !== "inactive") return;
  const question = getQuestion(state.topicId, state.questionId);
  const topic = getTopic(state.topicId);
  if (!question || !topic) throw new Error("没有找到这道问题，请返回话题列表重新打开。");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  state.stream = stream;
  const mimeType = chooseAudioMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  state.recorder = recorder;
  let writeQueue = Promise.resolve();
  let resolveStop;
  state.stopPromise = new Promise((resolve) => { resolveStop = resolve; });

  let session = state.session;
  if (!session || session.status === "complete") {
    session = {
      id: makeId(),
      elderLabel: state.profile.label,
      date: localDateKey(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
      topicId: topic.id,
      topicTitle: topic.title,
      questionId: question.id,
      questionText: question.text,
      status: "recording",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      clips: []
    };
  }
  const order = session.clips.filter((clip) => clip.kind === "supplement").length + 1;
  const clip = {
    id: makeId(),
    kind,
    order: kind === "answer" ? 1 : order,
    mimeType: recorder.mimeType || mimeType || "audio/webm",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    chunksCount: 0,
    state: "recording"
  };
  session.clips.push(clip);
  session.status = "recording";
  session.activeClipId = clip.id;
  session.updatedAt = new Date().toISOString();
  state.session = session;
  state.activeClip = clip;
  state.recordingState = "recording";
  await dbPut("sessions", session);

  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data || !event.data.size) return;
    const blob = event.data;
    const index = clip.chunksCount;
    const key = `${clip.id}:${String(index).padStart(8, "0")}`;
    clip.chunksCount += 1;
    clip.durationMs = currentElapsed();
    writeQueue = writeQueue.then(async () => {
      await dbPut("chunks", { key, clipId: clip.id, index, blob });
      session.updatedAt = new Date().toISOString();
      await dbPut("sessions", session);
    });
  });
  recorder.addEventListener("stop", async () => {
    try {
      await writeQueue;
      clip.state = "saved";
      clip.endedAt = new Date().toISOString();
      clip.durationMs = currentElapsed();
      session.status = "review";
      session.updatedAt = new Date().toISOString();
      delete session.activeClipId;
      await dbPut("sessions", session);
      state.session = session;
      state.activeClip = null;
      state.recordingState = "idle";
      state.view = "review";
      await refreshSessions();
      stopTimer();
      render();
    } catch (error) {
      clip.state = "interrupted";
      clip.interrupted = true;
      session.status = "interrupted";
      session.updatedAt = new Date().toISOString();
      delete session.activeClipId;
      try { await dbPut("sessions", session); } catch { /* Keep the already persisted chunks recoverable. */ }
      state.session = session;
      state.activeClip = null;
      state.recordingState = "idle";
      state.view = "review";
      await refreshSessions();
      stopTimer();
      render();
      toast("录音片段已停止，但保存时遇到问题。请不要关闭页面，稍后重试。");
    } finally {
      stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
      state.recorder = null;
      resolveStop();
    }
  }, { once: true });
  recorder.addEventListener("error", () => toast("录音出现问题，已保存的部分会保留。"));
  recorder.start(CHUNK_MS);
  state.startedAtMs = Date.now();
  state.pausedAtMs = 0;
  state.pausedTotalMs = 0;
  startTimer();
  await refreshSessions();
  render();
  toast(kind === "supplement" ? "开始录补充内容了。" : "开始录音了，请慢慢讲。", 2200);
}

function chooseAudioMimeType() {
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function pauseRecording() {
  if (!state.recorder || state.recorder.state !== "recording") return;
  state.recorder.pause();
  state.pausedAtMs = Date.now();
  state.recordingState = "paused";
  if (state.session) {
    state.session.status = "paused";
    state.activeClip.state = "paused";
    state.activeClip.durationMs = currentElapsed();
    dbPut("sessions", state.session).catch(() => toast("暂停了，但状态暂未保存。"));
  }
  render();
  toast("已经暂停，想好后可以继续讲。", 2200);
}

function resumeRecording() {
  if (!state.recorder || state.recorder.state !== "paused") return;
  if (state.pausedAtMs) state.pausedTotalMs += Date.now() - state.pausedAtMs;
  state.pausedAtMs = 0;
  state.recorder.resume();
  state.recordingState = "recording";
  if (state.session) {
    state.session.status = "recording";
    state.activeClip.state = "recording";
    dbPut("sessions", state.session).catch(() => toast("继续录音了，但状态暂未保存。"));
  }
  render();
}

function stopRecording() {
  if (!state.recorder || state.recorder.state === "inactive") return state.stopPromise || Promise.resolve();
  if (state.recordingState === "stopping") return state.stopPromise || Promise.resolve();
  if (state.pausedAtMs) state.pausedTotalMs += Date.now() - state.pausedAtMs;
  state.pausedAtMs = 0;
  state.recordingState = "stopping";
  state.activeClip.durationMs = currentElapsed();
  state.recorder.stop();
  stopTimer();
  return state.stopPromise;
}

function startTimer() {
  stopTimer();
  state.timer = window.setInterval(() => {
    const timer = document.getElementById("record-timer");
    if (timer && state.recordingState !== "paused") timer.textContent = formatDuration(currentElapsed());
  }, 400);
}

function stopTimer() {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = null;
}

function currentElapsed() {
  if (!state.startedAtMs) return 0;
  const currentPause = state.pausedAtMs ? Date.now() - state.pausedAtMs : 0;
  return Math.max(0, Date.now() - state.startedAtMs - state.pausedTotalMs - currentPause);
}

async function finishQuestion() {
  if (!state.session) return;
  const session = state.session;
  session.status = "complete";
  session.completedAt = new Date().toISOString();
  session.updatedAt = session.completedAt;
  delete session.activeClipId;
  await dbPut("sessions", session);
  await refreshSessions();
  state.recovering = state.recovering.filter((item) => item.id !== session.id);
  state.view = "topic";
  state.session = null;
  state.recordingState = "idle";
  render();
  if (state.profile.autoSpeak) playPrompt("finished");
}

async function getClipBlob(clipId) {
  const chunks = (await dbGetAll("chunks")).filter((chunk) => chunk.clipId === clipId).sort((a, b) => a.index - b.index);
  if (!chunks.length) throw new Error("还没有找到这段录音内容。");
  const session = state.session || (await dbGetAll("sessions")).find((item) => item.clips.some((clip) => clip.id === clipId));
  const clip = session?.clips.find((item) => item.id === clipId);
  return new Blob(chunks.map((chunk) => chunk.blob), { type: clip?.mimeType || chunks[0].blob.type || "audio/webm" });
}

async function playClip(clipId) {
  const blob = await getClipBlob(clipId);
  stopAudio();
  const audio = new Audio(URL.createObjectURL(blob));
  state.currentAudio = audio;
  const cleanup = () => {
    URL.revokeObjectURL(audio.src);
    if (state.currentAudio === audio) state.currentAudio = null;
  };
  audio.addEventListener("ended", cleanup, { once: true });
  audio.addEventListener("error", cleanup, { once: true });
  await audio.play();
}

function playQuestion() {
  const question = getQuestion(state.topicId, state.questionId);
  const audio = question?.audio?.[state.profile.voice];
  if (question) playText(question.text, state.availableAudio.has(audio) ? audio : null);
}

function playPrompt(key) {
  const text = state.questions.prompts[key];
  const audio = state.questions.promptAudio?.[key]?.[state.profile.voice];
  if (text) playText(text, state.availableAudio.has(audio) ? audio : null);
}

async function playVoicePreview(voice) {
  const path = voice === "male" ? "./audio/preview/intro-male.mp3" : "./audio/preview/intro-female.mp3";
  stopAudio();
  const audio = new Audio(path);
  state.currentAudio = audio;
  audio.addEventListener("ended", () => { if (state.currentAudio === audio) state.currentAudio = null; }, { once: true });
  try {
    await audio.play();
  } catch {
    if (state.currentAudio === audio) state.currentAudio = null;
    toast("声音样音暂时无法播放，请确认网页已经联网打开一次。", 4000);
  }
}

function playText(text, path) {
  stopAudio();
  const note = document.getElementById("listen-note");
  if (path) {
    const audio = new Audio(path);
    state.currentAudio = audio;
    let fallbackStarted = false;
    const fallback = () => {
      if (fallbackStarted) return;
      fallbackStarted = true;
      if (state.currentAudio === audio) state.currentAudio = null;
      speakFallback(text);
    };
    audio.addEventListener("ended", () => { if (state.currentAudio === audio) state.currentAudio = null; }, { once: true });
    audio.addEventListener("error", fallback, { once: true });
    audio.play().then(() => {
      if (note) note.textContent = "正在朗读，您可以继续听。";
    }).catch(fallback);
    return;
  }
  speakFallback(text);
}

function stopAudio() {
  if (state.currentAudio) {
    const audio = state.currentAudio;
    state.currentAudio = null;
    audio.pause();
    if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
  }
  window.speechSynthesis?.cancel();
}

function speakFallback(text) {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    toast("提问音频还没有准备好，您可以先看屏幕上的文字。", 3500);
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = 0.92;
  speechSynthesis.speak(utterance);
  const note = document.getElementById("listen-note");
  if (note) note.textContent = "正在用手机语音预览；准备好后会自动使用固定提问音频。";
}

async function exportToday() {
  const today = localDateKey();
  const sessions = (await refreshSessions()).filter((session) => session.elderLabel === state.profile.label && session.date === today && session.clips?.length && session.status !== "recording" && session.status !== "paused");
  if (!sessions.length) return toast("今天还没有可以打包的录音。");
  const files = [];
  const manifest = {
    format: "family-memoir-archive",
    version: 1,
    elderLabel: state.profile.label,
    date: today,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
    exportedAt: new Date().toISOString(),
    sessions: []
  };
  for (const session of sessions) {
    const manifestSession = {
      sessionId: session.id,
      topicId: session.topicId,
      topicTitle: session.topicTitle,
      questionId: session.questionId,
      questionText: session.questionText,
      status: session.status,
      createdAt: session.createdAt,
      completedAt: session.completedAt || null,
      clips: []
    };
    for (const clip of session.clips) {
      const blob = await getSessionClipBlob(session, clip);
      const ext = extensionForMime(clip.mimeType || blob.type);
      const fileName = `recordings/${session.id}/${String(clip.order).padStart(2, "0")}-${clip.kind}.${ext}`;
      files.push({ name: fileName, data: new Uint8Array(await blob.arrayBuffer()) });
      manifestSession.clips.push({
        clipId: clip.id,
        order: clip.order,
        kind: clip.kind,
        fileName,
        mimeType: clip.mimeType || blob.type,
        startedAt: clip.startedAt,
        endedAt: clip.endedAt || null,
        durationMs: clip.durationMs || null,
        interrupted: Boolean(clip.interrupted)
      });
    }
    manifest.sessions.push(manifestSession);
  }
  files.unshift({ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  const zipBlob = createStoredZip(files);
  const zipName = `${safeFileName(state.profile.label)}_${today}_家庭回忆.zip`;
  const file = new File([zipBlob], zipName, { type: "application/zip" });

  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: `${state.profile.label}的家庭回忆`, text: "今天的回忆录音，请帮忙保存。" });
      await markExported(sessions);
      toast("分享面板已关闭。请确认微信里已发送成功，再清理手机录音。", 4500);
    } catch (error) {
      if (error.name === "AbortError") toast("分享已取消，录音仍保存在手机里。", 3500);
      else downloadZip(zipBlob, zipName, sessions);
    }
  } else {
    downloadZip(zipBlob, zipName, sessions);
  }
}

async function getSessionClipBlob(session, clip) {
  const chunks = (await dbGetAll("chunks")).filter((chunk) => chunk.clipId === clip.id).sort((a, b) => a.index - b.index);
  if (!chunks.length) throw new Error(`没有找到第 ${clip.order} 段录音。`);
  return new Blob(chunks.map((chunk) => chunk.blob), { type: clip.mimeType || chunks[0].blob.type || "audio/webm" });
}

function extensionForMime(mime) {
  if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

async function markExported(sessions) {
  const now = new Date().toISOString();
  for (const session of sessions) {
    session.exportedAt = now;
    await dbPut("sessions", session);
  }
  await refreshSessions();
  render();
}

function downloadZip(blob, name, sessions) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 15000);
  markExported(sessions).catch(() => {});
  toast("ZIP 已下载。请从下载目录通过微信发送，确认收到后再清理录音。", 4500);
}

async function clearExportedSessions() {
  const sessions = (await refreshSessions()).filter((session) => session.elderLabel === state.profile.label && session.exportedAt);
  if (!sessions.length) return toast("还没有生成过 ZIP 的录音。");
  const clipTotal = sessions.reduce((sum, session) => sum + session.clips.length, 0);
  const accepted = window.confirm(`将从这部手机清理 ${sessions.length} 道问题、${clipTotal} 段录音。请先确认 ZIP 已在微信或电脑上收到并备份。继续清理吗？`);
  if (!accepted) return;
  for (const session of sessions) {
    for (const clip of session.clips) {
      const chunks = (await dbGetAll("chunks")).filter((chunk) => chunk.clipId === clip.id);
      for (const chunk of chunks) await dbDelete("chunks", chunk.key);
    }
    await dbDelete("sessions", session.id);
  }
  await refreshSessions();
  render();
  updateStorageMeter();
  toast("已按你的操作清理手机录音。", 3000);
}

async function updateStorageMeter() {
  const label = document.getElementById("storage-label");
  const fill = document.getElementById("storage-fill");
  if (!label || !navigator.storage?.estimate) {
    if (label) label.textContent = "浏览器未提供空间信息";
    return;
  }
  try {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage || 0;
    const quota = estimate.quota || 0;
    label.textContent = `${formatBytes(usage)} 已使用`;
    if (fill && quota) fill.style.width = `${Math.min(100, usage / quota * 100)}%`;
  } catch {
    label.textContent = "暂时无法读取";
  }
}

async function installApp() {
  if (!state.deferredInstallPrompt) return;
  await state.deferredInstallPrompt.prompt();
  state.deferredInstallPrompt = null;
  render();
}

function openTopic(topicId) {
  state.topicId = topicId;
  state.view = "topic";
  render();
}

function getTopic(topicId) { return state.questions.topics.find((topic) => topic.id === topicId); }
function getQuestion(topicId, questionId) { return getTopic(topicId)?.questions.find((question) => question.id === questionId); }

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatChineseDate(date) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(date);
}

function formatDuration(ms = 0) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatTimeOfDay(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function safeFileName(value) { return value.replace(/[\\/:*?"<>|]/g, "_"); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function escapeAttr(value) { return escapeHtml(value); }
function formatBytes(value) {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function friendlyError(error) {
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") return "麦克风没有权限。请在浏览器地址栏旁允许使用麦克风，再重新开始。";
  if (error.name === "NotFoundError") return "这部手机没有找到可用的麦克风。";
  if (error.name === "QuotaExceededError") return "手机可用空间不足。请先导出 ZIP 并确认收到，再清理旧录音。";
  return error.message || "刚才没有完成，请重试。";
}

function toast(message, duration = 3200) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.append(el);
  window.setTimeout(() => el.remove(), duration);
}

function createStoredZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const file of files) {
    const name = encoder.encode(file.name.replace(/\\/g, "/"));
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
