const $ = (s, r = document) => r.querySelector(s);
const META = new Set(["id", "sessionID", "messageID", "time_created", "time_updated"]);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}
function notice(msg, ok = true) {
  const n = $("#notice");
  n.hidden = false; n.className = ok ? "ok" : "bad"; n.textContent = msg;
  clearTimeout(n._t); n._t = setTimeout(() => (n.hidden = true), 6000);
}
function cleanForSave(obj) {
  const o = { ...obj };
  for (const k of META) delete o[k];
  return o;
}
const fmtT = (ms) => new Date(Number(ms)).toLocaleString();

// ---- header / backups ----
async function loadMeta() {
  const { data } = await api("/api/meta");
  $("#meta").textContent = `${data.dbPath} · ${data.journalMode} · ${data.counts.session} sess / ${data.counts.message} msg / ${data.counts.part} parts · ${data.backups} backups`;
  const { data: backs } = await api("/api/backups");
  const sel = $("#sel-restore");
  sel.innerHTML = `<option value="">restore…</option>` + backs.map((f) => `<option>${esc(f)}</option>`).join("");
}
async function loadProjects() {
  const { data } = await api("/api/projects");
  $("#f-project").innerHTML = `<option value="">all projects</option>` +
    data.map((p) => `<option value="${esc(p.id)}">${esc(p.worktree ?? p.id)}</option>`).join("");
}

// ---- session list ----
async function loadSessions() {
  const q = $("#q").value.trim(), project = $("#f-project").value;
  const qs = new URLSearchParams({ limit: "50", ...(q ? { q } : {}), ...(project ? { project } : {}) });
  const { data } = await api("/api/sessions?" + qs);
  $("#sessions").innerHTML = data.map((s) => `
    <div class="sess" data-id="${esc(s.id)}">
      <div class="t">${esc(s.title)} ${s.compaction_count ? `<span class="badge hot">compacted ×${s.compaction_count}</span>` : ""} <span class="badge">${s.message_count} msg</span></div>
      <div class="s">${esc(s.id)} · ${esc(s.directory)} · ${fmtT(s.time_updated)} · in ${s.tokens_input}/${s.tokens_output} · $${Number(s.cost).toFixed(4)}</div>
    </div>`).join("") || `<p class="muted">no sessions</p>`;
  document.querySelectorAll(".sess").forEach((el) => (el.onclick = () => openSession(el.dataset.id)));
}

// ---- detail ----
let cur = null, curMsgs = [];
async function openSession(id) {
  const { data } = await api(`/api/sessions/${id}`);
  cur = data;
  $("#view-list").hidden = true; $("#view-detail").hidden = false;
  $("#d-title").textContent = cur.title;
  $("#d-meta").textContent = `${cur.id} · ${cur.directory} · agent ${cur.agent ?? "?"} · created ${fmtT(cur.time_created)}`;
  await loadTranscript();
  showTab("transcript");
}
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  for (const t of ["transcript", "context", "epoch", "todos", "settings"]) $("#tab-" + t).hidden = t !== name;
  if (name === "context") loadContext();
  if (name === "epoch") loadEpoch();
  if (name === "todos") loadTodos();
  if (name === "settings") renderSettings();
}

function partPreview(p) {
  const t = p.type;
  if (t === "text") return String(p.text ?? "").slice(0, 600);
  if (t === "reasoning") return String(p.text ?? "").slice(0, 300);
  if (t === "tool") return `${p.tool}(${JSON.stringify(p.state?.input ?? {}).slice(0, 200)}) → ${String(p.state?.output ?? p.state?.error ?? p.state?.status).slice(0, 300)}`;
  if (t === "file") return `[${p.mime} ${p.filename ?? ""}]`;
  if (t === "compaction") return `compaction marker tail_start_id=${p.tail_start_id ?? "(none yet)"}`;
  if (t === "subtask") return `subtask ${p.description ?? ""}`;
  return JSON.stringify(p).slice(0, 300);
}

async function loadTranscript() {
  const { data } = await api(`/api/sessions/${cur.id}/messages`);
  curMsgs = data;
  const el = $("#tab-transcript");
  el.innerHTML = `<div class="row"><button id="btn-addmsg">+ message</button>
    <label><input type="checkbox" id="ck-tools" checked> tools</label>
    <label><input type="checkbox" id="ck-think"> reasoning</label></div><div id="msgs"></div>`;
  const render = (tools, think) => {
    $("#msgs").innerHTML = curMsgs.map((m) => {
      const parts = m.parts.filter((p) => (tools || p.type !== "tool") && (think || p.type !== "reasoning"));
      return `<div class="msg" data-mid="${esc(m.info.id)}">
        <div class="msg-h"><span class="role">${esc(m.info.role)}</span><span>${esc(m.info.id)}</span>
        <span>${fmtT(m.info.time_created)}</span><span class="sp"></span>
        <button data-act="delmsg" class="danger">delete msg</button>
        <button data-act="addpart">+ part</button></div>
        ${parts.map((p) => `
          <div class="part" data-pid="${esc(p.id)}">
            <div class="part-h"><span class="ty">${esc(p.type)}</span><span>${esc(p.id)}</span><span class="sp" style="flex:1"></span>
            <button data-act="editpart">edit</button>
            <button data-act="delpart" class="danger">delete</button></div>
            <div class="preview">${esc(partPreview(p))}</div>
            <div class="editor" hidden><textarea rows="8"></textarea>
              <div class="row"><button data-act="savepart">save</button><button data-act="canceledit">cancel</button></div></div>
          </div>`).join("")}
      </div>`;
    }).join("") || `<p class="muted">empty session</p>`;
  };
  render(true, false);
  $("#ck-tools").onchange = (e) => render(e.target.checked, $("#ck-think").checked);
  $("#ck-think").onchange = (e) => render($("#ck-tools").checked, e.target.checked);
  $("#btn-addmsg").onclick = async () => {
    const role = prompt("role (user|assistant):", "user");
    if (!role) return;
    const raw = prompt("parts as JSON array (e.g. [{\"type\":\"text\",\"text\":\"hi\"}])", `[{"type":"text","text":""}]`);
    try {
      const parts = JSON.parse(raw ?? "[]");
      const { data } = await api(`/api/sessions/${cur.id}/messages`, { method: "POST", body: JSON.stringify({ info: { role }, parts }) });
      notice(`message created: ${data.id}`); loadTranscript();
    } catch (e) { notice(String(e.message ?? e), false); }
  };
  el.onclick = async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const msgEl = e.target.closest(".msg"), partEl = e.target.closest(".part");
    const mid = msgEl?.dataset.mid, pid = partEl?.dataset.pid;
    const act = btn.dataset.act;
    try {
      if (act === "delmsg" && confirm(`Delete message ${mid} + its parts?`)) {
        await api(`/api/messages/${mid}`, { method: "DELETE" });
        notice("message deleted"); loadTranscript();
      } else if (act === "delpart" && confirm(`Delete part ${pid}?`)) {
        await api(`/api/parts/${pid}`, { method: "DELETE" });
        notice("part deleted"); loadTranscript();
      } else if (act === "editpart") {
        const msg = curMsgs.find((m) => m.info.id === mid);
        const part = msg.parts.find((p) => p.id === pid);
        const ta = partEl.querySelector("textarea");
        ta.value = JSON.stringify(cleanForSave(part), null, 2);
        partEl.querySelector(".editor").hidden = false;
      } else if (act === "canceledit") {
        partEl.querySelector(".editor").hidden = true;
      } else if (act === "savepart") {
        const msg = curMsgs.find((m) => m.info.id === mid);
        const part = msg.parts.find((p) => p.id === pid);
        const data = JSON.parse(partEl.querySelector("textarea").value);
        await api(`/api/parts/${pid}/data`, { method: "PATCH", body: JSON.stringify({ data, expectedUpdated: part.time_updated }) });
        notice("part saved"); loadTranscript();
      } else if (act === "addpart") {
        const raw = prompt('new part JSON (e.g. {"type":"text","text":"..."} )', `{"type":"text","text":""}`);
        if (!raw) return;
        await api(`/api/messages/${mid}/parts`, { method: "POST", body: JSON.stringify({ data: JSON.parse(raw) }) });
        notice("part added"); loadTranscript();
      }
    } catch (err2) { notice(String(err2.message ?? err2), false); }
  };
}

// ---- context tab ----
async function loadContext() {
  const el = $("#tab-context");
  el.innerHTML = `<p class="muted">computing projection…</p>`;
  const keep = 15000;
  const { data } = await api(`/api/sessions/${cur.id}/context?keep_tokens=${keep}`);
  el.innerHTML = `
    <div class="grid2">
      <div><b>Full transcript:</b> ${data.totalMessages} messages</div>
      <div><b>Model sees:</b> ${data.projected.length} messages ≈ ${data.estimatedTokens} tokens</div>
    </div>
    ${data.hiddenCount ? `<div class="hidden-note">${data.hiddenCount} older message(s) replaced by compaction summary (still stored).</div>` : `<p class="muted">No compaction active — model sees everything.</p>`}
    <div class="row">
      <label>keep tokens <input id="keep" value="${keep}" size="6"></label>
      <button id="btn-suggest">suggest tail</button>
      <span id="sug" class="muted">${data.suggestion.tail_start_id ? `suggested tail: ${esc(data.suggestion.tail_start_id)} (~${data.suggestion.keptTokens} tok)` : "history too short to compact"}</span>
    </div>
    <div class="row">
      <button id="btn-mark">insert compaction marker</button>
      <button id="btn-uncompact" class="danger">remove latest compaction (uncompact)</button>
    </div>
    <p class="muted">Marker insertion only stages compaction — resume the session in opencode to generate the summary.</p>
    <h3>Projected order (what the model receives)</h3>
    ${data.projected.map((m) => `<div class="msg"><div class="msg-h"><span class="role">${esc(m.info.role)}</span><span>${esc(m.info.id)}</span></div>
      <div class="preview">${esc(m.parts.map((p) => `[${p.type}] ` + partPreview(p).slice(0, 160)).join("\n"))}</div></div>`).join("")}`;
  $("#btn-suggest").onclick = async () => {
    const k = Number($("#keep").value || 15000);
    const r = await api(`/api/sessions/${cur.id}/context?keep_tokens=${k}`);
    $("#sug").textContent = r.data.suggestion.tail_start_id ? `suggested tail: ${r.data.suggestion.tail_start_id} (~${r.data.suggestion.keptTokens} tok)` : "history too short";
  };
  $("#btn-mark").onclick = async () => {
    const tail = prompt("tail_start_id (message id where retained tail starts, empty = whole-head summarize):", $("#sug").textContent.includes(":") ? $("#sug").textContent.split(":")[1].trim().split(" ")[0] : "");
    try {
      const r = await api(`/api/sessions/${cur.id}/compaction`, { method: "POST", body: JSON.stringify({ tail_start_id: tail || null }) });
      notice("marker inserted: " + r.data.id); loadContext();
    } catch (e) { notice(String(e.message ?? e), false); }
  };
  $("#btn-uncompact").onclick = async () => {
    if (!confirm("Remove latest compaction marker + its summary?")) return;
    try { await api(`/api/sessions/${cur.id}/compaction`, { method: "DELETE" }); notice("compaction removed"); loadContext(); }
    catch (e) { notice(String(e.message ?? e), false); }
  };
}

// ---- epoch / V2 ----
async function loadEpoch() {
  const el = $("#tab-epoch");
  const [{ data: epoch }, v2, inputs] = await Promise.all([
    api(`/api/sessions/${cur.id}/epoch`),
    api(`/api/sessions/${cur.id}/v2messages`),
    api(`/api/sessions/${cur.id}/inputs`),
  ]);
  el.innerHTML = `
    ${epoch ? `<div class="row"><label>baseline_seq <input id="ep-seq" value="${epoch.baseline_seq}" size="6"></label>
      <button id="ep-save">save epoch</button><button id="ep-clear" class="danger">clear epoch</button></div>
      <label>baseline (system text sent as cache prefix)</label><textarea id="ep-base" rows="8">${esc(epoch.baseline)}</textarea>
      <label>snapshot (model-hidden JSON)</label><textarea id="ep-snap" rows="8">${esc(epoch.snapshot)}</textarea>`
    : `<p class="muted">No context epoch row (expected on opencode 1.x V1 runtime). You can create one, but the V1 runner ignores it.</p>
       <div class="row"><button id="ep-save">create epoch</button></div>
       <label>baseline</label><textarea id="ep-base" rows="6"></textarea>
       <label>snapshot JSON</label><textarea id="ep-snap" rows="6">{}</textarea>
       <label>baseline_seq <input id="ep-seq" value="0" size="6"></label>`}
    <h3>session_message (V2, ${v2.data.length})</h3>
    <div class="preview">${esc(JSON.stringify(v2.data.slice(0, 5), null, 1))}${v2.data.length > 5 ? "\n…" : ""}</div>
    <h3>session_input (${inputs.data.length})</h3>
    <div class="preview">${esc(JSON.stringify(inputs.data.slice(0, 5), null, 1))}${inputs.data.length > 5 ? "\n…" : ""}</div>`;
  $("#ep-save").onclick = async () => {
    try {
      await api(`/api/sessions/${cur.id}/epoch`, { method: "PUT", body: JSON.stringify({ baseline: $("#ep-base").value, snapshot: $("#ep-snap").value, baseline_seq: Number($("#ep-seq").value || 0) }) });
      notice("epoch saved"); loadEpoch();
    } catch (e) { notice(String(e.message ?? e), false); }
  };
  const clr = $("#ep-clear");
  if (clr) clr.onclick = async () => {
    if (!confirm("Clear epoch? Next run initializes a fresh baseline.")) return;
    await api(`/api/sessions/${cur.id}/epoch`, { method: "DELETE" });
    notice("epoch cleared"); loadEpoch();
  };
}

// ---- todos ----
async function loadTodos() {
  const el = $("#tab-todos");
  const { data } = await api(`/api/sessions/${cur.id}/todos`);
  el.innerHTML = `<textarea id="td" rows="12">${esc(JSON.stringify(data.map((t) => ({ content: t.content, status: t.status, priority: t.priority })), null, 2))}</textarea>
    <div class="row"><button id="td-save">save todos</button></div>`;
  $("#td-save").onclick = async () => {
    try {
      await api(`/api/sessions/${cur.id}/todos`, { method: "PUT", body: JSON.stringify({ todos: JSON.parse($("#td").value) }) });
      notice("todos saved"); loadTodos();
    } catch (e) { notice(String(e.message ?? e), false); }
  };
}

// ---- settings ----
function renderSettings() {
  const el = $("#tab-settings");
  el.innerHTML = `
    <div class="row"><label>title <input id="s-title" value="${esc(cur.title)}" size="50"></label></div>
    <div class="row"><label>agent <input id="s-agent" value="${esc(cur.agent ?? "")}" size="12"></label>
    <label>cost <input id="s-cost" value="${cur.cost}" size="8"></label>
    <label>in <input id="s-ti" value="${cur.tokens_input}" size="8"></label>
    <label>out <input id="s-to" value="${cur.tokens_output}" size="8"></label></div>
    <div class="row"><button id="s-save">save</button>
    <button id="s-arch" class="danger">${cur.time_archived ? "unarchive" : "archive"}</button></div>
    <p class="muted">id ${esc(cur.id)} · project ${esc(cur.project_id)} · v${esc(cur.version)} · updated ${fmtT(cur.time_updated)}</p>`;
  $("#s-save").onclick = async () => {
    try {
      const { data } = await api(`/api/sessions/${cur.id}`, { method: "PATCH", body: JSON.stringify({ patch: { title: $("#s-title").value, agent: $("#s-agent").value || null, cost: Number($("#s-cost").value), tokens_input: Number($("#s-ti").value), tokens_output: Number($("#s-to").value) }, expectedUpdated: cur.time_updated }) });
      cur = data; notice("session saved"); openSession(cur.id);
    } catch (e) { notice(String(e.message ?? e), false); }
  };
  $("#s-arch").onclick = async () => {
    try {
      const { data } = await api(`/api/sessions/${cur.id}`, { method: "PATCH", body: JSON.stringify({ patch: { time_archived: cur.time_archived ? null : Date.now() }, expectedUpdated: cur.time_updated }) });
      cur = data; notice("toggled archive"); openSession(cur.id);
    } catch (e) { notice(String(e.message ?? e), false); }
  };
}

// ---- wire up ----
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$("#btn-search").onclick = loadSessions;
$("#q").onkeydown = (e) => { if (e.key === "Enter") loadSessions(); };
$("#btn-back").onclick = () => { $("#view-detail").hidden = true; $("#view-list").hidden = false; loadSessions(); };
$("#btn-backup").onclick = async () => { try { const r = await api("/api/backups", { method: "POST" }); notice("backup: " + r.data.file); loadMeta(); } catch (e) { notice(String(e.message ?? e), false); } };
$("#btn-restore").onclick = async () => {
  const f = $("#sel-restore").value;
  if (!f || !confirm(`Restore ${f} over the live db? Do this with opencode closed.`)) return;
  try { await api("/api/backups/restore", { method: "POST", body: JSON.stringify({ file: f }) }); notice("restored; reloading"); location.reload(); }
  catch (e) { notice(String(e.message ?? e), false); }
};
loadMeta().then(loadProjects).then(loadSessions).catch((e) => notice(String(e.message ?? e), false));
