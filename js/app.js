/* 划课 · 课时计数器 —— 多页面共用逻辑（页面感知版） */
(function () {
  "use strict";

  var STORAGE_KEY = "huake_data_v1";

  /* ---------- 存储层 ---------- */
  var memoryFallback = null;
  var canPersist = testStorage();

  function testStorage() {
    try {
      var k = "__huake_test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  function normalizeState(d) {
    if (!d || typeof d !== "object" || !Array.isArray(d.cards)) return emptyState();
    d.history = Array.isArray(d.history) ? d.history : [];
    d.meta = d.meta || {};
    if (!Array.isArray(d.operators) || d.operators.length === 0) {
      d.operators = [{ id: "op_default", name: "默认" }];
    }
    if (!d.meta.currentOperator || !findOp(d.operators, d.meta.currentOperator)) {
      d.meta.currentOperator = d.operators[0].id;
    }
    // 旧历史补操作人字段（早期版本无多人概念）
    d.history.forEach(function (h) {
      if (h.operatorId === undefined) h.operatorId = "";
      if (h.operatorName === undefined) h.operatorName = "";
    });
    d.attachments = Array.isArray(d.attachments) ? d.attachments : [];
    // 文件夹（课时卡分组）
    d.folders = Array.isArray(d.folders) ? d.folders : [];
    d.folders.forEach(function (f) {
      if (!f || typeof f !== "object") return;
      if (typeof f.id !== "string" || !f.id) f.id = uid();
      if (typeof f.name !== "string") f.name = "";
      if (typeof f.createdAt !== "string") f.createdAt = new Date().toISOString();
    });
    d.folders = d.folders.filter(function (f) { return f && typeof f === "object"; });
    var fids = {};
    d.folders.forEach(function (f) { fids[f.id] = true; });
    d.cards.forEach(function (c) {
      if (c.image === undefined) c.image = "";
      if (!Array.isArray(c.receipts)) c.receipts = [];
      if (typeof c.folderId !== "string") c.folderId = "";
      if (c.folderId && !fids[c.folderId]) c.folderId = "";   // 文件夹没了：卡片回未分组
      // 类型：lesson=按节计费的课时 / package=课包（记录总价与购买日期）
      if (c.kind !== "package") c.kind = "lesson";
      c.price = Number.isFinite(c.price) && c.price >= 0 ? c.price : 0;
      if (typeof c.purchasedAt !== "string") c.purchasedAt = "";
    });
    if (typeof d.meta.syncedAt !== "string") d.meta.syncedAt = "";
    if (typeof d.meta.pendingSync !== "boolean") d.meta.pendingSync = false;
    return d;
  }

  function load() {
    var raw;
    try {
      raw = canPersist ? localStorage.getItem(STORAGE_KEY) : memoryFallback;
    } catch (e) {
      raw = memoryFallback;
    }
    if (!raw) return emptyState();
    try {
      return normalizeState(JSON.parse(raw));
    } catch (e) {
      return emptyState();
    }
  }

  function saveLocal() {
    var raw = JSON.stringify(state);
    if (canPersist) {
      try {
        localStorage.setItem(STORAGE_KEY, raw);
      } catch (e) {
        canPersist = false;
        memoryFallback = raw;
        showStorageWarn();
      }
    } else {
      memoryFallback = raw;
    }
  }

  function save() {
    if (CLOUD.mode) state.meta.pendingSync = true;
    saveLocal();
    if (CLOUD.mode) scheduleCloudSave();
    else if (SYNC.enabled) schedulePush();
  }

  function emptyState() {
    var def = "op_default";
    return {
      cards: [], history: [], attachments: [], folders: [],
      operators: [{ id: def, name: "默认" }],
      meta: { lastAutoBackupMonth: "", theme: "light", currentOperator: def }
    };
  }

  var state = load();

  /* ---------- 多设备共享（本地服务器模式，无需云、无需登录） ---------- */
  /* 原理：电脑运行 scripts/serve.py 时，页面通过 /api/state 读写同一份 data.json；
     手机 / iPad 连同一 Wi-Fi 访问局域网地址，即与电脑共用一份数据。
     非局域网打开（file:// 或已发布的静态链接）时自动退回本地模式，数据只存本机。 */
  var SYNC = { enabled: false, pushing: false, dirty: false, timer: null };

  function isFileProtocol() { return location.protocol === "file:"; }
  function localHasData() {
    return state.cards.length > 0 || state.history.length > 0 || state.attachments.length > 0;
  }

  function syncBadge(mode) {
    var b = $("sync-badge");
    if (!b) {
      var f = document.querySelector(".site-footer");
      if (!f) return;
      b = document.createElement("span");
      b.id = "sync-badge";
      f.appendChild(b);
    }
    if (mode === "shared") {
      b.textContent = " · 共享模式：与电脑同一 Wi-Fi 的设备共用一份数据";
      b.className = "sync-badge on";
    } else if (mode === "error") {
      b.textContent = " · 共享服务暂时连不上，稍后自动重试";
      b.className = "sync-badge err";
    } else {
      b.textContent = isFileProtocol()
        ? " · 本地模式：数据只存本机（要共享，请用电脑给出的局域网地址访问）"
        : " · 本地模式：数据只存本机";
      b.className = "sync-badge";
    }
  }

  function schedulePush() {
    if (!SYNC.enabled) return;
    clearTimeout(SYNC.timer);
    SYNC.timer = setTimeout(syncPush, 500);
  }

  function syncPush() {
    if (!SYNC.enabled) return;
    if (SYNC.pushing) { SYNC.dirty = true; return; }
    SYNC.pushing = true;
    var now = new Date().toISOString();
    fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updatedAt: now, state: state })
    }).then(function (r) { return r.json(); }).then(function (res) {
      SYNC.pushing = false;
      if (res && res.ok) {
        if (state.meta.syncedAt !== now) { state.meta.syncedAt = now; saveLocal(); }
        syncBadge("shared");
      } else {
        syncBadge("error");
      }
      if (SYNC.dirty) { SYNC.dirty = false; schedulePush(); }
    }).catch(function () {
      SYNC.pushing = false;
      syncBadge("error");
    });
  }

  function syncAdopt(res, isPull) {
    var serverState = res && res.state;
    var serverTs = (res && res.updatedAt) || "";
    var localTs = state.meta.syncedAt || "";
    var serverOk = serverState && typeof serverState === "object" && Array.isArray(serverState.cards);
    SYNC.enabled = true;
    if (serverOk && serverTs > localTs) {
      // 其他设备更新过：采用服务器数据
      state = normalizeState(serverState);
      saveLocal(); render();
      if (isPull) toast("已同步其他设备的最新改动");
    } else if (!isPull && localHasData()) {
      // 本地不旧于服务器：把本地数据推上去（含服务器为空时的首次迁移）
      syncPush();
    }
    syncBadge("shared");
  }

  function syncPull() {
    if (!SYNC.enabled) return;
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (res) { syncAdopt(res, true); })
      .catch(function () { /* 网络抖动时静默，下次轮询再试 */ });
  }

  /* ---------- 云端同步（发布域名 + 登录后启用） ---------- */
  /* 原理：在发布域名上，页面按账号把整份数据存成云端存储里的一个私有文件
     （users/<uid>/huake/state.json，存储策略按登录身份隔离，只有同一账号能读写），
     并定时轻量探测文件变动、下载较新的一份。
     同一 Wi-Fi 下的局域网共享优先（无需登录）；file:// 本地打开时纯本地。
     注意：多设备同步请在各端使用相同的登录方式（推荐微信登录），
     换一种登录方式（如手机验证码）会得到另一个数据空间。 */
  var CLOUD = {
    client: null, mode: false, user: null,
    path: null, lastTs: 0, exists: null, pushing: false, dirty: false, timer: null,
    noInfo: false, infoFails: 0, pathRetry: 0,
    pendingOtp: null, codeLeft: 0, codeTimer: null
  };

  function cloudCfg() { return window.PUBLIC_CLOUD_CONFIG || null; }

  // 只有「发布域名 + 有配置 + 开关打开」才走云；局域网 / file:// / 其它域名一律不碰云
  function cloudPossible() {
    var cfg = cloudCfg();
    if (!cfg || !cfg.endpoint || !cfg.publishableKey) return false;
    if (cfg.enabled === false) return false;   // 显式关闭：数据表就绪前不启用云同步
    if (isFileProtocol()) return false;
    try {
      if (location.hostname !== new URL(cfg.endpoint).hostname) return false;
    } catch (e) { return false; }
    return true;
  }

  function toPromise(v) { return Promise.resolve(v); }

  // 按需动态加载云端 SDK（jsdelivr 为主、unpkg 兜底）；只有真的需要云时才请求
  function ensureSdk(cb) {
    if (window.WorkBuddyCloud && window.WorkBuddyCloud.createWorkBuddyCloud) { cb(true); return; }
    var called = false;
    function done(ok) { if (!called) { called = true; cb(ok); } }
    function load(url, next) {
      var s = document.createElement("script");
      s.src = url;
      s.onload = function () {
        if (window.WorkBuddyCloud && window.WorkBuddyCloud.createWorkBuddyCloud) done(true);
        else if (next) next();
        else done(false);
      };
      s.onerror = function () { if (next) next(); else done(false); };
      document.head.appendChild(s);
    }
    load("https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js", function () {
      load("https://unpkg.com/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js", null);
    });
  }

  function cloudStart() {
    var cfg = cloudCfg();
    try {
      CLOUD.client = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: cfg.endpoint,
        oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
        publishableKey: cfg.publishableKey
      });
    } catch (e) {
      syncBadge("local");
      return;
    }
    CLOUD.mode = true;
    try {
      CLOUD.client.auth.onAuthStateChange(function (event) {
        if (event === "SIGNED_OUT") {
          CLOUD.user = null;
          cloudReset();
          renderAccount();
          showLoginOverlay();
        }
      });
    } catch (e) { /* 个别 SDK 版本无此方法，忽略 */ }
    restoreAuth();
  }

  /* ---- 登录门（未登录时全屏遮盖，保护个人数据） ---- */
  function gateFormHtml() {
    return '' +
      '<div class="gate-logo">📒</div>' +
      '<h2 class="gate-title">登录后开始同步</h2>' +
      '<p class="gate-desc">用同一个账号、相同的登录方式登录电脑、手机和 iPad，各端数据自动同步；数据只属于你的账号。</p>' +
      '<button type="button" id="gate-wechat" class="btn primary gate-wechat">💬 微信登录</button>' +
      '<div class="gate-or"><span>或</span></div>' +
      '<div class="gate-row">' +
        '<input id="gate-phone" type="tel" inputmode="numeric" maxlength="11" placeholder="手机号" autocomplete="tel" />' +
        '<button type="button" id="gate-code" class="btn">获取验证码</button>' +
      '</div>' +
      '<div class="gate-phone-err" id="gate-phone-err"></div>' +
      '<div class="gate-row">' +
        '<input id="gate-otp" type="text" inputmode="numeric" maxlength="6" placeholder="验证码" autocomplete="one-time-code" />' +
        '<button type="button" id="gate-login" class="btn primary">登录</button>' +
      '</div>' +
      '<div class="gate-err" id="gate-err"></div>' +
      '<div class="gate-foot">登录即表示同意：数据仅用于本应用的课时记录与同步</div>';
  }

  function gateBox() {
    var g = $("cloud-gate");
    if (!g) {
      g = document.createElement("div");
      g.id = "cloud-gate";
      g.className = "cloud-gate hidden";
      document.body.appendChild(g);
    }
    return g;
  }

  function showLoginOverlay() {
    var g = gateBox();
    g.innerHTML = '<div class="gate-box">' + gateFormHtml() + '</div>';
    g.classList.remove("hidden");
    bindGate();
  }

  function hideLoginOverlay() {
    var g = $("cloud-gate");
    if (g) g.classList.add("hidden");
  }

  function showGateError(title, desc, allowLocal) {
    var g = gateBox();
    g.innerHTML = '<div class="gate-box">' +
      '<div class="gate-logo">⚠️</div>' +
      '<h2 class="gate-title">' + esc(title) + '</h2>' +
      '<p class="gate-desc">' + esc(desc) + '</p>' +
      (allowLocal ? '<button type="button" id="gate-local" class="btn">先本地使用</button>' : '') +
      '<button type="button" id="gate-retry" class="btn ghost">重试</button>' +
      '</div>';
    g.classList.remove("hidden");
    var loc = $("gate-local");
    if (loc) loc.addEventListener("click", function () {
      state.meta.pendingSync = true; saveLocal();   // 标记本机改动，之后登录可补传
      CLOUD.mode = false;
      cloudReset();
      hideLoginOverlay();
      renderAccount();
      syncBadge("local");
      toast("已切换本地模式：数据只存本机");
    });
    var retry = $("gate-retry");
    if (retry) retry.addEventListener("click", function () {
      showLoginOverlay();
      if (CLOUD.client) restoreAuth();
      else if (cloudPossible()) ensureSdk(function (ok) { if (ok) cloudStart(); });
    });
  }

  function loginError(msg) {
    var e = $("gate-err");
    if (e) e.textContent = msg || "登录失败，请重试";
  }

  function bindGate() {
    var wx = $("gate-wechat");
    if (wx) wx.addEventListener("click", function () {
      if (!CLOUD.client) return;
      loginError("");
      var page = location.pathname.split("/").pop() || "index.html";
      var target = location.origin + "/";
      if (page && page !== "index.html") target = location.origin + "/?page=" + encodeURIComponent(page);
      toPromise(CLOUD.client.auth.signInWithOAuth({ provider: "wechat", redirectTo: target }))
        .then(function (res) {
          if (res && res.error) { loginError(res.error.message || "微信登录暂不可用"); return; }
          if (res && res.data && res.data.url) { location.assign(res.data.url); return; }
          loginError("微信登录暂不可用");
        })
        .catch(function (e) { loginError((e && e.message) || "微信登录暂不可用"); });
    });
    var code = $("gate-code");
    if (code) code.addEventListener("click", sendGateCode);
    var login = $("gate-login");
    if (login) login.addEventListener("click", submitGateOtp);
    var phone = $("gate-phone");
    if (phone) phone.addEventListener("input", function () { var e = $("gate-phone-err"); if (e) e.textContent = ""; });
    var otp = $("gate-otp");
    if (otp) otp.addEventListener("input", function () { loginError(""); });
  }

  function sendGateCode() {
    var phoneEl = $("gate-phone");
    var phone = phoneEl ? (phoneEl.value || "").trim() : "";
    if (!/^1\d{10}$/.test(phone)) {
      var pe = $("gate-phone-err");
      if (pe) pe.textContent = "请输入正确的 11 位手机号";
      return;
    }
    if (!CLOUD.client) return;
    toPromise(CLOUD.client.auth.sendOtp({ phone: phone }))
      .then(function (res) {
        if (res && res.error) { loginError(res.error.message || "验证码发送失败，请重试"); return; }
        var d = (res && res.data) || {};
        CLOUD.pendingOtp = { phone: phone, verificationId: d.verificationId, isExistingUser: !!d.isExistingUser };
        toast("验证码已发送");
        startCodeCountdown(60);
      })
      .catch(function (e) { loginError((e && e.message) || "验证码发送失败，请重试"); });
  }

  function startCodeCountdown(sec) {
    var btn = $("gate-code");
    if (!btn) return;
    CLOUD.codeLeft = sec;
    btn.disabled = true;
    btn.textContent = sec + "s 后重试";
    clearInterval(CLOUD.codeTimer);
    CLOUD.codeTimer = setInterval(function () {
      CLOUD.codeLeft -= 1;
      var b = $("gate-code");
      if (CLOUD.codeLeft <= 0) {
        clearInterval(CLOUD.codeTimer);
        if (b) { b.disabled = false; b.textContent = "获取验证码"; }
        return;
      }
      if (b) b.textContent = CLOUD.codeLeft + "s 后重试";
    }, 1000);
  }

  function submitGateOtp() {
    var phoneEl = $("gate-phone"), otpEl = $("gate-otp");
    var phone = phoneEl ? (phoneEl.value || "").trim() : "";
    var token = otpEl ? (otpEl.value || "").trim() : "";
    var pending = CLOUD.pendingOtp;
    if (!pending || pending.phone !== phone) { loginError("请先获取当前手机号的验证码"); return; }
    if (!token) { loginError("请输入验证码"); return; }
    if (!CLOUD.client) return;
    toPromise(CLOUD.client.auth.verifyOtp({
      phone: pending.phone,
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: token
    }))
      .then(function (res) {
        if (res && res.error) { loginError(res.error.message || "验证码错误，请重试"); return; }
        CLOUD.pendingOtp = null;
        afterLogin();
      })
      .catch(function (e) { loginError((e && e.message) || "登录失败，请重试"); });
  }

  /* ---- 启动：先处理授权回调，再决定是否显示登录门 ---- */
  function restoreAuth() {
    var url = new URL(location.href);
    if (!url.searchParams.has("code") && !url.searchParams.has("error")) { continueNormalStartup(); return; }
    var provider = url.searchParams.get("provider");
    if (provider !== "workbuddy" && provider !== "wechat") {
      showLoginOverlay();
      loginError("授权回调缺少有效的登录方式，请重新登录。");
      return;
    }
    var handler = provider === "workbuddy"
      ? CLOUD.client.auth.handleWorkBuddyCallback
      : CLOUD.client.auth.handleWechatWebCallback;
    if (typeof handler !== "function") {
      showLoginOverlay();
      loginError("暂时无法使用此方式登录，请重试或改用手机验证码。");
      return;
    }
    toPromise(handler.call(CLOUD.client.auth)).then(function (res) {
      if (res && res.error) {
        showLoginOverlay();
        loginError(res.error.message || "登录失败，请重新登录");
        return;
      }
      if (res && res.data) {
        ["code", "state", "provider"].forEach(function (k) { url.searchParams.delete(k); });
        history.replaceState(null, "", url.pathname + url.search + url.hash);
        var page = url.searchParams.get("page");
        if (page && /^[a-z0-9_-]+\.html$/i.test(page)) { location.replace(page); return; }
        afterLogin();
      } else {
        continueNormalStartup();
      }
    }).catch(function (e) {
      showLoginOverlay();
      loginError((e && e.message) || "登录失败，请重新登录");
    });
  }

  function continueNormalStartup() {
    toPromise(CLOUD.client.auth.getSession()).then(function (res) {
      var session = res && res.data;
      if (session) afterLogin();
      else showLoginOverlay();
    }).catch(function () { showLoginOverlay(); });
  }

  function afterLogin() {
    hideLoginOverlay();
    toPromise(CLOUD.client.auth.getUser()).then(function (res) {
      CLOUD.user = (res && res.data) || null;
      renderAccount();
      cloudLoad();
    }).catch(function () {
      // 拿不到用户信息时退回会话里的身份，仍要能同步
      toPromise(CLOUD.client.auth.getSession()).then(function (r2) {
        var s = r2 && r2.data;
        CLOUD.user = (s && (s.user || s)) || null;
        renderAccount();
        cloudLoad();
      }).catch(function () { cloudFail({ message: "no user" }); });
    });
  }

  function cloudFail(err) {
    var status = err && (err.status || (err.originalError && err.originalError.status));
    var code = err && (err.code || (err.details && err.details.code));
    var msg = String((err && err.message) || "").toLowerCase();
    if (code === "42P01" || status === 404 || status === 400 ||
        msg.indexOf("not found") >= 0 || msg.indexOf("notfound") >= 0 || msg.indexOf("does not exist") >= 0) {
      showGateError("云同步还没准备好", "云端存储尚未就绪，暂时无法同步。你可以先本地使用，或稍后重试。", true);
      return;
    }
    showGateError("云同步暂时连不上", "网络或服务异常。你可以先本地使用，或稍后重试。", true);
  }

  /* ---- 云端读写：每个账号一个私有文件，整份数据作为 JSON ---- */
  function cloudUid() {
    var u = CLOUD.user || {};
    return u.id || u.user_id || u.userId || u.sub || null;
  }
  function cloudPath() {
    if (!CLOUD.client || !CLOUD.client.storage) return null;
    var uid = cloudUid();
    if (!uid) return null;
    try { return CLOUD.client.storage.userPath(uid, "huake/state.json"); }
    catch (e) { return null; }
  }
  function cloudReset() {
    CLOUD.path = null; CLOUD.lastTs = 0; CLOUD.exists = null;
    CLOUD.noInfo = false; CLOUD.infoFails = 0; CLOUD.pathRetry = 0;
  }
  function isNotFoundErr(err) {
    if (!err) return false;
    var s = err.status || (err.originalError && err.originalError.status);
    var msg = String(err.message || "").toLowerCase();
    return s === 404 || s === 400 || msg.indexOf("not found") >= 0 ||
      msg.indexOf("notfound") >= 0 || msg.indexOf("does not exist") >= 0;
  }
  function infoTs(d) {
    if (!d) return 0;
    var v = d.updatedAt || d.lastModified || d.createdAt || d.mtime || d.updated_at || d.last_modified;
    if (typeof v !== "string" && typeof v !== "number") return 0;
    return Date.parse(v) || 0;
  }
  function parseCloudText(text) {
    var obj = null;
    try { obj = JSON.parse(text); } catch (e) { return null; }
    if (!obj || typeof obj !== "object" || !Array.isArray(obj.cards)) return null;
    return normalizeState(obj);
  }
  function adoptCloud(payload, announce) {
    state = payload;
    saveLocal();
    render();
    renderAccount();
    if (announce) toast("已同步其他设备的最新改动");
  }
  // 用 info 轻量探测把本机的版本线对齐到服务器时钟（探测不到时间戳时退回本机时钟）
  function refreshServerTs() {
    if (!CLOUD.path || !CLOUD.client || !CLOUD.client.storage) return;
    var q;
    try { q = CLOUD.client.storage.info(CLOUD.path); }
    catch (e) { CLOUD.lastTs = Date.now(); return; }
    toPromise(q).then(function (res) {
      var ts = (res && !res.error) ? infoTs(res.data) : 0;
      CLOUD.lastTs = ts || Date.now();
    }).catch(function () { CLOUD.lastTs = Date.now(); });
  }

  function cloudLoad() {
    if (!CLOUD.mode || !CLOUD.client || !CLOUD.client.storage) return;
    var path = cloudPath();
    if (!path) { cloudBadge("err"); return; }
    CLOUD.path = path;
    CLOUD.pathRetry = 0;
    cloudBadge("loading");
    var q;
    try { q = CLOUD.client.storage.download(path); }
    catch (e) { cloudFail(e); return; }
    toPromise(q).then(function (res) {
      if (res && res.error) {
        if (isNotFoundErr(res.error)) {
          // 这个账号云端还没有文件：本机有数据就迁上去
          CLOUD.exists = false;
          cloudBadge("on");
          render(); renderAccount();
          if (localHasData()) cloudPush();
          return;
        }
        cloudFail(res.error);
        return;
      }
      var blob = res && res.data;
      if (!blob || typeof blob.text !== "function") { cloudBadge("on"); return; }
      blob.text().then(function (text) {
        var payload = parseCloudText(text);
        if (!payload) { cloudBadge("on"); return; }   // 云端文件损坏：保留本机，等下次推送覆盖
        CLOUD.exists = true;
        var localNewer = !!(state.meta.pendingSync && localHasData());
        if (!localNewer) adoptCloud(payload, false);    // 云端是这个账号的唯一事实来源：采用
        cloudBadge("on");
        render(); renderAccount();
        refreshServerTs();
        if (localNewer) cloudPush();                    // 离线编辑后重连：补传本机较新改动
      }).catch(function () { cloudBadge("on"); });
    }).catch(function (e) { cloudFail(e); });
  }

  function cloudPush() {
    if (!CLOUD.mode || !CLOUD.client || !CLOUD.client.storage) return;
    if (!CLOUD.path) {
      // 登录后用户信息还没回来：稍后重试，避免丢掉这次改动
      CLOUD.pathRetry++;
      if (CLOUD.pathRetry > 12) { cloudBadge("err"); return; }
      CLOUD.timer = setTimeout(cloudPush, 250);
      return;
    }
    if (CLOUD.pushing) { CLOUD.dirty = true; return; }
    CLOUD.pushing = true;
    var nowIso = new Date().toISOString();
    var payload = JSON.parse(JSON.stringify(state));
    if (payload.meta) delete payload.meta.pendingSync;   // 待传标记只留在本机，不进云端
    payload.meta.syncedAt = nowIso;                      // 版本戳随数据一起上云
    var body = JSON.stringify(payload);
    var opts = { contentType: "application/json", cacheControl: "0", upsert: true };
    function finish(ok) {
      CLOUD.pushing = false;
      if (!ok) { cloudBadge("err"); return; }
      CLOUD.exists = true;
      if (state.meta.pendingSync) state.meta.pendingSync = false;
      if (state.meta.syncedAt !== nowIso) state.meta.syncedAt = nowIso;
      saveLocal();
      cloudBadge("on");
      refreshServerTs();
      if (CLOUD.dirty) { CLOUD.dirty = false; scheduleCloudSave(); }
    }
    function putFallback() {
      var q2;
      try { q2 = CLOUD.client.storage.update(CLOUD.path, body, opts); }
      catch (e) { finish(false); return; }
      toPromise(q2).then(function (res) { finish(!(res && res.error)); })
        .catch(function () { finish(false); });
    }
    var q;
    try { q = CLOUD.client.storage.upload(CLOUD.path, body, opts); }
    catch (e) { putFallback(); return; }
    toPromise(q).then(function (res) {
      if (res && res.error) { putFallback(); return; }   // POST 覆盖不被支持时退回 PUT
      finish(true);
    }).catch(function () { putFallback(); });
  }

  function scheduleCloudSave() {
    if (!CLOUD.mode) return;
    clearTimeout(CLOUD.timer);
    CLOUD.timer = setTimeout(cloudPush, 500);
  }

  function cloudPull() {
    if (!CLOUD.mode || !CLOUD.client || !CLOUD.client.storage || !CLOUD.path) return;
    if (CLOUD.noInfo) { cloudDownload(true); return; }   // info 不可用：每轮直读
    var q;
    try { q = CLOUD.client.storage.info(CLOUD.path); }
    catch (e) { CLOUD.noInfo = true; cloudDownload(true); return; }
    toPromise(q).then(function (res) {
      if (res && res.error) {
        if (isNotFoundErr(res.error)) {
          CLOUD.infoFails = 0;
          CLOUD.exists = false;
          if (localHasData()) cloudPush();               // 云端文件没了：把本机这份传回去
          return;
        }
        CLOUD.infoFails++;
        if (CLOUD.infoFails >= 2) CLOUD.noInfo = true;   // 连续探测失败：退回每轮直读
        cloudDownload(true);
        return;
      }
      CLOUD.infoFails = 0;
      var ts = infoTs(res && res.data);
      var prev = CLOUD.lastTs;
      if (ts) CLOUD.lastTs = ts;                          // 始终以服务器读数为准
      if (ts && ts <= prev) return;                       // 文件没变化，不下载
      cloudDownload(true);
    }).catch(function () {
      CLOUD.infoFails++;
      if (CLOUD.infoFails >= 2) CLOUD.noInfo = true;
      cloudDownload(true);
    });
  }

  function cloudDownload(announce) {
    if (!CLOUD.path || !CLOUD.client || !CLOUD.client.storage) return;
    var q;
    try { q = CLOUD.client.storage.download(CLOUD.path); }
    catch (e) { return; }
    toPromise(q).then(function (res) {
      if (res && res.error) {
        if (isNotFoundErr(res.error)) {
          CLOUD.exists = false;
          if (localHasData()) cloudPush();
        }
        return;
      }
      var blob = res && res.data;
      if (!blob || typeof blob.text !== "function") return;
      blob.text().then(function (text) {
        var payload = parseCloudText(text);
        if (!payload) return;
        CLOUD.exists = true;
        // 自己刚上传的那份（版本戳相同）不必重复采用
        if (payload.meta.syncedAt && payload.meta.syncedAt === state.meta.syncedAt) return;
        // 本机还有未上传的改动时不让远端覆盖（与局域网模式同一套取舍）
        if (state.meta.pendingSync && localHasData()) return;
        adoptCloud(payload, announce);
      }).catch(function () { /* 网络抖动静默，下轮再试 */ });
    }).catch(function () { /* 网络抖动静默，下轮再试 */ });
  }

  function cloudBadge(mode) {
    var b = $("sync-badge");
    if (!b) {
      var f = document.querySelector(".site-footer");
      if (!f) return;
      b = document.createElement("span");
      b.id = "sync-badge";
      f.appendChild(b);
    }
    if (mode === "on") {
      b.textContent = " · 云同步已开启：同一账号的多设备自动同步";
      b.className = "sync-badge on";
    } else if (mode === "err") {
      b.textContent = " · 云同步暂时连不上，稍后自动重试";
      b.className = "sync-badge err";
    } else if (mode === "loading") {
      b.textContent = " · 正在连接云同步…";
      b.className = "sync-badge";
    } else {
      b.textContent = " · 本地模式：数据只存本机";
      b.className = "sync-badge";
    }
  }

  function maskStr(s) {
    s = String(s || "");
    if (s.length <= 7) return s;
    return s.slice(0, 3) + "****" + s.slice(-4);
  }

  function renderAccount() {
    var p = $("account-panel");
    if (!p) return;
    if (CLOUD.mode && CLOUD.user) {
      p.classList.remove("hidden");
      var u = CLOUD.user;
      var label = u.name || (u.phone ? maskStr(u.phone) : "") || (u.email ? maskStr(u.email) : "") || "已登录";
      var n = $("account-name");
      if (n) n.textContent = "当前账号：" + label;
      var d = $("account-desc");
      if (d) d.textContent = "登录同一个账号、相同的登录方式，电脑 / 手机 / iPad 自动同步同一份数据。";
    } else {
      p.classList.add("hidden");
    }
  }

  function cloudLogout() {
    if (!CLOUD.client) return;
    confirmDialog("退出登录？", "退出后这台设备仍保留本地数据，但不再同步；重新登录即可继续同步。", function () {
      toPromise(CLOUD.client.auth.signOut()).then(function () {
        CLOUD.user = null;
        cloudReset();
        renderAccount();
        showLoginOverlay();
      }).catch(function () { toast("退出登录失败，请重试"); });
    });
  }

  function startSync() {
    var url = null;
    try { url = new URL(location.href); } catch (e) { /* ignore */ }
    var hasCallback = !!(url && (url.searchParams.has("code") || url.searchParams.has("error")));
    if (hasCallback && cloudPossible()) {
      // 授权回调必须赶在登录门之前处理
      ensureSdk(function (ok) { if (ok) cloudStart(); else syncBadge("local"); });
      return;
    }
    if (!window.fetch || isFileProtocol()) { syncBadge("local"); return; }
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (res) { syncAdopt(res, false); })
      .catch(function () {
        if (cloudPossible()) {
          ensureSdk(function (ok) {
            if (ok) cloudStart();
            else { syncBadge("local"); toast("云同步组件加载失败，已按本地模式运行"); }
          });
        } else {
          syncBadge("local");
        }
      });
  }

  /* ---------- 工具 ---------- */
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id" + Date.now() + Math.random().toString(16).slice(2);
  }
  function $(id) { return document.getElementById(id); }
  function on(id, ev, cb) { var e = $(id); if (e) e.addEventListener(ev, cb); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function leftOf(card) { return card.total - card.used; }
  function fmtNum(x) {
    if (!Number.isFinite(x)) return "0";
    return String(Math.round(x * 1e4) / 1e4);
  }
  function fmtMoney(x) {
    if (!Number.isFinite(x)) return "0";
    var v = Math.round(x * 100) / 100;
    return (Math.round(v * 100) % 100 === 0) ? String(Math.round(v)) : String(v);
  }
  function monthStr(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  function pad(n) { return ("0" + n).slice(-2); }
  function dateStamp(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function idxOf(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return i;
    return -1;
  }

  /* ---------- 成员（操作人） ---------- */
  function findOp(ops, id) {
    for (var i = 0; i < ops.length; i++) if (ops[i].id === id) return ops[i];
    return null;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add("hidden"); }, 2200);
  }
  function showStorageWarn() { var e = $("storage-warn"); if (e) e.classList.remove("hidden"); }

  /* ---------- 主题 ---------- */
  function applyTheme() {
    var dark = state.meta.theme === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    var b = $("btn-theme");
    if (b) b.textContent = dark ? "☀" : "🌙";
  }
  function toggleTheme() {
    state.meta.theme = state.meta.theme === "dark" ? "light" : "dark";
    save(); applyTheme();
  }

  /* ---------- 渲染（页面感知：缺元素则跳过） ---------- */
  function render() {
    if ($("stat-cards")) renderOverview();
    if ($("ratio")) renderRatio();
    if ($("recent")) renderRecent();
    if ($("folder-bar")) renderFolders();
    if ($("cards")) renderCards();
    if ($("history")) renderHistory();
    if ($("filter-card")) renderFilter();
    if ($("account-panel")) renderAccount();
  }

  function renderOverview() {
    var totalLeft = 0, monthOps = 0;
    var ym = monthStr(new Date());
    state.cards.forEach(function (c) { totalLeft += leftOf(c); });
    state.history.forEach(function (h) {
      if ((h.date || "").slice(0, 7) === ym) monthOps++;
    });
    $("stat-cards").textContent = state.cards.length;
    $("stat-left").textContent = fmtNum(totalLeft);
    $("stat-month").textContent = monthOps;
  }

  function renderRatio() {
    var box = $("ratio");
    if (!box) return;
    box.innerHTML = "";
    if (state.cards.length === 0) {
      box.innerHTML = '<div class="hist-sub">添加课时卡后显示各卡剩余占比</div>';
      return;
    }
    var totalLeft = 0;
    state.cards.forEach(function (c) { totalLeft += Math.max(0, leftOf(c)); });
    state.cards.forEach(function (c) {
      var left = Math.max(0, leftOf(c));
      var pct = totalLeft > 0 ? Math.round((left / totalLeft) * 100) : 0;
      var row = document.createElement("div");
      row.className = "ratio-row";
      row.innerHTML =
        '<span class="ratio-name">' + esc(c.name) + '</span>' +
        '<span class="ratio-bar"><span style="width:' + pct + '%;background:' + (c.color || "var(--brand)") + '"></span></span>' +
        '<span class="ratio-pct">' + pct + '%</span>';
      box.appendChild(row);
    });
  }

  function renderRecent() {
    var box = $("recent");
    if (!box) return;
    box.innerHTML = "";
    if (state.history.length === 0) {
      box.innerHTML = '<div class="empty" style="border:none;padding:14px;">还没有记录，去「课时卡」划掉第一节吧。</div>';
      return;
    }
    state.history.slice().reverse().slice(0, 5).forEach(function (h) {
      var minus = h.delta < 0;
      var dateLabel = h.lessonDate ? ("上课 " + h.lessonDate) : ("记录 " + fmtDate(h.date));
      var noteHtml = h.note ? '<div class="hist-note">备注：' + esc(h.note) + '</div>' : "";
      var opHtml = h.operatorName ? ('<div class="hist-sub">' + dateLabel + ' · ' + esc(h.operatorName) + '</div>') : ('<div class="hist-sub">' + dateLabel + '</div>');
      var li = document.createElement("li");
      li.innerHTML =
        '<span class="hist-main">' +
          '<span class="hist-dot ' + (minus ? "minus" : "plus") + '"></span>' +
          '<span><div class="hist-text"><span class="name">' + esc(h.cardName) + '</span></div>' +
          opHtml + noteHtml + '</span>' +
        '</span>' +
        '<span class="hist-delta ' + (minus ? "minus" : "plus") + '">' + (minus ? "" : "+") + fmtNum(h.delta) + '</span>';
      box.appendChild(li);
    });
  }

  /* ---------- 文件夹（课时卡分组） ---------- */
  /* cardsFilter: ""=全部， "__none__"=未分组， 其余为文件夹 id（仅内存态，刷新回全部） */
  var cardsFilter = "";
  var cardsQuery = "";    // 搜索关键词（仅内存态）
  var dragCardId = null;   // 拖拽中的卡片 id（排序与「拖到文件夹」共用）
  function findFolder(id) {
    for (var i = 0; i < state.folders.length; i++) if (state.folders[i].id === id) return state.folders[i];
    return null;
  }
  function folderName(id) { var f = findFolder(id); return f ? f.name : ""; }
  function cardsInFolder(fid) {
    var n = 0;
    state.cards.forEach(function (c) { if (c.folderId === fid) n++; });
    return n;
  }
  function matchQuery(c, q) {
    if (!q) return true;
    var hay = (c.name + " " + (c.note || "") + " " + (c.kind === "package" ? "课包" : "")).toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (t) { return hay.indexOf(t) >= 0; });
  }
  function visibleCards() {
    var list = state.cards;
    if (cardsFilter === "__none__") list = list.filter(function (c) { return !c.folderId; });
    else if (cardsFilter) list = list.filter(function (c) { return c.folderId === cardsFilter; });
    if (cardsQuery) list = list.filter(function (c) { return matchQuery(c, cardsQuery); });
    return list;
  }
  function pruneFolderRefs() {
    var fids = {};
    state.folders.forEach(function (f) { fids[f.id] = true; });
    state.cards.forEach(function (c) { if (c.folderId && !fids[c.folderId]) c.folderId = ""; });
  }
  function renderFolders() {
    var bar = $("folder-bar");
    if (!bar) return;
    if (cardsFilter && cardsFilter !== "__none__" && !findFolder(cardsFilter)) cardsFilter = "";
    bar.innerHTML = "";
    function chip(label, value, count, active) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "folder-chip" + (active ? " active" : "");
      b.setAttribute("data-folder", value);
      b.innerHTML = esc(label) + (count === undefined ? "" : ' <span class="folder-n">' + count + "</span>");
      return b;
    }
    bar.appendChild(chip("全部", "", state.cards.length, cardsFilter === ""));
    if (state.folders.length) {
      bar.appendChild(chip("未分组", "__none__", cardsInFolder(""), cardsFilter === "__none__"));
    }
    state.folders.forEach(function (f) {
      var item = document.createElement("div");
      item.className = "folder-item";
      item.appendChild(chip(f.name, f.id, cardsInFolder(f.id), cardsFilter === f.id));
      var ren = document.createElement("button");
      ren.type = "button";
      ren.className = "folder-mini";
      ren.title = "重命名";
      ren.textContent = "✎";
      ren.setAttribute("data-folder-rename", f.id);
      var del = document.createElement("button");
      del.type = "button";
      del.className = "folder-mini danger";
      del.title = "删除文件夹";
      del.textContent = "✕";
      del.setAttribute("data-folder-del", f.id);
      item.appendChild(ren);
      item.appendChild(del);
      bar.appendChild(item);
    });
    var add = document.createElement("button");
    add.type = "button";
    add.className = "folder-chip new";
    add.setAttribute("data-folder-new", "1");
    add.textContent = "+ 新建文件夹";
    bar.appendChild(add);
  }

  var editingFolderId = null;
  function openFolderModal(id) {
    editingFolderId = id || null;
    $("folder-modal-title").textContent = id ? "重命名文件夹" : "新建文件夹";
    $("folder-name").value = id ? (findFolder(id) ? findFolder(id).name : "") : "";
    showModal("modal-folder");
    $("folder-name").focus();
  }

  function saveFolder() {
    var name = $("folder-name").value.trim();
    if (!name) { toast("请填写文件夹名称"); return; }
    var dup = state.folders.some(function (f) { return f.name === name && f.id !== editingFolderId; });
    if (dup) { toast("已有同名文件夹"); return; }
    if (editingFolderId) {
      var f = findFolder(editingFolderId);
      if (f) f.name = name;
      toast("已重命名");
    } else {
      var nf = { id: uid(), name: name, createdAt: new Date().toISOString() };
      state.folders.push(nf);
      cardsFilter = nf.id;   // 建完后直接看这个文件夹
      toast("已创建文件夹");
    }
    save(); render(); hideModal("modal-folder");
  }

  function delFolder(id) {
    var f = findFolder(id);
    if (!f) return;
    var n = cardsInFolder(id);
    confirmDialog("删除文件夹", "确定删除「" + f.name + "」？其中 " + n + " 张课时卡将回到「未分组」（卡片和数据不会丢）。", function () {
      state.folders = state.folders.filter(function (x) { return x.id !== id; });
      state.cards.forEach(function (c) { if (c.folderId === id) c.folderId = ""; });
      if (cardsFilter === id) cardsFilter = "";
      save(); render(); toast("已删除文件夹");
    });
  }

  function buildFolderSelect(sel, value) {
    if (!sel) return;
    sel.innerHTML = '<option value="">未分组</option>';
    state.folders.forEach(function (f) {
      var o = document.createElement("option");
      o.value = f.id; o.textContent = f.name;
      sel.appendChild(o);
    });
    sel.value = (value && findFolder(value)) ? value : "";
  }

  /* ---------- 移动卡片到文件夹 ---------- */
  var moveCardId = null;
  var moveBatch = false;   // true=批量移动（对 selectedIds 生效）
  function openMoveModal(id) {
    var c = findCard(id);
    if (!c) return;
    moveBatch = false;
    moveCardId = id;
    $("move-card-name").textContent = c.name + "（当前：" + (c.folderId ? folderName(c.folderId) : "未分组") + "）";
    buildMoveList(c.folderId);
    showModal("modal-move");
  }
  function openBatchMove() {
    var n = selectedCount();
    if (n === 0) { toast("请先选择课时卡"); return; }
    moveBatch = true;
    moveCardId = null;
    $("move-card-name").textContent = "将移动已选的 " + n + " 张卡片";
    buildMoveList(null);
    showModal("modal-move");
  }
  function buildMoveList(curFolder) {
    var list = $("move-list");
    if (!list) return;
    list.innerHTML = "";
    function item(label, value, active) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "move-item" + (active ? " active" : "");
      b.setAttribute("data-move-to", value);
      b.innerHTML = '<span class="move-item-name">' + esc(label) + "</span>" +
        (active ? '<span class="move-item-cur">当前</span>' : "");
      return b;
    }
    list.appendChild(item("未分组", "", curFolder === ""));
    state.folders.forEach(function (f) {
      list.appendChild(item(f.name, f.id, curFolder === f.id));
    });
  }

  function moveCardTo(id, folderId) {
    var c = findCard(id);
    if (!c) return;
    if (folderId && !findFolder(folderId)) folderId = "";
    if (c.folderId === folderId) { hideModal("modal-move"); return; }
    c.folderId = folderId;
    save(); render();
    hideModal("modal-move");
    toast(folderId ? "已移动到「" + folderName(folderId) + "」" : "已移到未分组");
  }

  function renderCards() {
    var wrap = $("cards");
    if (!wrap) return;
    wrap.innerHTML = "";
    wrap.classList.toggle("manage", !!manageMode);
    var list = visibleCards();
    var emptyEl = $("empty");
    if (emptyEl) {
      emptyEl.classList.toggle("hidden", list.length > 0);
      var hint = emptyEl.querySelector(".empty-hint");
      if (hint) {
        if (cardsQuery) hint.textContent = "没有匹配的课时卡，换个关键词试试";
        else if (cardsFilter && cardsFilter !== "__none__") hint.textContent = "这个文件夹下还没有课时卡";
        else if (cardsFilter === "__none__") hint.textContent = "没有未分组的课时卡";
        else hint.textContent = "点「添加课时卡」开始记录吧";
      }
    }
    list.forEach(function (c) {
      var left = leftOf(c);
      var pct = c.total > 0 ? Math.round((c.used / c.total) * 100) : 0;
      var low = left <= c.lowWarn;
      var isPkg = c.kind === "package";
      var el = document.createElement("div");
      el.className = "card" + (low ? " low" : "") + (isPkg ? " pkg" : "") + (manageMode && selectedIds[c.id] ? " selected" : "");
      el.setAttribute("data-id", c.id);
      el.draggable = !manageMode;
      el.style.borderLeftColor = low ? "var(--warn)" : (c.color || "var(--brand)");
      var noteHtml = c.note ? '<div class="card-note">📝 ' + esc(c.note) + '</div>' : "";
      var folderTag = (c.folderId && cardsFilter !== c.folderId)
        ? '<div class="card-folder">📁 ' + esc(folderName(c.folderId)) + '</div>' : "";
      var kindTag = isPkg ? '<span class="card-kind">课包</span>' : "";
      var pkgHtml = "";
      if (isPkg) {
        var price = c.price > 0 ? ("¥" + fmtMoney(c.price)) : "未记价";
        var buy = c.purchasedAt ? ("购买于 " + c.purchasedAt) : "";
        var leftVal = (c.price > 0 && c.total > 0) ? ("剩余价值 ¥" + fmtMoney(c.price * left / c.total)) : "";
        pkgHtml = '<div class="card-meta">购价 ' + esc(price) + (buy ? " · " + esc(buy) : "") + '</div>' +
          (leftVal ? '<div class="card-meta pkg-left">' + esc(leftVal) + '</div>' : "");
      }
      var selHtml = manageMode
        ? '<span class="card-sel' + (selectedIds[c.id] ? " on" : "") + '">' + (selectedIds[c.id] ? "✓" : "") + '</span>' : "";
      el.innerHTML =
        selHtml +
        '<div class="card-top">' +
          '<span class="card-name">' + (isPkg ? "📦 " : "") + esc(c.name) + kindTag + '</span>' +
          '<span class="card-left">剩 <b>' + fmtNum(left) + '</b> / ' + fmtNum(c.total) +
            '<span class="badge-low">余量告急</span></span>' +
        '</div>' +
        '<div class="progress"><span style="width:' + pct + '%"></span></div>' +
        '<div class="card-meta">已用 ' + fmtNum(c.used) + ' 节 · 预警阈值 ' + fmtNum(c.lowWarn) + '</div>' +
        pkgHtml +
        folderTag +
        noteHtml +
        (c.image ? '<div class="card-thumb" data-zoom="' + esc(c.image) + '"><img src="' + esc(c.image) + '" alt="封面" /></div>' : "") +
        '<div class="card-actions">' +
          '<button class="btn sm primary" data-act="subtract" data-id="' + c.id + '">划掉</button>' +
          '<button class="btn sm" data-act="add" data-id="' + c.id + '">加课</button>' +
          '<button class="btn sm ghost" data-act="edit" data-id="' + c.id + '">编辑</button>' +
          '<button class="btn sm ghost" data-act="move" data-id="' + c.id + '">📁 移动</button>' +
          '<button class="btn sm ghost" data-act="receipt" data-id="' + c.id + '">收据</button>' +
          '<button class="btn sm ghost" data-act="del" data-id="' + c.id + '">删除</button>' +
        '</div>';
      wrap.appendChild(el);
    });
    renderBatchBar();
  }

  /* ---------- 批量管理（多选后批量移动） ---------- */
  var manageMode = false;
  var selectedIds = {};
  function selectedCount() {
    var n = 0;
    for (var k in selectedIds) if (selectedIds[k]) n++;
    return n;
  }
  function toggleManage(on) {
    manageMode = (typeof on === "boolean") ? on : !manageMode;
    if (!manageMode) selectedIds = {};
    var btn = $("btn-manage");
    if (btn) btn.textContent = manageMode ? "完成管理" : "批量管理";
    renderCards();
  }
  function toggleSelect(id) {
    if (selectedIds[id]) delete selectedIds[id];
    else selectedIds[id] = true;
    renderCards();
  }
  function renderBatchBar() {
    var bar = $("batch-bar");
    if (!bar) return;
    bar.classList.toggle("hidden", !manageMode);
    if (!manageMode) return;
    var n = selectedCount();
    var cnt = $("batch-count");
    if (cnt) cnt.textContent = "已选 " + n + " 张";
    var mv = $("batch-move");
    if (mv) mv.disabled = n === 0;
    var all = $("batch-all");
    var list = visibleCards();
    var allSel = list.length > 0 && list.every(function (c) { return selectedIds[c.id]; });
    if (all) all.textContent = allSel ? "取消全选" : "全选";
  }
  function selectAllVisible() {
    var list = visibleCards();
    var allSel = list.length > 0 && list.every(function (c) { return selectedIds[c.id]; });
    if (allSel) list.forEach(function (c) { delete selectedIds[c.id]; });
    else list.forEach(function (c) { selectedIds[c.id] = true; });
    renderCards();
  }
  function batchMoveTo(folderId) {
    var ids = [];
    for (var k in selectedIds) if (selectedIds[k]) ids.push(k);
    if (folderId && !findFolder(folderId)) folderId = "";
    var moved = 0;
    ids.forEach(function (id) {
      var c = findCard(id);
      if (c && c.folderId !== folderId) { c.folderId = folderId; moved++; }
    });
    selectedIds = {};
    save(); render();
    hideModal("modal-move");
    toast(moved ? ("已移动 " + moved + " 张到" + (folderId ? "「" + folderName(folderId) + "」" : "未分组")) : "没有需要移动的卡片");
  }

  function renderHistory() {
    var ul = $("history");
    if (!ul) return;
    ul.innerHTML = "";
    var fid = $("filter-card") ? $("filter-card").value : "";
    var mid = $("filter-month") ? $("filter-month").value : "";
    var list = state.history.filter(function (h) {
      if (fid && h.cardId !== fid) return false;
      var mkey = (h.lessonDate || (h.date || "")).slice(0, 7);
      if (mid && mkey !== mid) return false;
      return true;
    });
    $("history-empty").classList.toggle("hidden", list.length > 0);
    list.slice().reverse().forEach(function (h) {
      var minus = h.delta < 0;
      var dateLabel = h.lessonDate ? ("上课 " + h.lessonDate) : ("记录 " + fmtDate(h.date));
      var noteHtml = h.note ? '<div class="hist-note">备注：' + esc(h.note) + '</div>' : "";
      var opHtml = h.operatorName ? ('<div class="hist-sub">' + dateLabel + ' · ' + esc(h.operatorName) + '</div>') : ('<div class="hist-sub">' + dateLabel + '</div>');
      var li = document.createElement("li");
      li.innerHTML =
        '<span class="hist-main">' +
          '<span class="hist-dot ' + (minus ? "minus" : "plus") + '"></span>' +
          '<span>' +
            '<div class="hist-text"><span class="name">' + esc(h.cardName) + '</span></div>' +
            opHtml + noteHtml +
          '</span>' +
        '</span>' +
        '<span style="display:flex;align-items:center;gap:8px;">' +
          '<span class="hist-delta ' + (minus ? "minus" : "plus") + '">' + (minus ? "" : "+") + fmtNum(h.delta) + '</span>' +
          '<button class="btn sm ghost" data-undo="' + h.id + '">撤销</button>' +
        '</span>';
      ul.appendChild(li);
    });
  }

  function renderFilter() {
    var sel = $("filter-card");
    if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">全部卡片</option>';
    state.cards.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c.id; o.textContent = c.name;
      sel.appendChild(o);
    });
    sel.value = (cur && idxOf(state.cards, cur) >= 0) ? cur : "";

    var msel = $("filter-month");
    if (!msel) return;
    var mcur = msel.value;
    var months = {};
    state.history.forEach(function (h) {
      var m = (h.lessonDate || (h.date || "")).slice(0, 7);
      if (m) months[m] = 1;
    });
    var mlist = Object.keys(months).sort().reverse();
    msel.innerHTML = '<option value="">全月份</option>';
    mlist.forEach(function (m) {
      var o = document.createElement("option");
      o.value = m; o.textContent = m;
      msel.appendChild(o);
    });
    msel.value = mlist.indexOf(mcur) >= 0 ? mcur : "";
  }

  /* 兼容旧数据：operators/operatorId 字段保留读写，不再提供成员管理界面 */

  /* ---------- 收据共用：文件大小 / CSV 解析 ---------- */
  var MAX_ATTACH_BYTES = 1024 * 1024; // 封面图 / 收据单文件上限 1MB（base64 会更大，localStorage 容量有限）

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function parseCsv(text) {
    var rows = [], row = [], cur = "", inQ = false;
    text = String(text).replace(/\r\n?/g, "\n");
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ",") { row.push(cur); cur = ""; }
        else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
        else cur += ch;
      }
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function openImageView(src) {
    var m = $("modal-image"), img = $("image-view");
    if (!m || !img) return;
    img.src = src || "";
    showModal("modal-image");
  }

  /* ---------- 课时卡图片 ---------- */
  var cardImageData = "";
  function setCardImagePreview(src) {
    var p = $("card-img-preview"), box = $("card-img-box");
    cardImageData = src || "";
    if (p) {
      if (cardImageData) { p.src = cardImageData; p.classList.remove("hidden"); }
      else { p.removeAttribute("src"); p.classList.add("hidden"); }
    }
    if (box) box.classList.toggle("hidden", !cardImageData);
  }
  function readCardImage(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast("请选择图片文件"); return; }
    if (file.size > MAX_ATTACH_BYTES) { toast("图片超过 1MB，请压缩后再上传"); return; }
    var reader = new FileReader();
    reader.onload = function () { setCardImagePreview(String(reader.result)); };
    reader.onerror = function () { toast("读取图片失败"); };
    reader.readAsDataURL(file);
  }

  /* ---------- 收据（挂在每张课时卡） ---------- */
  var receiptTarget = null;

  function findReceipt(card, id) {
    for (var i = 0; i < card.receipts.length; i++) if (card.receipts[i].id === id) return card.receipts[i];
    return null;
  }

  function csvTableHtml(text) {
    var rows = parseCsv(text);
    if (!rows.length) return '<div class="att-more">空表格</div>';
    var head = rows[0];
    var html = "<table class='sheet'><thead><tr>";
    head.forEach(function (h) { html += "<th>" + esc(h) + "</th>"; });
    html += "</tr></thead><tbody>";
    rows.slice(1, 8).forEach(function (r) {
      html += "<tr>";
      head.forEach(function (_, ci) { html += "<td>" + esc(r[ci] === undefined ? "" : r[ci]) + "</td>"; });
      html += "</tr>";
    });
    html += "</tbody></table>";
    if (rows.length > 8) html += '<div class="att-more">仅预览前 7 行，共 ' + rows.length + ' 行</div>';
    return html;
  }

  function openReceiptModal(id) {
    var c = findCard(id);
    if (!c) return;
    receiptTarget = id;
    $("receipt-card-name").textContent = c.name;
    renderReceipts();
    showModal("modal-receipt");
  }

  function renderReceipts() {
    var box = $("receipt-list");
    if (!box) return;
    var c = findCard(receiptTarget);
    if (!c) { box.innerHTML = ""; return; }
    var list = c.receipts.slice().reverse();
    box.innerHTML = "";
    if (list.length === 0) { box.innerHTML = '<div class="att-empty">还没有收据，点上方按钮上传（图片或 CSV）</div>'; return; }
    list.forEach(function (a) {
      var preview = a.kind === "image"
        ? '<div class="att-thumb" data-zoom="' + esc(a.data) + '"><img src="' + esc(a.data) + '" alt="' + esc(a.name) + '" /></div>'
        : '<div class="sheet-scroll">' + csvTableHtml(a.data) + '</div>';
      var el = document.createElement("div");
      el.className = "receipt-item";
      el.innerHTML =
        '<div class="att-info">' +
          '<div class="att-name">' + (a.kind === "image" ? "🖼️ " : "📊 ") + esc(a.name) + '</div>' +
          '<div class="att-meta">' + fmtSize(a.size) + (a.addedName ? (' · ' + esc(a.addedName)) : "") + ' · ' + fmtDate(a.date) + '</div>' +
          preview +
          '<div class="att-actions">' +
            (a.kind === "sheet" ? '<button class="btn sm" data-dl-receipt="' + a.id + '">下载</button>' : "") +
            '<button class="btn sm ghost" data-del-receipt="' + a.id + '">删除</button>' +
          '</div>' +
        '</div>';
      box.appendChild(el);
    });
  }

  function addReceipt(file) {
    if (!file || !receiptTarget) return;
    var c = findCard(receiptTarget);
    if (!c) return;
    var name = file.name || "收据";
    var isImage = /^image\//.test(file.type);
    var isSheet = /\.csv$/i.test(name) || /text\/csv/i.test(file.type);
    if (!isImage && !isSheet) { toast("收据仅支持图片或 CSV 表格"); return; }
    if (file.size > MAX_ATTACH_BYTES) { toast("文件超过 1MB，请压缩后再上传"); return; }
    var reader = new FileReader();
    reader.onload = function () {
      c.receipts.push({
        id: uid(), kind: isImage ? "image" : "sheet", name: name,
        data: String(reader.result), size: file.size,
        addedBy: "", addedName: "",
        date: new Date().toISOString()
      });
      save(); renderReceipts(); toast("已上传收据：" + name);
    };
    reader.onerror = function () { toast("读取文件失败"); };
    if (isImage) reader.readAsDataURL(file); else reader.readAsText(file);
  }

  function delReceipt(aid) {
    var c = findCard(receiptTarget);
    if (!c) return;
    var a = findReceipt(c, aid);
    if (!a) return;
    confirmDialog("删除收据", "确定删除收据「" + a.name + "」？", function () {
      c.receipts = c.receipts.filter(function (x) { return x.id !== aid; });
      save(); renderReceipts(); toast("已删除收据");
    });
  }

  function dlReceipt(aid) {
    var c = findCard(receiptTarget);
    if (!c) return;
    var a = findReceipt(c, aid);
    if (!a) return;
    download(a.name, a.data, a.kind === "sheet" ? "text/csv;charset=utf-8" : "application/octet-stream");
  }

  /* ---------- 课时卡操作 ---------- */
  function findCard(id) {
    var i = idxOf(state.cards, id);
    return i >= 0 ? state.cards[i] : null;
  }

  var editingId = null;
  var cardKind = "lesson";   // 当前卡类型：lesson=课时 / package=课包
  function setCardKind(kind) {
    cardKind = kind === "package" ? "package" : "lesson";
    var box = $("card-kind");
    if (box) {
      Array.prototype.forEach.call(box.querySelectorAll("[data-kind]"), function (b) {
        b.classList.toggle("active", b.getAttribute("data-kind") === cardKind);
      });
    }
    var pkg = $("pkg-fields");
    if (pkg) pkg.classList.toggle("hidden", cardKind !== "package");
    // 课包模式下「总课时」改叫「课包数」
    var tl = $("card-total-label");
    if (tl) tl.textContent = cardKind === "package" ? "课包数" : "总课时";
    var title = $("card-modal-title");
    if (title && !editingId) title.textContent = cardKind === "package" ? "添加课包" : "添加课时卡";
  }
  function openCardModal(id, kind) {
    editingId = id || null;
    var c = id ? findCard(id) : null;
    if (c) setCardKind(c.kind);
    else setCardKind(kind || "lesson");
    $("card-modal-title").textContent = c
      ? (c.kind === "package" ? "编辑课包" : "编辑课时卡")
      : (cardKind === "package" ? "添加课包" : "添加课时卡");
    if (c) {
      $("card-name").value = c.name;
      $("card-total").value = c.total;
      $("card-lowwarn").value = c.lowWarn;
      $("card-note").value = c.note || "";
      $("card-color").value = c.color || "#4f7cff";
      setCardImagePreview(c.image || "");
      buildFolderSelect($("card-folder"), c.folderId);
      $("card-price").value = c.price > 0 ? c.price : "";
      $("card-purchased").value = c.purchasedAt || "";
    } else {
      $("card-name").value = "";
      $("card-total").value = 10;
      $("card-lowwarn").value = 3;
      $("card-note").value = "";
      $("card-color").value = "#4f7cff";
      setCardImagePreview("");
      // 正在看某个文件夹时添加：默认归到该文件夹
      buildFolderSelect($("card-folder"), (cardsFilter && cardsFilter !== "__none__") ? cardsFilter : "");
      $("card-price").value = "";
      $("card-purchased").value = "";
    }
    showModal("modal-card");
    $("card-name").focus();
  }

  function saveCard() {
    var name = $("card-name").value.trim();
    var total = parseFloat($("card-total").value);
    var low = parseFloat($("card-lowwarn").value);
    var note = $("card-note").value.trim();
    if (!name) { toast("请填写名称"); return; }
    if (!Number.isFinite(total) || total <= 0) { toast("总课时需 > 0"); return; }
    if (!Number.isFinite(low) || low < 0) low = 0;
    var image = cardImageData || "";
    var folderId = $("card-folder") ? $("card-folder").value : "";
    if (folderId && !findFolder(folderId)) folderId = "";
    var isPkg = cardKind === "package";
    var price = 0, purchasedAt = "";
    if (isPkg) {
      var p = parseFloat($("card-price").value);
      price = Number.isFinite(p) && p >= 0 ? p : 0;
      purchasedAt = $("card-purchased").value || "";
    }
    if (editingId) {
      var c = findCard(editingId);
      if (total < c.used) { toast("总课时不能小于已用 " + fmtNum(c.used) + " 节"); return; }
      c.name = name; c.total = total; c.lowWarn = low; c.note = note; c.color = $("card-color").value; c.image = image;
      c.folderId = folderId; c.kind = cardKind; c.price = price; c.purchasedAt = purchasedAt;
    } else {
      state.cards.push({
        id: uid(), name: name, total: total, used: 0,
        lowWarn: low, note: note, color: $("card-color").value, image: image,
        receipts: [], folderId: folderId, createdAt: new Date().toISOString(),
        kind: cardKind, price: price, purchasedAt: purchasedAt
      });
    }
    save(); render(); hideModal("modal-card");
    toast(editingId ? "已保存" : (isPkg ? "已添加课包" : "已添加课时卡"));
  }

  function delCard(id) {
    var c = findCard(id);
    if (!c) return;
    confirmDialog("删除课时卡", "确定删除「" + c.name + "」？其历史记录也会一并清除。", function () {
      state.cards = state.cards.filter(function (x) { return x.id !== id; });
      state.history = state.history.filter(function (h) { return h.cardId !== id; });
      delete selectedIds[id];
      save(); render(); toast("已删除");
    });
  }

  /* ---------- 加减课 ---------- */
  var opTarget = null;
  var CHIPS = {
    subtract: [1, 1.5, 2, 3, 5, 5.5, 10, 50, 100, 500],
    add: [1, 2, 3, 5, 10, 50, 100, 500]
  };

  function buildChips(type) {
    var box = $("op-chips");
    if (!box) return;
    box.innerHTML = "";
    CHIPS[type].forEach(function (v) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = fmtNum(v);
      b.addEventListener("click", function () {
        $("op-count").value = v;
        Array.prototype.forEach.call(box.children, function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        updateOpHint();
      });
      box.appendChild(b);
    });
  }

  function openOpModal(id, type) {
    var c = findCard(id);
    if (!c) return;
    opTarget = { id: id, type: type };
    buildChips(type);
    $("op-title").textContent = type === "subtract" ? "划掉课时" : "加课";
    $("op-card-name").textContent = c.name + "（剩 " + fmtNum(leftOf(c)) + " / 共 " + fmtNum(c.total) + "）";
    $("op-count").value = 1;
    $("op-date").value = todayStr();
    $("op-note").value = "";
    updateOpHint();
    showModal("modal-op");
    $("op-count").focus();
  }

  function updateOpHint() {
    if (!opTarget) return;
    var c = findCard(opTarget.id);
    var n = parseFloat($("op-count").value);
    if (opTarget.type === "subtract") {
      var left = leftOf(c);
      if (!Number.isFinite(n) || n <= 0) $("op-hint").textContent = "请输入 > 0 的数量（当前剩余 " + fmtNum(left) + " 节）";
      else if (n > left + 1e-9) $("op-hint").textContent = "不能超过剩余 " + fmtNum(left) + " 节";
      else $("op-hint").textContent = "将划掉 " + fmtNum(n) + " 节，剩余变为 " + fmtNum(left - n) + " 节";
    } else {
      if (!Number.isFinite(n) || n <= 0) $("op-hint").textContent = "请输入 > 0 的数量";
      else $("op-hint").textContent = "将加 " + fmtNum(n) + " 节，总数变为 " + fmtNum(c.total + n) + " 节";
    }
  }

  function confirmOp() {
    if (!opTarget) return;
    var c = findCard(opTarget.id);
    var n = parseFloat($("op-count").value);
    if (!Number.isFinite(n) || n <= 0) { toast("请输入 > 0 的数量"); return; }
    var lessonDate = $("op-date").value || "";
    var note = $("op-note").value.trim();
    if (opTarget.type === "subtract") {
      var left = leftOf(c);
      if (n > left + 1e-9) { toast("不能超过剩余 " + fmtNum(left) + " 节"); return; }
      c.used += n;
      pushHistory(c, -n, lessonDate, note);
      toast("已划掉 " + fmtNum(n) + " 节");
    } else {
      c.total += n;
      pushHistory(c, n, lessonDate, note);
      toast("已加课 " + fmtNum(n) + " 节");
    }
    save(); render(); hideModal("modal-op");
  }

  function pushHistory(card, delta, lessonDate, note) {
    state.history.push({
      id: uid(),
      cardId: card.id,
      cardName: card.name,
      date: new Date().toISOString(),
      delta: delta,
      lessonDate: lessonDate || "",
      note: note || "",
      operatorId: "",
      operatorName: ""
    });
  }

  /* ---------- 撤销 ---------- */
  function undoEntry(hid) {
    var i = idxOf(state.history, hid);
    if (i < 0) return;
    var h = state.history[i];
    var c = findCard(h.cardId);
    if (!c) { toast("该卡片已删除，无法撤销"); return; }
    if (h.delta < 0) {
      var n = -h.delta;
      c.used = Math.max(0, c.used - n);
    } else {
      var add = h.delta;
      if (c.total - add < c.used - 1e-9) { toast("该加课已被划掉，撤销会令剩余为负，已取消"); return; }
      c.total -= add;
    }
    state.history.splice(i, 1);
    save(); render(); toast("已撤销");
  }

  function undoLast() {
    if (state.history.length === 0) { toast("没有可撤销的操作"); return; }
    undoEntry(state.history[state.history.length - 1].id);
  }

  /* ---------- 拖拽排序 ---------- */
  function enableDragSort() {
    var wrap = $("cards");
    if (!wrap) return;
    wrap.addEventListener("dragstart", function (e) {
      var card = e.target.closest(".card");
      if (!card) return;
      dragCardId = card.getAttribute("data-id");
      card.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    wrap.addEventListener("dragover", function (e) {
      e.preventDefault();
      var card = e.target.closest(".card");
      Array.prototype.forEach.call(wrap.children, function (x) { x.classList.remove("drag-over"); });
      if (card && card.getAttribute("data-id") !== dragCardId) card.classList.add("drag-over");
    });
    wrap.addEventListener("drop", function (e) {
      e.preventDefault();
      var card = e.target.closest(".card");
      if (!card || !dragCardId) return;
      var targetId = card.getAttribute("data-id");
      if (targetId && targetId !== dragCardId) {
        var from = idxOf(state.cards, dragCardId);
        var to = idxOf(state.cards, targetId);
        if (from < 0 || to < 0 || from === to) return;
        var moved = state.cards.splice(from, 1)[0];
        state.cards.splice(to, 0, moved);
        save(); render();
      }
      dragCardId = null;
    });
    wrap.addEventListener("dragend", function () {
      dragCardId = null;
      Array.prototype.forEach.call(wrap.children, function (x) { x.classList.remove("dragging", "drag-over"); });
    });
  }

  /* ---------- 拖拽卡片到文件夹栏：移动归属 ---------- */
  function enableFolderDrop() {
    var bar = $("folder-bar");
    if (!bar) return;
    function clearHover() {
      Array.prototype.forEach.call(bar.querySelectorAll(".drop-hover"), function (x) { x.classList.remove("drop-hover"); });
    }
    bar.addEventListener("dragover", function (e) {
      if (!dragCardId) return;
      e.preventDefault();
      var chip = e.target.closest("button[data-folder]");
      clearHover();
      // 「全部」不是归属目标，不高亮
      if (chip && chip.getAttribute("data-folder")) chip.classList.add("drop-hover");
    });
    bar.addEventListener("dragleave", function (e) {
      if (!bar.contains(e.relatedTarget)) clearHover();
    });
    bar.addEventListener("drop", function (e) {
      if (!dragCardId) return;
      e.preventDefault();
      clearHover();
      var chip = e.target.closest("button[data-folder]");
      if (!chip) return;
      var target = chip.getAttribute("data-folder");
      if (!target) return;                                   // 「全部」是视图筛选，不是归属目标
      moveCardTo(dragCardId, target === "__none__" ? "" : target);
      dragCardId = null;
    });
  }

  /* ---------- 备份 / 导出 / 导入 ---------- */
  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function backup() {
    var stamp = dateStamp(new Date());
    download("huake-backup-" + stamp + "-" + state.cards.length + "cards.json",
      JSON.stringify(state, null, 2), "application/json");
  }

  function exportData() {
    if (state.cards.length === 0 && state.history.length === 0) { toast("暂无数据可导出"); return; }
    backup();
    toast("已导出备份");
  }

  function exportExcel() {
    if (state.cards.length === 0 && state.history.length === 0) { toast("暂无数据可导出"); return; }
    function cell(v) {
      var t = typeof v === "number" ? "Number" : "String";
      return '<Cell><Data ss:Type="' + t + '">' + escXml(v) + "</Data></Cell>";
    }
    function row(cells) { return "<Row>" + cells.map(cell).join("") + "</Row>"; }
    var xml = '<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
      'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
    xml += '<Worksheet ss:Name="课时卡"><Table>';
    xml += row(["卡名", "类型", "总课时", "已用", "剩余", "预警阈值", "备注", "所属文件夹", "封面图", "收据数", "创建日期", "总价", "购买日期"]);
    state.cards.forEach(function (c) {
      xml += row([c.name, c.kind === "package" ? "课包" : "课时", c.total, c.used, leftOf(c), c.lowWarn, c.note || "",
        c.folderId ? folderName(c.folderId) : "", c.image ? "有" : "", (c.receipts ? c.receipts.length : 0), c.createdAt || "",
        c.kind === "package" && c.price > 0 ? c.price : "", c.kind === "package" ? (c.purchasedAt || "") : ""]);
    });
    xml += "</Table></Worksheet>\n";
    xml += '<Worksheet ss:Name="历史"><Table>';
    xml += row(["日期", "卡名", "类型", "数量", "上课日期", "备注"]);
    state.history.slice().reverse().forEach(function (h) {
      xml += row([fmtDate(h.date), h.cardName, h.delta < 0 ? "划课" : "加课",
        Math.abs(h.delta), h.lessonDate || "", h.note || ""]);
    });
    xml += "</Table></Worksheet>\n";
    xml += "</Workbook>";
    download("huake-" + dateStamp(new Date()) + ".xls", xml, "application/vnd.ms-excel");
    toast("已导出 Excel");
  }

  function escXml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function sanitizeReceipts(arr) {
    var out = [];
    (Array.isArray(arr) ? arr : []).forEach(function (a) {
      if (!a || typeof a.data !== "string" || !a.data) return;
      if (a.kind !== "image" && a.kind !== "sheet") return;
      out.push({
        id: typeof a.id === "string" ? a.id : uid(),
        kind: a.kind,
        name: typeof a.name === "string" ? a.name : "收据",
        data: a.data,
        size: Number(a.size) || 0,
        addedBy: typeof a.addedBy === "string" ? a.addedBy : "",
        addedName: typeof a.addedName === "string" ? a.addedName : "",
        date: typeof a.date === "string" ? a.date : new Date().toISOString()
      });
    });
    return out;
  }

  function sanitizeImport(d) {
    var cards = [], history = [], operators = [], folders = [], skipped = 0;
    (d.folders || []).forEach(function (f) {
      if (!f || typeof f.name !== "string" || !f.name.trim()) { skipped++; return; }
      folders.push({
        id: (typeof f.id === "string" && f.id) ? f.id : uid(),
        name: f.name.trim(),
        createdAt: typeof f.createdAt === "string" ? f.createdAt : new Date().toISOString()
      });
    });
    (d.cards || []).forEach(function (c) {
      if (!c || typeof c.name !== "string" || !c.name.trim()) { skipped++; return; }
      var total = parseFloat(c.total), used = parseFloat(c.used), low = parseFloat(c.lowWarn);
      if (!Number.isFinite(total) || total <= 0) { skipped++; return; }
      used = Number.isFinite(used) ? Math.min(Math.max(0, used), total) : 0;
      low = Number.isFinite(low) && low >= 0 ? low : 0;
      cards.push({
        id: typeof c.id === "string" ? c.id : uid(),
        name: c.name.trim(), total: total, used: used, lowWarn: low,
        kind: c.kind === "package" ? "package" : "lesson",
        price: Number.isFinite(c.price) && c.price >= 0 ? c.price : 0,
        purchasedAt: typeof c.purchasedAt === "string" ? c.purchasedAt : "",
        note: typeof c.note === "string" ? c.note : "",
        color: typeof c.color === "string" ? c.color : "#4f7cff",
        image: typeof c.image === "string" ? c.image : "",
        folderId: typeof c.folderId === "string" ? c.folderId : "",
        receipts: sanitizeReceipts(c.receipts),
        createdAt: typeof c.createdAt === "string" ? c.createdAt : new Date().toISOString()
      });
    });
    var attachments = [];
    (d.attachments || []).forEach(function (a) {
      if (!a || typeof a.data !== "string" || !a.data) return;
      if (a.kind !== "image" && a.kind !== "sheet") return;
      attachments.push({
        id: typeof a.id === "string" ? a.id : uid(),
        kind: a.kind,
        name: typeof a.name === "string" ? a.name : "附件",
        data: a.data,
        size: Number(a.size) || 0,
        addedBy: typeof a.addedBy === "string" ? a.addedBy : "",
        addedName: typeof a.addedName === "string" ? a.addedName : "",
        date: typeof a.date === "string" ? a.date : new Date().toISOString()
      });
    });
    (d.operators || []).forEach(function (o) {
      if (!o || typeof o.name !== "string" || !o.name.trim()) return;
      operators.push({ id: typeof o.id === "string" ? o.id : uid(), name: o.name.trim() });
    });
    if (operators.length === 0) operators = [{ id: "op_default", name: "默认" }];
    (d.history || []).forEach(function (h) {
      if (!h || !Number.isFinite(parseFloat(h.delta))) { skipped++; return; }
      history.push({
        id: typeof h.id === "string" ? h.id : uid(),
        cardId: typeof h.cardId === "string" ? h.cardId : "",
        cardName: typeof h.cardName === "string" ? h.cardName : "",
        date: typeof h.date === "string" ? h.date : new Date().toISOString(),
        delta: parseFloat(h.delta),
        lessonDate: typeof h.lessonDate === "string" ? h.lessonDate : "",
        note: typeof h.note === "string" ? h.note : "",
        operatorId: typeof h.operatorId === "string" ? h.operatorId : "",
        operatorName: typeof h.operatorName === "string" ? h.operatorName : ""
      });
    });
    return { cards: cards, history: history, operators: operators, attachments: attachments, folders: folders, skipped: skipped };
  }

  function doMerge(clean) {
    var byId = {};
    state.cards.forEach(function (c) { byId[c.id] = true; });
    clean.cards.forEach(function (c) {
      if (byId[c.id]) { var i = idxOf(state.cards, c.id); state.cards[i] = c; }
      else state.cards.push(c);
    });
    var hid = {};
    state.history.forEach(function (h) { hid[h.id] = true; });
    clean.history.forEach(function (h) { if (!hid[h.id]) state.history.push(h); });
    var oid = {};
    state.operators.forEach(function (o) { oid[o.id] = true; });
    clean.operators.forEach(function (o) {
      if (oid[o.id]) { var i = idxOf(state.operators, o.id); state.operators[i] = o; }
      else state.operators.push(o);
    });
    if (!findOp(state.operators, state.meta.currentOperator)) state.meta.currentOperator = state.operators[0].id;
    var aid = {};
    state.attachments.forEach(function (a) { aid[a.id] = true; });
    clean.attachments.forEach(function (a) { if (!aid[a.id]) state.attachments.push(a); });
    var fid = {};
    state.folders.forEach(function (f) { fid[f.id] = true; });
    (clean.folders || []).forEach(function (f) {
      if (fid[f.id]) { var i = idxOf(state.folders, f.id); if (i >= 0) state.folders[i] = f; }
      else state.folders.push(f);
    });
    pruneFolderRefs();
    save(); render();
    toast(clean.skipped ? "已合并（跳过 " + clean.skipped + " 条异常）" : "已合并导入");
  }

  function doOverwrite(clean) {
    var theme = state.meta.theme;
    var cur = state.meta.currentOperator;
    state.cards = clean.cards;
    state.history = clean.history;
    state.operators = clean.operators;
    state.attachments = clean.attachments;
    state.folders = clean.folders || [];
    pruneFolderRefs();
    state.meta.theme = theme;
    state.meta.currentOperator = findOp(clean.operators, cur) ? cur : clean.operators[0].id;
    save(); render(); applyTheme();
    toast(clean.skipped ? "已覆盖（跳过 " + clean.skipped + " 条异常）" : "已覆盖导入");
  }

  var pendingImport = null;
  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var d;
      try { d = JSON.parse(reader.result); }
      catch (e) { toast("文件不是有效 JSON"); return; }
      if (!d || !Array.isArray(d.cards) || !Array.isArray(d.history)) { toast("备份格式不正确"); return; }
      pendingImport = sanitizeImport(d);
      showModal("modal-import");
    };
    reader.onerror = function () { toast("读取文件失败"); };
    reader.readAsText(file);
  }

  function askImportMode(mode) {
    if (!pendingImport) return;
    var clean = pendingImport;
    pendingImport = null;
    hideModal("modal-import");
    if (mode === "merge") doMerge(clean);
    else doOverwrite(clean);
  }

  function monthlyAutoBackup() {
    var m = monthStr(new Date());
    if (state.meta.lastAutoBackupMonth === m) return;
    if (state.cards.length === 0 && state.history.length === 0) {
      state.meta.lastAutoBackupMonth = m; save(); return;
    }
    state.meta.lastAutoBackupMonth = m; save(); backup();
    toast("已自动生成 " + m + " 月备份");
  }

  /* ---------- 弹窗通用 ---------- */
  function showModal(id) { var e = $(id); if (e) e.classList.remove("hidden"); }
  function hideModal(id) { var e = $(id); if (e) e.classList.add("hidden"); }

  var confirmCb = null;
  function confirmDialog(title, text, cb) {
    var t = $("confirm-title"), x = $("confirm-text");
    if (!t || !x) { cb(); return; }
    t.textContent = title;
    x.textContent = text;
    confirmCb = cb;
    showModal("modal-confirm");
  }

  /* ---------- 事件绑定（全部守卫） ---------- */
  function bind() {
    on("btn-theme", "click", toggleTheme);
    on("btn-logout", "click", cloudLogout);
    on("btn-add", "click", function () {
      if ($("modal-add-type")) showModal("modal-add-type");
      else openCardModal(null, "lesson");
    });
    on("modal-add-type", "click", function (e) {
      var b = e.target.closest("[data-add-kind]");
      if (!b) return;
      hideModal("modal-add-type");
      openCardModal(null, b.getAttribute("data-add-kind"));
    });
    on("card-kind", "click", function (e) {
      var b = e.target.closest("[data-kind]");
      if (b) setCardKind(b.getAttribute("data-kind"));
    });
    on("card-save", "click", saveCard);
    on("card-search", "input", function (e) {
      cardsQuery = e.target.value.trim();
      renderCards();
    });
    on("btn-manage", "click", function () { toggleManage(); });
    on("batch-all", "click", selectAllVisible);
    on("batch-move", "click", openBatchMove);
    on("batch-cancel", "click", function () { toggleManage(false); });
    on("folder-bar", "click", function (e) {
      var ren = e.target.closest("[data-folder-rename]");
      if (ren) { openFolderModal(ren.getAttribute("data-folder-rename")); return; }
      var del = e.target.closest("[data-folder-del]");
      if (del) { delFolder(del.getAttribute("data-folder-del")); return; }
      var add = e.target.closest("[data-folder-new]");
      if (add) { openFolderModal(null); return; }
      var chip = e.target.closest("button[data-folder]");
      if (chip) { cardsFilter = chip.getAttribute("data-folder"); render(); }
    });
    on("folder-save", "click", saveFolder);
    on("folder-name", "keydown", function (e) { if (e.key === "Enter") saveFolder(); });
    on("cards", "click", function (e) {
      var z = e.target.closest("[data-zoom]");
      if (z) { openImageView(z.getAttribute("data-zoom")); return; }
      var btn = e.target.closest("button[data-act]");
      if (!btn) {
        // 管理模式下点卡片空白处 = 勾选/取消
        if (manageMode) {
          var card = e.target.closest(".card[data-id]");
          if (card) toggleSelect(card.getAttribute("data-id"));
        }
        return;
      }
      var id = btn.getAttribute("data-id");
      var act = btn.getAttribute("data-act");
      if (act === "subtract") openOpModal(id, "subtract");
      else if (act === "add") openOpModal(id, "add");
      else if (act === "edit") openCardModal(id);
      else if (act === "move") openMoveModal(id);
      else if (act === "receipt") openReceiptModal(id);
      else if (act === "del") delCard(id);
    });
    on("move-list", "click", function (e) {
      var b = e.target.closest("[data-move-to]");
      if (!b) return;
      var fid = b.getAttribute("data-move-to");
      if (moveBatch) batchMoveTo(fid);
      else if (moveCardId) moveCardTo(moveCardId, fid);
    });
    on("btn-receipt-image", "click", function () { var f = $("file-receipt-image"); if (f) f.click(); });
    on("btn-receipt-sheet", "click", function () { var f = $("file-receipt-sheet"); if (f) f.click(); });
    on("file-receipt-image", "change", function (e) { if (e.target.files && e.target.files[0]) addReceipt(e.target.files[0]); e.target.value = ""; });
    on("file-receipt-sheet", "change", function (e) { if (e.target.files && e.target.files[0]) addReceipt(e.target.files[0]); e.target.value = ""; });
    on("receipt-list", "click", function (e) {
      var z = e.target.closest("[data-zoom]");
      if (z) { openImageView(z.getAttribute("data-zoom")); return; }
      var d = e.target.closest("button[data-del-receipt]");
      if (d) { delReceipt(d.getAttribute("data-del-receipt")); return; }
      var dl = e.target.closest("button[data-dl-receipt]");
      if (dl) dlReceipt(dl.getAttribute("data-dl-receipt"));
    });
    on("op-count", "input", updateOpHint);
    on("op-confirm", "click", confirmOp);
    on("history", "click", function (e) {
      var btn = e.target.closest("button[data-undo]");
      if (btn) undoEntry(btn.getAttribute("data-undo"));
    });
    on("btn-undo-last", "click", undoLast);
    on("filter-card", "change", renderHistory);
    on("filter-month", "change", renderHistory);
    on("btn-card-image", "click", function () { var f = $("card-image"); if (f) f.click(); });
    on("btn-card-image-del", "click", function () { setCardImagePreview(""); });
    on("card-image", "change", function (e) { if (e.target.files && e.target.files[0]) readCardImage(e.target.files[0]); e.target.value = ""; });
    on("btn-export", "click", exportData);
    on("btn-excel", "click", exportExcel);
    on("btn-backup", "click", function () { backup(); toast("已备份"); });
    on("btn-import", "click", function () { var f = $("file-import"); if (f) f.click(); });
    on("file-import", "change", function (e) {
      if (e.target.files && e.target.files[0]) importData(e.target.files[0]);
      e.target.value = "";
    });
    on("import-merge", "click", function () { askImportMode("merge"); });
    on("import-overwrite", "click", function () { askImportMode("overwrite"); });
    on("confirm-ok", "click", function () {
      hideModal("modal-confirm");
      if (confirmCb) { var cb = confirmCb; confirmCb = null; cb(); }
    });

    ["modal-card", "modal-op"].forEach(function (mid) {
      var m = $(mid);
      if (m) m.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
          e.preventDefault();
          var b = m.querySelector(".btn.primary");
          if (b) b.click();
        }
      });
    });
    document.querySelectorAll("[data-close]").forEach(function (b) {
      b.addEventListener("click", function () {
        var md = b.closest(".modal");
        if (md) md.classList.add("hidden");
      });
    });
    document.querySelectorAll(".modal").forEach(function (m) {
      m.addEventListener("click", function (e) { if (e.target === m) m.classList.add("hidden"); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") document.querySelectorAll(".modal:not(.hidden)").forEach(function (m) { m.classList.add("hidden"); });
    });

    enableDragSort();
    enableFolderDrop();
  }

  /* ---------- 启动 ---------- */
  if (!canPersist) showStorageWarn();
  applyTheme();
  bind();
  render();
  monthlyAutoBackup();
  startSync();
  setInterval(syncTick, 8000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) syncTick(); });

  function syncTick() {
    if (CLOUD.mode) cloudPull();
    else syncPull();
  }
})();
