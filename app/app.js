(() => {
  "use strict";

  const view = document.getElementById("view");
  const dialog = document.getElementById("dialog");
  const dialogContent = document.getElementById("dialog-content");
  const notice = document.getElementById("server-notice");
  const isStaticGithubPages = location.hostname.endsWith("github.io");
  const pages = { queue: "Queue", calendar: "Calendar", library: "Library", accounts: "Accounts", settings: "Settings" };
  const state = { activeView: "queue", session: null, queue: [], library: [], settings: null, advanced: null, accounts: null, month: new Date(), busy: false, openAdvanced: false };
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const fullDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const demoSamples = [
    { filename: "Studio-cut.mp4", caption: "A cleaner edit for a busy week.", hashtags: "#creator #editing", platforms: ["tiktok"], status: "Queued" },
    { filename: "Edit-notes.mp4", caption: "Three small changes made this one work.", hashtags: "#behindthescenes", platforms: ["tiktok", "instagram"], status: "Queued" },
    { filename: "Weekly-recap.mp4", caption: "A few favorite frames from the week.", hashtags: "#weeklyrecap", platforms: ["tiktok", "youtube"], status: "Queued" },
    { filename: "Desk-setup.mp4", caption: "Testing a simpler recording setup.", hashtags: "#creatorstudio", platforms: ["tiktok"], status: "Queued" },
  ];

  const esc = (v = "") => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;
  const emptyMachine = () => `<div class="empty-machine" aria-hidden="true"><span class="gear-mark compact" data-teeth="6"><svg viewBox="0 0 24 24"><g data-cog data-teeth="6" data-direction="-1" data-phase="30"><use href="../assets/gear-system.svg#gear-6"/></g></svg></span><span class="gear-mark compact" data-teeth="12"><svg viewBox="0 0 48 48"><g data-cog data-teeth="12"><use href="../assets/gear-system.svg#gear-12"/></g></svg></span></div>`;
  const fmtDate = value => value ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "Unscheduled";
  const fileSize = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
  const titleCase = value => String(value || "").replaceAll("_", " ").replace(/\b\w/g, m => m.toUpperCase());
  const queueSort = items => [...items].sort((a, b) => new Date(a.scheduledAt || 8640000000000000) - new Date(b.scheduledAt || 8640000000000000));
  function isDemoWorkspace() {
    return !state.session?.account && state.queue.length === 0 && state.library.length === 0;
  }
  function demoItems() {
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(11, 30, 0, 0);
    return demoSamples.map((sample, index) => ({
      ...sample,
      id: `demo-video-${index + 1}`,
      mediaId: `demo-video-${index + 1}`,
      scheduledAt: new Date(start.getTime() + index * 24 * 60 * 60 * 1000).toISOString(),
      captionVariants: { tiktok: sample.caption, instagram: sample.caption, youtube: sample.caption },
    }));
  }
  const demoBanner = `<div class="demo-data-banner"><span class="demo-data-chip">DEMO DATA</span><span>Sample videos · nothing has been uploaded</span></div>`;

  async function api(path, options = {}) {
    const init = { method: options.method || "GET", headers: {}, credentials: "same-origin" };
    if (options.body instanceof FormData) init.body = options.body;
    else if (options.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(options.body); }
    const response = await fetch(path, init);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const error = new Error(data?.error || data?.message || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function showToast(message, error = false) {
    const node = document.createElement("div");
    node.className = `toast${error ? " error" : ""}`;
    node.textContent = message;
    document.getElementById("toast-region").append(node);
    setTimeout(() => node.remove(), 4200);
  }
  function setBusy(element, busy, label = "Working…") {
    if (!element) return;
    if (busy) { element.dataset.originalLabel = element.textContent.trim(); element.disabled = true; element.textContent = label; }
    else { element.disabled = false; if (element.dataset.originalLabel) element.textContent = element.dataset.originalLabel; }
  }
  function shellNotice(message) { notice.hidden = !message; notice.textContent = message || ""; }
  function showError(message, retry) {
    return `<div class="error-panel"><div><strong>Could not load this view.</strong><p>${esc(message)}</p></div><button class="button button-small" data-action="reload-view">Try again</button></div>`;
  }
  function renderLoading() { view.innerHTML = `<div class="page-heading"><div><h1>${esc(pages[state.activeView])}</h1></div></div><div aria-label="Loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`; }
  function setActive(viewName) {
    state.activeView = viewName;
    document.getElementById("page-title").textContent = pages[viewName];
    document.querySelectorAll("[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === viewName));
    updateConnectTop();
    document.querySelector(".sidebar").classList.remove("open");
    document.getElementById("mobile-menu").setAttribute("aria-expanded", "false");
    loadView();
  }
  async function loadView() {
    renderLoading();
    try {
      if (state.activeView === "queue") {
        state.queue = await api("/api/queue");
        if (!state.session?.account) state.library = await api("/api/library");
        renderQueue();
      }
      else if (state.activeView === "calendar") {
        state.queue = await api(`/api/calendar?month=${state.month.getFullYear()}-${String(state.month.getMonth() + 1).padStart(2, "0")}`);
        if (!state.session?.account) state.library = await api("/api/library");
        renderCalendar();
      }
      else if (state.activeView === "library") { state.library = await api("/api/library"); renderLibrary(); }
      else if (state.activeView === "accounts") { state.accounts = await api("/api/accounts"); renderAccounts(); }
      else if (state.activeView === "settings") {
        [state.settings, state.advanced] = await Promise.all([
          api("/api/settings"),
          api("/api/settings/advanced"),
        ]);
        renderSettings();
      }
    } catch (error) {
      const staticNotice = location.hostname.endsWith("github.io")
        ? "Final Cog needs the local Node server. GitHub Pages serves only static files and cannot load your account, queue, or uploads. Start the local Node app to use this workspace."
        : "";
      if (staticNotice) shellNotice(staticNotice);
      view.innerHTML = `<div class="page-heading"><div><h1>${esc(pages[state.activeView])}</h1></div></div>${showError(error.message)}`;
    }
  }
  function queueHeading(items = state.queue) {
    const scheduled = items.filter(x => ["Queued", "Sending"].includes(x.status)).length;
    return `<div class="page-heading"><div><h1>Your queue</h1><p>Next up for TikTok drafts.</p></div><div class="page-actions"><button class="button button-muted" data-action="open-schedule">${icon("calendar")}<span>Schedule a video</span></button><button class="button button-accent" data-action="go-library">${icon("plus")}<span>Add videos</span></button></div></div>
      <div class="list-heading"><span>${scheduled ? `${scheduled} IN THE UPCOMING QUEUE` : "UPCOMING QUEUE"}</span><span>STATUS / ACTIONS</span></div>`;
  }
  function renderQueue() {
    const demoMode = isDemoWorkspace();
    const items = demoMode ? demoItems() : state.queue;
    const count = items.filter(x => ["Queued", "Sending"].includes(x.status)).length;
    const badge = document.getElementById("queue-count"); badge.textContent = count; badge.hidden = !count;
    const welcome = !state.session?.account ? `<section class="first-run" aria-labelledby="first-run-title">
      <div class="first-run-copy"><span class="section-kicker">LOCAL WORKSPACE</span><h1 id="first-run-title">Connect your accounts.</h1><p>Start with TikTok, then add finished videos.</p><p class="privacy-line">Your data stays on this computer.</p></div>
      <div class="first-run-actions"><button class="button button-accent" data-action="connect-tiktok">Connect TikTok</button><button class="button button-muted" data-action="go-library">Upload videos</button><span class="coming-soon">Instagram and YouTube are coming soon.</span></div>
    </section>` : "";
    if (demoMode) {
      const sorted = queueSort(items);
      const nextPostId = sorted.find(item => item.status === "Queued")?.id;
      view.innerHTML = `${welcome}${welcome ? "" : queueHeading(items)}${demoBanner}<div class="queue-list">${sorted.map(item => queueRow(item, item.id === nextPostId, true)).join("")}</div>`;
      return;
    }
    if (!items.length) {
      view.innerHTML = `${welcome}${welcome ? "" : queueHeading()}<div class="empty-state">${emptyMachine()}<h2>${welcome ? "Your workspace is ready" : "Nothing in the queue yet"}</h2><p>${welcome ? "Upload finished videos whenever you are ready." : "Upload videos, choose a posting time, and review each TikTok draft before it goes public."}</p>${welcome ? "" : `<button class="button button-accent" data-action="go-library">${icon("upload")}<span>Upload videos</span></button>`}</div>`;
      return;
    }
    const sorted = queueSort(items);
    const nextPostId = sorted.find(item => item.status === "Queued")?.id;
    view.innerHTML = `${welcome}${welcome ? "" : queueHeading()}<div class="queue-list">${sorted.map(item => queueRow(item, item.id === nextPostId)).join("")}</div>`;
  }
  function queueRow(item, isNextPost = false, isDemo = false) {
    const status = String(item.status || "Queued");
    const statusClass = status.toLowerCase().replaceAll(" ", "-");
    const id = esc(item.id);
    const retry = status === "Failed" && item.retryAllowed === true && !/flag|policy|violation/i.test(item.errorReason || "");
    const actions = [];
    if (!isDemo) {
      if (item.caption || item.hashtags) actions.push(`<button class="text-action" data-action="copy-caption" data-id="${id}">Copy caption</button>`);
      if (["Queued", "Failed"].includes(status)) actions.push(`<button class="text-action" data-action="edit-queue" data-id="${id}">Edit</button>`);
      if (status === "Queued") actions.push(`<button class="text-action" data-action="send-now" data-id="${id}">Send now</button>`);
      if (retry) actions.push(`<button class="text-action" data-action="retry" data-id="${id}">Retry</button>`);
      if (status === "Sent to drafts") actions.push(`<button class="text-action" data-action="mark-posted" data-id="${id}">Mark posted</button>`);
      if (["Queued", "Failed", "Needs review"].includes(status)) actions.push(`<button class="text-action" data-action="delete-queue" data-id="${id}">Remove</button>`);
    }
    return `<article class="queue-row">
      <div class="media-tile">${icon("video")}</div>
      <div class="row-main"><div class="row-title">${esc(item.filename || "Video")}</div><div class="row-caption">${esc(item.caption || "No caption yet")}${item.hashtags ? ` ${esc(item.hashtags)}` : ""}</div>${item.errorReason ? `<div class="row-meta">${esc(item.errorReason)}</div>` : ""}</div>
      <div><div class="row-meta">${isNextPost ? '<span class="next-post-mark">NEXT</span>' : ""}${esc(fmtDate(item.scheduledAt))}</div><div class="row-status status-${esc(statusClass)}"><span class="status-mark"></span>${esc(status)}</div></div>
      <div class="row-actions">${isDemo ? '<span class="demo-data-chip">DEMO</span>' : actions.join("")}</div>
    </article>`;
  }
  function renderCalendar() {
    const demoMode = isDemoWorkspace();
    const items = demoMode ? demoItems() : state.queue;
    const month = state.month;
    const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(month);
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    const events = new Map();
    items.forEach(item => {
      if (!item.scheduledAt) return;
      const key = new Date(item.scheduledAt).toLocaleDateString("en-CA");
      if (!events.has(key)) events.set(key, []);
      events.get(key).push(item);
    });
    const weekday = dayNames.map(d => `<div class="calendar-weekday">${d}</div>`).join("");
    const cells = Array.from({ length: 42 }, (_, i) => {
      const date = new Date(start); date.setDate(start.getDate() + i);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const today = new Date().toDateString() === date.toDateString();
      const dayItems = events.get(key) || [];
      return `<div class="calendar-day${date.getMonth() !== month.getMonth() ? " outside" : ""}"><div class="day-number${today ? " today" : ""}">${date.getDate()}</div>${dayItems.map(item => `<div class="calendar-event${item.status === "Failed" ? " failed" : ""}" title="${esc(item.filename)}">${esc(item.filename || "Video")}<div class="event-time">${esc(new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(item.scheduledAt)))}</div></div>`).join("")}</div>`;
    }).join("");
    view.innerHTML = `<div class="page-heading"><div><h1>Calendar</h1><p>See where each video lands in your posting rhythm.</p></div><div class="calendar-toolbar"><button class="button button-small" data-action="month-prev" aria-label="Previous month">‹</button><h2>${esc(monthLabel)}</h2><button class="button button-small" data-action="month-next" aria-label="Next month">›</button><button class="button button-small button-muted" data-action="month-today">Today</button></div></div>
      ${demoMode ? demoBanner : ""}<div class="calendar-grid">${weekday}${cells}</div>`;
  }
  function renderLibrary() {
    const demoMode = isDemoWorkspace();
    const sampleRows = demoMode ? demoItems().map((item, index) => `
      <article class="library-item demo-library-item">
        <div class="file-cover">${icon("video")}</div>
        <div class="library-file"><strong>${esc(item.filename)}</strong><small>Demo data · sample video</small></div>
        <div class="demo-caption"><span>Caption</span><p>${esc(item.caption)} ${esc(item.hashtags)}</p><span>${item.platforms.map(titleCase).join(" · ")}</span></div>
        <span class="demo-data-chip">DEMO</span>
      </article>`).join("") : "";
    view.innerHTML = `<div class="page-heading"><div><h1>Video library</h1><p>Upload once. Keep a caption for each channel.</p></div></div>
      <div class="upload-zone" id="upload-zone"><div class="upload-symbol">${icon("upload")}</div><div class="upload-copy"><strong>Drop finished videos here</strong><span>Choose one or more video files to upload to your library.</span></div><input type="file" id="file-input" accept="video/*" multiple hidden><button class="button button-accent" data-action="pick-files">Choose files</button></div>
      <section class="github-import" aria-labelledby="github-import-title">
        <div class="github-import-head"><div><h2 id="github-import-title">Import from GitHub</h2><p>Find recent video assets in a repository release or Actions run.</p></div><span class="section-kicker">LOCAL COPY / SOURCE RECORDED</span></div>
        <form id="github-source-form" class="github-source-form">
          <label>Owner<input name="owner" maxlength="100" placeholder="owner" required></label>
          <label>Repository<input name="repo" maxlength="100" placeholder="repository" required></label>
          <button class="button button-muted" type="submit">Find videos</button>
        </form>
        <div class="github-source-results" id="github-source-results" aria-live="polite"></div>
      </section>
      ${demoMode ? demoBanner : ""}
      <div class="library-toolbar"><p>${demoMode ? "4 sample videos" : state.library.length ? `${state.library.length} ${state.library.length === 1 ? "video" : "videos"} in your library` : "Your uploaded videos will appear here."}</p><span class="section-kicker">CAPTION / HASHTAGS CAN BE EDITED ANYTIME</span></div>
      ${demoMode ? `<div class="library-list">${sampleRows}</div>` : state.library.length ? `<div class="library-list">${state.library.map(libraryItem).join("")}</div>` : `<div class="empty-state">${emptyMachine()}<h2>Your library is clear</h2><p>Start with finished, export-ready videos. Each upload stays here until you schedule it or remove it.</p></div>`}
      <div class="privacy-line">Your files stay on this computer.</div>`;
    const zone = document.getElementById("upload-zone");
    ["dragenter", "dragover"].forEach(type => zone.addEventListener(type, event => {
      event.preventDefault();
      zone.classList.add("dragover");
    }));
    ["dragleave", "drop"].forEach(type => zone.addEventListener(type, event => {
      event.preventDefault();
      zone.classList.remove("dragover");
      if (type === "drop") uploadFiles(event.dataTransfer.files);
    }));
  }
  function libraryItem(item) {
    const variants = item.captionVariants && typeof item.captionVariants === "object" ? item.captionVariants : {};
    const source = item.source;
    const sourceLabel = source?.provider?.startsWith("github")
      ? `GitHub ${source.owner}/${source.repo}${source.tag ? ` · ${source.tag}` : source.runId ? ` · run ${source.runId}` : ""}`
      : source?.provider === "local-file" ? "Imported from local file"
        : source?.provider === "https-url" ? "Imported from HTTPS URL" : "";
    return `<article class="library-item" data-library-id="${esc(item.id)}">
      <div class="file-cover">${icon("video")}</div>
      <div class="library-file">${esc(item.filename)}<small>${esc(fileSize(item.size || 0))} · ${esc(item.mimeType || "Video")}</small>${sourceLabel ? `<span class="library-source">${esc(sourceLabel)}</span>` : ""}</div>
      <div class="library-edit">
        <fieldset class="platform-picker"><legend>Post to</legend>
          <label><input class="platform-input" type="checkbox" value="tiktok" ${!item.platforms || item.platforms.includes("tiktok") ? "checked" : ""}><span>TikTok</span></label>
          <label class="platform-soon"><input class="platform-input" type="checkbox" value="instagram" ${item.platforms?.includes("instagram") ? "checked" : ""}><span>Instagram · soon</span></label>
          <label class="platform-soon"><input class="platform-input" type="checkbox" value="youtube" ${item.platforms?.includes("youtube") ? "checked" : ""}><span>YouTube · soon</span></label>
        </fieldset>
        <label for="caption-${esc(item.id)}">TikTok caption</label>
        <textarea id="caption-${esc(item.id)}" class="field-control caption-input" rows="2" aria-label="TikTok caption for ${esc(item.filename)}" placeholder="Write a caption">${esc(item.caption || variants.tiktok || "")}</textarea>
        <label for="hashtags-${esc(item.id)}">Hashtags</label>
        <input id="hashtags-${esc(item.id)}" class="field-control hashtags-input" aria-label="Hashtags for ${esc(item.filename)}" placeholder="#hashtags" value="${esc(item.hashtags || "")}">
        <details class="variants-details"><summary>Other platform captions</summary><div class="variant-fields">
          <label for="instagram-${esc(item.id)}">Instagram Reels</label>
          <textarea id="instagram-${esc(item.id)}" class="field-control variant-input" data-platform="instagram" rows="2" maxlength="2200" placeholder="Optional Instagram caption">${esc(variants.instagram || "")}</textarea>
          <label for="youtube-${esc(item.id)}">YouTube Shorts</label>
          <textarea id="youtube-${esc(item.id)}" class="field-control variant-input" data-platform="youtube" rows="2" maxlength="2200" placeholder="Optional YouTube caption">${esc(variants.youtube || "")}</textarea>
          <span class="section-kicker">Saved here until those channels are ready.</span>
        </div></details>
      </div>
      <div class="library-tools"><button class="text-action" data-action="draft-captions" data-id="${esc(item.id)}">Write a caption for me</button><button class="text-action" data-action="save-library" data-id="${esc(item.id)}">Save</button><button class="text-action" data-action="schedule-library" data-id="${esc(item.id)}">Schedule</button><button class="text-action" data-action="delete-library" data-id="${esc(item.id)}">Remove</button></div>
    </article>`;
  }
  function githubChoices(sources) {
    const options = [];
    for (const release of sources.releases || []) {
      for (const asset of release.assets || []) {
        options.push({
          label: `Release ${release.tag} · ${asset.title || asset.name}`,
          request: { owner: sources.owner, repo: sources.repo, tag: release.tag, assetName: asset.name },
        });
      }
    }
    for (const run of sources.runs || []) {
      for (const artifact of run.artifacts || []) {
        options.push({
          label: `Actions ${run.title} · ${artifact.name}`,
          request: { owner: sources.owner, repo: sources.repo, runId: String(run.id), artifactName: artifact.name },
        });
      }
    }
    const results = document.getElementById("github-source-results");
    if (!options.length) {
      results.innerHTML = `<p class="github-import-empty">No video assets or unexpired Actions artifacts were found in that repository.</p>`;
      return;
    }
    results.innerHTML = `<label class="section-kicker" for="github-source-choice">RECENT VIDEO SOURCES</label>
      <select class="github-source-choice" id="github-source-choice">${options.map(option =>
        `<option value="${esc(encodeURIComponent(JSON.stringify(option.request)))}">${esc(option.label)}</option>`
      ).join("")}</select>
      <div class="github-source-meta">${options.length} source${options.length === 1 ? "" : "s"} available. Imports are copied into this creator's local library.</div>
      <div class="github-import-actions"><button class="button button-accent" data-action="import-github">Import selected video</button></div>`;
  }
  async function loadGithubSources(form) {
    const results = document.getElementById("github-source-results");
    const owner = form.elements.owner.value.trim();
    const repo = form.elements.repo.value.trim();
    results.innerHTML = `<p class="github-import-empty">Loading repository releases and recent workflow artifacts…</p>`;
    try {
      const query = new URLSearchParams({ owner, repo });
      githubChoices(await api(`/api/github/sources?${query}`));
    } catch (error) {
      results.innerHTML = `<p class="github-import-empty">${esc(error.message)}</p>`;
    }
  }
  function renderAccounts() {
    const t = state.accounts?.tiktok;
    const avatar = t?.avatarUrl ? `<img src="${esc(t.avatarUrl)}" alt="">` : esc((t?.displayName || "T").trim().charAt(0).toUpperCase());
    view.innerHTML = `<div class="page-heading"><div><h1>Accounts</h1><p>Connect the channel that receives your finished videos.</p></div></div>
      <div class="account-layout"><section><div class="section-kicker">ACTIVE INTEGRATION</div>
        ${t ? `<div class="connected-block"><div class="account-avatar">${avatar}</div><div><h3>${esc(t.displayName || "TikTok account")}</h3><p>${t.username ? `@${esc(t.username)} · ` : ""}Connected ${esc(fmtDate(t.connectedAt))}</p></div><div class="account-actions"><button class="button button-small button-plain" data-action="disconnect">Disconnect</button></div></div>` : `<div class="connected-block"><div class="account-avatar" aria-hidden="true">T</div><div><h3>TikTok</h3><p>Not connected yet</p></div><button class="button button-small button-accent" style="margin-left:auto" data-action="connect-tiktok">Connect</button></div>`}
        <div class="integration-list"><div class="integration-row"><span class="integration-name">TikTok</span><span class="integration-status ${t ? "active" : ""}">${t ? "Connected" : "Ready to connect"}</span></div>
          <div class="integration-row"><span class="integration-name">YouTube Shorts</span><span class="integration-status">Coming soon</span></div>
          <div class="integration-row"><span class="integration-name">Instagram Reels</span><span class="integration-status">Coming soon</span></div>
          <div class="integration-row"><span class="integration-name">Twitch</span><span class="integration-status">Coming later</span></div></div>
      </section><aside class="side-explainer"><strong>Your final step stays yours.</strong>Final Cog places videos in your TikTok inbox drafts. Review the draft, add any finishing touches, and publish from TikTok when you're ready.<p>No public auto-posting is performed by this app.</p></aside></div>`;
  }
  function renderSettings() {
    const s = state.settings;
    const advancedWasOpen = state.openAdvanced || Boolean(view.querySelector(".advanced-settings")?.open);
    const days = (s.activeDays || []).map(Number);
    const times = s.preferredTimes?.length ? s.preferredTimes : [""];
    view.innerHTML = `<div class="page-heading"><div><h1>Posting cadence</h1><p>Set the pace you want to keep. Fill the queue when you're ready to use these preferences.</p></div></div>
      <form id="settings-form" class="settings-form">
        <section class="settings-section"><div><h2>Weekly pace</h2><p class="section-desc">How many videos to schedule in a typical week.</p></div><div class="settings-controls"><div class="form-field"><label for="posts-per-week">Videos per week</label><input class="field-control" type="number" id="posts-per-week" min="1" max="21" value="${esc(s.postsPerWeek ?? 3)}" required></div></div></section>
        <section class="settings-section"><div><h2>Active days</h2><p class="section-desc">Choose the days you want videos sent to drafts.</p></div><div class="settings-controls"><div class="days-list">${dayNames.map((d, i) => `<label class="day-option"><input type="checkbox" name="activeDays" value="${i}" ${days.includes(i) ? "checked" : ""}><span>${d}</span></label>`).join("")}</div></div></section>
        <section class="settings-section"><div><h2>Preferred times</h2><p class="section-desc">Local times for your selected days.</p></div><div class="settings-controls"><div class="times-list" id="times-list">${times.map((t, i) => `<div class="time-entry"><input class="field-control preferred-time" type="time" value="${esc(t)}" aria-label="Preferred time ${i + 1}"><button type="button" class="remove-time" data-action="remove-time" aria-label="Remove preferred time">−</button></div>`).join("")}</div><button type="button" class="text-action" data-action="add-time">Add a time</button></div></section>
        <section class="settings-section"><div><h2>Spacing</h2><p class="section-desc">At least 20 hours between posts to each channel.</p></div><div class="settings-controls"><div class="form-field"><label for="spacing">Minimum spacing</label><input class="field-control" type="number" id="spacing" min="20" max="168" value="${esc(s.minSpacingHours ?? 20)}" required></div><div class="form-field"><label for="timezone">Timezone</label><select class="field-control" id="timezone">${timezoneOptions(s.timezone)}</select></div></div></section>
        <section class="settings-section"><div><h2>Best times</h2><p class="section-desc">Hours that work well for your audience, 0–23.</p></div><div class="settings-controls"><div class="form-field"><label for="best-hours-tiktok">TikTok hours</label><input class="field-control" name="bestHoursTikTok" id="best-hours-tiktok" value="${esc((s.bestHours?.tiktok || []).join(", "))}" placeholder="Example: 9, 12, 18"></div><p class="section-desc">Used for suggestions when saved. Otherwise Final Cog uses its default posting windows.</p></div></section>
        <div class="settings-bottom"><button type="submit" class="button button-accent">Save cadence</button><button type="button" class="button button-muted" data-action="fill-schedule">Fill queue from library</button><span class="settings-message" id="settings-message" role="status"></span></div>
      </form>
      <details class="advanced-settings"><summary>Advanced</summary>
        <section class="advanced-panel"><h2>Connect an AI agent</h2><p>Copy a local MCP setup for Claude Code or Claude Desktop.</p><button class="button button-muted" data-action="connect-agent">Show agent config</button></section>
        <section class="advanced-panel"><h2>AI caption drafts</h2><p>Optional. Captions are drafts for you to review; they are never posted automatically.</p>
          <form id="anthropic-key-form"><label for="anthropic-key">Anthropic API key</label><div class="inline-fields"><input id="anthropic-key" name="apiKey" class="field-control" type="password" autocomplete="off" placeholder="${state.advanced?.anthropicConfigured ? "Key saved on this computer" : "Enter your key"}"><button class="button button-small button-muted" type="submit">Save key</button>${state.advanced?.anthropicConfigured ? `<button class="button button-small button-plain" type="button" data-action="remove-anthropic-key">Remove key</button>` : ""}</div></form>
          <label class="toggle-setting"><input id="ai-captions-enabled" type="checkbox" ${state.advanced?.aiCaptionsEnabled ? "checked" : ""} ${state.advanced?.anthropicConfigured ? "" : "disabled"}><span>Enable “Write a caption for me”</span></label>
          <p class="section-desc">Video frames are sent to Anthropic only when you request a draft. Spoken words are not transcribed automatically; you can provide a transcript for context.</p>
        </section>
      </details>`;
    if (advancedWasOpen) {
      view.querySelector(".advanced-settings")?.setAttribute("open", "");
      state.openAdvanced = false;
    }
  }
  function timezoneOptions(selected) {
    let names;
    try { names = Intl.supportedValuesOf("timeZone"); } catch { names = ["UTC", "America/Los_Angeles", "America/New_York", "Europe/London"]; }
    if (selected && !names.includes(selected)) names.unshift(selected);
    const current = selected || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return names.map(n => `<option value="${esc(n)}" ${n === current ? "selected" : ""}>${esc(n.replaceAll("_", " "))}</option>`).join("");
  }

  function openDialog(markup) { dialogContent.innerHTML = markup; dialog.showModal(); }
  function closeDialog() { if (dialog.open) dialog.close(); }
  function openTikTokSetup() {
    openDialog(`<h2>Connect TikTok</h2><p class="dialog-intro">Add your TikTok developer app details once. Final Cog encrypts them on this computer.</p>
      <form id="tiktok-credentials-form"><div class="dialog-fields">
        <div class="form-field"><label for="tiktok-client-key">Client key</label><input class="field-control" id="tiktok-client-key" name="clientKey" autocomplete="off" required></div>
        <div class="form-field"><label for="tiktok-client-secret">Client secret</label><input class="field-control" id="tiktok-client-secret" name="clientSecret" type="password" autocomplete="new-password" required></div>
      </div><p class="section-desc">Find both values in your TikTok developer app. They are never sent to the browser after saving.</p>
      <div class="dialog-actions"><button type="button" class="button button-small" data-action="close-dialog">Cancel</button><button type="submit" class="button button-accent">Save and continue</button></div></form>`);
  }
  function findQueue(id) { return state.queue.find(item => String(item.id) === String(id)); }
  function findLibrary(id) { return state.library.find(item => String(item.id) === String(id)); }
  function openSchedule(item) {
    const editing = !!item?.id;
    const videos = state.library;
    openDialog(`<h2>${editing ? "Edit scheduled video" : "Schedule a video"}</h2><p class="dialog-intro">Choose when Final Cog should send this video to TikTok drafts.</p>
      <form id="schedule-form" data-edit-id="${editing ? esc(item.id) : ""}"><div class="dialog-fields">
        ${editing ? `<input type="hidden" name="mediaId" value="${esc(item.mediaId || "")}"><div class="form-field"><label>Video</label><div class="field-control">${esc(item.filename || "Selected video")}</div></div>` : `<div class="form-field"><label for="schedule-media">Video</label><select class="field-control" id="schedule-media" name="mediaId" required>${videos.map(v => `<option value="${esc(v.id)}">${esc(v.filename)}</option>`).join("")}</select></div>`}
        <div class="form-field"><label for="schedule-caption">Caption</label><textarea class="field-control" id="schedule-caption" name="caption" rows="3">${esc(item?.caption || (!editing ? (videos[0]?.caption || "") : ""))}</textarea></div>
        <div class="form-field"><label for="schedule-hashtags">Hashtags</label><input class="field-control" id="schedule-hashtags" name="hashtags" value="${esc(item?.hashtags || (!editing ? (videos[0]?.hashtags || "") : ""))}" placeholder="#yourtags"></div>
        <div class="form-field"><label for="schedule-at">Send to drafts at</label><input class="field-control" id="schedule-at" name="scheduledAt" type="datetime-local" value="${esc(item?.scheduledAt ? toLocalInput(item.scheduledAt) : "")}" required><button type="button" class="text-action" data-action="suggest-time">Suggest a time</button><span id="suggestion-reason" class="section-desc"></span></div></div>
        <div class="dialog-actions"><button type="button" class="button button-small" data-action="close-dialog">Cancel</button><button type="submit" class="button button-accent">${editing ? "Save changes" : "Add to queue"}</button></div></form>`);
  }
  function toLocalInput(value) { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }

  async function refreshCurrent() { await loadView(); await refreshSession(); }
  function updateConnectTop() {
    const button = document.getElementById("connect-top");
    if (button) button.hidden = isStaticGithubPages || !!state.session?.account || ["queue", "accounts"].includes(state.activeView);
  }
  async function refreshSession() {
    try {
      state.session = await api("/api/session");
      const account = state.session?.account;
      const chip = document.getElementById("account-chip");
      const label = account ? (account.displayName || `@${account.username}`) : "Not connected";
      chip.innerHTML = `<span class="account-dot"></span><span>${esc(label)}</span>`;
      chip.classList.toggle("connected", !!state.session?.authenticated);
      document.getElementById("channel-state").textContent = account ? "Connected" : "Not connected";
      updateConnectTop();
      if (isStaticGithubPages) {
        shellNotice("GitHub Pages serves the marketing site only. Run Final Cog locally to use your TikTok account, queue, library, and uploads.");
      } else {
        shellNotice("");
      }
    } catch {
      if (isStaticGithubPages) {
        shellNotice("GitHub Pages serves the marketing site only. Run Final Cog locally to use your TikTok account, queue, library, and uploads.");
      }
    }
  }
  function inputValuesFromSchedule(form) {
    return { mediaId: form.elements.mediaId.value, caption: form.elements.caption.value.trim(), hashtags: form.elements.hashtags.value.trim(), scheduledAt: new Date(form.elements.scheduledAt.value).toISOString() };
  }
  async function uploadFiles(files) {
    if (!files.length) return;
    const form = new FormData();
    [...files].forEach(file => form.append("files", file));
    try { const result = await api("/api/library", { method: "POST", body: form }); state.library = [...(result.items || []), ...state.library]; showToast(`${result.items?.length || files.length} video${files.length === 1 ? "" : "s"} uploaded`); renderLibrary(); }
    catch (error) { showToast(`Upload failed: ${error.message}`, true); }
  }
  async function draftCaptions(mediaId) {
    const item = findLibrary(mediaId);
    if (!item) return;
    if (!state.advanced?.aiCaptionsEnabled) {
      showToast("Turn on AI captions in Settings > Advanced first.", true);
      state.openAdvanced = true;
      setActive("settings");
      return;
    }
    openDialog(`<h2>Write a caption</h2><p class="dialog-intro">Add spoken words for context, then review and edit the suggestions before saving.</p>
      <form id="draft-caption-form" data-id="${esc(mediaId)}"><div class="dialog-fields">
        <div class="form-field"><label for="transcript-input">Spoken words, if any</label><textarea class="field-control" id="transcript-input" name="transcript" rows="3" maxlength="4000" placeholder="Optional transcript"></textarea></div>
        <p class="section-desc">A few video frames will be sent to Anthropic. Nothing is saved or scheduled until you review it.</p>
      </div><div class="dialog-actions"><button type="button" class="button button-small" data-action="close-dialog">Cancel</button><button type="submit" class="button button-accent">Draft captions</button></div></form>`);
  }
  function confirmAction(message, callback) {
    openDialog(`<h2>Confirm this change</h2><p class="dialog-intro">${esc(message)}</p><div class="dialog-actions"><button class="button button-small" data-action="close-dialog">Cancel</button><button class="button button-danger" data-action="confirm-action">Continue</button></div>`);
    dialogContent.querySelector('[data-action="confirm-action"]').onclick = async () => { closeDialog(); await callback(); };
  }

  document.addEventListener("click", async event => {
    const nav = event.target.closest("[data-view]");
    if (nav) { setActive(nav.dataset.view); return; }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    try {
      if (action === "reload-view") await loadView();
      else if (action === "go-library") setActive("library");
      else if (action === "connect-tiktok") {
        if (isStaticGithubPages) { showToast("Run Final Cog on this computer to connect TikTok.", true); return; }
        if (state.session?.tiktokConfigured) location.href = "/auth/tiktok/start";
        else openTikTokSetup();
      }
      else if (action === "draft-captions") await draftCaptions(id);
      else if (action === "open-schedule") {
        if (!state.library.length) { await api("/api/library").then(data => state.library = data); }
        if (!state.library.length) { showToast("Upload a video to your library before scheduling.", true); setActive("library"); return; }
        openSchedule();
      } else if (action === "close-dialog") closeDialog();
      else if (action === "pick-files") document.getElementById("file-input").click();
      else if (action === "suggest-time") {
        const suggestion = await api("/api/schedule/suggest");
        document.getElementById("schedule-at").value = toLocalInput(suggestion.scheduledAt);
        document.getElementById("suggestion-reason").textContent = suggestion.reason;
      }
      else if (action === "connect-agent") {
        const result = await api("/api/agent/config");
        const configText = JSON.stringify(result.json, null, 2);
        openDialog(`<h2>Connect an AI agent</h2><p class="dialog-intro">Add this entry to Claude Code or Claude Desktop. It connects to Final Cog on this computer.</p><textarea class="field-control agent-config" id="agent-config-text" rows="14" readonly></textarea><div class="dialog-actions"><button class="button button-small" data-action="close-dialog">Close</button><button class="button button-accent" data-action="copy-agent-config">Copy config</button></div>`);
        document.getElementById("agent-config-text").value = configText;
      }
      else if (action === "copy-agent-config") {
        await navigator.clipboard.writeText(document.getElementById("agent-config-text").value);
        showToast("Agent config copied.");
      }
      else if (action === "remove-anthropic-key") {
        await api("/api/settings/anthropic-key", { method: "DELETE" });
        state.advanced = await api("/api/settings/advanced");
        renderSettings();
        showToast("Anthropic key removed.");
      }
      else if (action === "import-github") {
        const choice = document.getElementById("github-source-choice");
        if (!choice?.value) { showToast("Find a GitHub video source first.", true); return; }
        const source = JSON.parse(decodeURIComponent(choice.value));
        setBusy(button, true, "Importing…");
        const item = await api("/api/github/import", { method: "POST", body: source });
        state.library = [item, ...state.library];
        showToast(`Imported ${item.filename} to the library.`);
        renderLibrary();
      }
      else if (action === "edit-queue") openSchedule(findQueue(id));
      else if (action === "send-now") {
        setBusy(button, true, "Queuing…"); await api(`/api/queue/${encodeURIComponent(id)}/send-now`, { method: "POST" }); showToast("Queued for immediate TikTok draft upload."); await refreshCurrent();
      } else if (action === "retry") {
        const item = findQueue(id);
        if (!item?.retryAllowed || /flag|policy|violation/i.test(item.errorReason || "")) { showToast("This item is not eligible to retry.", true); return; }
        setBusy(button, true, "Queuing…"); await api(`/api/queue/${encodeURIComponent(id)}/retry`, { method: "POST" }); showToast("Eligible retry queued."); await refreshCurrent();
      } else if (action === "mark-posted") {
        await api(`/api/queue/${encodeURIComponent(id)}/mark-posted`, { method: "POST" }); showToast("Marked as posted."); await refreshCurrent();
      } else if (action === "copy-caption") {
        const item = findQueue(id);
        const caption = [item?.caption, item?.hashtags].filter(Boolean).join(" ").trim();
        if (!caption) { showToast("This video has no saved caption.", true); return; }
        await navigator.clipboard.writeText(caption);
        showToast("Caption copied. Paste it into TikTok.");
      } else if (action === "delete-queue") {
        confirmAction("Remove this video from the queue? The original file stays in your library.", async () => { await api(`/api/queue/${encodeURIComponent(id)}`, { method: "DELETE" }); showToast("Removed from queue."); await refreshCurrent(); });
      } else if (action === "save-library") {
        const row = button.closest(".library-item");
        const caption = row.querySelector(".caption-input").value;
        const captionVariants = { tiktok: caption };
        row.querySelectorAll(".variant-input").forEach(input => { captionVariants[input.dataset.platform] = input.value; });
        const platforms = [...row.querySelectorAll(".platform-input:checked")].map(input => input.value);
        const item = await api(`/api/library/${encodeURIComponent(id)}`, { method: "PATCH", body: { caption, hashtags: row.querySelector(".hashtags-input").value, captionVariants, platforms } });
        state.library = state.library.map(v => String(v.id) === String(id) ? item : v); showToast("Video details saved.");
      } else if (action === "schedule-library") {
        const item = findLibrary(id); openSchedule({ mediaId: item.id, filename: item.filename, caption: item.caption, hashtags: item.hashtags });
      } else if (action === "delete-library") {
        confirmAction("Remove this video, its saved captions, and its queue history from this local app?", async () => { await api(`/api/library/${encodeURIComponent(id)}`, { method: "DELETE" }); state.library = state.library.filter(x => String(x.id) !== String(id)); renderLibrary(); showToast("Video removed."); });
      } else if (action === "month-prev" || action === "month-next") {
        state.month = new Date(state.month.getFullYear(), state.month.getMonth() + (action === "month-prev" ? -1 : 1), 1); await loadView();
      } else if (action === "month-today") { state.month = new Date(); await loadView(); }
      else if (action === "disconnect") {
        confirmAction("Disconnect TikTok and remove its saved authorization tokens? Your local videos and queue will stay.", async () => {
          await api("/api/accounts/disconnect", { method: "POST" });
          showToast("TikTok disconnected.");
          await refreshSession();
          await loadView();
        });
      }
      else if (action === "add-time") {
        document.getElementById("times-list").insertAdjacentHTML("beforeend", `<div class="time-entry"><input class="field-control preferred-time" type="time" aria-label="Preferred time"><button type="button" class="remove-time" data-action="remove-time" aria-label="Remove preferred time">−</button></div>`);
      } else if (action === "remove-time") {
        const entries = document.querySelectorAll(".time-entry");
        if (entries.length <= 1) entries[0].querySelector("input").value = "";
        else button.closest(".time-entry").remove();
      } else if (action === "fill-schedule") {
        setBusy(button, true, "Filling…");
        const result = await api("/api/schedule/fill", { method: "POST" });
        showToast(`${result.created?.length || 0} video${result.created?.length === 1 ? "" : "s"} added to queue.`);
        await loadView();
      }
    } catch (error) { showToast(error.message, true); if (["send-now", "retry"].includes(action)) await loadView(); }
  });

  document.addEventListener("submit", async event => {
    if (event.target.id === "tiktok-credentials-form") {
      event.preventDefault();
      try {
        await api("/api/setup/tiktok", {
          method: "POST",
          body: {
            clientKey: event.target.elements.clientKey.value,
            clientSecret: event.target.elements.clientSecret.value,
          },
        });
        closeDialog();
        location.href = "/auth/tiktok/start";
      } catch (error) {
        showToast(error.message, true);
      }
      return;
    }
    if (event.target.id === "anthropic-key-form") {
      event.preventDefault();
      const input = event.target.elements["anthropic-key"];
      try {
        await api("/api/settings/anthropic-key", { method: "PUT", body: { apiKey: input.value } });
        input.value = "";
        state.advanced = await api("/api/settings/advanced");
        renderSettings();
        showToast("Anthropic key saved on this computer.");
      } catch (error) { showToast(error.message, true); }
      return;
    }
    if (event.target.id === "draft-caption-form") {
      event.preventDefault();
      const form = event.target;
      const mediaId = form.dataset.id;
      const video = findLibrary(mediaId);
      try {
        const result = await api(`/api/videos/${encodeURIComponent(mediaId)}/draft-captions`, {
          method: "POST",
          body: { transcript: form.elements.transcript.value, platforms: video?.platforms || ["tiktok"] },
        });
        const fields = Object.entries(result.captions).map(([platform, draft]) => {
          const label = { tiktok: "TikTok", instagram: "Instagram Reels", youtube: "YouTube Shorts" }[platform] || platform;
          return `<div class="form-field"><label for="draft-${esc(platform)}">${label}</label><textarea class="field-control" id="draft-${esc(platform)}" data-caption data-platform="${esc(platform)}" rows="3">${esc(draft.caption)}</textarea><input class="field-control" data-hashtags data-platform="${esc(platform)}" value="${esc(draft.hashtags)}" aria-label="${label} hashtags"></div>`;
        }).join("");
        openDialog(`<h2>Review your captions</h2><p class="dialog-intro">Edit anything you want. Nothing is saved until you save the video in your library.</p><form id="apply-caption-form" data-id="${esc(mediaId)}"><div class="dialog-fields">${fields}</div><div class="dialog-actions"><button type="button" class="button button-small" data-action="close-dialog">Cancel</button><button type="submit" class="button button-accent">Use these drafts</button></div></form>`);
      } catch (error) { showToast(error.message, true); }
      return;
    }
    if (event.target.id === "apply-caption-form") {
      event.preventDefault();
      const form = event.target;
      const row = document.querySelector(`.library-item[data-library-id="${CSS.escape(form.dataset.id)}"]`);
      if (row) {
        form.querySelectorAll("[data-caption]").forEach(input => {
          const platform = input.dataset.platform;
          const hashtags = form.querySelector(`[data-hashtags][data-platform="${CSS.escape(platform)}"]`);
          const captionInput = platform === "tiktok"
            ? row.querySelector(".caption-input")
            : row.querySelector(`.variant-input[data-platform="${CSS.escape(platform)}"]`);
          if (captionInput) {
            captionInput.value = platform === "tiktok" || !hashtags?.value.trim()
              ? input.value
              : `${input.value.trim()} ${hashtags.value.trim()}`.trim();
          }
          if (platform === "tiktok" && hashtags) row.querySelector(".hashtags-input").value = hashtags.value;
        });
      }
      closeDialog();
      showToast("Caption drafts added for review. Save the video to keep them.");
      return;
    }
    if (event.target.id === "github-source-form") {
      event.preventDefault();
      await loadGithubSources(event.target);
      return;
    }
    if (event.target.id === "schedule-form") {
      event.preventDefault();
      const form = event.target;
      try {
        const values = inputValuesFromSchedule(form);
        if (form.dataset.editId) await api(`/api/queue/${encodeURIComponent(form.dataset.editId)}`, { method: "PATCH", body: { scheduledAt: values.scheduledAt, caption: values.caption, hashtags: values.hashtags } });
        else await api(`/api/videos/${encodeURIComponent(values.mediaId)}/schedule`, { method: "POST", body: values });
        closeDialog(); showToast(form.dataset.editId ? "Schedule updated." : "Added to queue."); await refreshCurrent();
      } catch (error) { showToast(error.message, true); }
    }
    if (event.target.id === "settings-form") {
      event.preventDefault();
      const form = event.target;
      const bestHours = form.elements.bestHoursTikTok.value.split(",").map(value => value.trim()).filter(Boolean).map(Number).filter(Number.isInteger);
      const body = {
        timezone: form.elements.timezone.value,
        postsPerWeek: Number(form.elements["posts-per-week"].value),
        activeDays: [...form.querySelectorAll('input[name="activeDays"]:checked')].map(x => Number(x.value)),
        preferredTimes: [...form.querySelectorAll(".preferred-time")].map(x => x.value).filter(Boolean),
        minSpacingHours: Number(form.elements.spacing.value),
        bestHours: { tiktok: bestHours },
      };
      try {
        state.settings = await api("/api/settings", { method: "PUT", body });
        document.getElementById("settings-message").textContent = "Cadence saved.";
        showToast("Cadence saved.");
      } catch (error) { document.getElementById("settings-message").textContent = error.message; }
    }
  });
  document.addEventListener("change", event => {
    if (event.target.id === "file-input") uploadFiles(event.target.files);
    if (event.target.id === "ai-captions-enabled") {
      api("/api/settings/ai-enabled", { method: "PUT", body: { enabled: event.target.checked } })
        .then(() => {
          if (state.advanced) state.advanced.aiCaptionsEnabled = event.target.checked;
          showToast(event.target.checked ? "AI caption drafts enabled." : "AI caption drafts disabled.");
        })
        .catch(error => {
          event.target.checked = false;
          showToast(error.message, true);
        });
    }
    if (event.target.id === "schedule-media") {
      const item = findLibrary(event.target.value);
      if (item) { document.getElementById("schedule-caption").value = item.caption || ""; document.getElementById("schedule-hashtags").value = item.hashtags || ""; }
    }
  });
  document.getElementById("mobile-menu").addEventListener("click", event => {
    const open = !document.querySelector(".sidebar").classList.contains("open");
    document.querySelector(".sidebar").classList.toggle("open", open);
    event.currentTarget.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      document.querySelector(".sidebar").classList.remove("open");
      document.getElementById("mobile-menu").setAttribute("aria-expanded", "false");
    }
  });

  async function initializeWorkspace() {
    updateConnectTop();
    if (isStaticGithubPages) {
      shellNotice("GitHub Pages serves the marketing site only. Run Final Cog locally to use your workspace.");
      await loadView();
      return;
    }
    try {
      await refreshSession();
      await loadView();
      if (new URLSearchParams(location.search).get("auth") === "setup") openTikTokSetup();
    } catch (error) {
      shellNotice(error.message);
    }
  }

  initializeWorkspace();
})();
