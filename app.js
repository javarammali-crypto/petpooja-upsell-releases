import { firebaseConfig, SUPER_ADMIN, ALLOWED_DOMAIN } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  onSnapshot, query, orderBy, limit, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

// ------------------------------------------------------------------ state
const S = {
  user: null,
  isSuper: false,
  page: localStorage.getItem("page") || "activity",
  users: [], roles: new Set(), blocked: new Set(),
  leads: [], activities: [], forms: [],
  outlets: new Map(), // resId -> {name, priority, size}
  settings: { claimRadiusMeters: 1000 },
  editingFormId: null, draft: null,
  filters: { range: "today", from: "", to: "", rep: "", type: "", status: "", priority: "", q: "" },
  who: localStorage.getItem("who") || "all",
  actView: localStorage.getItem("actView") || "summary",
  leadFilters: { rep: "", status: "", q: "", due: "" },
  unsub: [],
  rows: [], headers: [], outletMeta: null, imports: [], backups: [],
  locReqs: [], fixes: new Map(), locView: "pending",
  imp: null, // import in progress: { fileName, mode, rows, headers, preview }
};

const PIN_SVG = `<svg viewBox="0 0 24 24" fill="white"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.3 7 13 7 13s7-7.7 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>`;
const $app = document.getElementById("app");

// ------------------------------------------------------------------ utils
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toDate = (ts) => (ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : ts ? new Date(ts) : null);
const fmtDT = (d) => (d ? d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtD = (d) => (d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const ymd = (d) => d.toISOString().slice(0, 10);
const km = (m) => (m == null ? "—" : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const prio = (p) => `<span class="pill ${esc((p || "").toLowerCase())}">${esc(p || "—")}</span>`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "f" + Date.now();

function statusPill(s) {
  if (!s) return `<span class="muted">—</span>`;
  const l = s.toLowerCase();
  let c = "soft";
  if (/(won|sale|sold|converted|done)/.test(l)) c = "green";
  else if (/(lost|not interested|rejected|dead)/.test(l)) c = "red";
  else if (/demo/.test(l)) c = "purple";
  else if (/(negotiat|proposal|hot|follow)/.test(l)) c = "orange";
  return `<span class="pill ${c}">${esc(s)}</span>`;
}

function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  document.getElementById("toast-root").appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 260); }, 3200);
}

function modal({ title, body = "", html = "", confirm = "OK", danger = false, cancel = "Cancel", onOpen }) {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    const o = document.createElement("div");
    o.className = "overlay";
    o.innerHTML = `<div class="modal"><h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ""}${html}
      <div class="actions">${cancel ? `<button class="btn" data-x="0">${esc(cancel)}</button>` : ""}
      <button class="btn ${danger ? "danger solid" : "primary"}" data-x="1">${esc(confirm)}</button></div></div>`;
    const close = (v) => { o.classList.add("closing"); setTimeout(() => o.remove(), 180); resolve(v); };
    o.addEventListener("click", (e) => {
      if (e.target === o) close(false);
      const b = e.target.closest("[data-x]");
      if (b) close(b.dataset.x === "1" ? (o.querySelector("[data-value]")?.value ?? true) : false);
    });
    root.appendChild(o);
    onOpen?.(o);
  });
}

async function run(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) { console.error(e); toast("Failed: " + (e.code || e.message), true); }
}

const userByUid = (uid) => S.users.find((u) => u.uid === uid);
const isAdminEmail = (e) => e === SUPER_ADMIN || S.roles.has(e);

// ------------------------------------------------------------------ auth
function renderLogin(message = "") {
  $app.innerHTML = `<div class="login"><div class="login-card">
    <div class="badge">${PIN_SVG}</div>
    <h1>Upsell Leads Admin</h1>
    <p>Sign in with your @${ALLOWED_DOMAIN} Google account. Only admins can open this portal.</p>
    <button class="btn dark big" id="signin">Sign in with Google</button>
    ${message ? `<div class="notice" style="margin-top:18px">${esc(message)}</div>` : ""}
  </div></div>`;
  document.getElementById("signin").onclick = async () => {
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ hd: ALLOWED_DOMAIN, prompt: "select_account" });
    try { await signInWithPopup(auth, p); } catch (e) { if (e.code !== "auth/popup-closed-by-user") renderLogin(e.message); }
  };
}

onAuthStateChanged(auth, async (user) => {
  S.unsub.forEach((u) => u()); S.unsub = [];
  if (!user) return renderLogin();
  const email = (user.email || "").toLowerCase();
  if (!email.endsWith("@" + ALLOWED_DOMAIN)) {
    await signOut(auth);
    return renderLogin(`Only @${ALLOWED_DOMAIN} accounts can sign in. You used ${email}.`);
  }
  S.user = { uid: user.uid, email, name: user.displayName || email.split("@")[0] };
  S.isSuper = email === SUPER_ADMIN;
  let admin = S.isSuper;
  if (!admin) {
    try { admin = (await getDoc(doc(db, "roles", email))).exists(); } catch { admin = false; }
  }
  if (!admin) {
    await signOut(auth);
    return renderLogin(`${email} is not an admin. Ask the super admin to give you admin access.`);
  }
  start();
});

// ------------------------------------------------------------------ data
function start() {
  renderShell();
  const live = (q, cb) => S.unsub.push(onSnapshot(q, cb, (e) => toast("Couldn't load data: " + e.code, true)));
  live(collection(db, "users"), (s) => {
    S.users = s.docs.map((d) => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (toDate(b.lastLogin)?.getTime() || 0) - (toDate(a.lastLogin)?.getTime() || 0));
    refresh();
  });
  live(collection(db, "roles"), (s) => { S.roles = new Set(s.docs.map((d) => d.id)); refresh(); });
  live(collection(db, "blocked"), (s) => { S.blocked = new Set(s.docs.map((d) => d.id)); refresh(); });
  live(collection(db, "leads"), (s) => { S.leads = s.docs.map((d) => ({ resId: d.id, ...d.data() })); refresh(); });
  live(query(collection(db, "activities"), orderBy("createdAt", "desc"), limit(3000)), (s) => {
    S.activities = s.docs.map((d) => ({ id: d.id, ...d.data() })); refresh();
  });
  live(collection(db, "forms"), (s) => {
    S.forms = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    refresh();
  });
  live(doc(db, "config", "settings"), (d) => { if (d.exists()) S.settings = { ...S.settings, ...d.data() }; refresh(); });
  live(doc(db, "config", "emailReport"), (d) => { S.emailReport = d.exists() ? d.data() : {}; refresh(); });
  live(query(collection(db, "location_requests"), orderBy("createdAt", "desc"), limit(300)), (s) => {
    S.locReqs = s.docs.map((d) => ({ id: d.id, ...d.data() })); refresh();
  });
  live(collection(db, "outlet_fixes"), (s) => { S.fixes = new Map(s.docs.map((d) => [d.id, d.data()])); refresh(); });
  live(doc(db, "outlets_meta", "current"), (d) => {
    const m = d.exists() ? d.data() : null;
    if (!m || m.version !== S.outletMeta?.version) { S.outletMeta = m; loadOutlets(m); }
  });
  live(query(collection(db, "outlet_imports"), orderBy("at", "desc"), limit(30)), (s) => { S.imports = s.docs.map((d) => ({ id: d.id, ...d.data() })); refresh(); });
  live(query(collection(db, "outlets_backups"), orderBy("createdAt", "desc"), limit(30)), (s) => { S.backups = s.docs.map((d) => ({ id: d.id, ...d.data() })); refresh(); });
}

async function loadOutlets(meta) {
  try {
    const n = meta?.chunkCount || 0;
    const chunks = await Promise.all([...Array(n).keys()].map((i) => getDoc(doc(db, "outlets_chunks", String(i)))));
    S.outlets = new Map();
    S.rows = [];
    S.headers = (() => { try { return JSON.parse(meta?.headers || "[]"); } catch { return []; } })();
    chunks.forEach((c) => JSON.parse(c.data()?.json || "[]").forEach((r) => {
      const id = String(r["Res ID"] || "").trim();
      if (!id) return;
      S.rows.push(r);
      S.outlets.set(id, { name: r["Restaurant"] || "", priority: (r["Priority"] || "").toUpperCase(), size: r["Outlet Size"] || "", area: r["Standardized Area"] || "" });
    }));
    refresh();
  } catch (e) { console.error(e); }
}

let refreshQueued = false;
function refresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => { refreshQueued = false; renderPage(false); renderNavCounts(); });
}

// ------------------------------------------------------------------ shell
const PAGES = [
  ["activity", "Activity", "M3 12h4l3 8 4-16 3 8h4"],
  ["leads", "Leads & claims", "M4 6h16M4 12h16M4 18h10"],
  ["forms", "Forms", "M6 3h9l5 5v13H6zM14 3v6h6"],
  ["users", "Users & roles", "M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21a8 8 0 0116 0"],
  ["locfix", "Location fixes", "M12 21s-7-6.3-7-12a7 7 0 1114 0c0 5.7-7 12-7 12zM12 11.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"],
  ["outlets", "Outlets & import", "M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1"],
  ["settings", "Settings", "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"],
];

function renderShell() {
  $app.innerHTML = `<div class="shell">
    <aside class="side">
      <div class="brand"><div class="badge">${PIN_SVG}</div><div><b>Upsell Leads</b><span>Admin portal</span></div></div>
      ${PAGES.map(([id, label, path]) => `<button class="nav" data-page="${id}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>
        ${label}<span class="count" data-count="${id}" hidden></span></button>`).join("")}
      <div class="me"><b>${esc(S.user.email)}</b>${S.isSuper ? "Super admin" : "Admin"} ·
        <a href="#" id="logout" style="color:var(--orange)">Sign out</a></div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  $app.querySelectorAll("[data-page]").forEach((b) => b.onclick = () => {
    S.page = b.dataset.page; localStorage.setItem("page", S.page); renderPage(true);
  });
  document.getElementById("logout").onclick = (e) => { e.preventDefault(); signOut(auth); };
  renderPage(true);
}

function renderNavCounts() {
  const set = (id, n) => { const el = document.querySelector(`[data-count="${id}"]`); if (el) { el.hidden = !n; el.textContent = n; } };
  set("leads", S.leads.filter((l) => l.claimedBy).length);
  set("users", S.users.length);
  set("locfix", S.locReqs.filter((r) => r.status === "pending").length);
}

function renderPage(animate) {
  const main = document.getElementById("main");
  if (!main) return;
  document.querySelectorAll("[data-page]").forEach((b) => b.classList.toggle("active", b.dataset.page === S.page));
  // Keep focus & scroll when live data refreshes the page.
  const active = document.activeElement;
  const focusKey = active?.dataset?.key;
  const caret = active?.selectionStart;
  const scroller = main.querySelector(".table-wrap");
  const scrollTop = scroller?.scrollTop || 0;
  const html = ({ activity: pageActivity, leads: pageLeads, forms: pageForms, users: pageUsers, outlets: pageOutlets, locfix: pageLocFix, settings: pageSettings }[S.page] || pageActivity)();
  main.innerHTML = `<div class="${animate ? "page" : ""}">${html}</div>`;
  bindPage();
  if (focusKey) {
    const el = main.querySelector(`[data-key="${focusKey}"]`);
    if (el) { el.focus(); try { if (caret != null) el.setSelectionRange(caret, caret); } catch {} }
  }
  const sc = main.querySelector(".table-wrap");
  if (sc) sc.scrollTop = scrollTop;
}

// ------------------------------------------------------------------ Activity page
// ---- journey stages -------------------------------------------------------
const STAGE_LABEL = { claimed: "Claimed", visit: "Visit", demo_booked: "Demo booked", demo: "Demo", sale: "Sale", lost: "Lost" };
// Demo booked: flag written by the app, or a "Demo booked?" answer of Yes on older entries.
function actBooked(a) {
  if (a.demoBooked === true) return true;
  if (a.demoBooked === false) return false;
  return (a.answers || []).some((x) => /demo\s*booked/i.test(x.label || "") && /^yes$/i.test(x.value || ""));
}
const isLostStatus = (s) => /(lost|not interested|rejected)/i.test(s || "");
function formStage(f) {
  if (!f) return "";
  if (f.stage === "none") return "";
  if (f.stage) return f.stage;
  const n = (f.name || "").toLowerCase();
  if (/sale|won/.test(n)) return "sale";
  if (/demo/.test(n)) return "demo";
  if (/visit/.test(n)) return "visit";
  if (/lost/.test(n)) return "lost";
  return "";
}
function actStage(a) {
  if (a.type === "claim" || a.type === "assign") return "claimed";
  if (a.type === "unclaim") return "";
  const fs = formStage(S.forms.find((f) => f.id === a.type) || { name: a.formName });
  // Older app versions saved "lost" instead of the step: a demo marked Not interested is still a demo done.
  if (a.stage === "lost") return fs && fs !== "lost" ? fs : "lost";
  if (a.stage) return a.stage;
  if (fs) return fs;
  if (isLostStatus(a.status)) return "lost";
  return "";
}
const actDate = (a) => toDate(a.createdAt) || (a.clientTime ? new Date(a.clientTime) : null);

// ---- date range ------------------------------------------------------------
const RANGES = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "Last 7 days"], ["month", "This month"], ["all", "All time"], ["custom", "Custom dates"]];
function rangeBounds() {
  const f = S.filters, d = new Date(), day = 864e5;
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const t0 = startOf(d);
  switch (f.range) {
    case "today": return [t0, new Date(t0.getTime() + day)];
    case "yesterday": return [new Date(t0.getTime() - day), t0];
    case "7d": return [new Date(t0.getTime() - 6 * day), new Date(t0.getTime() + day)];
    case "month": return [new Date(d.getFullYear(), d.getMonth(), 1), new Date(t0.getTime() + day)];
    case "custom": return [f.from ? new Date(f.from + "T00:00:00") : new Date(0), f.to ? new Date(new Date(f.to + "T00:00:00").getTime() + day) : new Date(8.64e15)];
    default: return [new Date(0), new Date(8.64e15)];
  }
}
function rangeLabel() {
  if (S.filters.range === "custom") return `${S.filters.from || "start"} → ${S.filters.to || "today"}`;
  return (RANGES.find((r) => r[0] === S.filters.range) || RANGES[0])[1];
}
const inRange = (a) => { const [lo, hi] = rangeBounds(); const d = actDate(a); return d && d >= lo && d < hi; };

function filteredActivities() {
  const f = S.filters;
  const q = f.q.trim().toLowerCase();
  return S.activities.filter((a) => {
    if (!inRange(a)) return false;
    if (f.rep && a.email !== f.rep) return false;
    if (f.type && a.formName !== f.type) return false;
    if (f.status && a.status !== f.status) return false;
    if (f.priority && a.priority !== f.priority) return false;
    if (q && !(`${a.resId} ${a.outletName} ${a.name} ${a.email}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

// ---- funnel numbers --------------------------------------------------------
// Counts: distinct outlets where the step happened inside the date range.
// Conversion %: of the outlets that reached a step in the range, how many went on to the next step (any time after).
function funnel(emailFilter) {
  const pr = S.filters.priority;
  const all = S.activities.filter((a) => (!emailFilter || a.email === emailFilter) && (!pr || a.priority === pr));
  const STEPS = ["claimed", "visit", "booked", "demo", "sale"];
  const firstAt = Object.fromEntries(STEPS.map((k) => [k, new Map()]));
  const inR = Object.fromEntries(STEPS.map((k) => [k, new Set()]));
  const mark = (st, key, t, inrange) => {
    const m = firstAt[st];
    if (!m.has(key) || t < m.get(key)) m.set(key, t);
    if (inrange) inR[st].add(key);
  };
  for (const a of all) {
    const key = a.email + "|" + a.resId;
    const t = actDate(a)?.getTime() || 0;
    const ir = inRange(a);
    const st = actStage(a);
    if (firstAt[st]) mark(st, key, t, ir);
    if (actBooked(a)) mark("booked", key, t, ir);
  }
  // A lead that reaches a later step without logging an earlier one has still passed it
  // (e.g. a demo done without a separate "demo booked"). Fill those skipped steps in, at the
  // time of the later step, so the counts and the percentages agree.
  for (const key of new Set(STEPS.flatMap((st) => [...firstAt[st].keys()]))) {
    for (let i = STEPS.length - 2; i >= 1; i--) {
      const st = STEPS[i];
      if (firstAt[st].has(key)) continue;
      const later = STEPS.slice(i + 1).filter((l) => firstAt[l].has(key));
      if (!later.length) continue;
      firstAt[st].set(key, Math.min(...later.map((l) => firstAt[l].get(key))));
      if (later.some((l) => inR[l].has(key))) inR[st].add(key);
    }
  }
  const reached = (key, to, after) => {
    const t = firstAt[to].get(key);
    return t != null && t >= after - 60e3;
  };
  const conv = (from, to) => {
    const base = [...inR[from]];
    if (!base.length) return null;
    const ok = base.filter((k) => reached(k, to, firstAt[from].get(k))).length;
    return Math.round((ok / base.length) * 100);
  };
  const outlets = (set) => new Set([...set].map((k) => k.split("|")[1])).size;
  return {
    claimed: outlets(inR.claimed), visit: outlets(inR.visit), booked: outlets(inR.booked), demo: outlets(inR.demo), sale: outlets(inR.sale),
    c2v: conv("claimed", "visit"), v2b: conv("visit", "booked"), b2d: conv("booked", "demo"), d2s: conv("demo", "sale"), c2s: conv("claimed", "sale"),
  };
}
const pct = (v) => (v == null ? "—" : v + "%");

function pageActivity() {
  const f = S.filters;
  const F = funnel("");
  const reps = [...new Set(S.activities.map((a) => a.email).filter(Boolean))].sort();
  const types = [...new Set(S.activities.map((a) => a.formName).filter(Boolean))].sort();
  const statuses = [...new Set(S.activities.map((a) => a.status).filter(Boolean))].sort();
  const opt = (arr, v) => arr.map((x) => `<option ${x === v ? "selected" : ""} value="${esc(x)}">${esc(x)}</option>`).join("");
  const tile = (n, label, color, i, hint = "") => `<div class="card stat" style="animation-delay:${i * 40}ms" ${hint ? `title="${esc(hint)}"` : ""}><b ${color ? `style="color:${color}"` : ""}>${n}</b><span>${label}</span></div>`;
  const summary = S.actView === "summary";

  return `
  <div class="head"><h1>Activity</h1>
    <select class="field" data-key="range" style="font-weight:700">${RANGES.map(([v, t]) => `<option value="${v}" ${f.range === v ? "selected" : ""}>${t}</option>`).join("")}</select>
    ${f.range === "custom" ? `<input type="date" class="field" data-key="from" value="${esc(f.from)}" title="From" /><span class="muted">to</span><input type="date" class="field" data-key="to" value="${esc(f.to)}" title="To" />` : ""}
    <select data-key="priority" class="field"><option value="">All priorities</option>${opt(["P1", "P2", "P3"], f.priority)}</select>
    <div class="spacer"></div>
    <button class="btn primary" id="${summary ? "export-sum" : "export-act"}">⬇ Download Excel</button></div>

  <div class="stats" style="grid-template-columns:repeat(5,1fr)">
    ${tile(F.claimed, "Claimed leads", "", 0)}
    ${tile(F.visit, "Visit done (outlets)", "", 1)}
    ${tile(F.booked, "Demo booked", "var(--p3)", 2)}
    ${tile(F.demo, "Demo done", "var(--purple)", 3)}
    ${tile(F.sale, "Sale done", "var(--green)", 4)}
  </div>
  <div class="stats" style="grid-template-columns:repeat(5,1fr)">
    ${tile(pct(F.c2v), "Claimed → visit", "var(--orange)", 5, "Of leads claimed in this period, how many got a visit")}
    ${tile(pct(F.v2b), "Visit → demo booked", "var(--orange)", 6, "Of leads visited in this period, how many got a demo booked")}
    ${tile(pct(F.b2d), "Demo booked → demo", "var(--orange)", 7, "Of demos booked in this period, how many were done")}
    ${tile(pct(F.d2s), "Demo → sale", "var(--orange)", 8, "Of leads demoed in this period, how many became a sale")}
    ${tile(pct(F.c2s), "Claimed → sale", "var(--green)", 9, "Of leads claimed in this period, how many became a sale")}
  </div>

  ${overdueBanner()}
  <div class="row" style="margin:6px 0 12px">
    <div class="seg">
      <button class="${summary ? "on" : ""}" data-view="summary">Employee-wise summary</button>
      <button class="${!summary ? "on" : ""}" data-view="log">Activity log</button>
    </div>
    <span class="muted">${esc(rangeLabel())}</span>
    ${summary ? `<div class="spacer"></div>
      <div class="seg">
        <button class="${S.who === "all" ? "on" : ""}" data-who="all">Everyone</button>
        <button class="${S.who === "reps" ? "on" : ""}" data-who="reps">Reps only</button>
        <button class="${S.who === "admins" ? "on" : ""}" data-who="admins">Admins only</button>
      </div>` : ""}
    ${!summary ? `<div class="spacer"></div>
      <input type="search" class="field" data-key="q" placeholder="Search Res ID, outlet, rep" value="${esc(f.q)}" />
      <select data-key="rep" class="field"><option value="">All reps</option>${opt(reps, f.rep)}</select>
      <select data-key="type" class="field"><option value="">All activity types</option>${opt(types, f.type)}</select>
      <select data-key="status" class="field"><option value="">All statuses</option>${opt(statuses, f.status)}</select>` : ""}
  </div>
  ${summary ? employeeTable() : activityLog()}`;
}

// ---- pending / overdue (current state, not limited by the date range) -------
function dueAt(v) {
  if (!v) return null;
  const d = new Date(v.length > 10 ? v.replace(" ", "T") : v + "T10:00:00");
  return isNaN(d) ? null : d.getTime();
}
function leadOpen(l) { return l.claimedBy && !leadExpired(l) && l.stage !== "sale" && l.stage !== "lost"; }
function demoDue(l) { return leadOpen(l) && l.stage === "demo_booked" && !l.demoAt ? dueAt(l.demoDate) : null; }
function followUpDue(l) {
  if (!leadOpen(l)) return null;
  const t = dueAt(l.nextFollowUp);
  if (t == null) return null;
  const last = toDate(l.lastActivityAt)?.getTime() || 0;
  return last < t ? t : null;
}
function pendingFor(email) {
  const now = Date.now();
  const mine = S.leads.filter((l) => !email || l.claimedByEmail === email);
  const fu = mine.map(followUpDue).filter((t) => t != null);
  const dm = mine.map(demoDue).filter((t) => t != null);
  return {
    fuPending: fu.filter((t) => t >= now).length, fuOverdue: fu.filter((t) => t < now).length,
    demoPending: dm.filter((t) => t >= now).length, demoOverdue: dm.filter((t) => t < now).length,
  };
}

function employeeRows() {
  // Everyone who has signed in to the app appears, even with no activity yet (all zeros).
  const known = new Map(S.users.map((u) => [u.email, u.name || u.email]));
  const emails = [...new Set([...S.users.map((u) => u.email), ...S.activities.map((a) => a.email)].filter(Boolean))]
    .filter((e) => !S.blocked.has(e) || S.activities.some((a) => a.email === e))
    .filter((e) => S.who === "all" || (S.who === "admins" ? isAdminEmail(e) : !isAdminEmail(e)));
  return emails.map((e) => ({ email: e, name: known.get(e) || S.activities.find((a) => a.email === e)?.name || e, ...funnel(e), ...pendingFor(e) }))
    .sort((a, b) => (b.claimed + b.visit + b.booked + b.demo + b.sale) - (a.claimed + a.visit + a.booked + a.demo + a.sale) || a.name.localeCompare(b.name));
}

const overdueCell = (n, email) => `<td style="text-align:right">${n ? `<button class="pill red flash" data-overdue-rep="${esc(email)}" title="Show these leads">${n}</button>` : `<span class="muted">0</span>`}</td>`;

function overdueBanner() {
  const p = pendingFor("");
  if (!p.fuOverdue && !p.demoOverdue) return "";
  return `<button class="alert flash-bg" data-overdue-rep="">
    <span class="dot"></span>
    <b>${p.demoOverdue} overdue demo${p.demoOverdue === 1 ? "" : "s"}</b> and <b>${p.fuOverdue} overdue follow-up${p.fuOverdue === 1 ? "" : "s"}</b> across the team
    <span class="muted" style="margin-left:auto">View leads →</span></button>`;
}

function employeeTable() {
  const rows = employeeRows();
  if (!rows.length) return `<div class="card"><div class="empty">No activity yet.</div></div>`;
  const cell = (v, strong) => `<td style="text-align:right">${v === 0 ? `<span class="muted">0</span>` : strong ? `<b>${v}</b>` : v}</td>`;
  const pc = (v) => `<td style="text-align:right">${v == null ? `<span class="muted">—</span>` : `<span class="pill ${v >= 60 ? "green" : v >= 30 ? "orange" : "red"}">${v}%</span>`}</td>`;
  return `<div class="card table-wrap"><table><thead><tr>
    <th>Employee</th><th style="text-align:right">Claimed</th><th style="text-align:right">Visits</th><th style="text-align:right">Demo booked</th><th style="text-align:right">Demos</th><th style="text-align:right">Sales</th>
    <th style="text-align:right" title="Follow-ups set and still to come">FU pending</th><th style="text-align:right" title="Follow-up time passed, nothing logged since">FU overdue</th>
    <th style="text-align:right" title="Demos booked for a time still to come">Demos upcoming</th><th style="text-align:right" title="Demo time passed, demo not logged">Demos overdue</th>
    <th style="text-align:right">Claim → visit</th><th style="text-align:right">Visit → booked</th><th style="text-align:right">Booked → demo</th><th style="text-align:right">Demo → sale</th><th style="text-align:right">Claim → sale</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td><b>${esc(r.name)}</b><div class="muted">${esc(r.email)}</div></td>
      ${cell(r.claimed, true)}${cell(r.visit, true)}${cell(r.booked, true)}${cell(r.demo, true)}${cell(r.sale, true)}
      ${cell(r.fuPending, true)}${overdueCell(r.fuOverdue, r.email)}${cell(r.demoPending, true)}${overdueCell(r.demoOverdue, r.email)}
      ${pc(r.c2v)}${pc(r.v2b)}${pc(r.b2d)}${pc(r.d2s)}${pc(r.c2s)}
      <td><button class="btn small" data-rep-log="${esc(r.email)}">View log</button></td></tr>`).join("")}
  </tbody></table></div>`;
}

function activityLog() {
  const list = filteredActivities();
  const radius = S.settings.claimRadiusMeters || 1000;
  return `<div class="card table-wrap">
    ${list.length ? `<table><thead><tr><th>When</th><th>Rep</th><th>Activity</th><th>Outlet</th><th>Status</th><th>Distance</th><th>Details</th></tr></thead><tbody>
    ${list.slice(0, 800).map((a) => {
      const d = actDate(a);
      const far = a.distanceM != null && a.distanceM > radius;
      const st = actStage(a);
      const ans = (a.answers || []).filter((x) => x.value).map((x) => `<div><b>${esc(x.label)}:</b> ${esc(x.value)}</div>`).join("");
      return `<tr>
        <td>${fmtDT(d)}</td>
        <td><b>${esc(a.name || a.email)}</b><div class="muted">${esc(a.email)}</div></td>
        <td>${esc(a.formName || a.type)}${st && st !== "claimed" ? `<div class="muted">${esc(STAGE_LABEL[st] || st)} step</div>` : ""}${actBooked(a) ? `<div><span class="pill" style="background:#e7f5ff;color:var(--p3)">Demo booked${a.demoDate ? " · " + esc(prettyDT(a.demoDate)) : ""}</span></div>` : ""}</td>
        <td>${prio(a.priority)} <b>${esc(a.resId)}</b><div class="muted">${esc(a.outletName)}</div></td>
        <td>${statusPill(a.status)}${a.geoSkipped ? `<div><span class="pill orange" title="An admin turned the location check off for this lead">Location check skipped</span></div>` : ""}</td>
        <td>${a.mock ? `<span class="pill red">Fake GPS</span>` : far ? `<span class="pill red">${km(a.distanceM)}</span>` : `<span class="muted">${km(a.distanceM)}</span>`}</td>
        <td class="answers">${ans || `<span class="muted">—</span>`}</td></tr>`;
    }).join("")}</tbody></table>
    ${list.length > 800 ? `<div class="empty">Showing the latest 800 here. The Excel download has all ${list.length}.</div>` : ""}`
    : `<div class="empty">No activity for ${esc(rangeLabel().toLowerCase())}${S.filters.rep || S.filters.type || S.filters.status || S.filters.q ? " with these filters" : ""}.</div>`}
  </div>`;
}

function exportSummary() {
  const rows = employeeRows().map((r) => ({
    "Employee": r.name, "Email": r.email, "Claimed": r.claimed, "Visits": r.visit, "Demo booked": r.booked, "Demos": r.demo, "Sales": r.sale,
    "Claim → visit %": r.c2v ?? "", "Visit → demo booked %": r.v2b ?? "", "Demo booked → demo %": r.b2d ?? "", "Demo → sale %": r.d2s ?? "", "Claim → sale %": r.c2s ?? "",
  }));
  const F = funnel("");
  rows.push({ "Employee": "TOTAL", "Email": rangeLabel(), "Claimed": F.claimed, "Visits": F.visit, "Demo booked": F.booked, "Demos": F.demo, "Sales": F.sale,
    "Claim → visit %": F.c2v ?? "", "Visit → demo booked %": F.v2b ?? "", "Demo booked → demo %": F.b2d ?? "", "Demo → sale %": F.d2s ?? "", "Claim → sale %": F.c2s ?? "" });
  downloadXlsx(rows, "Employee summary", `upsell-summary-${ymd(new Date())}.xlsx`);
}

function exportActivities() {
  const list = filteredActivities();
  const labels = [];
  list.forEach((a) => (a.answers || []).forEach((x) => { if (!labels.includes(x.label)) labels.push(x.label); }));
  const rows = list.map((a) => {
    const d = toDate(a.createdAt) || (a.clientTime ? new Date(a.clientTime) : null);
    const r = {
      "Date": d ? d.toLocaleDateString("en-IN") : "", "Time": d ? d.toLocaleTimeString("en-IN") : "",
      "Rep name": a.name || "", "Rep email": a.email || "", "Activity": a.formName || a.type || "", "Journey step": STAGE_LABEL[actStage(a)] || "",
      "Res ID": a.resId || "", "Outlet": a.outletName || "", "Priority": a.priority || "", "Lead status": a.status || "",
      "Next follow-up": prettyDT(a.nextFollowUp || ""), "Demo booked": actBooked(a) ? "Yes" : a.demoBooked === false ? "No" : "", "Demo date": prettyDT(a.demoDate || ""), "Lost": a.lost || isLostStatus(a.status) ? "Yes" : "",
      "Distance from outlet (m)": a.distanceM != null ? Math.round(a.distanceM) : "",
      "Fake GPS": a.mock ? "Yes" : "", "Latitude": a.lat ?? "", "Longitude": a.lng ?? "", "App version": a.appVersion || "",
    };
    labels.forEach((l) => { r[l] = (a.answers || []).find((x) => x.label === l)?.value || ""; });
    return r;
  });
  downloadXlsx(rows, "Activity", `upsell-activity-${ymd(new Date())}.xlsx`);
}

async function downloadXlsx(rows, sheet, file) {
  if (!rows.length) return toast("Nothing to download", true);
  try {
    const XLSX = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = Object.keys(rows[0]).map((k) => ({ wch: Math.min(48, Math.max(10, k.length + 2, ...rows.slice(0, 200).map((r) => String(r[k] ?? "").length))) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheet);
    XLSX.writeFile(wb, file);
  } catch (e) {
    // Fallback: CSV (opens in Excel)
    const keys = Object.keys(rows[0]);
    const csv = [keys, ...rows.map((r) => keys.map((k) => r[k]))]
      .map((line) => line.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    a.download = file.replace(".xlsx", ".csv");
    a.click();
  }
}

// ------------------------------------------------------------------ Leads page
function filteredLeads() {
  const f = S.leadFilters;
  const q = f.q.trim().toLowerCase();
  return S.leads.filter((l) => {
    if (f.rep === "__none") { if (l.claimedBy) return false; }
    else if (f.rep && l.claimedByEmail !== f.rep) return false;
    if (f.status && (l.status || "") !== f.status) return false;
    if (f.due) {
      const now = Date.now(), d = demoDue(l), u = followUpDue(l);
      const od = (d != null && d < now) || (u != null && u < now);
      if (f.due === "overdue" && !od) return false;
      if (f.due === "pending" && !((d != null && d >= now) || (u != null && u >= now))) return false;
    }
    const o = S.outlets.get(l.resId);
    if (q && !(`${l.resId} ${l.outletName || o?.name || ""} ${l.claimedByName || ""}`.toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => (toDate(b.lastActivityAt)?.getTime() || 0) - (toDate(a.lastActivityAt)?.getTime() || 0));
}

function pageLeads() {
  const list = filteredLeads();
  const reps = [...new Set(S.leads.map((l) => l.claimedByEmail).filter(Boolean))].sort();
  const statuses = [...new Set(S.leads.map((l) => l.status).filter(Boolean))].sort();
  const f = S.leadFilters;
  const today = ymd(new Date());
  const opt = (arr, v) => arr.map((x) => `<option ${x === v ? "selected" : ""} value="${esc(x)}">${esc(x)}</option>`).join("");
  return `
  <div class="head"><h1>Leads & claims</h1><span class="sub">${S.leads.filter((l) => l.claimedBy && !leadExpired(l)).length} active claims · ${S.leads.filter(leadExpired).length} expired · ${S.outlets.size || "…"} outlets</span>
    <div class="spacer"></div>
    <button class="btn" id="assign-new">+ Assign a lead</button>
    <button class="btn primary" id="export-leads">⬇ Download Excel (${list.length})</button></div>
  <div class="filters">
    <input type="search" class="field" data-lkey="q" data-key="lq" placeholder="Search Res ID, outlet, rep" value="${esc(f.q)}" />
    <select data-lkey="rep"><option value="">All reps</option><option value="__none" ${f.rep === "__none" ? "selected" : ""}>Unclaimed (released)</option>${opt(reps, f.rep)}</select>
    <select data-lkey="status"><option value="">All statuses</option>${opt(statuses, f.status)}</select>
    <select data-lkey="due"><option value="">Any follow-up / demo</option><option value="overdue" ${f.due === "overdue" ? "selected" : ""}>Overdue only</option><option value="pending" ${f.due === "pending" ? "selected" : ""}>Upcoming only</option></select>
  </div>
  <div class="card table-wrap">
  ${list.length ? `<table><thead><tr><th>Outlet</th><th>Claimed by</th><th>Stage</th><th>Status</th><th>Last activity</th><th>Next follow-up</th><th>Updates</th><th></th></tr></thead><tbody>
  ${list.map((l) => {
    const o = S.outlets.get(l.resId);
    const fu = l.nextFollowUp || "";
    return `<tr>
      <td>${prio(l.priority || o?.priority)} <b>${esc(l.resId)}</b><div class="muted">${esc(l.outletName || o?.name)}</div></td>
      <td>${l.claimedBy ? `<b>${esc(l.claimedByName)}</b><div class="muted">${esc(l.claimedByEmail)} · ${fmtD(toDate(l.claimedAt))}${l.claimDistanceM != null ? " · " + km(l.claimDistanceM) : ""}</div>` : `<span class="pill soft">Unclaimed</span>`}</td>
      <td>${stageCell(l)}</td>
      <td>${statusPill(l.status)}</td>
      <td>${esc(l.lastActivityType || "—")}<div class="muted">${fmtDT(toDate(l.lastActivityAt))}</div></td>
      <td>${fu ? (() => { const t = followUpDue(l); const late = t != null && t < Date.now();
        return `<span class="pill ${late ? "red flash" : fu.slice(0, 10) === today ? "orange" : "soft"}">${late ? "Overdue · " : ""}${esc(prettyDT(fu))}</span>`; })() : `<span class="muted">—</span>`}</td>
      <td>${l.activityCount || 0}</td>
      <td><div class="actions"><button class="btn small" data-reassign="${esc(l.resId)}">Reassign</button>
        ${l.claimedBy ? `<button class="btn small danger" data-unclaim="${esc(l.resId)}">Unclaim</button>` : ""}
        <button class="btn small ${l.skipGeo ? "danger" : ""}" data-skipgeo="${esc(l.resId)}" title="${l.skipGeo ? "Visits and demos on this lead can be logged from anywhere. Click to turn the location check back on." : "Let visits and demos on this lead be logged from anywhere"}">${l.skipGeo ? "📍 Location check OFF" : "📍 Skip location check"}</button></div></td></tr>`;
  }).join("")}</tbody></table>` : `<div class="empty">No claimed leads yet. Reps claim leads in the app when they're within ${km(S.settings.claimRadiusMeters || 1000)} of the outlet.</div>`}
  </div>`;
}

function leadExpired(l) { const d = toDate(l.deadline); return !!(l.claimedBy && d && d.getTime() < Date.now()); }
function remaining(ms) {
  const m = Math.max(0, Math.floor(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor(m / 60) % 24;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m % 60}m`;
}
function stageCell(l) {
  if (!l.claimedBy) return `<span class="muted">—</span>`;
  const st = l.stage || "claimed";
  const label = STAGE_LABEL[st] || st;
  const cls = st === "sale" ? "green" : st === "lost" ? "red" : st === "demo" ? "purple" : "soft";
  const d = toDate(l.deadline);
  const next = st === "claimed" ? "Visit" : (st === "visit" || st === "demo_booked") ? "Demo" : "";
  const dd = demoDue(l);
  const booked = st === "demo_booked" && l.demoDate
    ? (dd != null && dd < Date.now() ? `<div><span class="pill red flash">Demo overdue · ${esc(prettyDT(l.demoDate))}</span></div>` : `<div class="muted">Demo on ${esc(prettyDT(l.demoDate))}</div>`)
    : "";
  let dl = "";
  if (d && leadExpired(l)) dl = `<div><span class="pill red">Expired: ${next || "deadline"} missed</span></div>`;
  else if (d) dl = `<div class="muted">${next} due in ${remaining(d.getTime() - Date.now())}</div>`;
  return `<span class="pill ${cls}">${esc(label)}</span>${booked}${dl}`;
}

async function pickRep(title, body) {
  const reps = S.users.filter((u) => !S.blocked.has(u.email)).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  if (!reps.length) { toast("No users have signed in yet", true); return null; }
  const email = await modal({
    title, body, confirm: "Assign",
    html: `<select class="field" data-value>${reps.map((u) => `<option value="${esc(u.email)}">${esc(u.name || u.email)} · ${esc(u.email)}</option>`).join("")}</select>`,
  });
  return email ? reps.find((u) => u.email === email) : null;
}

async function assignLead(resId, rep) {
  const o = S.outlets.get(resId);
  const batch = writeBatch(db);
  batch.set(doc(db, "leads", resId), {
    resId, outletName: o?.name || "", priority: o?.priority || "",
    claimedBy: rep.uid, claimedByEmail: rep.email, claimedByName: rep.name || rep.email,
    claimedAt: serverTimestamp(), claimDistanceM: null, assignedBy: S.user.email,
    lastActivityType: "Assigned by admin", lastActivityAt: serverTimestamp(),
    stage: "claimed", deadline: visitDeadline(),
    visitAt: null, demoAt: null, saleAt: null, lostAt: null, demoBookedAt: null, demoDate: "",
  }, { merge: true });
  batch.set(doc(collection(db, "activities")), {
    resId, outletName: o?.name || "", priority: o?.priority || "", type: "assign", formName: "Assigned by admin",
    status: S.leads.find((l) => l.resId === resId)?.status || "", uid: rep.uid, email: rep.email, name: rep.name || rep.email,
    by: S.user.email, createdAt: serverTimestamp(), clientTime: Date.now(), answers: [],
  });
  await batch.commit();
}

async function unclaimLead(resId) {
  const l = S.leads.find((x) => x.resId === resId);
  const batch = writeBatch(db);
  batch.update(doc(db, "leads", resId), {
    claimedBy: null, claimedByEmail: "", claimedByName: "", claimedAt: null, deadline: null,
    lastActivityType: "Released by admin", lastActivityAt: serverTimestamp(),
  });
  batch.set(doc(collection(db, "activities")), {
    resId, outletName: l?.outletName || "", priority: l?.priority || "", type: "unclaim", formName: "Released by admin",
    status: l?.status || "", uid: l?.claimedBy || "", email: l?.claimedByEmail || "", name: l?.claimedByName || "",
    by: S.user.email, createdAt: serverTimestamp(), clientTime: Date.now(), answers: [],
  });
  await batch.commit();
}

function exportLeads() {
  const rows = filteredLeads().map((l) => {
    const o = S.outlets.get(l.resId);
    return {
      "Res ID": l.resId, "Outlet": l.outletName || o?.name || "", "Priority": l.priority || o?.priority || "",
      "Outlet size": o?.size || "", "Area": o?.area || "",
      "Claimed by": l.claimedByName || "", "Claimed by email": l.claimedByEmail || "",
      "Claimed on": toDate(l.claimedAt)?.toLocaleString("en-IN") || "",
      "Claim distance (m)": l.claimDistanceM != null ? Math.round(l.claimDistanceM) : "",
      "Stage": l.claimedBy ? (STAGE_LABEL[l.stage || "claimed"] || l.stage) : "", "Claim expired": leadExpired(l) ? "Yes" : "",
      "Deadline": toDate(l.deadline)?.toLocaleString("en-IN") || "", "Demo date": prettyDT(l.demoDate || ""),
      "Lead status": l.status || "", "Last activity": l.lastActivityType || "",
      "Last activity at": toDate(l.lastActivityAt)?.toLocaleString("en-IN") || "",
      "Next follow-up": prettyDT(l.nextFollowUp || ""), "Updates": l.activityCount || 0,
    };
  });
  downloadXlsx(rows, "Leads", `upsell-leads-${ymd(new Date())}.xlsx`);
}

// ------------------------------------------------------------------ Forms page
const TYPES = [
  ["text", "Short text"], ["longtext", "Long text"], ["number", "Number"], ["dropdown", "Dropdown (pick one)"],
  ["multiselect", "Multi-select"], ["date", "Date"], ["yesno", "Yes / No"],
];
const PRODUCTS = ["Scale", "Growth", "Marketing Automation", "KDS", "Tally", "Payroll", "Purchase", "Payment integration", "WCD", "Captain", "TRM", "Kiosk", "Token Mgmt", "Z/S Reco", "Finance.petpooja", "WABA", "Scan & Order"];
const STATUSES = ["Interested", "Follow-up needed", "Demo scheduled", "Demo done", "Negotiation", "Won", "Not interested", "Lost"];

function defaultForms() {
  const f = (label, type, extra = {}) => ({ id: slug(label), label, type, required: false, options: [], help: "", role: "", ...extra });
  return [
    { id: "visit", name: "Visit", stage: "visit", order: 1, statusOptions: STATUSES, fields: [
      f("Met with", "dropdown", { options: ["Owner", "Manager", "Staff"], required: true }),
      f("Products pitched", "multiselect", { options: PRODUCTS, required: true }),
      f("Customer response", "dropdown", { options: ["Positive", "Neutral", "Negative"] }),
      ...demoBookingFields(),
      f("Next follow-up date", "date", { role: "followup" }),
      f("Remarks", "longtext"),
    ] },
    { id: "demo", name: "Demo", stage: "demo", order: 2, statusOptions: STATUSES, fields: [
      f("Products demoed", "multiselect", { options: PRODUCTS, required: true }),
      f("Attended by", "text"),
      f("Demo outcome", "dropdown", { options: ["Liked it, wants to buy", "Needs time", "Not convinced"] }),
      f("Next follow-up date", "date", { role: "followup" }),
      f("Remarks", "longtext"),
    ] },
    { id: "followup", name: "Follow-up", stage: "none", order: 3, statusOptions: STATUSES, fields: [
      f("Mode", "dropdown", { options: ["Visit", "Call", "WhatsApp"], required: true }),
      f("Products discussed", "multiselect", { options: PRODUCTS }),
      f("Next follow-up date", "date", { role: "followup" }),
      f("Remarks", "longtext", { required: true }),
    ] },
    { id: "sale_done", name: "Sale done", stage: "sale", order: 4, statusOptions: ["Won"], fields: [
      f("Products sold", "multiselect", { options: PRODUCTS, required: true }),
      f("Deal value (₹)", "number", { required: true }),
      f("Order / invoice reference", "text"),
      f("Remarks", "longtext"),
    ] },
  ];
}

function pageForms() {
  if (!S.forms.length && !S.draft) {
    return `<div class="head"><h1>Forms</h1><span class="sub">What reps fill in when they update a lead</span></div>
      <div class="card editor" style="text-align:center;padding:40px">
        <h2>No forms yet</h2><p class="muted" style="margin:6px 0 20px">Start with ready-made Visit, Demo, Follow-up and Sale done forms, then edit them to fit your process.</p>
        <button class="btn primary" id="seed-forms">Create default forms</button>
        <button class="btn" id="new-form" style="margin-left:6px">Start from blank</button>
      </div>`;
  }
  if (!S.draft || (!S.draft._new && !S.forms.some((f) => f.id === S.editingFormId))) {
    const cur = S.forms.find((f) => f.id === S.editingFormId) || S.forms[0];
    if (cur) { S.editingFormId = cur.id; S.draft = structuredClone(cur); }
  }
  const d = S.draft;
  return `
  <div class="head"><h1>Forms</h1><span class="sub">One form per activity type. Changes reach every phone instantly when you publish.</span></div>
  <div class="builder">
    <div class="card form-list">
      ${S.forms.map((f) => `<button class="form-item ${f.id === S.editingFormId ? "active" : ""}" data-form="${esc(f.id)}">
        <div style="flex:1"><b>${esc(f.name)}</b><div class="muted">${(f.fields || []).length} fields · v${f.version || 1}</div></div>
        ${f.active === false ? `<span class="pill soft">Hidden</span>` : ""}</button>`).join("")}
      ${d?._new ? `<button class="form-item active"><b>${esc(d.name || "New form")}</b></button>` : ""}
      <button class="btn small" id="new-form" style="margin:8px">+ New activity type</button>
    </div>
    <div class="card editor">
      <div class="row">
        <input class="field" data-key="fname" data-draft="name" value="${esc(d.name)}" placeholder="Activity name, e.g. Visit" style="font-size:18px;font-weight:700;flex:1;min-width:200px" />
        <label class="check"><input type="checkbox" data-draft-bool="active" ${d.active !== false ? "checked" : ""}/> Show in app</label>
        <input class="field" type="number" data-key="forder" data-draft-num="order" value="${esc(d.order ?? 0)}" title="Order in app" style="width:80px" />
      </div>

      <span class="label">Journey step this form records</span>
      <div class="row">
        <select class="field" data-draft-stage>${[["", "Auto (from the name)"], ["visit", "Visit"], ["demo", "Demo"], ["sale", "Sale"], ["lost", "Lost"], ["none", "None (e.g. follow-up)"]]
          .map(([v, t]) => `<option value="${v}" ${(d.stage || "") === v ? "selected" : ""}>${t}</option>`).join("")}</select>
        <span class="muted">Now counts as: <b>${esc(STAGE_LABEL[formStage(d)] || "no step")}</b>. Visit starts the 5-day demo deadline; Demo, Sale and Lost clear it.</span>
      </div>

      <span class="label">Lead status options</span>
      <div class="chips">${(d.statusOptions || []).map((s, i) => `<span class="chip">${esc(s)}<button data-del-status="${i}" title="Remove">×</button></span>`).join("")}
        <input class="chip-input" data-key="status-input" placeholder="Type a status and press Enter" /></div>
      <label class="check" style="margin-top:10px"><input type="checkbox" data-draft-bool="statusRequired" ${d.statusRequired !== false ? "checked" : ""}/> Status is required</label>

      <span class="label">Fields</span>
      <div class="fields">
        ${(d.fields || []).map((fl, i) => `<div class="fcard">
          <div class="row" style="margin-bottom:10px">
            <b style="color:var(--ink-soft)">${i + 1}.</b>
            <div class="tools">
              <button class="icon-btn" data-move="${i}:-1" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
              <button class="icon-btn" data-move="${i}:1" title="Move down" ${i === d.fields.length - 1 ? "disabled" : ""}>↓</button>
              <button class="icon-btn" data-del-field="${i}" title="Delete" style="color:var(--p1)">✕</button>
            </div>
          </div>
          <div class="grid">
            <input class="field" data-key="fl-${i}-label" data-fl="${i}:label" value="${esc(fl.label)}" placeholder="Question / label" />
            <select class="field" data-fl="${i}:type">${TYPES.map(([v, t]) => `<option value="${v}" ${fl.type === v ? "selected" : ""}>${t}</option>`).join("")}</select>
          </div>
          ${["dropdown", "multiselect"].includes(fl.type) ? `<div style="margin-top:10px"><textarea class="field" data-key="fl-${i}-opts" data-fl="${i}:options" placeholder="One option per line">${esc((fl.options || []).join("\n"))}</textarea></div>` : ""}
          <div class="row" style="margin-top:10px">
            <input class="field" data-key="fl-${i}-help" data-fl="${i}:help" value="${esc(fl.help || "")}" placeholder="Help text (optional)" style="flex:1;min-width:180px" />
            <label class="check"><input type="checkbox" data-fl-bool="${i}:required" ${fl.required ? "checked" : ""}/> Required</label>
          </div>
          ${roleRow(fl, i)}
          ${condRow(d, fl, i)}
        </div>`).join("")}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="add-field">+ Add field</button>
        ${!(d.fields || []).some((f) => f.role === "demo_booked") ? `<button class="btn" id="add-demo-fields" title="Adds: Demo booked? (Yes/No) → Demo date if Yes, Reason if No">+ Add "Demo booked?" fields</button>` : ""}
      </div>

      <div class="savebar">
        <button class="btn primary" id="publish-form">Publish to app</button>
        ${!d._new ? `<button class="btn" id="discard-form">Discard changes</button>` : ""}
        <div class="spacer"></div>
        ${!d._new ? `<button class="btn danger" id="delete-form">Delete form</button>` : ""}
      </div>
    </div>
  </div>`;
}

const ROLES = {
  date: [["", "Normal date"], ["followup", "Next follow-up date"], ["demo_date", "Demo date (for Demo booked)"]],
  yesno: [["", "Normal yes/no"], ["demo_booked", "Demo booked? (Yes moves lead to Demo booked)"]],
};
function roleRow(fl, i) {
  const opts = ROLES[fl.type];
  if (!opts) return "";
  return `<div class="row" style="margin-top:10px"><span class="muted" style="min-width:110px">Special meaning</span>
    <select class="field" data-fl-role="${i}">${opts.map(([v, t]) => `<option value="${v}" ${(fl.role || "") === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>`;
}
function condRow(d, fl, i) {
  const parents = (d.fields || []).slice(0, i).filter((p) => ["yesno", "dropdown", "multiselect"].includes(p.type) && p.label);
  const hasStatus = (d.statusOptions || []).length > 0;
  if (!parents.length && !hasStatus && !fl.showIf) return "";
  const onStatus = fl.showIf?.field === "__status";
  const parent = onStatus ? null : (d.fields || []).find((p) => p.id && p.id === fl.showIf?.field);
  const values = onStatus ? (d.statusOptions || [])
    : parent ? (parent.type === "yesno" ? ["Yes", "No"] : (parent.options || []).map((o) => o.trim()).filter(Boolean)) : [];
  return `<div class="row cond" style="margin-top:10px"><span class="muted" style="min-width:110px">Show</span>
    <select class="field" data-fl-cond="${i}">
      <option value="">Always</option>
      ${hasStatus ? `<option value="__status" ${onStatus ? "selected" : ""}>Only when Lead status is…</option>` : ""}
      ${parents.map((p) => `<option value="${esc(p.id)}" ${fl.showIf?.field === p.id ? "selected" : ""}>Only when "${esc(p.label)}" is…</option>`).join("")}
    </select>
    ${(parent || onStatus) ? `<select class="field" data-fl-condv="${i}">${values.map((v) => `<option ${fl.showIf?.equals === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>` : ""}
  </div>`;
}
const newFieldId = () => "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
function demoBookingFields() {
  const booked = { id: newFieldId(), label: "Demo booked?", type: "yesno", required: true, options: [], help: "", role: "demo_booked" };
  return [
    booked,
    { id: newFieldId() + "d", label: "Demo date", type: "date", required: true, options: [], help: "", role: "demo_date", showIf: { field: booked.id, equals: "Yes" } },
    { id: newFieldId() + "r", label: "Reason demo not booked", type: "longtext", required: true, options: [], help: "", role: "", showIf: { field: booked.id, equals: "No" } },
  ];
}

async function publishForm() {
  const d = S.draft;
  if (!d.name?.trim()) return toast("Give the form a name", true);
  const fields = (d.fields || []).filter((f) => f.label?.trim()).map((f, i) => ({
    id: f.id || slug(f.label) + "_" + i, label: f.label.trim(), type: f.type || "text", required: !!f.required,
    options: (f.options || []).map((o) => o.trim()).filter(Boolean), help: f.help || "", role: f.role || "",
    ...(f.showIf?.field ? { showIf: { field: f.showIf.field, equals: f.showIf.equals || "" } } : {}),
  }));
  // A condition must point at an earlier field that still exists.
  const ids = new Set([...fields.map((f) => f.id), "__status"]);
  fields.forEach((f) => { if (f.showIf && !ids.has(f.showIf.field)) delete f.showIf; });
  const bad = fields.find((f) => ["dropdown", "multiselect"].includes(f.type) && !f.options.length);
  if (bad) return toast(`"${bad.label}" needs at least one option`, true);
  const id = d._new ? slug(d.name) : d.id;
  if (d._new && S.forms.some((f) => f.id === id)) return toast("A form with this name already exists", true);
  const prev = S.forms.find((f) => f.id === id);
  await run(async () => {
    await setDoc(doc(db, "forms", id), {
      name: d.name.trim(), order: Number(d.order) || 0, active: d.active !== false,
      statusOptions: d.statusOptions || [], statusRequired: d.statusRequired !== false, fields, stage: d.stage || "",
      version: (prev?.version || 0) + 1, updatedAt: serverTimestamp(), updatedBy: S.user.email,
    });
    S.editingFormId = id; S.draft = null;
  }, "Published. Reps will see it right away.");
}

// ------------------------------------------------------------------ Users page
function pageUsers() {
  const dayAgo = Date.now() - 864e5;
  const active = S.users.filter((u) => (toDate(u.lastLogin)?.getTime() || 0) >= dayAgo).length;
  const known = new Set(S.users.map((u) => u.email));
  const extraBlocked = [...S.blocked].filter((e) => !known.has(e));
  const extraAdmins = [...S.roles].filter((e) => !known.has(e));
  return `
  <div class="head"><h1>Users & roles</h1><span class="sub">${S.isSuper ? "You're the super admin: you can make and remove admins." : "Only the super admin can change admin roles."}</span>
    <div class="spacer"></div>${S.isSuper ? `<button class="btn" id="add-admin">+ Add admin by email</button>` : ""}
    <button class="btn primary" id="export-users">⬇ Download Excel</button></div>
  <div class="stats">
    <div class="card stat"><b>${S.users.length}</b><span>Signed up</span></div>
    <div class="card stat"><b style="color:var(--green)">${active}</b><span>Active last 24h</span></div>
    <div class="card stat"><b>${S.roles.size + 1}</b><span>Admins</span></div>
    <div class="card stat"><b style="color:var(--p1)">${S.blocked.size}</b><span>Blocked</span></div>
  </div>
  <div class="card table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Leads</th><th>Joined</th><th>Last active</th><th>App</th><th></th></tr></thead><tbody>
  ${S.users.map((u) => {
    const sup = u.email === SUPER_ADMIN, adm = S.roles.has(u.email), blk = S.blocked.has(u.email);
    const leads = S.leads.filter((l) => l.claimedBy === u.uid).length;
    return `<tr>
      <td><b>${esc(u.name || u.email)}</b><div class="muted">${esc(u.email)}</div></td>
      <td>${sup ? `<span class="pill orange">Super admin</span>` : adm ? `<span class="pill purple">Admin</span>` : `<span class="pill soft">Rep</span>`}
          ${blk ? ` <span class="pill red">Blocked</span>` : ""}</td>
      <td>${leads}</td><td>${fmtD(toDate(u.firstLogin))}</td><td>${fmtDT(toDate(u.lastLogin))}</td><td class="muted">${esc(u.appVersion || "")}</td>
      <td style="white-space:nowrap">${sup ? "" : `
        ${S.isSuper ? (adm ? `<button class="btn small" data-unadmin="${esc(u.email)}">Remove admin</button>` : `<button class="btn small" data-admin="${esc(u.email)}">Make admin</button>`) : ""}
        ${blk ? `<button class="btn small" data-unblock="${esc(u.email)}">Unblock</button>` : `<button class="btn small danger" data-block="${esc(u.email)}">Block</button>`}
        <button class="btn small danger" data-remove="${esc(u.uid)}" data-email="${esc(u.email)}">Remove</button>`}</td></tr>`;
  }).join("")}
  ${extraAdmins.map((e) => `<tr><td><b>${esc(e)}</b><div class="muted">Hasn't signed in yet</div></td><td><span class="pill purple">Admin</span></td><td>—</td><td>—</td><td>—</td><td></td>
      <td>${S.isSuper ? `<button class="btn small" data-unadmin="${esc(e)}">Remove admin</button>` : ""}</td></tr>`).join("")}
  ${extraBlocked.map((e) => `<tr><td><b>${esc(e)}</b><div class="muted">Removed from list</div></td><td><span class="pill red">Blocked</span></td><td>—</td><td>—</td><td>—</td><td></td>
      <td><button class="btn small" data-unblock="${esc(e)}">Unblock</button></td></tr>`).join("")}
  </tbody></table></div>`;
}

// ------------------------------------------------------------------ Settings page
const visitHours = () => Number(S.settings.visitWindowHours) || 24;
const visitEod = () => (S.settings.visitDeadlineMode || "eod") !== "hours";
/** Same rule as the app: end of today (if "same day"), otherwise now + N hours. */
function visitDeadline() {
  if (!visitEod()) return new Date(Date.now() + visitHours() * 3600e3);
  const d = new Date(); d.setHours(23, 59, 59, 0); return d;
}
const demoDays = () => Number(S.settings.demoWindowDays) || 5;
/** "2026-11-18 15:30" → "18 Nov, 3:30 pm"; plain dates → "18 Nov 2026" */
function prettyDT(v) {
  if (!v) return "";
  const d = new Date(v.length > 10 ? v.replace(" ", "T") : v + "T00:00:00");
  if (isNaN(d)) return v;
  return v.length > 10
    ? d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function emailReportCard() {
  const r = S.emailReport || {};
  const recips = r.recipients || [];
  const times = (r.times || []).slice().sort();
  const lastSent = r.lastSentAt ? `Last sent ${fmtDT(toDate(r.lastSentAt))}${r.lastSlot ? " (" + esc(r.lastSlot) + " slot)" : ""}.` : "Not sent yet.";
  return `<div class="card editor" style="max-width:680px;margin-top:16px">
    <div class="row"><h2 style="margin:0">Daily summary email</h2><div class="spacer"></div>
      <label class="check"><input type="checkbox" id="er-enabled" ${r.enabled !== false && recips.length ? "checked" : ""}/> On</label></div>
    <p class="muted" style="margin:6px 0 0">Sent from <b>${esc(SUPER_ADMIN)}</b> at each time below: today's claims, visits, demos booked, demos and sales so far, plus each employee's numbers and their overdue follow-ups and demos.</p>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="er-loc" ${r.locationAlerts !== false ? "checked" : ""}/> Also email these people when a rep reports a wrong pin (within 5 minutes)</label>

    <span class="label">Send to</span>
    <div class="chips">${recips.map((e, i) => `<span class="chip">${esc(e)}<button data-er-del-r="${i}" title="Remove">×</button></span>`).join("")}
      <input class="chip-input" id="er-add-r" placeholder="Type an email and press Enter" /></div>

    <span class="label">Send at (India time)</span>
    <div class="chips">${times.map((t, i) => `<span class="chip">${esc(t)}<button data-er-del-t="${esc(t)}" title="Remove">×</button></span>`).join("")}
      <input type="time" class="chip-input" id="er-add-t" style="min-width:120px" /><button class="btn small" id="er-add-t-btn">+ Add time</button></div>

    <div class="row" style="margin-top:16px"><button class="btn" id="er-test">Send a test email now</button>
      <span class="muted">${r.testRequestedAt && !r.testSentAt ? "Test requested: it arrives within 5 minutes." : lastSent}</span></div>
    ${!r.scriptSeenAt ? `<div class="notice" style="margin-top:14px">The email sender isn't set up yet. It needs a one-time Apps Script setup on ${esc(SUPER_ADMIN)}'s account (see the instructions shared in chat). Until then, nothing is sent.</div>`
      : `<p class="muted" style="margin:10px 0 0">Email sender last checked in ${fmtDT(toDate(r.scriptSeenAt))}.</p>`}
  </div>`;
}

function pageSettings() {
  const r = S.settings.claimRadiusMeters || 1000;
  return `
  <div class="head"><h1>Settings</h1><span class="sub">Changes reach every phone within seconds.</span></div>
  <div class="card editor" style="max-width:680px">
    <span class="label" style="margin-top:0">Claim distance</span>
    <p class="muted" style="margin:0 0 10px">How close a rep must be to an outlet to claim it.</p>
    <div class="row"><input class="field" type="number" min="50" step="50" id="radius" value="${esc(r)}" style="width:140px" /> metres
      <button class="btn primary" id="save-radius">Save</button></div>

    <span class="label">Visit &amp; demo distance (geo-tagging)</span>
    <p class="muted" style="margin:0 0 10px">A Visit or Demo done can only be logged when the rep is this close to the outlet.</p>
    <div class="row"><input class="field" type="number" min="50" step="50" id="act-radius" value="${esc(S.settings.activityRadiusMeters || 1000)}" style="width:140px" /> metres
      <button class="btn primary" id="save-act-radius">Save</button></div>

    <span class="label">Deadline to log a visit after claiming</span>
    <p class="muted" style="margin:0 0 10px">If no visit is logged in time, the claim expires and the lead opens up on the map for everyone again.</p>
    <div class="seg">
      <button class="${visitEod() ? "on" : ""}" data-visit-mode="eod">Same day (by midnight)</button>
      <button class="${!visitEod() ? "on" : ""}" data-visit-mode="hours">Within a number of hours</button>
    </div>
    ${visitEod()
      ? `<p class="muted" style="margin:10px 0 0">A lead claimed at 6 PM must get its visit by 11:59 PM the same day.</p>`
      : `<div class="row" style="margin-top:10px"><input class="field" type="number" min="1" step="1" id="visit-hours" value="${esc(visitHours())}" style="width:140px" /> hours
      <span class="muted">(24 = 1 day)</span>
      <button class="btn primary" id="save-visit">Save</button></div>`}

    <span class="label">Time to log a demo after the first visit</span>
    <p class="muted" style="margin:0 0 10px">If no demo is logged in this time, the claim expires and the lead opens up on the map again.</p>
    <div class="row"><input class="field" type="number" min="1" step="1" id="demo-days" value="${esc(demoDays())}" style="width:140px" /> days
      <button class="btn primary" id="save-demo">Save</button></div>
    <p class="muted" style="margin:10px 0 0">New limits apply to claims and visits logged after you save. Deadlines already running keep their original time.</p>

    <span class="label">Phone reminder before demos &amp; follow-ups</span>
    <p class="muted" style="margin:0 0 10px">Reps get a notification this long before a booked demo or follow-up.</p>
    <div class="row"><input class="field" type="number" min="0" step="0.5" id="remind-hours" value="${esc(S.settings.reminderHoursBefore ?? 2)}" style="width:140px" /> hours before
      <button class="btn primary" id="save-remind">Save</button></div>

    <span class="label">Outlet data</span>
    <p class="muted" style="margin:0">${S.rows.length || S.outlets.size} outlets in the app. Manage them in <b>Outlets &amp; import</b>. Outlets without valid coordinates can be assigned from <b>Leads &amp; claims → Assign a lead</b>.</p>
  </div>
  ${emailReportCard()}`;
}

// ------------------------------------------------------------------ events
function bindPage() {
  const main = document.getElementById("main");
  const on = (sel, ev, fn) => main.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));

  // Activity
  on("[data-key='q'],[data-key='from'],[data-key='to']", "input", (e) => { S.filters[e.target.dataset.key] = e.target.value; renderPage(false); });
  on("[data-view]", "click", (e) => { S.actView = e.currentTarget.dataset.view; localStorage.setItem("actView", S.actView); renderPage(false); });
  on("#export-sum", "click", exportSummary);
  on("[data-who]", "click", (e) => { S.who = e.currentTarget.dataset.who; localStorage.setItem("who", S.who); renderPage(false); });
  on("[data-overdue-rep]", "click", (e) => {
    const em = e.currentTarget.dataset.overdueRep;
    S.leadFilters = { rep: em || "", status: "", q: "", due: "overdue" };
    S.page = "leads"; localStorage.setItem("page", "leads"); renderPage(true);
  });
  on("[data-rep-log]", "click", (e) => { S.filters.rep = e.currentTarget.dataset.repLog; S.actView = "log"; renderPage(false); });
  on("select[data-key]", "change", (e) => { S.filters[e.target.dataset.key] = e.target.value; renderPage(false); });
  on("#clear-f", "click", () => { Object.keys(S.filters).forEach((k) => S.filters[k] = ""); S.filters.range = "today"; renderPage(false); });
  on("#export-act", "click", exportActivities);

  // Leads
  on("[data-lkey]", "input", (e) => { S.leadFilters[e.target.dataset.lkey] = e.target.value; renderPage(false); });
  on("#export-leads", "click", exportLeads);
  on("[data-unclaim]", "click", async (e) => {
    const id = e.target.dataset.unclaim;
    const l = S.leads.find((x) => x.resId === id);
    if (await modal({ title: `Unclaim ${id}?`, body: `${l?.claimedByName || "The rep"} will lose this lead. Its history and status are kept, and any rep can claim it again.`, confirm: "Unclaim", danger: true }))
      run(() => unclaimLead(id), "Lead released");
  });
  on("[data-skipgeo]", "click", async (e) => {
    const id = e.currentTarget.dataset.skipgeo;
    const l = S.leads.find((x) => x.resId === id);
    const turnOff = !l?.skipGeo;
    if (turnOff && !(await modal({ title: `Skip the location check for ${id}?`, body: "Visits and demos on this lead can then be logged from anywhere. They're marked \"Location check skipped\" in the Activity log. Use this only when the pin is wrong and can't be fixed yet.", confirm: "Skip location check" }))) return;
    run(() => updateDoc(doc(db, "leads", id), { skipGeo: turnOff }), turnOff ? "Location check is off for this lead" : "Location check is back on");
  });
  on("[data-reassign]", "click", async (e) => {
    const id = e.target.dataset.reassign;
    const rep = await pickRep(`Reassign ${id}`, "Choose who should own this lead. History and status are kept.");
    if (rep) run(() => assignLead(id, rep), `Assigned to ${rep.name || rep.email}`);
  });
  on("#assign-new", "click", async () => {
    const id = await modal({ title: "Assign a lead", body: "Enter the Res ID of the outlet.", confirm: "Next", html: `<input class="field" data-value placeholder="Res ID, e.g. 30077" />`, onOpen: (o) => o.querySelector("input").focus() });
    if (!id || id === true) return;
    const resId = String(id).trim();
    if (!S.outlets.has(resId)) return toast(`Res ID ${resId} isn't in the sheet`, true);
    const rep = await pickRep(`Assign ${resId}`, S.outlets.get(resId).name);
    if (rep) run(() => assignLead(resId, rep), `Assigned to ${rep.name || rep.email}`);
  });

  // Forms
  on("#seed-forms", "click", () => run(async () => {
    const batch = writeBatch(db);
    defaultForms().forEach((f) => batch.set(doc(db, "forms", f.id), {
      name: f.name, order: f.order, active: true, statusOptions: f.statusOptions, statusRequired: true, stage: f.stage || "",
      fields: f.fields, version: 1, updatedAt: serverTimestamp(), updatedBy: S.user.email,
    }));
    await batch.commit();
  }, "Default forms created"));
  on("#new-form", "click", () => {
    S.editingFormId = null;
    S.draft = { _new: true, name: "", order: S.forms.length + 1, active: true, statusOptions: [...STATUSES], statusRequired: true, fields: [] };
    renderPage(false);
  });
  on("[data-form]", "click", (e) => {
    const f = S.forms.find((x) => x.id === e.currentTarget.dataset.form);
    S.editingFormId = f.id; S.draft = structuredClone(f); renderPage(false);
  });
  on("[data-draft]", "input", (e) => { S.draft[e.target.dataset.draft] = e.target.value; });
  on("[data-draft-num]", "input", (e) => { S.draft[e.target.dataset.draftNum] = Number(e.target.value); });
  on("[data-draft-bool]", "change", (e) => { S.draft[e.target.dataset.draftBool] = e.target.checked; });
  on("[data-draft-stage]", "change", (e) => { S.draft.stage = e.target.value; renderPage(false); });
  on("[data-key='status-input']", "keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim();
    if (v && !(S.draft.statusOptions || []).includes(v)) { S.draft.statusOptions = [...(S.draft.statusOptions || []), v]; renderPage(false); }
    else e.target.value = "";
  });
  on("[data-del-status]", "click", (e) => { S.draft.statusOptions.splice(Number(e.target.dataset.delStatus), 1); renderPage(false); });
  on("[data-fl]", "input", (e) => {
    const [i, k] = e.target.dataset.fl.split(":");
    const fl = S.draft.fields[Number(i)];
    if (k === "options") fl.options = e.target.value.split("\n");
    else fl[k] = e.target.value;
  });
  on("select[data-fl]", "change", () => renderPage(false));
  on("[data-fl-bool]", "change", (e) => {
    const [i, k] = e.target.dataset.flBool.split(":");
    const fl = S.draft.fields[Number(i)];
    if (k === "followup") fl.role = e.target.checked ? "followup" : "";
    else fl[k] = e.target.checked;
  });
  on("[data-move]", "click", (e) => {
    const [i, dir] = e.currentTarget.dataset.move.split(":").map(Number);
    const f = S.draft.fields; const j = i + dir;
    if (j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]]; renderPage(false);
  });
  on("[data-del-field]", "click", (e) => { S.draft.fields.splice(Number(e.currentTarget.dataset.delField), 1); renderPage(false); });
  on("#add-field", "click", () => {
    S.draft.fields = [...(S.draft.fields || []), { id: newFieldId(), label: "", type: "text", required: false, options: [], help: "", role: "" }];
    renderPage(false);
    setTimeout(() => document.querySelector(`[data-key="fl-${S.draft.fields.length - 1}-label"]`)?.focus(), 30);
  });
  on("#publish-form", "click", publishForm);
  on("#add-demo-fields", "click", () => {
    const f = S.draft.fields || [];
    // Put them before Remarks / follow-up if present, otherwise at the end.
    const at = f.findIndex((x) => x.role === "followup" || /remark/i.test(x.label || ""));
    const add = demoBookingFields();
    S.draft.fields = at >= 0 ? [...f.slice(0, at), ...add, ...f.slice(at)] : [...f, ...add];
    renderPage(false);
    toast("Added. Review and press Publish to app.");
  });
  on("[data-fl-role]", "change", (e) => { S.draft.fields[Number(e.target.dataset.flRole)].role = e.target.value; });
  on("[data-fl-cond]", "change", (e) => {
    const fl = S.draft.fields[Number(e.target.dataset.flCond)];
    if (!e.target.value) delete fl.showIf;
    else {
      const p = S.draft.fields.find((x) => x.id === e.target.value);
      const first = e.target.value === "__status" ? (S.draft.statusOptions || [])[0] || ""
        : p?.type === "yesno" ? "Yes" : (p?.options || []).map((o) => o.trim()).filter(Boolean)[0] || "";
      fl.showIf = { field: e.target.value, equals: first };
    }
    renderPage(false);
  });
  on("[data-fl-condv]", "change", (e) => { const fl = S.draft.fields[Number(e.target.dataset.flCondv)]; fl.showIf = { ...fl.showIf, equals: e.target.value }; });
  on("#discard-form", "click", () => { S.draft = structuredClone(S.forms.find((f) => f.id === S.editingFormId)); renderPage(false); toast("Changes discarded"); });
  on("#delete-form", "click", async () => {
    if (await modal({ title: `Delete "${S.draft.name}"?`, body: "Reps won't see this activity type any more. Activities already logged with it are kept.", confirm: "Delete", danger: true }))
      run(async () => { await deleteDoc(doc(db, "forms", S.editingFormId)); S.editingFormId = null; S.draft = null; }, "Form deleted");
  });

  // Users
  on("[data-admin]", "click", async (e) => {
    const em = e.target.dataset.admin;
    if (await modal({ title: "Make admin?", body: `${em} will be able to open this portal, manage forms, leads and users. Only you can manage admins.`, confirm: "Make admin" }))
      run(() => setDoc(doc(db, "roles", em), { role: "admin", grantedBy: S.user.email, grantedAt: serverTimestamp() }), "Admin added");
  });
  on("#add-admin", "click", async () => {
    const em = await modal({ title: "Add admin", body: "They can sign in to this portal straight away.", confirm: "Add admin", html: `<input class="field" data-value placeholder="name@${ALLOWED_DOMAIN}" />`, onOpen: (o) => o.querySelector("input").focus() });
    if (!em || em === true) return;
    const e = String(em).trim().toLowerCase();
    if (!e.endsWith("@" + ALLOWED_DOMAIN)) return toast(`Must be an @${ALLOWED_DOMAIN} email`, true);
    run(() => setDoc(doc(db, "roles", e), { role: "admin", grantedBy: S.user.email, grantedAt: serverTimestamp() }), "Admin added");
  });
  on("[data-unadmin]", "click", async (e) => {
    const em = e.target.dataset.unadmin;
    if (await modal({ title: "Remove admin?", body: `${em} will become a normal rep.`, confirm: "Remove admin", danger: true }))
      run(() => deleteDoc(doc(db, "roles", em)), "Admin removed");
  });
  on("[data-block]", "click", async (e) => {
    const em = e.target.dataset.block;
    if (await modal({ title: "Block user?", body: `${em} will be signed out immediately and can't use the app until unblocked.`, confirm: "Block", danger: true }))
      run(() => setDoc(doc(db, "blocked", em), { blockedAt: serverTimestamp(), blockedBy: S.user.email }), "User blocked");
  });
  on("[data-unblock]", "click", (e) => run(() => deleteDoc(doc(db, "blocked", e.target.dataset.unblock)), "User unblocked"));
  on("[data-remove]", "click", async (e) => {
    const em = e.target.dataset.email;
    if (await modal({ title: "Remove user?", body: `${em} is removed from the list. If they sign in again they reappear. Use Block to keep someone out.`, confirm: "Remove", danger: true }))
      run(() => deleteDoc(doc(db, "users", e.target.dataset.remove)), "User removed");
  });
  on("#export-users", "click", () => downloadXlsx(S.users.map((u) => ({
    "Name": u.name || "", "Email": u.email, "Role": u.email === SUPER_ADMIN ? "Super admin" : S.roles.has(u.email) ? "Admin" : "Rep",
    "Blocked": S.blocked.has(u.email) ? "Yes" : "", "Claimed leads": S.leads.filter((l) => l.claimedBy === u.uid).length,
    "Joined": toDate(u.firstLogin)?.toLocaleString("en-IN") || "", "Last active": toDate(u.lastLogin)?.toLocaleString("en-IN") || "",
    "App version": u.appVersion || "",
  })), "Users", `upsell-users-${ymd(new Date())}.xlsx`));

  bindOutlets(on);
  bindLocFix(on);

  // Settings
  on("#save-radius", "click", () => {
    const v = Number(document.getElementById("radius").value);
    if (!(v >= 50)) return toast("Enter at least 50 metres", true);
    run(() => setDoc(doc(db, "config", "settings"), { claimRadiusMeters: v }, { merge: true }), "Saved");
  });
  on("#save-act-radius", "click", () => {
    const v = Number(document.getElementById("act-radius").value);
    if (!(v >= 50)) return toast("Enter at least 50 metres", true);
    run(() => setDoc(doc(db, "config", "settings"), { activityRadiusMeters: v }, { merge: true }), `Saved: visits and demos within ${v} m`);
  });
  on("[data-visit-mode]", "click", (e) => {
    const m = e.currentTarget.dataset.visitMode;
    run(() => setDoc(doc(db, "config", "settings"), { visitDeadlineMode: m }, { merge: true }),
      m === "eod" ? "Saved: visit must be logged the same day" : "Saved: visit within a number of hours");
  });
  on("#save-visit", "click", () => {
    const v = Math.round(Number(document.getElementById("visit-hours").value));
    if (!(v >= 1 && v <= 720)) return toast("Enter between 1 and 720 hours", true);
    run(() => setDoc(doc(db, "config", "settings"), { visitWindowHours: v }, { merge: true }), `Saved: visit within ${v} hours`);
  });
  on("#save-remind", "click", () => {
    const v = Number(document.getElementById("remind-hours").value);
    if (!(v >= 0 && v <= 48)) return toast("Enter between 0 and 48 hours", true);
    run(() => setDoc(doc(db, "config", "settings"), { reminderHoursBefore: v }, { merge: true }), `Saved: reminders ${v} hours before`);
  });
  const erSave = (patch, msg) => run(() => setDoc(doc(db, "config", "emailReport"), patch, { merge: true }), msg);
  on("#er-loc", "change", (e) => erSave({ locationAlerts: e.target.checked }, e.target.checked ? "Location-fix alerts on" : "Location-fix alerts off"));
  on("#er-enabled", "change", (e) => erSave({ enabled: e.target.checked }, e.target.checked ? "Summary emails on" : "Summary emails off"));
  on("#er-add-r", "keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return toast("Enter a valid email", true);
    const list = [...new Set([...(S.emailReport?.recipients || []), v])];
    erSave({ recipients: list, enabled: true }, "Recipient added");
  });
  on("[data-er-del-r]", "click", (e) => {
    const list = (S.emailReport?.recipients || []).filter((_, i) => i !== Number(e.target.dataset.erDelR));
    erSave({ recipients: list }, "Recipient removed");
  });
  on("#er-add-t-btn", "click", () => {
    const v = document.getElementById("er-add-t").value;
    if (!/^\d{2}:\d{2}$/.test(v)) return toast("Pick a time first", true);
    const list = [...new Set([...(S.emailReport?.times || []), v])].sort();
    erSave({ times: list }, `Daily email at ${v} added`);
  });
  on("[data-er-del-t]", "click", (e) => {
    const list = (S.emailReport?.times || []).filter((t) => t !== e.target.dataset.erDelT);
    erSave({ times: list }, "Time removed");
  });
  on("#er-test", "click", () => {
    if (!(S.emailReport?.recipients || []).length) return toast("Add at least one email first", true);
    erSave({ testRequestedAt: Date.now(), testSentAt: null }, "Test requested: it arrives within 5 minutes");
  });
  on("#save-demo", "click", () => {
    const v = Math.round(Number(document.getElementById("demo-days").value));
    if (!(v >= 1 && v <= 60)) return toast("Enter between 1 and 60 days", true);
    run(() => setDoc(doc(db, "config", "settings"), { demoWindowDays: v }, { merge: true }), `Saved: demo within ${v} days`);
  });
}

// ================================================================== Outlets & import
// The outlet list lives in Firestore (outlets_meta/current + outlets_chunks/N), exactly the
// format the app reads. Imports and restores rewrite it in one atomic batch, after saving a backup.

const REQUIRED = ["Res ID", "Restaurant", "Priority", "latitude", "longitude"];
const RECOMMENDED = ["Outlet Size", "What to pitch", "Plan recommendation", "address", "Brand", "Projected ARR"];
const ALIASES = {
  "res id": "Res ID", "resid": "Res ID", "rest id": "Res ID", "restaurant id": "Res ID", "rid": "Res ID",
  "restaurant": "Restaurant", "restaurant name": "Restaurant", "outlet name": "Restaurant", "outlet": "Restaurant",
  "priority": "Priority", "lat": "latitude", "latitude": "latitude", "lng": "longitude", "long": "longitude", "lon": "longitude", "longitude": "longitude",
  "address": "address", "outlet size": "Outlet Size", "what to pitch": "What to pitch", "plan recommendation": "Plan recommendation",
};
const COORD = new Set(["latitude", "longitude"]);
const validCoord = (r) => {
  const la = parseFloat(r.latitude), lo = parseFloat(r.longitude);
  return la >= 6 && la <= 37.5 && lo >= 68 && lo <= 97.5;
};

function canonicalHeader(h) {
  const t = String(h ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const known = [...S.headers, ...REQUIRED, ...RECOMMENDED].find((x) => x.toLowerCase() === t.toLowerCase());
  return known || ALIASES[t.toLowerCase()] || t;
}

async function parseFile(file) {
  const XLSX = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // Formatted text for everything (dates stay as shown), raw numbers for coordinates (no rounding).
  const shown = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
  const hi = shown.findIndex((r) => r.some((c) => String(c).trim()));
  if (hi < 0) throw new Error("The file is empty");
  const headers = shown[hi].map(canonicalHeader);
  const rows = [];
  for (let i = hi + 1; i < shown.length; i++) {
    const o = {};
    let any = false;
    headers.forEach((h, j) => {
      if (!h) return;
      let v = COORD.has(h) ? raw[i]?.[j] : shown[i]?.[j];
      v = String(v ?? "").trim();
      if (h === "Res ID") v = v.replace(/\.0+$/, "");
      if (h === "Priority") v = v.toUpperCase();
      if (v) any = true;
      o[h] = v;
    });
    if (any) rows.push(o);
  }
  return { headers: headers.filter(Boolean), rows, sheetName: wb.SheetNames[0] };
}

function buildPreview(imp) {
  const missing = REQUIRED.filter((h) => !imp.headers.includes(h));
  const current = new Map(S.rows.map((r) => [String(r["Res ID"]).trim(), r]));
  const seen = new Map();
  const dupes = [];
  const noId = [];
  imp.rows.forEach((r, i) => {
    const id = r["Res ID"];
    if (!id) { noId.push(i + 2); return; }
    if (seen.has(id)) dupes.push(id);
    seen.set(id, r); // last one wins
  });
  const incoming = [...seen.values()];
  const added = [], changed = [], same = [];
  for (const r of incoming) {
    const cur = current.get(r["Res ID"]);
    if (!cur) { added.push(r); continue; }
    const diffs = imp.headers.filter((h) => h !== "Res ID" && String(cur[h] ?? "") !== String(r[h] ?? ""));
    if (diffs.length) changed.push({ row: r, cur, diffs }); else same.push(r);
  }
  const removed = imp.mode === "replace" ? S.rows.filter((r) => !seen.has(String(r["Res ID"]).trim())) : [];
  const claimedIds = new Set(S.leads.filter((l) => l.claimedBy).map((l) => l.resId));
  const removedClaimed = removed.filter((r) => claimedIds.has(String(r["Res ID"]).trim()));
  const badCoords = incoming.filter((r) => !validCoord(r));
  const badPriority = incoming.filter((r) => !["P1", "P2", "P3"].includes(r.Priority));
  // Resulting dataset
  let result;
  if (imp.mode === "replace") result = incoming;
  else {
    const merged = new Map(current);
    for (const r of incoming) merged.set(r["Res ID"], { ...(current.get(r["Res ID"]) || {}), ...r });
    result = [...merged.values()];
  }
  const headers = imp.mode === "replace" ? imp.headers : [...new Set([...S.headers, ...imp.headers])];
  return { missing, dupes: [...new Set(dupes)], noId, added, changed, same, removed, removedClaimed, badCoords, badPriority, result, headers };
}

function chunkRows(rows) {
  // Keep each Firestore document well under its 1 MB limit.
  const chunks = [];
  let cur = [], size = 2;
  for (const r of rows) {
    const len = JSON.stringify(r).length + 1;
    if (cur.length && (size + len > 600000 || cur.length >= 600)) { chunks.push(cur); cur = []; size = 2; }
    cur.push(r); size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function saveBackup(reason) {
  if (!S.rows.length) return null;
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const chunks = chunkRows(S.rows);
  const batch = writeBatch(db);
  batch.set(doc(db, "outlets_backups", id), {
    createdAt: serverTimestamp(), by: S.user.email, reason, rowCount: S.rows.length,
    chunkCount: chunks.length, headers: JSON.stringify(S.headers), sourceVersion: S.outletMeta?.version || null,
  });
  chunks.forEach((c, i) => batch.set(doc(db, "outlets_backups", id, "chunks", String(i)), { json: JSON.stringify(c) }));
  await batch.commit();
  return id;
}

async function publishRows(rows, headers, info) {
  const chunks = chunkRows(rows);
  const version = Date.now();
  const batch = writeBatch(db);
  chunks.forEach((c, i) => batch.set(doc(db, "outlets_chunks", String(i)), { version, index: i, json: JSON.stringify(c) }));
  const old = S.outletMeta?.chunkCount || 0;
  for (let i = chunks.length; i < Math.max(old, chunks.length + 3); i++) batch.delete(doc(db, "outlets_chunks", String(i)));
  batch.set(doc(db, "outlets_meta", "current"), {
    version, chunkCount: chunks.length, rowCount: rows.length, headers: JSON.stringify(headers),
    updatedAt: new Date().toISOString(), source: info.source, by: S.user.email,
  });
  batch.set(doc(collection(db, "outlet_imports")), { at: serverTimestamp(), by: S.user.email, ...info, rowCount: rows.length });
  await batch.commit();
}

async function pruneBackups(keep = 25) {
  const extra = (S.backups || []).slice(keep);
  for (const b of extra) {
    const batch = writeBatch(db);
    for (let i = 0; i < (b.chunkCount || 0); i++) batch.delete(doc(db, "outlets_backups", b.id, "chunks", String(i)));
    batch.delete(doc(db, "outlets_backups", b.id));
    await batch.commit().catch(() => {});
  }
}

function pageOutlets() {
  const m = S.outletMeta;
  const by = (p) => S.rows.filter((r) => (r.Priority || "").toUpperCase() === p).length;
  const off = S.rows.filter((r) => !validCoord(r)).length;
  const imp = S.imp;
  const pv = imp?.preview;
  const fileBlock = !imp ? `
    <label class="drop" id="drop">
      <input type="file" id="file" accept=".xlsx,.xls,.csv" hidden />
      <div class="drop-icon">⬆</div>
      <b>Upload an Excel or CSV file</b>
      <span class="muted">Drag it here or click to choose. The first row must be the column names.</span>
      <span class="muted" style="margin-top:6px">Needed columns: ${REQUIRED.map(esc).join(", ")}</span>
    </label>` : "";
  const list = (arr, fmt, n = 8) => arr.length ? `<ul class="mini">${arr.slice(0, n).map(fmt).join("")}${arr.length > n ? `<li class="muted">…and ${arr.length - n} more</li>` : ""}</ul>` : "";
  const previewBlock = imp && pv ? `
    <div class="card editor import">
      <div class="row"><h2 style="margin:0">${esc(imp.fileName)}</h2><span class="muted">${imp.rows.length} rows read</span><div class="spacer"></div>
        <button class="btn small" id="imp-cancel">Cancel</button></div>
      <div class="seg" style="margin-top:14px">
        <button class="${imp.mode === "merge" ? "on" : ""}" data-imp-mode="merge">Add &amp; update</button>
        <button class="${imp.mode === "replace" ? "on" : ""}" data-imp-mode="replace">Replace everything</button>
      </div>
      <p class="muted" style="margin:8px 0 0">${imp.mode === "merge"
        ? "New Res IDs are added, existing ones are updated with this file's values, and outlets not in the file stay as they are. Use this for a new city or a partial update."
        : "The app's outlet list becomes exactly this file. Outlets not in the file are removed from the map."}</p>
      ${pv.missing.length ? `<div class="notice" style="margin-top:14px;background:#fff5f5"><b>Can't import:</b> missing column${pv.missing.length > 1 ? "s" : ""} ${pv.missing.map((h) => `<b>${esc(h)}</b>`).join(", ")}. Rename the column in your file and upload again.</div>` : `
      <div class="stats" style="grid-template-columns:repeat(4,1fr);margin-top:16px">
        <div class="card stat"><b style="color:var(--green)">+${pv.added.length}</b><span>New outlets</span></div>
        <div class="card stat"><b style="color:var(--orange)">${pv.changed.length}</b><span>Updated</span></div>
        <div class="card stat"><b>${pv.same.length}</b><span>Unchanged</span></div>
        <div class="card stat"><b style="color:${pv.removed.length ? "var(--p1)" : "inherit"}">−${pv.removed.length}</b><span>Removed</span></div>
      </div>
      <div class="muted" style="margin-bottom:10px">After import: <b>${pv.result.length}</b> outlets in the app (now ${S.rows.length}).</div>
      ${pv.removedClaimed.length ? `<div class="notice" style="background:#fff5f5"><b>${pv.removedClaimed.length} removed outlet(s) are claimed by reps.</b> Their claims and history are kept, but the outlets disappear from the map and from the reps' My Leads.${list(pv.removedClaimed, (r) => `<li>${esc(r["Res ID"])} · ${esc(r.Restaurant)}</li>`, 5)}</div>` : ""}
      ${pv.dupes.length ? `<div class="notice">⚠ ${pv.dupes.length} Res ID(s) appear more than once in the file; the last row is used: ${pv.dupes.slice(0, 10).map(esc).join(", ")}${pv.dupes.length > 10 ? "…" : ""}</div>` : ""}
      ${pv.noId.length ? `<div class="notice">⚠ ${pv.noId.length} row(s) have no Res ID and will be skipped (rows ${pv.noId.slice(0, 10).join(", ")}${pv.noId.length > 10 ? "…" : ""}).</div>` : ""}
      ${pv.badCoords.length ? `<div class="notice">⚠ ${pv.badCoords.length} outlet(s) have missing or invalid latitude/longitude. They'll be imported but won't show on the map.${list(pv.badCoords, (r) => `<li>${esc(r["Res ID"])} · ${esc(r.Restaurant)} · ${esc(r.latitude || "blank")}, ${esc(r.longitude || "blank")}</li>`, 5)}</div>` : ""}
      ${pv.badPriority.length ? `<div class="notice">⚠ ${pv.badPriority.length} outlet(s) have a priority other than P1/P2/P3 (they show as grey pins).</div>` : ""}
      ${(() => { const n = pv.result.filter((r) => S.fixes.has(String(r["Res ID"]).trim())).length;
        return n ? `<div class="notice" style="background:#ebfbee">✓ ${n} outlet(s) in this list have field-verified locations. Those corrected locations stay in use, whatever coordinates the file has. Manage them in <b>Location fixes</b>.</div>` : ""; })()}
      <div class="grid2">
        ${pv.added.length ? `<div><span class="label">New</span>${list(pv.added, (r) => `<li>${prio(r.Priority)} <b>${esc(r["Res ID"])}</b> ${esc(r.Restaurant)}</li>`)}</div>` : ""}
        ${pv.changed.length ? `<div><span class="label">Updated</span>${list(pv.changed, (c) => `<li><b>${esc(c.row["Res ID"])}</b> ${esc(c.row.Restaurant)}<div class="muted">${c.diffs.slice(0, 3).map((h) => `${esc(h)}: ${esc(String(c.cur[h] ?? "").slice(0, 40) || "—")} → <b>${esc(String(c.row[h] ?? "").slice(0, 40) || "—")}</b>`).join("<br>")}${c.diffs.length > 3 ? `<br>+${c.diffs.length - 3} more fields` : ""}</div></li>`)}</div>` : ""}
      </div>
      <div class="savebar">
        <button class="btn primary" id="imp-go" ${(!pv.added.length && !pv.changed.length && !pv.removed.length) ? "disabled" : ""}>Publish to app</button>
        <span class="muted">A backup of the current list is saved first, so you can undo with Restore.</span>
      </div>`}
    </div>` : "";

  return `
  <div class="head"><h1>Outlets &amp; import</h1>
    <span class="sub">${S.rows.length} outlets in the app${m?.updatedAt ? ` · last updated ${fmtDT(new Date(m.updatedAt))}${m.by ? " by " + esc(m.by) : m.source ? "" : " (Google Sheet sync)"}` : ""}</span>
    <div class="spacer"></div><button class="btn" id="dl-outlets">⬇ Download all outlets</button></div>
  <div class="stats" style="grid-template-columns:repeat(5,1fr)">
    <div class="card stat"><b>${S.rows.length}</b><span>Total outlets</span></div>
    <div class="card stat"><b style="color:var(--p1)">${by("P1")}</b><span>P1</span></div>
    <div class="card stat"><b style="color:var(--p2)">${by("P2")}</b><span>P2</span></div>
    <div class="card stat"><b style="color:var(--p3)">${by("P3")}</b><span>P3</span></div>
    <div class="card stat"><b style="color:${off ? "var(--p1)" : "inherit"}">${off}</b><span>Not on map (bad coordinates)</span></div>
  </div>
  ${fileBlock}${previewBlock}
  <div class="grid2" style="margin-top:18px">
    <div class="card editor"><h2>Import history</h2>
      ${(S.imports || []).length ? `<table><tbody>${S.imports.map((i) => `<tr><td>${fmtDT(toDate(i.at))}<div class="muted">${esc(i.by)}</div></td>
        <td>${esc(i.source === "restore" ? "Restored backup" : i.fileName || i.source)}<div class="muted">${i.source === "restore" ? "" : `${esc(i.mode === "replace" ? "Replace" : "Add & update")} · +${i.added || 0} / ~${i.changed || 0} / −${i.removed || 0}`}</div></td>
        <td style="text-align:right">${i.rowCount ?? ""}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No imports yet.</p>`}
    </div>
    <div class="card editor"><h2>Backups</h2>
      <p class="muted" style="margin:0 0 8px">Saved automatically before every import or restore. The last 25 are kept.</p>
      ${(S.backups || []).length ? `<table><tbody>${S.backups.map((b) => `<tr><td>${fmtDT(toDate(b.createdAt))}<div class="muted">${esc(b.reason || "")}</div></td>
        <td style="text-align:right">${b.rowCount} outlets</td><td style="text-align:right"><button class="btn small" data-restore="${esc(b.id)}">Restore</button></td></tr>`).join("")}</tbody></table>`
        : `<p class="muted">No backups yet.</p><button class="btn small" id="backup-now">Back up now</button>`}
    </div>
  </div>`;
}

function bindOutlets(on) {
  const main = document.getElementById("main");
  const start = async (file) => {
    if (!file) return;
    try {
      const parsed = await parseFile(file);
      S.imp = { fileName: file.name, mode: "merge", ...parsed };
      S.imp.preview = buildPreview(S.imp);
      renderPage(false);
    } catch (e) { console.error(e); toast("Couldn't read the file: " + e.message, true); }
  };
  on("#file", "change", (e) => start(e.target.files[0]));
  const drop = main.querySelector("#drop");
  if (drop) {
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => start(e.dataTransfer.files[0]));
  }
  on("#imp-cancel", "click", () => { S.imp = null; renderPage(false); });
  on("[data-imp-mode]", "click", (e) => { S.imp.mode = e.currentTarget.dataset.impMode; S.imp.preview = buildPreview(S.imp); renderPage(false); });
  on("#imp-go", "click", async (e) => {
    const imp = S.imp, pv = imp.preview;
    const ok = await modal({
      title: "Publish to app?",
      body: `${pv.added.length} new, ${pv.changed.length} updated${pv.removed.length ? `, ${pv.removed.length} removed` : ""}. Reps see the changes within seconds. A backup of the current list is saved first.`,
      confirm: "Publish", danger: pv.removed.length > 0,
    });
    if (!ok) return;
    e.target.disabled = true;
    await run(async () => {
      await saveBackup(`Before import: ${imp.fileName}`);
      await publishRows(pv.result, pv.headers, {
        source: "import", fileName: imp.fileName, mode: imp.mode,
        added: pv.added.length, changed: pv.changed.length, removed: pv.removed.length,
      });
      S.imp = null;
      pruneBackups();
    }, "Published. The app now has the new outlet list.");
    renderPage(false);
  });
  on("[data-restore]", "click", async (e) => {
    const b = S.backups.find((x) => x.id === e.target.dataset.restore);
    if (!b) return;
    const ok = await modal({ title: "Restore this backup?", body: `The app's outlet list goes back to ${b.rowCount} outlets from ${fmtDT(toDate(b.createdAt))}. The current list is backed up first, so this can be undone too.`, confirm: "Restore", danger: true });
    if (!ok) return;
    await run(async () => {
      const chunks = await Promise.all([...Array(b.chunkCount || 0).keys()].map((i) => getDoc(doc(db, "outlets_backups", b.id, "chunks", String(i)))));
      const rows = chunks.flatMap((c) => JSON.parse(c.data()?.json || "[]"));
      if (!rows.length) throw new Error("This backup is empty");
      const headers = (() => { try { return JSON.parse(b.headers || "[]"); } catch { return []; } })();
      await saveBackup(`Before restoring backup from ${fmtDT(toDate(b.createdAt))}`);
      await publishRows(rows, headers, { source: "restore", backupId: b.id });
      pruneBackups();
    }, "Backup restored");
  });
  on("#backup-now", "click", () => run(() => saveBackup("Manual backup"), "Backup saved"));
  on("#dl-outlets", "click", () => {
    const hs = S.headers.length ? S.headers : Object.keys(S.rows[0] || {});
    // Field-verified (approved) locations replace the imported coordinates in the download.
    downloadXlsx(S.rows.map((r) => {
      const o = Object.fromEntries(hs.map((h) => [h, r[h] ?? ""]));
      const f = S.fixes.get(String(r["Res ID"]).trim());
      if (f) { o.latitude = f.lat; o.longitude = f.lng; }
      o["Location verified in field"] = f ? "Yes" : "";
      return o;
    }), "Outlets", `upsell-outlets-${ymd(new Date())}.xlsx`);
  });
}

// ================================================================== Location fixes
// Reps report a wrong pin from the outlet (location_requests). Approving writes outlet_fixes/{resId},
// which the app applies on top of the imported outlet list, and optionally assigns the lead to the rep.

const gmaps = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
const gmapsRoute = (a, b) => `https://www.google.com/maps/dir/?api=1&origin=${a}&destination=${b}`;
function osmEmbed(lat, lng) {
  const d = 0.004;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d},${lat - d},${lng + d},${lat + d}&layer=mapnik&marker=${lat},${lng}`;
}

function pageLocFix() {
  const pending = S.locReqs.filter((r) => r.status === "pending");
  const done = S.locReqs.filter((r) => r.status !== "pending");
  const view = S.locView;
  const card = (r) => {
    const lead = S.leads.find((l) => l.resId === r.resId);
    const otherOwner = lead && lead.claimedBy && !leadExpired(lead) && lead.claimedBy !== r.uid ? lead.claimedByName || lead.claimedByEmail : "";
    const hasOld = r.oldLat != null && r.oldLng != null;
    return `<div class="card editor locreq">
      <div class="row">${prio(r.priority)}<h2 style="margin:0">${esc(r.outletName || r.resId)}</h2><span class="muted">Res ID ${esc(r.resId)}</span>
        <div class="spacer"></div><span class="muted">${fmtDT(toDate(r.createdAt) || (r.clientTime ? new Date(r.clientTime) : null))}</span></div>
      <div class="grid2" style="margin-top:12px">
        <div>
          <div class="muted" style="margin-bottom:6px">Reported by <b style="color:var(--ink)">${esc(r.name || r.email)}</b> · ${esc(r.email)}</div>
          ${r.address ? `<div style="margin-bottom:8px"><span class="label" style="margin:0 0 4px">Address in the outlet list</span>${esc(r.address)}</div>` : ""}
          <div class="row" style="gap:8px;margin:10px 0">
            <span class="pill red">Current pin is ${km(r.distanceM)} away</span>
            <span class="pill ${r.accuracyM <= 30 ? "green" : "orange"}">GPS ±${Math.round(r.accuracyM || 0)} m</span>
          </div>
          ${r.note ? `<div class="notice" style="margin:8px 0">“${esc(r.note)}”</div>` : ""}
          <div class="row" style="gap:6px;margin-top:8px">
            <a class="btn small" target="_blank" href="${gmaps(r.newLat, r.newLng)}">Reported spot ↗</a>
            ${hasOld ? `<a class="btn small" target="_blank" href="${gmaps(r.oldLat, r.oldLng)}">Current pin ↗</a>
            <a class="btn small" target="_blank" href="${gmapsRoute(`${r.oldLat},${r.oldLng}`, `${r.newLat},${r.newLng}`)}">Both on a route ↗</a>` : ""}
          </div>
          ${r.status === "pending" ? `
          <label class="check" style="margin-top:14px">
            <input type="checkbox" data-assign-${esc(r.id)} ${otherOwner ? "disabled" : "checked"} />
            ${otherOwner ? `Can't assign: the lead is claimed by ${esc(otherOwner)}` : `Assign the lead to ${esc(r.name || r.email)} after fixing`}
          </label>
          <div class="row" style="margin-top:14px">
            <button class="btn primary" data-approve="${esc(r.id)}">✓ Approve &amp; fix location</button>
            <button class="btn danger" data-reject="${esc(r.id)}">Reject</button>
          </div>` : `
          <div style="margin-top:12px">${r.status === "approved"
            ? `<span class="pill green">Approved</span> <span class="muted">by ${esc(r.decidedBy || "")} · ${fmtDT(toDate(r.decidedAt))}</span>
               ${S.fixes.get(r.resId)?.requestId === r.id ? `<button class="btn small" data-undo-fix="${esc(r.id)}" style="margin-left:8px">Undo fix</button>` : ""}`
            : r.status === "undone" ? `<span class="pill soft">Approved, then undone</span>`
            : `<span class="pill red">Rejected</span> <span class="muted">${esc(r.reason || "")} · ${esc(r.decidedBy || "")}</span>`}</div>`}
        </div>
        <div class="locmedia">
          ${r.hasPhoto ? photoSlot(r.id) : `<div class="photo none">No photo (sent from an older app)</div>`}
          <iframe class="osm" loading="lazy" src="${osmEmbed(r.newLat, r.newLng)}" title="Reported location"></iframe>
        </div>
      </div>
    </div>`;
  };
  return `
  <div class="head"><h1>Location fixes</h1><span class="sub">Reps report wrong pins from the outlet. Approve to move the pin for everyone.</span></div>
  <div class="row" style="margin-bottom:14px"><div class="seg">
    <button class="${view === "pending" ? "on" : ""}" data-locview="pending">Waiting for approval (${pending.length})</button>
    <button class="${view === "done" ? "on" : ""}" data-locview="done">History (${done.length})</button>
  </div><span class="muted">${S.fixes.size} outlet(s) have a field-verified location.</span></div>
  ${(view === "pending" ? pending : done).map(card).join("") || `<div class="card"><div class="empty">${view === "pending" ? "No requests waiting. When a rep reports a wrong pin from the app, it shows up here." : "Nothing here yet."}</div></div>`}`;
}

// Outlet photos are loaded one by one, only when a request is on screen.
function photoSlot(id) {
  const p = (S.photos ||= new Map()).get(id);
  if (p === undefined) loadPhoto(id);
  if (p === undefined || p === "…") return `<div class="photo loading">Loading photo…</div>`;
  if (!p) return `<div class="photo none">Photo not available</div>`;
  return `<img class="photo" data-photo="${esc(id)}" src="data:image/jpeg;base64,${p}" alt="Outlet photo" title="Click to enlarge" />`;
}
async function loadPhoto(id) {
  S.photos.set(id, "…"); // in flight
  try {
    const d = await getDoc(doc(db, "location_photos", id));
    S.photos.set(id, d.exists() ? d.data().photo || null : null);
  } catch { S.photos.set(id, null); }
  if (S.page === "locfix") renderPage(false);
}

async function approveLocFix(r, assign) {
  const batch = writeBatch(db);
  batch.update(doc(db, "location_requests", r.id), { status: "approved", decidedBy: S.user.email, decidedAt: serverTimestamp() });
  batch.set(doc(db, "outlet_fixes", r.resId), {
    lat: r.newLat, lng: r.newLng, oldLat: r.oldLat ?? null, oldLng: r.oldLng ?? null, requestId: r.id,
    reportedBy: r.email, approvedBy: S.user.email, approvedAt: serverTimestamp(),
  });
  batch.set(doc(collection(db, "activities")), {
    resId: r.resId, outletName: r.outletName || "", priority: r.priority || "", type: "locfix", formName: "Location corrected",
    status: S.leads.find((l) => l.resId === r.resId)?.status || "", uid: r.uid, email: r.email, name: r.name || r.email,
    by: S.user.email, createdAt: serverTimestamp(), clientTime: Date.now(), answers: r.note ? [{ id: "note", label: "Note", type: "text", value: r.note }] : [],
  });
  await batch.commit();
  if (assign) {
    const lead = S.leads.find((l) => l.resId === r.resId);
    const alreadyTheirs = lead && lead.claimedBy === r.uid && !leadExpired(lead);
    if (!alreadyTheirs) await assignLead(r.resId, { uid: r.uid, email: r.email, name: r.name || r.email });
  }
}

function bindLocFix(on) {
  on("[data-photo]", "click", (e) => {
    const box = document.createElement("div");
    box.className = "lightbox";
    box.innerHTML = `<img src="${e.currentTarget.src}" alt="Outlet photo" />`;
    box.onclick = () => box.remove();
    document.body.appendChild(box);
  });
  on("[data-locview]", "click", (e) => { S.locView = e.currentTarget.dataset.locview; renderPage(false); });
  on("[data-approve]", "click", async (e) => {
    const r = S.locReqs.find((x) => x.id === e.currentTarget.dataset.approve);
    if (!r) return;
    const box = document.querySelector(`[data-assign-${CSS.escape(r.id)}]`);
    const assign = !!box && box.checked && !box.disabled;
    if (!(await modal({ title: `Fix the location of ${r.outletName || r.resId}?`, body: `The pin moves to the spot ${r.name || r.email} reported, for every rep.${assign ? ` The lead is assigned to ${r.name || r.email}, who can log the visit straight away.` : ""}`, confirm: "Approve" }))) return;
    run(() => approveLocFix(r, assign), "Location fixed" + (assign ? " and lead assigned" : ""));
  });
  on("[data-reject]", "click", async (e) => {
    const r = S.locReqs.find((x) => x.id === e.currentTarget.dataset.reject);
    if (!r) return;
    const reason = await modal({ title: "Reject this location fix?", body: "The pin stays where it is. The rep sees your reason in the app.", confirm: "Reject", danger: true,
      html: `<input class="field" data-value placeholder="Reason (optional), e.g. that's their other branch" />`, onOpen: (o) => o.querySelector("input").focus() });
    if (reason === false) return;
    run(() => updateDoc(doc(db, "location_requests", r.id), { status: "rejected", reason: reason === true ? "" : String(reason).trim(), decidedBy: S.user.email, decidedAt: serverTimestamp() }), "Rejected");
  });
  on("[data-undo-fix]", "click", async (e) => {
    const r = S.locReqs.find((x) => x.id === e.currentTarget.dataset.undoFix);
    if (!r) return;
    if (!(await modal({ title: "Undo this location fix?", body: "The pin goes back to the location from the outlet list.", confirm: "Undo fix", danger: true }))) return;
    run(async () => {
      const batch = writeBatch(db);
      batch.delete(doc(db, "outlet_fixes", r.resId));
      batch.update(doc(db, "location_requests", r.id), { status: "undone", decidedBy: S.user.email, decidedAt: serverTimestamp() });
      await batch.commit();
    }, "Fix undone");
  });
}
