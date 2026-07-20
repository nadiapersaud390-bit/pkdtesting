import { firebaseConfig } from "./firebase-config.js";

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";

import {
  getAnalytics,
  isSupported as analyticsIsSupported
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-analytics.js";

import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  push,
  onValue,
  onDisconnect,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";

const appRoot = document.getElementById("appRoot");
const entryMode = document.body.dataset.entry === "alcohol" ? "alcohol" : "management";

const PORTAL_ACCOUNTS = {
  management: "management@priceking-login.com",
  alcohol: "alcohol@priceking-login.com"
};

const STAFF_NAME_KEY = `pkdStaffName:${entryMode}`;

function cleanStaffName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
}

function expectedPortalEmail() {
  return PORTAL_ACCOUNTS[entryMode];
}

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const database = getDatabase(firebaseApp);

analyticsIsSupported()
  .then((supported) => {
    if (supported) getAnalytics(firebaseApp);
  })
  .catch(() => {});

setPersistence(auth, browserLocalPersistence).catch(console.error);

const PATHS = {
  users: "users",
  items: "inventory/alcohol/items",
  catalogItems: "inventory/alcohol/catalog/items",
  catalogMeta: "inventory/alcohol/catalog/meta",
  sales: "inventory/alcohol/sales",
  countSets: "inventory/alcohol/countSets",
  settings: "inventory/alcohol/settings",
  counts: "inventory/alcohol/countSessions",
  logs: "auditLogs",
  presence: "presence"
};

const ROLES = {
  admin: {
    label: "Administrator",
    sections: ["overview", "alcohol", "products", "countsets", "stock", "history", "audit"],
    writeInventory: true
  },
  alcohol_manager: {
    label: "Alcohol Manager",
    sections: ["overview", "alcohol", "products", "countsets", "stock", "history"],
    writeInventory: true
  },
  alcohol_viewer: {
    label: "Alcohol Viewer",
    sections: ["overview", "alcohol", "products", "countsets", "stock", "history"],
    writeInventory: false
  }
};

const state = {
  user: null,
  profile: null,
  items: [],
  catalog: [],
  catalogSource: "Loading master list…",
  catalogReady: false,
  catalogFallbackAttempted: false,
  settings: {
    businessName: "Price King Distributors",
    currency: "GYD",
    defaultMarkup: 10,
    countDate: new Date().toISOString().slice(0, 10)
  },
  sessions: [],
  countSets: [],
  activeCountSetId: "",
  sales: [],
  stockSearch: "",
  stockStatus: "all",
  stockPeriod: "30",
  logs: [],
  users: [],
  currentSection: "overview",
  search: "",
  category: "",
  filterNotInSet: false,
  productSearch: "",
  productSource: "all",
  page: 1,
  pageSize: 50,
  subscriptions: [],
  connected: false
};

const $ = (id) => document.getElementById(id);
const integer = (value) => Math.max(0, Math.floor(number(value)));
const nonNegative = (value) => Math.max(0, number(value));

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value ?? "").replace(/[,$]/g, "").replace(/[^\d.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function csvSafe(value) {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvEscape(value) {
  return `"${csvSafe(value).replace(/"/g, '""')}"`;
}

function formatNumber(value, decimals = 0) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(number(value));
}

function formatMoney(value) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: state.settings.currency || "GYD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(number(value));
  } catch {
    return `$${formatNumber(value, 2)}`;
  }
}

function formatDate(value) {
  if (!value) return "—";
  const parsed = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTime(value) {
  if (!value) return "—";
  const parsed = new Date(Number(value) || value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

function sanitizeItem(raw = {}, key = "") {
  const unitsPerCase = integer(raw.unitsPerCase);
  const savedUnitSelling = nonNegative(raw.sellingPrice ?? raw.unitSellingPrice);
  const savedCaseSelling = nonNegative(raw.caseSellingPrice ?? raw.sellingPricePerCase);
  const validSources = new Set(["catalog", "manual", "imported", "legacy"]);
  const inferredSource = raw.catalogId ? "catalog" : "legacy";
  const entrySource = validSources.has(String(raw.entrySource || ""))
    ? String(raw.entrySource)
    : inferredSource;

  return {
    id: String(raw.id || key || uid()),
    catalogId: String(raw.catalogId || ""),
    name: String(raw.name || raw.productName || "").trim(),
    category: String(raw.category || "Other").trim() || "Other",
    size: String(raw.size || "").trim(),
    brand: String(raw.brand || "").trim(),
    cases: integer(raw.cases),
    unitsPerCase,
    looseUnits: integer(raw.looseUnits),
    caseCost: nonNegative(raw.caseCost),
    caseMarkup: nonNegative(raw.caseMarkup),
    caseSellingPrice: savedCaseSelling || (savedUnitSelling > 0 && unitsPerCase > 0 ? savedUnitSelling * unitsPerCase : 0),
    unitCost: nonNegative(raw.unitCost),
    unitMarkup: nonNegative(raw.unitMarkup ?? raw.markup),
    sellingPrice: savedUnitSelling,
    supplier: String(raw.supplier || "").trim(),
    reorderLevel: integer(raw.reorderLevel),
    notes: String(raw.notes || "").trim(),
    entrySource,
    manualAdded: entrySource === "manual",
    createdAt: raw.createdAt || raw.manualAddedAt || raw.updatedAt || Date.now(),
    createdBy: String(raw.createdBy || raw.manualAddedBy || raw.updatedBy || ""),
    createdByName: String(raw.createdByName || raw.manualAddedByName || ""),
    updatedAt: raw.updatedAt || Date.now(),
    updatedBy: String(raw.updatedBy || ""),
    lastCountSetId: String(raw.lastCountSetId || ""),
    lastCountSetName: String(raw.lastCountSetName || "")
  };
}

function totalQty(item) {
  return integer(item.cases) * integer(item.unitsPerCase) + integer(item.looseUnits);
}

function resolvedUnitCost(item) {
  const direct = nonNegative(item.unitCost);
  if (direct > 0) return direct;
  const pack = integer(item.unitsPerCase);
  return pack > 0 ? nonNegative(item.caseCost) / pack : 0;
}

function resolvedCaseCost(item) {
  const direct = nonNegative(item.caseCost);
  if (direct > 0) return direct;
  const pack = integer(item.unitsPerCase);
  return pack > 0 ? resolvedUnitCost(item) * pack : 0;
}

function resolvedCaseSelling(item) {
  const direct = nonNegative(item.caseSellingPrice);
  if (direct > 0) return direct;
  const pack = integer(item.unitsPerCase);
  return pack > 0 ? nonNegative(item.sellingPrice) * pack : 0;
}

function calculate(item) {
  const cases = integer(item.cases);
  const looseUnits = integer(item.looseUnits);
  const quantity = totalQty(item);
  const costEach = resolvedUnitCost(item);
  const caseCostValue = resolvedCaseCost(item);
  const sellingEach = nonNegative(item.sellingPrice);
  const caseSellingValue = resolvedCaseSelling(item);

  const stockCost = cases * caseCostValue + looseUnits * costEach;
  const salesValue = cases * caseSellingValue + looseUnits * sellingEach;
  const profit = salesValue - stockCost;

  const caseMarkup = caseCostValue > 0
    ? ((caseSellingValue - caseCostValue) / caseCostValue) * 100
    : nonNegative(item.caseMarkup);

  const unitMarkup = costEach > 0
    ? ((sellingEach - costEach) / costEach) * 100
    : nonNegative(item.unitMarkup);

  return {
    quantity,
    cases,
    looseUnits,
    costEach,
    caseCostValue,
    sellingEach,
    caseSellingValue,
    stockCost,
    salesValue,
    profit,
    caseMarkup,
    unitMarkup,
    caseProfit: caseSellingValue - caseCostValue,
    unitProfit: sellingEach - costEach
  };
}

function totals(items = state.items) {
  return items.reduce((acc, item) => {
    const calc = calculate(item);
    acc.products += 1;
    acc.cases += integer(item.cases);
    acc.units += calc.quantity;
    acc.cost += calc.stockCost;
    acc.sales += calc.salesValue;
    acc.profit += calc.profit;
    return acc;
  }, { products: 0, cases: 0, units: 0, cost: 0, sales: 0, profit: 0 });
}

function roleInfo() {
  return ROLES[state.profile?.role] || null;
}

function canWriteInventory() {
  return Boolean(roleInfo()?.writeInventory);
}

function canUseSection(section) {
  const allowedByRole = roleInfo()?.sections?.includes(section);
  if (!allowedByRole) return false;
  if (entryMode === "alcohol") return ["overview", "alcohol", "products", "countsets", "stock", "history"].includes(section);
  return true;
}

function initials(name) {
  const parts = String(name || "User").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "U";
}

function toast(message, type = "success") {
  let wrap = document.getElementById("toastWrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toastWrap";
    wrap.className = "toast-wrap";
    document.body.appendChild(wrap);
  }
  const node = document.createElement("div");
  node.className = `toast ${type === "error" ? "error" : ""}`;
  node.textContent = message;
  wrap.appendChild(node);
  window.setTimeout(() => node.remove(), 3600);
}

function authErrorMessage(error) {
  const code = error?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "The PIN is incorrect.";
  }
  if (code.includes("too-many-requests")) return "Too many attempts. Please wait and try again.";
  if (code.includes("network-request-failed")) return "Network error. Check the internet connection.";
  if (code.includes("invalid-email")) return "The portal account is not configured correctly.";
  return error?.message || "The request could not be completed.";
}

function renderLoading(text = "Connecting securely to Firebase…") {
  appRoot.innerHTML = `
    <main class="center-page">
      <section class="center-card">
        <div class="spinner"></div>
        <h1>Please wait</h1>
        <p>${escapeHtml(text)}</p>
      </section>
    </main>
  `;
}

function renderLogin(message = "", messageType = "error") {
  const isAlcohol = entryMode === "alcohol";
  appRoot.innerHTML = `
    <main class="auth-page">
      <section class="auth-panel">
        <div class="auth-brand">
          <div class="brand-seal">PKD</div>
          <div>
            <h1>Price King Distributors</h1>
            <p>Secure Inventory System</p>
          </div>
        </div>

        <div class="auth-copy">
          <div class="eyebrow">${isAlcohol ? "ALCOHOL COUNT PORTAL" : "MANAGEMENT PORTAL"}</div>
          <h2>${isAlcohol ? "Alcohol Count Login" : "Management Login"}</h2>
          <p>
            Enter your name and the ${isAlcohol ? "Alcohol Count" : "Management"} PIN.
            Your name is recorded in the activity log.
          </p>
        </div>

        <form id="loginForm" class="auth-form">
          <div class="field">
            <label for="staffName">Your name</label>
            <input
              id="staffName"
              type="text"
              autocomplete="name"
              placeholder="Example: Cindy"
              maxlength="60"
              required
            >
          </div>

          <div class="field">
            <label for="loginPin">${isAlcohol ? "Alcohol Count" : "Management"} PIN</label>
            <input
              id="loginPin"
              type="password"
              inputmode="numeric"
              autocomplete="current-password"
              placeholder="Enter 6-digit PIN"
              pattern="[0-9]{6,30}"
              minlength="6"
              maxlength="30"
              required
            >
            <span class="help-text">The PIN must contain at least 6 numbers.</span>
          </div>

          ${message ? `<div class="auth-message ${messageType}">${escapeHtml(message)}</div>` : ""}
          <button id="loginButton" class="btn btn-primary" type="submit">Log In</button>
        </form>

        <div class="portal-switch">
          ${isAlcohol
            ? 'Administrator? <a href="../index.html">Open Management Portal</a>'
            : 'Alcohol-count staff? <a href="pages/alcohol.html">Open Alcohol Count Login</a>'}
        </div>
      </section>

      <aside class="auth-visual">
        <div class="visual-content">
          <div class="line"></div>
          <h2>Accurate stock.<br>Clear decisions.</h2>
          <p>Manage cases, loose units, costs, selling prices and stock values from one synchronized system.</p>
        </div>
      </aside>
    </main>
  `;

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const staffName = cleanStaffName($("staffName").value);
    const pin = $("loginPin").value.trim();
    const internalEmail = expectedPortalEmail();
    const button = $("loginButton");

    if (!staffName) {
      renderLogin("Enter your name.", "error");
      return;
    }

    if (!/^\d{6,30}$/.test(pin)) {
      renderLogin("The PIN must contain at least 6 numbers.", "error");
      return;
    }

    button.disabled = true;
    button.textContent = "Logging in…";

    try {
      localStorage.setItem(STAFF_NAME_KEY, staffName);
      await signInWithEmailAndPassword(auth, internalEmail, pin);
    } catch (error) {
      localStorage.removeItem(STAFF_NAME_KEY);
      renderLogin(authErrorMessage(error), "error");
    }
  });
}
function renderAccessDenied(reason) {
  appRoot.innerHTML = `
    <main class="center-page">
      <section class="center-card">
        <div class="brand-seal">PKD</div>
        <h1>Access has not been granted</h1>
        <p>${escapeHtml(reason)}</p>
        <button id="deniedSignOut" class="btn btn-primary" type="button">Return to Login</button>
      </section>
    </main>
  `;
  $("deniedSignOut").addEventListener("click", () => signOut(auth));
}

function sectionTitle(section) {
  const titles = {
    overview: ["Dashboard Overview", "Realtime inventory and system summary"],
    alcohol: ["Overall Alcohol Inventory", "Combined stock from every count set"],
    products: ["Add & Manage Products", "Add from the master list or create manual products"],
    countsets: ["Count Sets", "Separate deliveries and counting periods"],
    stock: ["Stock & Sales Tracker", "Current stock, sales movement and low-stock monitoring"],
    history: ["Count History", "Saved stock-count snapshots"],
    audit: ["Activity Log", "Recorded changes made by authorized users"],
    users: ["User Access", "Assign roles and control portal access"]
  };
  return titles[section] || titles.overview;
}

function navButton(section, icon, label) {
  if (!canUseSection(section)) return "";
  return `<button class="nav-btn ${state.currentSection === section ? "active" : ""}" type="button" data-section="${section}">
    <span class="nav-icon">${icon}</span><span>${label}</span>
  </button>`;
}

function renderAppShell() {
  const profile = state.profile;
  const [title, subtitle] = sectionTitle(state.currentSection);

  appRoot.innerHTML = `
    <div class="app-shell">
      <aside id="sidebar" class="sidebar">
        <div class="sidebar-brand">
          <div class="brand-seal">PKD</div>
          <div><h1>Price King</h1><p>Inventory Portal</p></div>
        </div>

        <div class="nav-label">WORKSPACE</div>
        <nav class="nav-list">
          ${navButton("overview", "⌂", "Overview")}
          ${navButton("alcohol", "▦", "Overall Inventory")}
          ${navButton("products", "＋", "Add Products")}
          ${navButton("countsets", "▣", "Count Sets")}
          ${navButton("stock", "↕", "Stock Tracker")}
          ${navButton("history", "◷", "Count History")}
          ${navButton("audit", "≡", "Activity Log")}
          ${navButton("users", "♙", "User Access")}
        </nav>

        <div class="sidebar-user">
          <div class="user-line">
            <div class="user-avatar">${escapeHtml(initials(profile.displayName || profile.loginName || "User"))}</div>
            <div>
              <strong title="${escapeHtml(profile.displayName || profile.loginName || "User")}">${escapeHtml(profile.displayName || profile.loginName || "User")}</strong>
              <small>${escapeHtml(ROLES[profile.role]?.label || profile.role)}</small>
            </div>
          </div>
          <button id="signOutButton" class="signout-btn" type="button">Sign Out</button>
        </div>
      </aside>

      <div class="main-column">
        <header class="topbar">
          <div class="topbar-left">
            <button id="mobileMenuButton" class="mobile-menu" type="button">☰</button>
            <div>
              <h2 id="topbarTitle">${escapeHtml(title)}</h2>
              <p id="topbarSubtitle">${escapeHtml(subtitle)}</p>
            </div>
          </div>
          <div class="topbar-actions">
            <div id="syncChip" class="sync-chip ${state.connected ? "" : "offline"}">
              <span class="sync-dot"></span>
              <span>${state.connected ? "Firebase Synced" : "Connecting…"}</span>
            </div>
            <button id="printButton" class="btn btn-secondary" type="button">Print</button>
          </div>
        </header>

        <main class="main-content">
          <section id="section-overview" class="page-section ${state.currentSection === "overview" ? "active" : ""}"></section>
          <section id="section-alcohol" class="page-section ${state.currentSection === "alcohol" ? "active" : ""}"></section>
          <section id="section-products" class="page-section ${state.currentSection === "products" ? "active" : ""}"></section>
          <section id="section-countsets" class="page-section ${state.currentSection === "countsets" ? "active" : ""}"></section>
          <section id="section-stock" class="page-section ${state.currentSection === "stock" ? "active" : ""}"></section>
          <section id="section-history" class="page-section ${state.currentSection === "history" ? "active" : ""}"></section>
          <section id="section-audit" class="page-section ${state.currentSection === "audit" ? "active" : ""}"></section>
          <section id="section-users" class="page-section ${state.currentSection === "users" ? "active" : ""}"></section>
        </main>
      </div>
    </div>
    <div id="modalHost"></div>
    <div id="toastWrap" class="toast-wrap"></div>
  `;

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => showSection(button.dataset.section));
  });

  $("signOutButton").addEventListener("click", async () => {
    await addAudit("logout", "Signed out", { staffName: state.profile?.displayName || "" });
    localStorage.removeItem(STAFF_NAME_KEY);
    await signOut(auth);
  });

  $("mobileMenuButton").addEventListener("click", () => $("sidebar").classList.toggle("open"));
  $("printButton").addEventListener("click", () => window.print());

  renderCurrentSection();
}

function showSection(section) {
  if (!canUseSection(section)) return;
  state.currentSection = section;
  const [title, subtitle] = sectionTitle(section);
  document.querySelectorAll(".page-section").forEach((node) => node.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((node) => node.classList.toggle("active", node.dataset.section === section));
  $(`section-${section}`)?.classList.add("active");
  $("topbarTitle").textContent = title;
  $("topbarSubtitle").textContent = subtitle;
  $("sidebar")?.classList.remove("open");
  renderCurrentSection();
}

function renderCurrentSection() {
  if (state.currentSection === "overview") renderOverview();
  if (state.currentSection === "alcohol") renderAlcohol();
  if (state.currentSection === "products") renderProducts();
  if (state.currentSection === "countsets") renderCountSets();
  if (state.currentSection === "stock") renderStockTracker();
  if (state.currentSection === "history") renderHistory();
  if (state.currentSection === "audit") renderAudit();
  if (state.currentSection === "users") renderUsers();
}

function updateSyncChip() {
  const chip = $("syncChip");
  if (!chip) return;
  chip.classList.toggle("offline", !state.connected);
  chip.querySelector("span:last-child").textContent = state.connected ? "Firebase Synced" : "Offline / Connecting";
}

function renderOverview() {
  const target = $("section-overview");
  if (!target) return;
  const sum = totals();
  const recent = state.logs.slice(0, 5);
  const today = new Date();
  const todaySales = salesSummary(periodSales("today"));
  const lowStockCount = state.items.filter((item) => inventoryStatus(item) === "low").length;
  const outOfStockCount = state.items.filter((item) => inventoryStatus(item) === "out").length;

  target.innerHTML = `
    <section class="hero-card card">
      <div>
        <div class="eyebrow">${entryMode === "alcohol" ? "ALCOHOL COUNT WORKSPACE" : "MANAGEMENT WORKSPACE"}</div>
        <h1>Welcome, ${escapeHtml(state.profile.displayName || state.profile.loginName || "User")}.</h1>
        <p>The figures below update automatically whenever an authorized user changes the alcohol inventory.</p>
      </div>
      <div class="hero-aside">
        <div class="hero-date">
          <span>Current count date</span>
          <strong>${escapeHtml(formatDate(state.settings.countDate))}</strong>
        </div>
      </div>
    </section>

    <section class="kpi-grid">
      <article class="kpi-card"><span>Products</span><strong>${formatNumber(sum.products)}</strong></article>
      <article class="kpi-card"><span>Total Units</span><strong>${formatNumber(sum.units)}</strong></article>
      <article class="kpi-card"><span>Full Cases</span><strong>${formatNumber(sum.cases)}</strong></article>
      <article class="kpi-card gold"><span>Stock Cost</span><strong>${formatMoney(sum.cost)}</strong></article>
      <article class="kpi-card gold"><span>Sales Value</span><strong>${formatMoney(sum.sales)}</strong></article>
      <article class="kpi-card green"><span>Potential Profit</span><strong class="${sum.profit < 0 ? "negative" : ""}">${formatMoney(sum.profit)}</strong></article>
    </section>

    <section class="overview-alert-grid">
      <article class="overview-alert-card card">
        <span>Units Sold Today</span>
        <strong>${formatNumber(todaySales.units)}</strong>
        <small>${formatMoney(todaySales.amount)} in recorded sales</small>
      </article>
      <article class="overview-alert-card card warning">
        <span>Low Stock Products</span>
        <strong>${formatNumber(lowStockCount)}</strong>
        <small>At or below the reorder level</small>
      </article>
      <article class="overview-alert-card card danger">
        <span>Out of Stock</span>
        <strong>${formatNumber(outOfStockCount)}</strong>
        <small>Products requiring restocking</small>
      </article>
      <article class="overview-alert-card card action-card">
        <span>Stock Tracker</span>
        <strong>Open</strong>
        <button id="overviewStockButton" class="btn btn-secondary btn-small" type="button">View Stock & Sales</button>
      </article>
    </section>

    <section class="overview-grid">
      <article class="module-card card">
        <div class="eyebrow">ACTIVE MODULE</div>
        <h3>Alcohol Inventory Count</h3>
        <p>Track cases, units per case, loose bottles, cost prices, selling prices, stock value and profit. Every authorized device receives changes in realtime.</p>
        <div class="module-card-footer">
          <span class="status-badge">${state.connected ? "LIVE SYNC ACTIVE" : "WAITING FOR CONNECTION"}</span>
          <button id="openAlcoholButton" class="btn btn-primary" type="button">Open Alcohol Count</button>
        </div>
      </article>

      <article class="activity-preview card">
        <div class="eyebrow">RECENT SYSTEM ACTIVITY</div>
        <h3>${state.profile.role === "admin" ? "Latest changes" : "Your workspace"}</h3>
        <div class="mini-list">
          ${state.profile.role === "admin" && recent.length
            ? recent.map((log) => `
                <div class="mini-row">
                  <div><strong>${escapeHtml(log.actionLabel || log.action || "Activity")}</strong><span>${escapeHtml(log.userEmail || "")}</span></div>
                  <span>${escapeHtml(formatDateTime(log.timestamp))}</span>
                </div>`).join("")
            : `<div class="mini-row"><div><strong>Realtime inventory</strong><span>Changes save directly to Firebase</span></div><span>${state.connected ? "Online" : "Connecting"}</span></div>
               <div class="mini-row"><div><strong>Access role</strong><span>${escapeHtml(ROLES[state.profile.role]?.label || state.profile.role)}</span></div><span>Active</span></div>`}
        </div>
      </article>
    </section>
  `;

  $("openAlcoholButton").addEventListener("click", () => showSection("alcohol"));
  $("overviewStockButton")?.addEventListener("click", () => showSection("stock"));
}

function normalizeEntrySource(value) {
  return ["catalog", "manual", "imported", "legacy"].includes(String(value))
    ? String(value)
    : "legacy";
}

function entrySourceLabel(value) {
  const source = normalizeEntrySource(value);
  return {
    catalog: "Master List",
    manual: "Manual",
    imported: "Uploaded",
    legacy: "Existing"
  }[source];
}

function entrySourceBadge(value) {
  const source = normalizeEntrySource(value);
  return `<span class="source-badge ${source}">${escapeHtml(entrySourceLabel(source))}</span>`;
}

function inventoryFilters() {
  const categories = [...new Set(state.items.map((item) => item.category).filter(Boolean))].sort();
  return `
    <div class="toolbar-left">
      <input id="inventorySearch" type="search" placeholder="Search product, size or supplier" value="${escapeHtml(state.search)}">
      <select id="inventoryCategory">
        <option value="">All categories</option>
        ${categories.map((category) => `<option value="${escapeHtml(category)}" ${state.category === category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}
      </select>
    </div>
    <div class="toolbar-right">
      ${activeCountSet() ? `<button id="filterNotInSetBtn" class="btn btn-secondary btn-small${state.filterNotInSet ? " active-filter" : ""}" type="button">Not in Active Set${state.filterNotInSet ? " ✕" : ""}</button>` : ""}
      <select id="pageSize">
        ${[25,50,100,250].map((size) => `<option value="${size}" ${state.pageSize === size ? "selected" : ""}>${size} rows</option>`).join("")}
      </select>
    </div>
  `;
}

function activeSetItemIds() {
  const active = activeCountSet();
  if (!active) return new Set();
  return new Set(Object.values(active.items || {}).map((l) => l.itemId).filter(Boolean));
}

function filteredItems() {
  const search = state.search.trim();
  const inSetIds = state.filterNotInSet ? activeSetItemIds() : null;

  return state.items.filter((item) => {
    const matchesCategory = !state.category || item.category === state.category;
    const searchable = `${item.name} ${item.category} ${item.size} ${item.supplier} ${entrySourceLabel(item.entrySource)}`;
    const matchesSearch = !search || matchesSearchQuery(searchable, search);
    const matchesSetFilter = !inSetIds || !inSetIds.has(item.id);
    return matchesCategory && matchesSearch && matchesSetFilter;
  });
}

const BUNDLED_CATALOG_URL = new URL("../data/master-alcohol-list.csv", import.meta.url);

function normalizeCatalogEntry(raw = {}, key = "") {
  const name = String(
    raw.name ||
    raw["Product / Label"] ||
    raw["Product Name"] ||
    raw.Product ||
    ""
  ).trim();

  const size = String(
    raw.size ||
    raw["Bottle Size"] ||
    raw.Size ||
    ""
  ).trim();

  const category = String(raw.category || raw.Category || "Other").trim() || "Other";
  const brand = String(raw.brand || raw.Brand || "").trim();
  const subcategory = String(raw.subcategory || raw.Subcategory || "").trim();
  const style = String(raw.style || raw["Style / Age / Flavour"] || "").trim();
  const country = String(raw.country || raw["Country / Region"] || "").trim();

  return {
    id: String(raw.id || raw.ID || key || uid()),
    name,
    category,
    size,
    brand,
    subcategory,
    style,
    country
  };
}

function catalogueFromWorkbook(workbook) {
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error("The master-list file has no worksheet.");

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], {
    defval: "",
    raw: false
  });

  const seen = new Set();
  const catalogue = [];

  rows.forEach((row, index) => {
    const item = normalizeCatalogEntry(row, `catalog-${index + 1}`);
    if (!item.name) return;

    const uniqueKey = `${item.name.toLowerCase()}|${item.size.toLowerCase()}`;
    if (seen.has(uniqueKey)) return;
    seen.add(uniqueKey);
    catalogue.push(item);
  });

  catalogue.sort((a, b) =>
    a.name.localeCompare(b.name) ||
    a.size.localeCompare(b.size)
  );

  if (!catalogue.length) {
    throw new Error("No alcohol products were found in the master list.");
  }

  return catalogue;
}

async function catalogueFromFile(file) {
  if (!window.XLSX) {
    throw new Error("The CSV/Excel reader did not load. Refresh the page and try again.");
  }
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: "array",
    cellDates: false
  });
  return catalogueFromWorkbook(workbook);
}

function mergeCatalogueEntries(...catalogueLists) {
  const merged = [];
  const seen = new Set();

  catalogueLists.flat().forEach((item) => {
    const normalized = normalizeCatalogEntry(item);
    if (!normalized.name) return;

    const key = `${normalized.name.toLowerCase()}|${normalized.size.toLowerCase()}`;
    if (seen.has(key)) return;

    seen.add(key);
    merged.push(normalized);
  });

  merged.sort((a, b) =>
    a.name.localeCompare(b.name) ||
    a.size.localeCompare(b.size)
  );

  return merged;
}

async function loadBundledCatalogue(options = {}) {
  const mergeWithCurrent = options.mergeWithCurrent === true;

  if (state.catalogFallbackAttempted && !options.force) return;
  state.catalogFallbackAttempted = true;

  try {
    const response = await fetch(BUNDLED_CATALOG_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Master list could not be loaded (${response.status}).`);
    }

    const workbook = XLSX.read(await response.arrayBuffer(), {
      type: "array",
      cellDates: false
    });

    const bundledCatalogue = catalogueFromWorkbook(workbook);

    state.catalog = mergeWithCurrent
      ? mergeCatalogueEntries(state.catalog, bundledCatalogue)
      : bundledCatalogue;

    state.catalogSource = mergeWithCurrent
      ? "Firebase + Updated Included Master Alcohol List"
      : "Updated Included Master Alcohol List";

    state.catalogReady = true;

    if (state.currentSection === "alcohol" && $("section-alcohol")) {
      renderAlcohol();
    }
  } catch (error) {
    console.error("Bundled master list failed to load:", error);

    if (!state.catalog.length) {
      state.catalogSource = "Master list unavailable";
      state.catalogReady = false;
      toast("The included master alcohol list could not be loaded.", "error");
    }
  }
}

const SEARCH_SYNONYMS = {
  shiraz: ["syrah"],
  syrah: ["shiraz"],
  whisky: ["whiskey"],
  whiskey: ["whisky"],
  johnny: ["johnnie"],
  johnnie: ["johnny"],
  champagne: ["sparkling"],
  sparkling: ["champagne"],
  cognac: ["brandy"],
  brandy: ["cognac"],
  rhum: ["rum"],
  rum: ["rhum"],
  lager: ["beer"],
  beer: ["lager"],
  stout: ["beer"],
  rose: ["rosé"],
  carmenere: ["carmenère"],
  gewurztraminer: ["gewürztraminer"],
  fernandez: ["fernandes"],
  fernandes: ["fernandez"],
  sharloff: ["skarloff"],
  skarloff: ["sharloff", "skaroff"],
  skaroff: ["skarloff"],
  pergola: ["pérgola"],
  pérgola: ["pergola"],
  selecao: ["seleção"],
  seleção: ["selecao"],
  mascato: ["moscato"],
  moscato: ["mascato"],
  mcallan: ["macallan"],
  mccallan: ["macallan"],
  macallan: ["mcallan", "mccallan"],
  caranet: ["cabernet"],
  cabernet: ["caranet"],
  edward: ["edwards"],
  edwards: ["edward"]
};

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTokenGroups(query) {
  return normalizeSearchText(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const equivalents = SEARCH_SYNONYMS[token] || [];
      return [...new Set([token, ...equivalents.map(normalizeSearchText)])];
    });
}

function matchesSearchQuery(haystack, query) {
  const normalizedHaystack = normalizeSearchText(haystack);
  const tokenGroups = searchTokenGroups(query);

  return tokenGroups.every((group) =>
    group.some((token) => normalizedHaystack.includes(token))
  );
}

function manualProductSuggestions() {
  return state.items
    .filter((item) => normalizeEntrySource(item.entrySource) === "manual")
    .map((item) => ({
      id: item.id,
      inventoryItemId: item.id,
      catalogId: "",
      entrySource: "manual",
      name: item.name,
      category: item.category || "Other",
      size: item.size || "",
      brand: item.brand || "",
      subcategory: "",
      style: "",
      country: "",
      unitsPerCase: integer(item.unitsPerCase),
      caseCost: nonNegative(item.caseCost),
      caseMarkup: nonNegative(item.caseMarkup),
      caseSellingPrice: nonNegative(item.caseSellingPrice),
      unitCost: nonNegative(item.unitCost),
      unitMarkup: nonNegative(item.unitMarkup),
      sellingPrice: nonNegative(item.sellingPrice),
      supplier: item.supplier || "",
      reorderLevel: integer(item.reorderLevel),
      notes: item.notes || ""
    }));
}

function searchableProductSuggestions(includeManual = false) {
  const catalogue = state.catalog.map((item) => ({
    ...item,
    catalogId: item.id,
    inventoryItemId: "",
    entrySource: "catalog"
  }));

  if (!includeManual) return catalogue;

  const combined = [];
  const seen = new Set();

  // Put manually saved products first. When the same name and size are also in
  // the master list, the saved manual record is the more useful choice because
  // it carries the user's units-per-case, pricing, supplier and other details.
  [...manualProductSuggestions(), ...catalogue].forEach((item) => {
    const key = `${normalizeSearchText(item.name)}|${normalizeSearchText(item.size)}`;
    if (!item.name || seen.has(key)) return;
    seen.add(key);
    combined.push(item);
  });

  return combined;
}

function catalogueSearch(query, limit = 18, options = {}) {
  const clean = normalizeSearchText(query);
  const products = searchableProductSuggestions(options.includeManual === true);
  if (!clean || !products.length) return [];

  const matches = [];

  for (const item of products) {
    const searchable = [
      item.name,
      item.brand,
      item.size,
      item.category,
      item.subcategory,
      item.style,
      item.country,
      item.supplier,
      entrySourceLabel(item.entrySource)
    ].join(" ");

    if (!matchesSearchQuery(searchable, clean)) continue;

    const normalizedName = normalizeSearchText(item.name);
    const normalizedBrand = normalizeSearchText(item.brand);

    let score = 6;
    if (normalizedName === clean) score = 0;
    else if (normalizedName.startsWith(clean)) score = 1;
    else if (normalizedBrand.startsWith(clean)) score = 2;
    else if (normalizedName.includes(clean)) score = 3;
    else if (normalizedBrand.includes(clean)) score = 4;

    matches.push({ item, score });
  }

  matches.sort((a, b) =>
    a.score - b.score ||
    (normalizeEntrySource(a.item.entrySource) === "manual" ? -1 : 0) -
      (normalizeEntrySource(b.item.entrySource) === "manual" ? -1 : 0) ||
    a.item.name.localeCompare(b.item.name) ||
    a.item.size.localeCompare(b.item.size)
  );

  return matches.slice(0, limit).map((entry) => entry.item);
}

async function syncCatalogueToFirebase(catalogue, sourceName) {
  const itemsPayload = {};

  catalogue.forEach((item, index) => {
    const key = `c${String(index + 1).padStart(6, "0")}`;
    itemsPayload[key] = {
      id: key,
      name: item.name,
      category: item.category,
      size: item.size,
      brand: item.brand,
      subcategory: item.subcategory,
      style: item.style,
      country: item.country
    };
  });

  await set(ref(database, PATHS.catalogItems), itemsPayload);
  await set(ref(database, PATHS.catalogMeta), {
    count: catalogue.length,
    sourceName,
    updatedAt: serverTimestamp(),
    updatedBy: state.user.uid,
    updatedByName: state.profile?.displayName || ""
  });
}

function openMasterListModal() {
  openModal(`
    <div class="modal-header">
      <div>
        <div class="eyebrow">PRODUCT CATALOGUE</div>
        <h2>Master Alcohol List</h2>
      </div>
      <button class="icon-btn" type="button" data-close-modal>×</button>
    </div>

    <div class="modal-body">
      <div class="catalogue-summary">
        <div>
          <span>Products available</span>
          <strong>${formatNumber(state.catalog.length)}</strong>
        </div>
        <div>
          <span>Current source</span>
          <strong>${escapeHtml(state.catalogSource)}</strong>
        </div>
      </div>

      <div class="file-drop">
        <strong>Upload or replace the master alcohol list</strong>
        <p class="muted">
          Select the Master Alcohol List CSV or an Excel file with
          Product / Label, Category and Bottle Size columns.
        </p>
        <input id="catalogueFile" type="file" accept=".csv,.xlsx,.xls">
      </div>

      <div id="catalogueMessage"></div>
    </div>

    <div class="modal-footer">
      <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
      <button id="useIncludedCatalogue" class="btn btn-secondary" type="button">Sync Included List</button>
      <button id="uploadCatalogue" class="btn btn-primary" type="button">Upload and Sync</button>
    </div>
  `, true);

  const message = $("catalogueMessage");

  $("useIncludedCatalogue").addEventListener("click", async () => {
    const button = $("useIncludedCatalogue");
    button.disabled = true;
    button.textContent = "Syncing…";
    try {
      if (!state.catalog.length) await loadBundledCatalogue();
      await syncCatalogueToFirebase(state.catalog, "Included Master Alcohol List.csv");
      await addAudit(
        "catalogue_synced",
        `Synchronized ${state.catalog.length} products from the included master alcohol list`
      );
      message.innerHTML = `<div class="message success">${formatNumber(state.catalog.length)} products synchronized to Firebase.</div>`;
      window.setTimeout(closeModal, 900);
    } catch (error) {
      console.error(error);
      message.innerHTML = `<div class="message error">${escapeHtml(firebaseWriteMessage(error))}</div>`;
      button.disabled = false;
      button.textContent = "Sync Included List";
    }
  });

  $("uploadCatalogue").addEventListener("click", async () => {
    const file = $("catalogueFile").files[0];
    if (!file) {
      message.innerHTML = '<div class="message error">Select the master-list CSV or Excel file.</div>';
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      message.innerHTML = '<div class="message error">The master-list file is larger than 25 MB.</div>';
      return;
    }

    const button = $("uploadCatalogue");
    button.disabled = true;
    button.textContent = "Reading list…";

    try {
      const catalogue = await catalogueFromFile(file);
      button.textContent = "Saving to Firebase…";
      await syncCatalogueToFirebase(catalogue, file.name);
      await addAudit(
        "catalogue_uploaded",
        `Uploaded and synchronized ${catalogue.length} master-list products`,
        { fileName: file.name, count: catalogue.length }
      );
      message.innerHTML = `<div class="message success">${formatNumber(catalogue.length)} products uploaded and synchronized.</div>`;
      window.setTimeout(closeModal, 900);
    } catch (error) {
      console.error(error);
      message.innerHTML = `<div class="message error">${escapeHtml(error.message || firebaseWriteMessage(error))}</div>`;
      button.disabled = false;
      button.textContent = "Upload and Sync";
    }
  });
}

function sanitizeCountSet(raw = {}, key = "") {
  const rawItems = raw.items && typeof raw.items === "object" ? raw.items : {};

  return {
    id: String(raw.id || key || uid()),
    name: String(raw.name || "Count Set").trim(),
    countDate: String(raw.countDate || "").trim(),
    notes: String(raw.notes || "").trim(),
    status: raw.status === "closed" ? "closed" : "open",
    createdAt: raw.createdAt || Date.now(),
    createdBy: String(raw.createdBy || ""),
    createdByName: String(raw.createdByName || ""),
    updatedAt: raw.updatedAt || raw.createdAt || Date.now(),
    lineCount: integer(raw.lineCount),
    productCount: integer(raw.productCount || raw.lineCount),
    totalCases: integer(raw.totalCases),
    totalUnits: integer(raw.totalUnits),
    stockCost: nonNegative(raw.stockCost),
    salesValue: nonNegative(raw.salesValue),
    potentialProfit: number(raw.potentialProfit),
    items: Object.entries(rawItems)
      .map(([lineId, line]) => ({
        lineId,
        itemId: String(line.itemId || ""),
        catalogId: String(line.catalogId || ""),
        entrySource: normalizeEntrySource(line.entrySource || (line.catalogId ? "catalog" : "legacy")),
        name: String(line.name || "").trim(),
        category: String(line.category || "Other").trim(),
        size: String(line.size || "").trim(),
        casesAdded: integer(line.casesAdded),
        unitsPerCase: integer(line.unitsPerCase),
        looseUnitsAdded: integer(line.looseUnitsAdded),
        totalUnitsAdded: integer(line.totalUnitsAdded),
        caseCost: nonNegative(line.caseCost),
        caseSellingPrice: nonNegative(line.caseSellingPrice),
        unitCost: nonNegative(line.unitCost),
        unitSellingPrice: nonNegative(line.unitSellingPrice),
        stockCost: nonNegative(line.stockCost),
        salesValue: nonNegative(line.salesValue),
        potentialProfit: number(line.potentialProfit),
        supplier: String(line.supplier || "").trim(),
        notes: String(line.notes || "").trim(),
        addedAt: line.addedAt || Date.now(),
        addedBy: String(line.addedBy || ""),
        addedByName: String(line.addedByName || "")
      }))
      .sort((a, b) => number(b.addedAt) - number(a.addedAt))
  };
}

function activeCountSet() {
  return state.countSets.find((countSet) => countSet.id === state.activeCountSetId) || null;
}

function openCountSets() {
  showSection("countsets");
}

async function activateCountSet(countSetId) {
  const countSet = state.countSets.find((entry) => entry.id === countSetId);

  if (!countSet) {
    toast("That count set could not be found.", "error");
    return;
  }

  if (countSet.status === "closed") {
    toast("Reopen the count set before making it active.", "error");
    return;
  }

  try {
    await update(ref(database, PATHS.settings), {
      activeCountSetId: countSet.id,
      countDate: countSet.countDate || state.settings.countDate,
      updatedAt: serverTimestamp(),
      updatedBy: state.user.uid
    });

    await addAudit(
      "count_set_activated",
      `Made "${countSet.name}" the active count set`,
      { countSetId: countSet.id, countSetName: countSet.name }
    );

    toast(`Active count set: ${countSet.name}`);
  } catch (error) {
    console.error(error);
    toast(firebaseWriteMessage(error), "error");
  }
}

function openNewCountSetModal(afterCreate = null) {
  const suggestedName = `Stock Received — ${new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  })}`;

  openModal(`
    <form id="newCountSetForm">
      <div class="modal-header">
        <div>
          <div class="eyebrow">NEW COUNT PERIOD</div>
          <h2>Create New Count Set</h2>
        </div>
        <button class="icon-btn" type="button" data-close-modal>×</button>
      </div>

      <div class="modal-body">
        <div class="count-set-explanation">
          <strong>The overall inventory will not be cleared.</strong>
          <p>
            Products entered in this new set will be added to the stock already on hand.
            The set keeps a separate record of what arrived during this period.
          </p>
        </div>

        <div class="form-grid">
          <div class="field full-span">
            <label for="countSetName">Count set name <em>*</em></label>
            <input id="countSetName" type="text" value="${escapeHtml(suggestedName)}" required>
          </div>

          <div class="field">
            <label for="countSetDate">Received / count date <em>*</em></label>
            <input id="countSetDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required>
          </div>

          <div class="field">
            <label for="countSetStatus">Status</label>
            <select id="countSetStatus">
              <option value="open">Open — allow items to be added</option>
              <option value="closed">Closed — record only</option>
            </select>
          </div>

          <div class="field full-span">
            <label for="countSetNotes">Notes</label>
            <textarea id="countSetNotes" rows="3" placeholder="Example: July container, supplier delivery, branch stock count"></textarea>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
        <button id="createCountSetButton" class="btn btn-primary" type="submit">Create & Start Count</button>
      </div>
    </form>
  `, true);

  $("newCountSetForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = $("countSetName").value.trim();
    const countDate = $("countSetDate").value;
    const status = $("countSetStatus").value === "closed" ? "closed" : "open";
    const notes = $("countSetNotes").value.trim();

    if (!name || !countDate) {
      toast("Enter the count set name and date.", "error");
      return;
    }

    const button = $("createCountSetButton");
    button.disabled = true;
    button.textContent = "Creating…";

    try {
      const countSetRef = push(ref(database, PATHS.countSets));
      const countSetId = countSetRef.key;

      const payload = {
        id: countSetId,
        name,
        countDate,
        notes,
        status,
        createdAt: serverTimestamp(),
        createdBy: state.user.uid,
        createdByName: state.profile?.displayName || "",
        updatedAt: serverTimestamp(),
        lineCount: 0,
        productCount: 0,
        totalCases: 0,
        totalUnits: 0,
        stockCost: 0,
        salesValue: 0,
        potentialProfit: 0
      };

      const updates = {};
      updates[`${PATHS.countSets}/${countSetId}`] = payload;

      if (status === "open") {
        updates[`${PATHS.settings}/activeCountSetId`] = countSetId;
        updates[`${PATHS.settings}/countDate`] = countDate;
      }

      await update(ref(database), updates);

      await addAudit(
        "count_set_created",
        `Created count set "${name}"`,
        { countSetId, countSetName: name, countDate }
      );

      closeModal();
      toast(`Count set created: ${name}`);

      if (typeof afterCreate === "function" && status === "open") {
        window.setTimeout(afterCreate, 150);
      }
    } catch (error) {
      console.error(error);
      toast(firebaseWriteMessage(error), "error");
      button.disabled = false;
      button.textContent = "Create & Start Count";
    }
  });
}

async function changeCountSetStatus(countSetId, nextStatus) {
  const countSet = state.countSets.find((entry) => entry.id === countSetId);
  if (!countSet) return;

  const closing = nextStatus === "closed";
  const approved = window.confirm(
    `${closing ? "Close" : "Reopen"} the count set "${countSet.name}"?`
  );
  if (!approved) return;

  const updates = {};
  updates[`${PATHS.countSets}/${countSetId}/status`] = closing ? "closed" : "open";
  updates[`${PATHS.countSets}/${countSetId}/updatedAt`] = serverTimestamp();

  if (closing && state.activeCountSetId === countSetId) {
    updates[`${PATHS.settings}/activeCountSetId`] = "";
  }

  try {
    await update(ref(database), updates);

    await addAudit(
      closing ? "count_set_closed" : "count_set_reopened",
      `${closing ? "Closed" : "Reopened"} count set "${countSet.name}"`,
      { countSetId, countSetName: countSet.name }
    );

    toast(`Count set ${closing ? "closed" : "reopened"}.`);
  } catch (error) {
    console.error(error);
    toast(firebaseWriteMessage(error), "error");
  }
}

function countSetExportRows(countSet) {
  return countSet.items.map((line, index) => ({
    "No.": index + 1,
    "Count Set": countSet.name,
    "Count Date": countSet.countDate,
    "Product Name": line.name,
    "Entry Source": entrySourceLabel(line.entrySource),
    "Category": line.category,
    "Size": line.size,
    "Cases Added": line.casesAdded,
    "Units Per Case": line.unitsPerCase,
    "Loose Units Added": line.looseUnitsAdded,
    "Total Units Added": line.totalUnitsAdded,
    "Case Cost": line.caseCost,
    "Case Selling Price": line.caseSellingPrice,
    "Unit Cost": line.unitCost,
    "Unit Selling Price": line.unitSellingPrice,
    "Stock Cost": line.stockCost,
    "Sales Value": line.salesValue,
    "Potential Profit": line.potentialProfit,
    "Supplier": line.supplier,
    "Notes": line.notes,
    "Added By": line.addedByName,
    "Added At": formatDateTime(line.addedAt)
  }));
}

function exportCountSet(countSetId) {
  openExportCountSetModal(countSetId);
}

function openExportCountSetModal(countSetId) {
  const countSet = state.countSets.find((entry) => entry.id === countSetId);

  if (!countSet || !countSet.items.length) {
    toast("This count set has no items to export.", "error");
    return;
  }

  const allColumns = [
    "No.", "Count Set", "Count Date", "Product Name", "Entry Source", "Category", "Size",
    "Cases Added", "Units Per Case", "Loose Units Added", "Total Units Added",
    "Case Cost", "Case Selling Price", "Unit Cost", "Unit Selling Price",
    "Stock Cost", "Sales Value", "Potential Profit", "Supplier", "Notes",
    "Added By", "Added At"
  ];

  openModal(`
    <div class="modal-header">
      <div>
        <div class="eyebrow">EXPORT</div>
        <h2>Choose Columns to Export</h2>
        <p class="muted">${escapeHtml(countSet.name)} · ${countSet.items.length} item${countSet.items.length === 1 ? "" : "s"}</p>
      </div>
      <button class="icon-btn" type="button" data-close-modal>×</button>
    </div>
    <div class="modal-body">
      <div class="export-col-actions">
        <button id="exportSelectAll" class="btn btn-secondary btn-small" type="button">Select All</button>
        <button id="exportDeselectAll" class="btn btn-secondary btn-small" type="button">Deselect All</button>
      </div>
      <ul class="export-col-list">
        ${allColumns.map((col) => `
          <li>
            <label class="export-col-item">
              <input type="checkbox" class="export-col-cb" value="${escapeHtml(col)}" checked>
              <span>${escapeHtml(col)}</span>
            </label>
          </li>
        `).join("")}
      </ul>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
      <button id="exportCountSetBtn" class="btn btn-primary" type="button">Export CSV</button>
      ${window.XLSX ? `<button id="exportCountSetXlsxBtn" class="btn btn-primary" type="button">Export Excel</button>` : ""}
    </div>
  `, true);

  const getSelected = () =>
    [...document.querySelectorAll(".export-col-cb:checked")].map((cb) => cb.value);

  $("exportSelectAll").addEventListener("click", () => {
    document.querySelectorAll(".export-col-cb").forEach((cb) => { cb.checked = true; });
  });
  $("exportDeselectAll").addEventListener("click", () => {
    document.querySelectorAll(".export-col-cb").forEach((cb) => { cb.checked = false; });
  });

  const doExport = (format) => {
    const selected = getSelected();
    if (!selected.length) { toast("Select at least one column.", "error"); return; }

    const allRows = countSetExportRows(countSet);
    const rows = allRows.map((row) => {
      const filtered = {};
      selected.forEach((col) => { filtered[col] = row[col] ?? ""; });
      return filtered;
    });

    const safeName = countSet.name.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");

    if (format === "xlsx" && window.XLSX) {
      const sheet = XLSX.utils.json_to_sheet(rows);
      sheet["!cols"] = selected.map((h) => ({ wch: Math.min(36, Math.max(12, h.length + 2)) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheet, "Count Set");
      XLSX.writeFile(wb, `Count_Set_${safeName || countSet.id}.xlsx`);
    } else {
      const csv = [
        selected.map(csvEscape).join(","),
        ...rows.map((row) => selected.map((col) => csvEscape(row[col])).join(","))
      ].join("\r\n");
      downloadBlob(`\uFEFF${csv}`, `Count_Set_${safeName || countSet.id}.csv`, "text/csv;charset=utf-8");
    }

    closeModal();
    addAudit("count_set_exported", `Exported count set "${countSet.name}"`, { countSetId });
  };

  $("exportCountSetBtn").addEventListener("click", () => doExport("csv"));
  $("exportCountSetXlsxBtn")?.addEventListener("click", () => doExport("xlsx"));
}

function openCountSetDetails(countSetId) {
  const countSet = state.countSets.find((entry) => entry.id === countSetId);
  if (!countSet) return;

  openModal(`
    <div class="modal-header">
      <div>
        <div class="eyebrow">COUNT SET DETAILS</div>
        <h2>${escapeHtml(countSet.name)}</h2>
        <p class="muted">
          ${escapeHtml(formatDate(countSet.countDate))}
          · ${countSet.status === "closed" ? "Closed" : "Open"}
          · ${formatNumber(countSet.totalUnits)} units added
        </p>
      </div>
      <button class="icon-btn" type="button" data-close-modal>×</button>
    </div>

    <div class="modal-body">
      ${countSet.notes ? `
        <div class="count-set-notes">${escapeHtml(countSet.notes)}</div>
      ` : ""}

      <div class="count-set-summary-grid">
        <div><span>Entries</span><strong>${formatNumber(countSet.lineCount)}</strong></div>
        <div><span>Cases Added</span><strong>${formatNumber(countSet.totalCases)}</strong></div>
        <div><span>Units Added</span><strong>${formatNumber(countSet.totalUnits)}</strong></div>
        <div><span>Stock Cost</span><strong>${formatMoney(countSet.stockCost)}</strong></div>
        <div><span>Sales Value</span><strong>${formatMoney(countSet.salesValue)}</strong></div>
        <div><span>Potential Profit</span><strong>${formatMoney(countSet.potentialProfit)}</strong></div>
      </div>

      <div class="table-scroll count-set-detail-scroll">
        <table class="data-table count-set-detail-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Size</th>
              <th class="number">Cases Added</th>
              <th class="number">Units/Case</th>
              <th class="number">Loose Added</th>
              <th class="number">Total Units</th>
              <th class="number">Stock Cost</th>
              <th class="number">Sales Value</th>
              <th>Added By</th>
              <th>Added At</th>
            </tr>
          </thead>
          <tbody>
            ${countSet.items.length ? countSet.items.map((line) => `
              <tr>
                <td><strong>${escapeHtml(line.name)}</strong> ${entrySourceBadge(line.entrySource)}</td>
                <td>${escapeHtml(line.size || "—")}</td>
                <td class="number">${formatNumber(line.casesAdded)}</td>
                <td class="number">${formatNumber(line.unitsPerCase)}</td>
                <td class="number">${formatNumber(line.looseUnitsAdded)}</td>
                <td class="number"><strong>${formatNumber(line.totalUnitsAdded)}</strong></td>
                <td class="number">${formatMoney(line.stockCost)}</td>
                <td class="number">${formatMoney(line.salesValue)}</td>
                <td>${escapeHtml(line.addedByName || "—")}</td>
                <td>${escapeHtml(formatDateTime(line.addedAt))}</td>
              </tr>
            `).join("") : `
              <tr>
                <td colspan="10">
                  <div class="empty-state compact-empty">
                    <h3>No items in this count set</h3>
                  </div>
                </td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn btn-secondary" type="button" data-close-modal>Close</button>
      ${countSet.items.length ? `
        <button id="exportOneCountSet" class="btn btn-secondary" type="button">Export CSV</button>
      ` : ""}
      ${countSet.status === "open" && canWriteInventory() ? `
        <button id="addToThisCountSet" class="btn btn-primary" type="button">Add Item to This Set</button>
      ` : ""}
    </div>
  `);

  $("exportOneCountSet")?.addEventListener("click", () => exportCountSet(countSet.id));

  $("addToThisCountSet")?.addEventListener("click", async () => {
    if (state.activeCountSetId !== countSet.id) {
      await activateCountSet(countSet.id);
    }
    closeModal();
    window.setTimeout(() => openItemModal(), 150);
  });
}

function renderCountSets() {
  const target = $("section-countsets");
  if (!target) return;

  const canWrite = canWriteInventory();
  const active = activeCountSet();
  const sortedSets = state.countSets.slice().sort((a, b) =>
    String(b.countDate).localeCompare(String(a.countDate)) ||
    number(b.createdAt) - number(a.createdAt)
  );

  const overall = sortedSets.reduce((acc, countSet) => {
    acc.sets += 1;
    acc.open += countSet.status === "open" ? 1 : 0;
    acc.units += countSet.totalUnits;
    acc.cost += countSet.stockCost;
    acc.value += countSet.salesValue;
    return acc;
  }, { sets: 0, open: 0, units: 0, cost: 0, value: 0 });

  target.innerHTML = `
    <section class="card count-set-hero">
      <div class="section-heading">
        <div>
          <div class="eyebrow">DELIVERY & COUNT PERIODS</div>
          <h2>Count Sets</h2>
          <p>
            Start a new set whenever more alcohol arrives. Every set is recorded separately,
            while the Overall Inventory combines the stock from all sets.
          </p>
        </div>

        <div class="section-actions">
          ${canWrite ? '<button id="newCountSetButton" class="btn btn-primary" type="button">＋ New Count Set</button>' : ""}
          <button id="viewOverallInventoryButton" class="btn btn-secondary" type="button">View Overall Inventory</button>
        </div>
      </div>

      <div class="active-count-set-card ${active ? "" : "no-active"}">
        <div>
          <span>Active Count Set</span>
          <strong>${escapeHtml(active?.name || "No active count set")}</strong>
          <small>
            ${active
              ? `${escapeHtml(formatDate(active.countDate))} · ${formatNumber(active.totalUnits)} units entered`
              : "Create or activate an open set before adding new stock."}
          </small>
        </div>

        ${active && canWrite ? `
          <button id="addActiveSetItemButton" class="btn btn-gold" type="button">Add Item to Active Set</button>
        ` : ""}
      </div>
    </section>

    <section class="kpi-grid">
      <article class="kpi-card"><span>Count Sets</span><strong>${formatNumber(overall.sets)}</strong></article>
      <article class="kpi-card"><span>Open Sets</span><strong>${formatNumber(overall.open)}</strong></article>
      <article class="kpi-card"><span>Units Added</span><strong>${formatNumber(overall.units)}</strong></article>
      <article class="kpi-card gold"><span>Recorded Stock Cost</span><strong>${formatMoney(overall.cost)}</strong></article>
      <article class="kpi-card gold"><span>Recorded Sales Value</span><strong>${formatMoney(overall.value)}</strong></article>
      <article class="kpi-card green"><span>Current Overall Units</span><strong>${formatNumber(totals().units)}</strong></article>
    </section>

    <section class="data-card card">
      ${sortedSets.length ? `
        <div class="table-scroll">
          <table class="data-table count-sets-table">
            <thead>
              <tr>
                <th>Count Set</th>
                <th>Date</th>
                <th>Status</th>
                <th class="number">Entries</th>
                <th class="number">Cases Added</th>
                <th class="number">Units Added</th>
                <th class="number">Stock Cost</th>
                <th class="number">Sales Value</th>
                <th>Created By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${sortedSets.map((countSet) => `
                <tr class="${state.activeCountSetId === countSet.id ? "active-count-set-row" : ""}">
                  <td>
                    <strong>${escapeHtml(countSet.name)}</strong>
                    ${state.activeCountSetId === countSet.id ? '<span class="active-set-label">ACTIVE</span>' : ""}
                  </td>
                  <td>${escapeHtml(formatDate(countSet.countDate))}</td>
                  <td>
                    <span class="count-set-status ${countSet.status}">
                      ${countSet.status === "closed" ? "Closed" : "Open"}
                    </span>
                  </td>
                  <td class="number">${formatNumber(countSet.lineCount)}</td>
                  <td class="number">${formatNumber(countSet.totalCases)}</td>
                  <td class="number"><strong>${formatNumber(countSet.totalUnits)}</strong></td>
                  <td class="number">${formatMoney(countSet.stockCost)}</td>
                  <td class="number">${formatMoney(countSet.salesValue)}</td>
                  <td>${escapeHtml(countSet.createdByName || "—")}</td>
                  <td>
                    <div class="table-actions">
                      <button class="row-btn view-count-set" type="button" data-id="${escapeHtml(countSet.id)}">View</button>
                      <button class="row-btn export-count-set" type="button" data-id="${escapeHtml(countSet.id)}">Export</button>
                      ${canWrite && countSet.status === "open" && state.activeCountSetId !== countSet.id ? `
                        <button class="row-btn activate-count-set" type="button" data-id="${escapeHtml(countSet.id)}">Set Active</button>
                      ` : ""}
                      ${canWrite ? `
                        <button
                          class="row-btn ${countSet.status === "open" ? "delete" : ""} change-count-set-status"
                          type="button"
                          data-id="${escapeHtml(countSet.id)}"
                          data-status="${countSet.status === "open" ? "closed" : "open"}"
                        >${countSet.status === "open" ? "Close" : "Reopen"}</button>
                      ` : ""}
                    </div>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `
        <div class="empty-state">
          <div class="icon">▣</div>
          <h3>No count sets yet</h3>
          <p>Create the first count set for the stock currently arriving.</p>
        </div>
      `}
    </section>
  `;

  $("newCountSetButton")?.addEventListener("click", () => openNewCountSetModal());
  $("viewOverallInventoryButton").addEventListener("click", () => showSection("alcohol"));
  $("addActiveSetItemButton")?.addEventListener("click", () => openItemModal());

  document.querySelectorAll(".view-count-set").forEach((button) => {
    button.addEventListener("click", () => openCountSetDetails(button.dataset.id));
  });

  document.querySelectorAll(".export-count-set").forEach((button) => {
    button.addEventListener("click", () => exportCountSet(button.dataset.id));
  });

  document.querySelectorAll(".activate-count-set").forEach((button) => {
    button.addEventListener("click", () => activateCountSet(button.dataset.id));
  });

  document.querySelectorAll(".change-count-set-status").forEach((button) => {
    button.addEventListener("click", () =>
      changeCountSetStatus(button.dataset.id, button.dataset.status)
    );
  });
}

function addProductWithMode(mode) {
  const active = activeCountSet();
  const openForm = () => openItemModal(null, null, null, mode);

  if (!active || active.status !== "open") {
    openNewCountSetModal(openForm);
    return;
  }

  openForm();
}

function filteredProductDirectory() {
  const search = state.productSearch.trim();
  const source = state.productSource;

  return state.items.filter((item) => {
    const matchesSource = source === "all" || normalizeEntrySource(item.entrySource) === source;
    const searchable = `${item.name} ${item.category} ${item.size} ${item.supplier} ${entrySourceLabel(item.entrySource)}`;
    return matchesSource && (!search || matchesSearchQuery(searchable, search));
  });
}

function renderProducts() {
  const target = $("section-products");
  if (!target) return;

  const canWrite = canWriteInventory();
  const counts = state.items.reduce((acc, item) => {
    const source = normalizeEntrySource(item.entrySource);
    acc[source] = (acc[source] || 0) + 1;
    acc.all += 1;
    return acc;
  }, { all: 0, catalog: 0, manual: 0, imported: 0, legacy: 0 });

  const products = filteredProductDirectory();
  const active = activeCountSet();

  target.innerHTML = `
    <section class="card product-manager-hero">
      <div class="section-heading">
        <div>
          <div class="eyebrow">PRODUCT ENTRY</div>
          <h2>Add & Manage Alcohol Products</h2>
          <p>
            Add a product from the Firebase master list or create it manually.
            Manual products are marked separately so you can always identify them.
          </p>
          <div class="product-sync-note">
            <span>Firebase status</span>
            <strong>${state.connected ? "Synced" : "Connecting…"}</strong>
            <small>Active count set: ${escapeHtml(active?.name || "None selected")}</small>
          </div>
        </div>

        <div class="product-entry-actions">
          ${canWrite ? '<button id="addCatalogProductButton" class="product-entry-card catalog" type="button"><span class="product-entry-icon">▦</span><strong>Add from Master List</strong><small>Search and select an existing alcohol product</small></button>' : ""}
          ${canWrite ? '<button id="addManualProductButton" class="product-entry-card manual" type="button"><span class="product-entry-icon">✎</span><strong>Add Product Manually</strong><small>Type a new product not found in the list</small></button>' : ""}
        </div>
      </div>
    </section>

    <section class="product-source-grid">
      <button class="product-source-stat ${state.productSource === "all" ? "active" : ""}" data-source="all" type="button"><span>All Products</span><strong>${formatNumber(counts.all)}</strong></button>
      <button class="product-source-stat ${state.productSource === "manual" ? "active" : ""}" data-source="manual" type="button"><span>Manual Products</span><strong>${formatNumber(counts.manual)}</strong></button>
      <button class="product-source-stat ${state.productSource === "catalog" ? "active" : ""}" data-source="catalog" type="button"><span>Master List</span><strong>${formatNumber(counts.catalog)}</strong></button>
      <button class="product-source-stat ${state.productSource === "imported" ? "active" : ""}" data-source="imported" type="button"><span>Uploaded</span><strong>${formatNumber(counts.imported)}</strong></button>
      <button class="product-source-stat ${state.productSource === "legacy" ? "active" : ""}" data-source="legacy" type="button"><span>Existing / Older</span><strong>${formatNumber(counts.legacy)}</strong></button>
    </section>

    <section class="data-card card product-directory-card">
      <div class="product-directory-toolbar">
        <div>
          <div class="eyebrow">PRODUCT DIRECTORY</div>
          <h3>${state.productSource === "manual" ? "Manually Added Products" : "All Saved Products"}</h3>
        </div>
        <input id="productDirectorySearch" type="search" placeholder="Search product, size or supplier" value="${escapeHtml(state.productSearch)}">
      </div>

      ${products.length ? `
        <div class="table-scroll product-directory-scroll">
          <table class="data-table product-directory-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Source</th>
                <th>Category</th>
                <th>Size</th>
                <th class="number">Stock Qty</th>
                <th>Supplier</th>
                <th>Added By</th>
                <th>Added On</th>
                ${canWrite ? "<th>Actions</th>" : ""}
              </tr>
            </thead>
            <tbody>
              ${products.map((item) => `
                <tr class="product-source-row ${normalizeEntrySource(item.entrySource)}">
                  <td><strong>${escapeHtml(item.name)}</strong></td>
                  <td>${entrySourceBadge(item.entrySource)}</td>
                  <td>${escapeHtml(item.category || "Other")}</td>
                  <td>${escapeHtml(item.size || "—")}</td>
                  <td class="number"><strong>${formatNumber(totalQty(item))}</strong></td>
                  <td>${escapeHtml(item.supplier || "—")}</td>
                  <td>${escapeHtml(item.createdByName || (item.entrySource === "manual" ? "Manual entry" : "—"))}</td>
                  <td>${escapeHtml(formatDateTime(item.createdAt))}</td>
                  ${canWrite ? `
                    <td>
                      <div class="table-actions">
                        <button class="row-btn product-add-stock" type="button" data-id="${escapeHtml(item.id)}">Add Stock</button>
                        <button class="row-btn product-edit" type="button" data-id="${escapeHtml(item.id)}">Edit</button>
                      </div>
                    </td>
                  ` : ""}
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `
        <div class="empty-state">
          <div class="icon">＋</div>
          <h3>${state.productSource === "manual" ? "No manual products yet" : "No products found"}</h3>
          <p>${state.productSource === "manual" ? "Products entered with the manual form will appear separately here." : "Change the filter or add a new product."}</p>
        </div>
      `}
    </section>
  `;

  $("addCatalogProductButton")?.addEventListener("click", () => addProductWithMode("catalog"));
  $("addManualProductButton")?.addEventListener("click", () => addProductWithMode("manual"));

  document.querySelectorAll(".product-source-stat").forEach((button) => {
    button.addEventListener("click", () => {
      state.productSource = button.dataset.source || "all";
      renderProducts();
    });
  });

  $("productDirectorySearch")?.addEventListener("input", (event) => {
    state.productSearch = event.target.value;
    renderProducts();
    const input = $("productDirectorySearch");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  document.querySelectorAll(".product-edit").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.items.find((entry) => entry.id === button.dataset.id);
      if (item) openItemModal(item);
    });
  });

  document.querySelectorAll(".product-add-stock").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.items.find((entry) => entry.id === button.dataset.id);
      if (!item) return;
      const activeSet = activeCountSet();
      const source = normalizeEntrySource(item.entrySource);
      const itemMode = source === "catalog" && item.catalogId
        ? "catalog"
        : source === "manual"
          ? "manual"
          : "combined";
      const openForm = () => openItemModal(null, item, null, itemMode);
      if (!activeSet || activeSet.status !== "open") {
        openNewCountSetModal(openForm);
      } else {
        openForm();
      }
    });
  });
}

function renderAlcohol() {
  const target = $("section-alcohol");
  if (!target) return;
  const canWrite = canWriteInventory();
  const sum = totals();
  const active = activeCountSet();

  target.innerHTML = `
    <section class="card">
      <div class="inventory-header">
        <div class="section-heading">
          <div>
            <div class="eyebrow">OVERALL ALCOHOL INVENTORY</div>
            <h2>${escapeHtml(state.settings.businessName || "Price King Distributors")}</h2>
            <p>
              This table shows the current stock from <strong>all count sets combined</strong>.
              · Master list:
              <strong>${state.catalogReady ? `${formatNumber(state.catalog.length)} choices` : "Loading…"}</strong>
              · ${escapeHtml(state.catalogSource)}
            </p>

            <div class="overall-active-set">
              <span>Active count set</span>
              <strong>${escapeHtml(active?.name || "None selected")}</strong>
              <small>
                ${active
                  ? `${escapeHtml(formatDate(active.countDate))} · New items will be recorded in this set`
                  : "Create a new count set before entering the next delivery."}
              </small>
            </div>
          </div>

          <div class="section-actions">
            ${canWrite ? '<button id="newCountSetTopButton" class="btn btn-gold" type="button">＋ New Count Set</button>' : ""}
            ${canWrite ? `<button id="addItemButton" class="btn btn-primary" type="button">${active ? "＋ Add to Active Set" : "＋ Add Item"}</button>` : ""}
            ${canWrite ? '<button id="openProductsButton" class="btn btn-secondary" type="button">Add / Manual Products</button>' : ""}
            <button id="openCountSetsButton" class="btn btn-secondary" type="button">View Count Sets</button>
            ${canWrite ? '<button id="masterListButton" class="btn btn-secondary" type="button">Master Alcohol List</button>' : ""}
            ${canWrite ? '<button id="importButton" class="btn btn-secondary" type="button">Upload Inventory</button>' : ""}
            ${canWrite ? '<button id="inventorySettingsButton" class="btn btn-secondary" type="button">Count Settings</button>' : ""}
            <button id="exportCsvButton" class="btn btn-secondary" type="button">Export CSV</button>
            <button id="exportExcelButton" class="btn btn-secondary" type="button">Export Excel</button>
            ${canWrite ? '<button id="saveSnapshotButton" class="btn btn-secondary" type="button">Save Overall Snapshot</button>' : ""}
          </div>
        </div>
      </div>
      <div class="toolbar">${inventoryFilters()}</div>
    </section>

    <section class="kpi-grid">
      <article class="kpi-card"><span>Products</span><strong>${formatNumber(sum.products)}</strong></article>
      <article class="kpi-card"><span>Total Units</span><strong>${formatNumber(sum.units)}</strong></article>
      <article class="kpi-card"><span>Full Cases</span><strong>${formatNumber(sum.cases)}</strong></article>
      <article class="kpi-card gold"><span>Stock Cost</span><strong>${formatMoney(sum.cost)}</strong></article>
      <article class="kpi-card gold"><span>Sales Value</span><strong>${formatMoney(sum.sales)}</strong></article>
      <article class="kpi-card green"><span>Potential Profit</span><strong>${formatMoney(sum.profit)}</strong></article>
    </section>

    <section class="table-card card">
      <div class="table-scroll">
        <table id="inventoryTable">
          <thead>
            <tr>
              <th class="sticky-name">Product Name</th>
              <th>Source</th>
              <th>Category</th>
              <th>Size</th>
              <th>Cases</th>
              <th>Units/Case</th>
              <th>Loose</th>
              <th>Total Qty</th>
              <th class="price-header">Case Cost</th>
              <th class="price-header">Case Markup</th>
              <th class="price-header">Case Selling</th>
              <th class="price-header">Unit Cost</th>
              <th class="price-header">Unit Markup</th>
              <th class="price-header">Unit Selling</th>
              <th>Stock Cost</th>
              <th>Sales Value</th>
              <th>Profit</th>
              <th>Supplier</th>
              ${canWrite ? "<th>Actions</th>" : ""}
            </tr>
          </thead>
          <tbody id="inventoryBody"></tbody>
          <tfoot id="inventoryFoot"></tfoot>
        </table>

        <div id="inventoryEmpty" class="empty-state hidden">
          <div class="icon">▦</div>
          <h3>No inventory items found</h3>
          <p>${canWrite ? "Select a product from the master list or upload an inventory file." : "No stock has been entered yet."}</p>
        </div>
      </div>

      <div class="pagination">
        <span id="paginationInfo"></span>
        <div>
          <button id="prevPage" class="btn btn-secondary btn-small" type="button">Previous</button>
          <span id="pageIndicator"></span>
          <button id="nextPage" class="btn btn-secondary btn-small" type="button">Next</button>
        </div>
      </div>
    </section>
  `;

  bindInventoryToolbar();
  renderInventoryRows();

  if (canWrite) {
    $("newCountSetTopButton").addEventListener("click", () => openNewCountSetModal());

    $("addItemButton").addEventListener("click", () => {
      const activeSet = activeCountSet();

      if (!activeSet || activeSet.status !== "open") {
        openNewCountSetModal(() => openItemModal());
        return;
      }

      openItemModal();
    });

    $("openProductsButton").addEventListener("click", () => showSection("products"));
    $("masterListButton").addEventListener("click", openMasterListModal);
    $("importButton").addEventListener("click", openImportModal);
    $("inventorySettingsButton").addEventListener("click", openInventorySettingsModal);
    $("saveSnapshotButton").addEventListener("click", saveCountSnapshot);
  }

  $("openCountSetsButton").addEventListener("click", openCountSets);
  $("exportCsvButton").addEventListener("click", exportCsv);
  $("exportExcelButton").addEventListener("click", exportExcel);
}

function bindInventoryToolbar() {
  $("inventorySearch").addEventListener("input", (event) => {
    state.search = event.target.value;
    state.page = 1;
    renderInventoryRows();
  });
  $("inventoryCategory").addEventListener("change", (event) => {
    state.category = event.target.value;
    state.page = 1;
    renderInventoryRows();
  });
  $("filterNotInSetBtn")?.addEventListener("click", () => {
    state.filterNotInSet = !state.filterNotInSet;
    state.page = 1;
    renderAlcohol();
  });
  $("pageSize").addEventListener("change", (event) => {
    state.pageSize = integer(event.target.value) || 50;
    state.page = 1;
    renderInventoryRows();
  });
  $("prevPage").addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      renderInventoryRows();
    }
  });
  $("nextPage").addEventListener("click", () => {
    const pages = Math.max(1, Math.ceil(filteredItems().length / state.pageSize));
    if (state.page < pages) {
      state.page += 1;
      renderInventoryRows();
    }
  });
}

function renderInventoryRows() {
  const body = $("inventoryBody");
  if (!body) return;

  const canWrite = canWriteInventory();
  const filtered = filteredItems();
  const pages = Math.max(1, Math.ceil(filtered.length / state.pageSize));

  if (state.page > pages) state.page = pages;

  const start = (state.page - 1) * state.pageSize;
  const rows = filtered.slice(start, start + state.pageSize);

  $("inventoryEmpty").classList.toggle("hidden", filtered.length > 0);
  $("inventoryTable").classList.toggle("hidden", filtered.length === 0);

  const inSetIds = activeSetItemIds();
  const active = activeCountSet();

  body.innerHTML = rows.map((item) => {
    const calc = calculate(item);
    const low = item.reorderLevel > 0 && calc.quantity <= item.reorderLevel;
    const inSet = !active || inSetIds.has(item.id);

    return `
      <tr class="${low ? "low-stock" : ""}${!inSet ? " not-in-set" : ""}">
        <td class="sticky-name" title="${escapeHtml(item.name)}">
          <div class="sticky-name-inner">
            ${canWrite ? `<button class="inline-edit-btn edit-item" data-id="${escapeHtml(item.id)}" type="button" title="Edit">✏</button>` : ""}
            <span>${escapeHtml(item.name)}${low ? ' <span class="low-badge">LOW</span>' : ""}${!inSet ? ' <span class="not-in-set-badge">NOT IN SET</span>' : ""}</span>
          </div>
        </td>
        <td>${entrySourceBadge(item.entrySource)}</td>
        <td>${escapeHtml(item.category)}</td>
        <td>${escapeHtml(item.size)}</td>
        <td>${formatNumber(item.cases)}</td>
        <td>${formatNumber(item.unitsPerCase)}</td>
        <td>${formatNumber(item.looseUnits)}</td>
        <td><strong>${formatNumber(calc.quantity)}</strong></td>
        <td class="price-cell">${formatMoney(calc.caseCostValue)}</td>
        <td class="price-cell">${formatNumber(calc.caseMarkup, 1)}%</td>
        <td class="price-cell">${formatMoney(calc.caseSellingValue)}</td>
        <td class="price-cell">${formatMoney(calc.costEach)}</td>
        <td class="price-cell">${formatNumber(calc.unitMarkup, 1)}%</td>
        <td class="price-cell">${formatMoney(calc.sellingEach)}</td>
        <td>${formatMoney(calc.stockCost)}</td>
        <td>${formatMoney(calc.salesValue)}</td>
        <td class="${calc.profit < 0 ? "negative" : "positive"}">${formatMoney(calc.profit)}</td>
        <td>${escapeHtml(item.supplier || "—")}</td>
        ${canWrite ? `
          <td>
            <div class="row-actions">
              ${!inSet && active ? `<button class="row-btn add-to-set" data-id="${escapeHtml(item.id)}" type="button">＋ Add to Set</button>` : ""}
              <button class="row-btn edit-item" data-id="${escapeHtml(item.id)}" type="button">Edit</button>
              <button class="row-btn delete delete-item" data-id="${escapeHtml(item.id)}" type="button">Delete</button>
            </div>
          </td>` : ""}
      </tr>
    `;
  }).join("");

  const filteredTotals = totals(filtered);

  $("inventoryFoot").innerHTML = filtered.length ? `
    <tr>
      <td colspan="4">FILTERED TOTAL</td>
      <td>${formatNumber(filteredTotals.cases)}</td>
      <td></td>
      <td></td>
      <td>${formatNumber(filteredTotals.units)}</td>
      <td colspan="6"></td>
      <td>${formatMoney(filteredTotals.cost)}</td>
      <td>${formatMoney(filteredTotals.sales)}</td>
      <td>${formatMoney(filteredTotals.profit)}</td>
      <td colspan="${canWrite ? 2 : 1}"></td>
    </tr>` : "";

  $("paginationInfo").textContent = filtered.length
    ? `Showing ${formatNumber(start + 1)}–${formatNumber(Math.min(start + state.pageSize, filtered.length))} of ${formatNumber(filtered.length)}`
    : "Showing 0 items";

  $("pageIndicator").textContent = `Page ${state.page} of ${pages}`;
  $("prevPage").disabled = state.page <= 1;
  $("nextPage").disabled = state.page >= pages;

  document.querySelectorAll(".edit-item").forEach((button) => {
    button.addEventListener("click", () =>
      openItemModal(state.items.find((item) => item.id === button.dataset.id))
    );
  });

  document.querySelectorAll(".add-to-set").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.items.find((entry) => entry.id === button.dataset.id);
      if (item) openSelectCountSetModal(item);
    });
  });

  document.querySelectorAll(".delete-item").forEach((button) => {
    button.addEventListener("click", () =>
      deleteInventoryItem(button.dataset.id)
    );
  });
}

function openModal(content, small = false) {
  const host = $("modalHost");
  host.innerHTML = `<div id="modalBackdrop" class="modal-backdrop"><section class="modal ${small ? "small" : ""}">${content}</section></div>`;
  $("modalBackdrop").addEventListener("mousedown", (event) => {
    if (event.target.id === "modalBackdrop") closeModal();
  });
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
}

function closeModal() {
  const host = $("modalHost");
  if (host) host.innerHTML = "";
}

function openInventorySettingsModal() {
  openModal(`
    <form id="inventorySettingsForm">
      <div class="modal-header">
        <div><div class="eyebrow">ALCOHOL INVENTORY</div><h2>Count Settings</h2></div>
        <button class="icon-btn" type="button" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="field full-span">
            <label for="settingsBusinessName">Business / report name</label>
            <input id="settingsBusinessName" type="text" maxlength="100" value="${escapeHtml(state.settings.businessName || "Price King Distributors")}">
          </div>
          <div class="field">
            <label for="settingsCountDate">Count date</label>
            <input id="settingsCountDate" type="date" value="${escapeHtml(state.settings.countDate || new Date().toISOString().slice(0,10))}">
          </div>
          <div class="field">
            <label for="settingsCurrency">Currency</label>
            <select id="settingsCurrency">
              ${["GYD","USD","CAD","TTD","JMD","BBD"].map((currency) => `<option value="${currency}" ${state.settings.currency === currency ? "selected" : ""}>${currency}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="settingsMarkup">Default markup %</label>
            <input id="settingsMarkup" type="number" min="0" step="0.01" value="${nonNegative(state.settings.defaultMarkup)}">
          </div>
          <div class="field">
            <label>Firebase synchronization</label>
            <input type="text" value="${state.connected ? "Connected and synchronized" : "Waiting for connection"}" readonly>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
        <button id="saveInventorySettings" class="btn btn-primary" type="submit">Save Settings</button>
      </div>
    </form>
  `, true);

  $("inventorySettingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      businessName: $("settingsBusinessName").value.trim() || "Price King Distributors",
      countDate: $("settingsCountDate").value || new Date().toISOString().slice(0,10),
      currency: $("settingsCurrency").value,
      defaultMarkup: nonNegative($("settingsMarkup").value),
      updatedAt: serverTimestamp(),
      updatedBy: state.user.uid
    };
    const button = $("saveInventorySettings");
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      await set(ref(database, PATHS.settings), payload);
      await addAudit("settings_updated", `Updated alcohol count settings for ${payload.countDate}`);
      closeModal();
      toast("Count settings saved and synchronized.");
    } catch (error) {
      toast(firebaseWriteMessage(error), "error");
      button.disabled = false;
      button.textContent = "Save Settings";
    }
  });
}


function countSetLineMatchesProduct(line, product) {
  const lineItemId = String(line?.itemId || "").trim();
  const productItemId = String(product?.itemId || product?.id || "").trim();

  if (lineItemId && productItemId && lineItemId === productItemId) return true;

  const lineCatalogId = String(line?.catalogId || "").trim();
  const productCatalogId = String(product?.catalogId || "").trim();

  if (lineCatalogId && productCatalogId && lineCatalogId === productCatalogId) return true;

  return (
    normalizeSearchText(line?.name) === normalizeSearchText(product?.name) &&
    normalizeSearchText(line?.size) === normalizeSearchText(product?.size)
  );
}

function countSetLineQuantity(line) {
  const recordedTotal = integer(line?.totalUnitsAdded);
  if (recordedTotal > 0) return recordedTotal;

  return (
    integer(line?.casesAdded) * integer(line?.unitsPerCase) +
    integer(line?.looseUnitsAdded)
  );
}

function firstPositiveLineValue(incomingValue, existingLines, field) {
  const incoming = nonNegative(incomingValue);
  if (incoming > 0) return incoming;

  for (const line of existingLines) {
    const value = nonNegative(line?.[field]);
    if (value > 0) return value;
  }

  return 0;
}

function mergeCountSetProductLines(existingLines, incomingLine, lineId) {
  const firstExisting = existingLines[0] || {};
  const existingQuantity = existingLines.reduce(
    (sum, line) => sum + countSetLineQuantity(line),
    0
  );
  const totalUnitsAdded = existingQuantity + countSetLineQuantity(incomingLine);

  const unitsPerCase =
    integer(incomingLine.unitsPerCase) ||
    existingLines.map((line) => integer(line.unitsPerCase)).find((value) => value > 0) ||
    0;

  const casesAdded = unitsPerCase > 0
    ? Math.floor(totalUnitsAdded / unitsPerCase)
    : 0;
  const looseUnitsAdded = unitsPerCase > 0
    ? totalUnitsAdded % unitsPerCase
    : totalUnitsAdded;

  const existingSource = existingLines
    .map((line) => normalizeEntrySource(line.entrySource))
    .find((source) => source !== "legacy");

  const existingAddedTimes = existingLines
    .map((line) => number(line.addedAt))
    .filter((value) => value > 0);

  return {
    id: lineId,
    itemId: String(incomingLine.itemId || firstExisting.itemId || ""),
    catalogId: String(incomingLine.catalogId || firstExisting.catalogId || ""),
    entrySource: existingSource || normalizeEntrySource(incomingLine.entrySource),
    name: String(incomingLine.name || firstExisting.name || "").trim(),
    category: String(incomingLine.category || firstExisting.category || "Other").trim(),
    size: String(incomingLine.size || firstExisting.size || "").trim(),
    casesAdded,
    unitsPerCase,
    looseUnitsAdded,
    totalUnitsAdded,
    caseCost: firstPositiveLineValue(incomingLine.caseCost, existingLines, "caseCost"),
    caseSellingPrice: firstPositiveLineValue(incomingLine.caseSellingPrice, existingLines, "caseSellingPrice"),
    unitCost: firstPositiveLineValue(incomingLine.unitCost, existingLines, "unitCost"),
    unitSellingPrice: firstPositiveLineValue(incomingLine.unitSellingPrice, existingLines, "unitSellingPrice"),
    stockCost:
      existingLines.reduce((sum, line) => sum + nonNegative(line.stockCost), 0) +
      nonNegative(incomingLine.stockCost),
    salesValue:
      existingLines.reduce((sum, line) => sum + nonNegative(line.salesValue), 0) +
      nonNegative(incomingLine.salesValue),
    potentialProfit:
      existingLines.reduce((sum, line) => sum + number(line.potentialProfit), 0) +
      number(incomingLine.potentialProfit),
    supplier: String(incomingLine.supplier || firstExisting.supplier || "").trim(),
    notes: String(incomingLine.notes || firstExisting.notes || "").trim(),
    addedAt: existingAddedTimes.length ? Math.min(...existingAddedTimes) : serverTimestamp(),
    addedBy: String(firstExisting.addedBy || incomingLine.addedBy || ""),
    addedByName: String(firstExisting.addedByName || incomingLine.addedByName || ""),
    lastAddedAt: serverTimestamp(),
    lastAddedBy: String(incomingLine.addedBy || ""),
    lastAddedByName: String(incomingLine.addedByName || ""),
    mergeCount:
      existingLines.reduce((sum, line) => sum + Math.max(1, integer(line.mergeCount)), 0) + 1,
    updatedAt: serverTimestamp()
  };
}

function summarizeCountSetLines(lines) {
  return lines.reduce((summary, line) => {
    summary.lineCount += 1;
    summary.productCount += 1;
    summary.totalCases += integer(line.casesAdded);
    summary.totalUnits += countSetLineQuantity(line);
    summary.stockCost += nonNegative(line.stockCost);
    summary.salesValue += nonNegative(line.salesValue);
    summary.potentialProfit += number(line.potentialProfit);
    return summary;
  }, {
    lineCount: 0,
    productCount: 0,
    totalCases: 0,
    totalUnits: 0,
    stockCost: 0,
    salesValue: 0,
    potentialProfit: 0
  });
}

async function prepareCountSetLineMerge(countSetId, incomingLine) {
  const countSetRef = ref(database, `${PATHS.countSets}/${countSetId}`);
  const snapshot = await get(countSetRef);

  if (!snapshot.exists()) {
    throw new Error("The selected count set could not be found.");
  }

  const latestCountSet = sanitizeCountSet(snapshot.val(), countSetId);

  if (latestCountSet.status !== "open") {
    throw new Error("The selected count set is not open.");
  }

  const matchingLines = latestCountSet.items.filter((line) =>
    countSetLineMatchesProduct(line, incomingLine)
  );

  const lineId = matchingLines[0]?.lineId ||
    push(ref(database, `${PATHS.countSets}/${countSetId}/items`)).key ||
    uid();

  const mergedLine = mergeCountSetProductLines(matchingLines, incomingLine, lineId);
  const remainingLines = latestCountSet.items.filter((line) =>
    !matchingLines.some((match) => match.lineId === line.lineId)
  );
  const finalLines = [...remainingLines, mergedLine];
  const summary = summarizeCountSetLines(finalLines);

  const updates = {};
  updates[`${PATHS.countSets}/${countSetId}/items/${lineId}`] = mergedLine;

  matchingLines.slice(1).forEach((duplicateLine) => {
    updates[`${PATHS.countSets}/${countSetId}/items/${duplicateLine.lineId}`] = null;
  });

  updates[`${PATHS.countSets}/${countSetId}/lineCount`] = summary.lineCount;
  updates[`${PATHS.countSets}/${countSetId}/productCount`] = summary.productCount;
  updates[`${PATHS.countSets}/${countSetId}/totalCases`] = summary.totalCases;
  updates[`${PATHS.countSets}/${countSetId}/totalUnits`] = summary.totalUnits;
  updates[`${PATHS.countSets}/${countSetId}/stockCost`] = summary.stockCost;
  updates[`${PATHS.countSets}/${countSetId}/salesValue`] = summary.salesValue;
  updates[`${PATHS.countSets}/${countSetId}/potentialProfit`] = summary.potentialProfit;
  updates[`${PATHS.countSets}/${countSetId}/updatedAt`] = serverTimestamp();

  return {
    updates,
    merged: matchingLines.length > 0,
    removedDuplicateLines: Math.max(0, matchingLines.length - 1),
    lineId,
    countSet: latestCountSet
  };
}

function openSelectCountSetModal(inventoryItem) {
  const sorted = state.countSets.slice().sort((a, b) =>
    String(b.countDate).localeCompare(String(a.countDate))
  );

  openModal(`
    <div class="modal-header">
      <div>
        <div class="eyebrow">CHOOSE COUNT SET</div>
        <h2>Add to Which Set?</h2>
      </div>
      <button class="icon-btn" type="button" data-close-modal>×</button>
    </div>
    <div class="modal-body">
      ${sorted.length === 0 ? `<p class="muted">No count sets found. Create one first.</p>` : `
      <ul class="count-set-picker">
        ${sorted.map((cs) => `
          <li>
            <button class="count-set-pick-btn${cs.status !== "open" ? " cs-pick-closed" : ""}" data-id="${escapeHtml(cs.id)}" type="button"${cs.status !== "open" ? " disabled" : ""}>
              <span class="cs-pick-name">${escapeHtml(cs.name)}</span>
              <span class="cs-pick-meta">
                <span class="count-set-status ${escapeHtml(cs.status)}">${cs.status === "open" ? "Open" : "Closed"}</span>
                ${escapeHtml(formatDate(cs.countDate))}
              </span>
            </button>
          </li>
        `).join("")}
      </ul>`}
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
      <button id="confirmAddToSetBtn" class="btn btn-primary" type="button" disabled>Save</button>
    </div>
  `, true);

  let selectedCountSetId = null;

  document.querySelectorAll(".count-set-pick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".count-set-pick-btn").forEach((b) => b.classList.remove("cs-pick-selected"));
      btn.classList.add("cs-pick-selected");
      selectedCountSetId = btn.dataset.id;
      $("confirmAddToSetBtn").disabled = false;
    });
  });

  $("confirmAddToSetBtn").addEventListener("click", async () => {
    const countSet = state.countSets.find((s) => s.id === selectedCountSetId);
    if (!countSet) return;
    const saveBtn = $("confirmAddToSetBtn");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const result = await quickSaveItemToCountSet(inventoryItem, countSet);
      closeModal();
      toast(
        result.merged
          ? `${inventoryItem.name} was already in "${countSet.name}". Its quantity was increased.`
          : `${inventoryItem.name} added to "${countSet.name}".`
      );
    } catch (err) {
      console.error(err);
      toast("Save failed. Please try again.", "error");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  });
}

async function quickSaveItemToCountSet(item, countSet) {
  const calc = calculate(item);

  const linePayload = {
    itemId: item.id,
    catalogId: item.catalogId || "",
    entrySource: normalizeEntrySource(item.entrySource),
    name: item.name,
    category: item.category || "",
    size: item.size || "",
    casesAdded: item.cases,
    unitsPerCase: item.unitsPerCase,
    looseUnitsAdded: item.looseUnits,
    totalUnitsAdded: calc.quantity,
    caseCost: calc.caseCostValue,
    caseSellingPrice: calc.caseSellingValue,
    unitCost: calc.costEach,
    unitSellingPrice: calc.sellingEach,
    stockCost: calc.stockCost,
    salesValue: calc.salesValue,
    potentialProfit: calc.profit,
    supplier: item.supplier || "",
    notes: item.notes || "",
    addedAt: serverTimestamp(),
    addedBy: state.user.uid,
    addedByName: state.profile?.displayName || ""
  };

  const mergeResult = await prepareCountSetLineMerge(countSet.id, linePayload);
  const updates = { ...mergeResult.updates };

  updates[`${PATHS.items}/${item.id}/lastCountSetId`] = countSet.id;
  updates[`${PATHS.items}/${item.id}/lastCountSetName`] = countSet.name;
  updates[`${PATHS.items}/${item.id}/updatedAt`] = serverTimestamp();

  await update(ref(database), updates);

  await addAudit(
    mergeResult.merged ? "item_quantity_increased_in_count_set" : "item_added_to_count_set",
    mergeResult.merged
      ? `Increased ${item.name} by ${calc.quantity} unit${calc.quantity === 1 ? "" : "s"} in "${countSet.name}"`
      : `Recorded ${calc.quantity} unit${calc.quantity === 1 ? "" : "s"} of ${item.name} in "${countSet.name}"`,
    {
      countSetId: countSet.id,
      countSetName: countSet.name,
      itemId: item.id,
      itemName: item.name,
      unitsAdded: calc.quantity,
      mergedIntoExistingLine: mergeResult.merged,
      removedDuplicateLines: mergeResult.removedDuplicateLines
    }
  );

  return mergeResult;
}

function openItemModal(item = null, prefill = null, targetCountSetId = null, productEntryMode = "combined") {
  const editing = Boolean(item);
  const current = editing
    ? sanitizeItem(item)
    : {
        id: "",
        catalogId: prefill?.catalogId || "",
        name: prefill?.name || "",
        category: prefill?.category || "",
        size: prefill?.size || "",
        brand: prefill?.brand || "",
        cases: 0,
        unitsPerCase: prefill?.unitsPerCase || 0,
        looseUnits: 0,
        caseCost: prefill?.caseCost || 0,
        caseMarkup: prefill?.caseMarkup || 0,
        caseSellingPrice: prefill?.caseSellingPrice || 0,
        unitCost: prefill?.unitCost || 0,
        unitMarkup: prefill?.unitMarkup || 0,
        sellingPrice: prefill?.sellingPrice || 0,
        supplier: prefill?.supplier || "",
        reorderLevel: prefill?.reorderLevel || 0,
        notes: prefill?.notes || "",
        entrySource: normalizeEntrySource(prefill?.entrySource || (prefill?.catalogId ? "catalog" : productEntryMode === "manual" ? "manual" : "legacy")),
        createdAt: prefill?.createdAt || Date.now(),
        createdBy: prefill?.createdBy || "",
        createdByName: prefill?.createdByName || ""
      };

  if (productEntryMode !== "manual" && !state.catalog.length) {
    loadBundledCatalogue();
  }

  const categoryChoices = [...new Set([
    "Rum",
    "Whisky / Whiskey",
    "Wine",
    "Beer / Stout / Malt",
    "Vodka",
    "Gin",
    "Tequila / Mezcal",
    "Brandy / Cognac / Pisco",
    "Champagne / Sparkling Wine",
    "Liqueur / Aperitif / Bitters",
    "Cider",
    "Ready-to-Drink / Coolers",
    "Sake / Soju / Asian Spirits",
    "Fortified Wine / Vermouth",
    "Specialty / Traditional Alcohol",
    "Other",
    ...state.catalog.map((catalogueItem) => catalogueItem.category)
  ])].filter(Boolean).sort();

  const currentCalc = calculate(current);
  const manualChoiceCount = state.items.filter(
    (savedItem) => normalizeEntrySource(savedItem.entrySource) === "manual"
  ).length;

  const targetCountSet = targetCountSetId
    ? state.countSets.find((s) => s.id === targetCountSetId)
    : activeCountSet();

  const recordingInLabel = !editing
    ? `<p class="muted">Recording in: <strong>${escapeHtml(targetCountSet?.name || "No count set selected")}</strong></p>`
    : "";

  openModal(`
    <form id="itemForm">
      <div class="modal-header">
        <div>
          <div class="eyebrow">${editing ? "OVERALL INVENTORY" : productEntryMode === "manual" ? "MANUAL PRODUCT" : productEntryMode === "catalog" ? "MASTER LIST PRODUCT" : "ACTIVE COUNT SET"}</div>
          <h2>${editing ? "Edit Overall Inventory Item" : productEntryMode === "manual" ? "Add Product Manually" : productEntryMode === "catalog" ? "Add from Master Alcohol List" : "Add Stock to Count Set"}</h2>
          ${recordingInLabel}
        </div>
        <button class="icon-btn" type="button" data-close-modal>×</button>
      </div>

      <div class="modal-body">
        <div class="form-grid">
          <div class="field full-span product-combobox">
            <label for="itemName">${productEntryMode === "manual" ? "Product name (manual entry)" : productEntryMode === "catalog" ? "Select product from master list" : "Select or type product"} <em>*</em></label>
            <input
              id="itemName"
              type="text"
              value="${escapeHtml(current.name)}"
              placeholder="${productEntryMode === "manual" ? "Type the complete product name" : "Start typing a product or brand, then press Enter"}"
              autocomplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="false"
              aria-controls="productSuggestions"
              required
            >
            <input id="itemCatalogId" type="hidden" value="${escapeHtml(current.catalogId)}">
            <div id="productSuggestions" class="autocomplete-menu hidden" role="listbox"></div>
            <span id="catalogueHelp" class="help-text">
              ${productEntryMode === "manual"
                ? "This product will be saved with a MANUAL label and synchronized to Firebase."
                : productEntryMode === "catalog"
                  ? state.catalog.length
                    ? `${formatNumber(state.catalog.length)} master-list choices available. Use ↑ ↓ and Enter.`
                    : "Loading the master alcohol list…"
                  : state.catalog.length || manualChoiceCount
                    ? `${formatNumber(state.catalog.length)} master-list choices${manualChoiceCount ? ` + ${formatNumber(manualChoiceCount)} manually saved product${manualChoiceCount === 1 ? "" : "s"}` : ""}. Use ↑ ↓ and Enter.`
                    : "Loading saved products and the master alcohol list…"}
            </span>
          </div>

          <div class="field">
            <label for="itemCategory">Category</label>
            <input id="itemCategory" type="text" list="categoryOptions" value="${escapeHtml(current.category)}">
            <datalist id="categoryOptions">
              ${categoryChoices.map((category) => `<option value="${escapeHtml(category)}"></option>`).join("")}
            </datalist>
          </div>

          <div class="field">
            <label for="itemSize">Bottle size</label>
            <input id="itemSize" type="text" value="${escapeHtml(current.size)}" placeholder="750 ml">
          </div>

          <section class="quantity-box full-span">
            <h3 class="box-title">Stock Count</h3>
            <div class="form-grid four">
              <div class="field">
                <label for="itemCases">Number of cases</label>
                <input id="itemCases" type="number" min="0" step="1" value="${editing ? current.cases : ""}">
              </div>
              <div class="field">
                <label for="itemUnitsPerCase">Units in each case</label>
                <input id="itemUnitsPerCase" type="number" min="0" step="1" value="${editing ? current.unitsPerCase : ""}">
              </div>
              <div class="field quick-stock-field">
                <label for="itemLooseUnits">Loose units</label>

                <div class="quick-stock-input">
                  <input
                    id="itemLooseUnits"
                    type="number"
                    min="0"
                    step="1"
                    value="${editing ? current.looseUnits : ""}"
                  >
                  <button
                    id="openLooseQuickAdd"
                    class="quick-stock-plus"
                    type="button"
                    title="Add more loose units"
                    aria-label="Add more loose units"
                    aria-expanded="false"
                    aria-controls="looseQuickAddPanel"
                  >＋</button>
                </div>

                <div id="looseQuickAddPanel" class="quick-add-panel hidden">
                  <div class="quick-add-copy">
                    <strong>Add loose stock</strong>
                    <span>Enter only the extra quantity received.</span>
                  </div>

                  <div class="quick-add-actions">
                    <input
                      id="looseQuickAddAmount"
                      type="number"
                      min="1"
                      step="1"
                      inputmode="numeric"
                      placeholder="Example: 5"
                      aria-label="Extra loose units to add"
                    >
                    <button id="confirmLooseQuickAdd" class="btn btn-primary btn-small" type="button">
                      Add to Stock
                    </button>
                    <button id="cancelLooseQuickAdd" class="btn btn-secondary btn-small" type="button">
                      Cancel
                    </button>
                  </div>

                  <div id="looseQuickAddMessage" class="quick-add-message hidden"></div>
                </div>
              </div>
              <div class="total-units-display">
                <label>Total units</label>
                <div class="total-units-value" id="formTotalQtyInline">${editing ? formatNumber(currentCalc.quantity) : "—"}</div>
              </div>
            </div>

            <div class="calc-strip">
              <div class="calc-item"><span>Total Quantity</span><strong id="formTotalQty">${editing ? formatNumber(currentCalc.quantity) : ""}</strong></div>
              <div class="calc-item"><span>Full Cases</span><strong id="formCases">${editing ? formatNumber(current.cases) : ""}</strong></div>
              <div class="calc-item"><span>Loose Units</span><strong id="formLoose">${editing ? formatNumber(current.looseUnits) : ""}</strong></div>
            </div>
          </section>

          <section class="price-box full-span">
            <h3 class="box-title">Case Pricing</h3>

            <div class="pricing-grid">
              <div class="field">
                <label for="itemCaseCost">Cost price per case</label>
                <input id="itemCaseCost" type="number" min="0" step="0.01" value="${current.caseCost || ""}" placeholder="">
              </div>

              <div class="field">
                <label for="itemCaseMarkup">Case markup %</label>
                <input id="itemCaseMarkup" type="number" min="0" step="0.01" value="${editing && (currentCalc.caseMarkup || current.caseMarkup) ? (currentCalc.caseMarkup || current.caseMarkup) : ""}">
              </div>

              <div class="field">
                <label for="itemCaseSelling">Selling price per case</label>
                <input id="itemCaseSelling" type="number" min="0" step="0.01" value="${current.caseSellingPrice || ""}" placeholder="">
              </div>

              <button id="applyCaseMarkup" class="btn btn-primary pricing-apply" type="button">Apply Case Markup</button>
            </div>

            <div class="calc-strip">
              <div class="calc-item"><span>Case Cost</span><strong id="formCaseCost">${editing ? formatMoney(currentCalc.caseCostValue) : ""}</strong></div>
              <div class="calc-item"><span>Case Selling</span><strong id="formCaseSelling">${editing ? formatMoney(currentCalc.caseSellingValue) : ""}</strong></div>
              <div class="calc-item"><span>Profit Per Case</span><strong id="formCaseProfit">${editing ? formatMoney(currentCalc.caseProfit) : ""}</strong></div>
            </div>
          </section>

          <section class="price-box full-span">
            <h3 class="box-title">Single-Unit Pricing</h3>

            <div class="pricing-grid">
              <div class="field">
                <label for="itemUnitCost">Cost price for one</label>
                <input id="itemUnitCost" type="number" min="0" step="0.01" value="${current.unitCost || ""}" placeholder="">
              </div>

              <div class="field">
                <label for="itemUnitMarkup">Unit markup %</label>
                <input id="itemUnitMarkup" type="number" min="0" step="0.01" value="${editing && (currentCalc.unitMarkup || current.unitMarkup) ? (currentCalc.unitMarkup || current.unitMarkup) : ""}">
              </div>

              <div class="field">
                <label for="itemSellingPrice">Selling price for one</label>
                <input id="itemSellingPrice" type="number" min="0" step="0.01" value="${current.sellingPrice || ""}" placeholder="">
              </div>

              <button id="applyUnitMarkup" class="btn btn-primary pricing-apply" type="button">Apply Unit Markup</button>
            </div>

            <div class="calc-strip">
              <div class="calc-item"><span>Unit Cost</span><strong id="formUnitCost">${editing ? formatMoney(currentCalc.costEach) : ""}</strong></div>
              <div class="calc-item"><span>Unit Selling</span><strong id="formUnitSelling">${editing ? formatMoney(currentCalc.sellingEach) : ""}</strong></div>
              <div class="calc-item"><span>Profit Per Unit</span><strong id="formUnitProfit">${editing ? formatMoney(currentCalc.unitProfit) : ""}</strong></div>
            </div>
          </section>

          <section class="quantity-box full-span">
            <div class="calc-strip total-preview-strip">
              <div class="calc-item"><span>Total Stock Cost</span><strong id="formStockCost">${editing ? formatMoney(currentCalc.stockCost) : ""}</strong></div>
              <div class="calc-item"><span>Total Sales Value</span><strong id="formSalesValue">${editing ? formatMoney(currentCalc.salesValue) : ""}</strong></div>
              <div class="calc-item"><span>Potential Profit</span><strong id="formProfit">${editing ? formatMoney(currentCalc.profit) : ""}</strong></div>
            </div>
          </section>

          <div class="field">
            <label for="itemSupplier">Supplier</label>
            <input id="itemSupplier" type="text" value="${escapeHtml(current.supplier)}" placeholder="Optional">
          </div>

          <div class="field">
            <label for="itemReorder">Reorder level</label>
            <input id="itemReorder" type="number" min="0" step="1" value="${editing ? current.reorderLevel : ""}">
          </div>

          <div class="field full-span">
            <label for="itemNotes">Notes</label>
            <textarea id="itemNotes" rows="2">${escapeHtml(current.notes)}</textarea>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
        <button id="saveItemButton" class="btn btn-primary" type="submit">${editing ? "Save Changes" : "Add Item"}</button>
      </div>
    </form>
  `);

  // New items must always begin with completely blank quantity and pricing fields.
  // This explicit reset also protects against stale browser state or an older
  // cached form value being restored by the browser.
  if (!editing) {
    const blankNumericFieldIds = [
      "itemCases",
      "itemUnitsPerCase",
      "itemLooseUnits",
      "itemCaseCost",
      "itemCaseMarkup",
      "itemCaseSelling",
      "itemUnitCost",
      "itemUnitMarkup",
      "itemSellingPrice",
      "itemReorder"
    ];

    blankNumericFieldIds.forEach((id) => {
      const field = $(id);
      if (!field) return;
      field.value = "";
      field.defaultValue = "";
      field.removeAttribute("value");
      field.setAttribute("autocomplete", "off");
    });

    const blankCalculationIds = [
      "formTotalQty",
      "formCases",
      "formLoose",
      "formCaseCost",
      "formCaseSelling",
      "formCaseProfit",
      "formUnitCost",
      "formUnitSelling",
      "formUnitProfit",
      "formStockCost",
      "formSalesValue",
      "formProfit"
    ];

    blankCalculationIds.forEach((id) => {
      const output = $(id);
      if (output) output.textContent = "";
    });
  }

  let suggestions = [];
  let activeSuggestion = -1;
  let selectedInventoryItemId = "";

  const suggestionMenu = $("productSuggestions");
  const productInput = $("itemName");

  const hideSuggestions = () => {
    suggestions = [];
    activeSuggestion = -1;
    suggestionMenu.innerHTML = "";
    suggestionMenu.classList.add("hidden");
    productInput.setAttribute("aria-expanded", "false");
  };

  const chooseSuggestion = (suggestedItem) => {
    if (!suggestedItem) return;

    const suggestionSource = normalizeEntrySource(suggestedItem.entrySource || "catalog");
    selectedInventoryItemId = suggestionSource === "manual"
      ? String(suggestedItem.inventoryItemId || suggestedItem.id || "")
      : "";

    $("itemCatalogId").value = suggestionSource === "catalog"
      ? String(suggestedItem.catalogId || suggestedItem.id || "")
      : "";

    productInput.value = suggestedItem.name;
    $("itemCategory").value = suggestedItem.category || "Other";
    $("itemSize").value = suggestedItem.size || "";

    if (suggestionSource === "manual") {
      const savedValues = {
        itemUnitsPerCase: suggestedItem.unitsPerCase,
        itemCaseCost: suggestedItem.caseCost,
        itemCaseMarkup: suggestedItem.caseMarkup,
        itemCaseSelling: suggestedItem.caseSellingPrice,
        itemUnitCost: suggestedItem.unitCost,
        itemUnitMarkup: suggestedItem.unitMarkup,
        itemSellingPrice: suggestedItem.sellingPrice,
        itemSupplier: suggestedItem.supplier,
        itemReorder: suggestedItem.reorderLevel,
        itemNotes: suggestedItem.notes
      };

      Object.entries(savedValues).forEach(([fieldId, value]) => {
        const field = $(fieldId);
        if (!field) return;
        if (typeof value === "number" && value <= 0) return;
        if (value === null || value === undefined || String(value).trim() === "") return;
        field.value = value;
      });
    }

    hideSuggestions();
    preview();
    $("itemCases").focus();
  };

  const renderSuggestions = () => {
    if (productEntryMode === "manual") {
      hideSuggestions();
      return;
    }

    const query = productInput.value;
    suggestions = catalogueSearch(query, 18, {
      includeManual: productEntryMode === "combined"
    });

    if (!query.trim()) {
      hideSuggestions();
      return;
    }

    if (!suggestions.length) {
      suggestionMenu.innerHTML = `
        <div class="autocomplete-empty">
          ${productEntryMode === "catalog"
            ? "No master-list match."
            : "No saved or master-list product matches. You may continue with the name you typed."}
        </div>`;
      suggestionMenu.classList.remove("hidden");
      productInput.setAttribute("aria-expanded", "true");
      return;
    }

    if (activeSuggestion < 0 || activeSuggestion >= suggestions.length) {
      activeSuggestion = 0;
    }

    suggestionMenu.innerHTML = suggestions.map((suggestedItem, index) => `
      <button
        class="autocomplete-option ${index === activeSuggestion ? "active" : ""}"
        type="button"
        role="option"
        aria-selected="${index === activeSuggestion}"
        data-index="${index}"
      >
        <span class="autocomplete-name">${escapeHtml(suggestedItem.name)}</span>
        <span class="autocomplete-meta">
          ${entrySourceBadge(suggestedItem.entrySource || "catalog")}
          ${escapeHtml(suggestedItem.size || "Size not listed")}
          · ${escapeHtml(suggestedItem.category)}
          ${suggestedItem.brand ? ` · ${escapeHtml(suggestedItem.brand)}` : ""}
        </span>
      </button>
    `).join("");

    suggestionMenu.classList.remove("hidden");
    productInput.setAttribute("aria-expanded", "true");

    suggestionMenu.querySelectorAll(".autocomplete-option").forEach((button) => {
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        chooseSuggestion(suggestions[integer(button.dataset.index)]);
      });
    });
  };

  productInput.addEventListener("input", () => {
    $("itemCatalogId").value = "";
    selectedInventoryItemId = "";
    activeSuggestion = 0;
    if (productEntryMode !== "manual") renderSuggestions();
  });

  productInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!suggestions.length) renderSuggestions();
      activeSuggestion = Math.min(activeSuggestion + 1, suggestions.length - 1);
      renderSuggestions();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      activeSuggestion = Math.max(activeSuggestion - 1, 0);
      renderSuggestions();
      return;
    }

    if (event.key === "Enter") {
      if (productEntryMode === "manual") {
        event.preventDefault();
        hideSuggestions();
        $("itemCases").focus();
      } else if (suggestions.length) {
        event.preventDefault();
        chooseSuggestion(suggestions[Math.max(activeSuggestion, 0)]);
      } else {
        event.preventDefault();
        hideSuggestions();
        $("itemCases").focus();
      }
      return;
    }

    if (event.key === "Escape") {
      hideSuggestions();
    }
  });

  if (productEntryMode !== "manual") productInput.addEventListener("focus", renderSuggestions);
  productInput.addEventListener("blur", () => {
    window.setTimeout(hideSuggestions, 150);
  });

  const formValues = () => ({
    cases: integer($("itemCases").value),
    unitsPerCase: integer($("itemUnitsPerCase").value),
    looseUnits: integer($("itemLooseUnits").value),
    caseCost: nonNegative($("itemCaseCost").value),
    caseMarkup: nonNegative($("itemCaseMarkup").value),
    caseSellingPrice: nonNegative($("itemCaseSelling").value),
    unitCost: nonNegative($("itemUnitCost").value),
    unitMarkup: nonNegative($("itemUnitMarkup").value),
    sellingPrice: nonNegative($("itemSellingPrice").value)
  });

  const preview = () => {
    const temp = formValues();
    const calc = calculate(temp);
    const hasValue = (id) => String($(id).value ?? "").trim() !== "";

    const hasCases = hasValue("itemCases");
    const hasUnitsPerCase = hasValue("itemUnitsPerCase");
    const hasLooseUnits = hasValue("itemLooseUnits");
    const hasStockQuantity = hasCases || hasLooseUnits;

    const hasCaseCost = hasValue("itemCaseCost");
    const hasCaseMarkup = hasValue("itemCaseMarkup");
    const hasCaseSelling = hasValue("itemCaseSelling");
    const hasCasePricing = hasCaseCost || hasCaseMarkup || hasCaseSelling;

    const hasUnitCost = hasValue("itemUnitCost");
    const hasUnitMarkup = hasValue("itemUnitMarkup");
    const hasUnitSelling = hasValue("itemSellingPrice");
    const hasUnitPricing = hasUnitCost || hasUnitMarkup || hasUnitSelling;

    const hasAnyPricing = hasCasePricing || hasUnitPricing;
    const hasAnyEntry =
      hasCases ||
      hasUnitsPerCase ||
      hasLooseUnits ||
      hasAnyPricing;

    $("formTotalQty").textContent = hasStockQuantity
      ? formatNumber(calc.quantity)
      : "";
    const inlineTotal = $("formTotalQtyInline");
    if (inlineTotal) inlineTotal.textContent = hasStockQuantity ? formatNumber(calc.quantity) : "—";

    $("formCases").textContent = hasCases
      ? formatNumber(temp.cases)
      : "";

    $("formLoose").textContent = hasLooseUnits
      ? formatNumber(temp.looseUnits)
      : "";

    $("formCaseCost").textContent = hasCasePricing
      ? formatMoney(calc.caseCostValue)
      : "";

    $("formCaseSelling").textContent = hasCasePricing
      ? formatMoney(calc.caseSellingValue)
      : "";

    $("formCaseProfit").textContent = hasCasePricing
      ? formatMoney(calc.caseProfit)
      : "";

    $("formUnitCost").textContent = hasUnitPricing || (hasCaseCost && hasUnitsPerCase)
      ? formatMoney(calc.costEach)
      : "";

    $("formUnitSelling").textContent = hasUnitPricing
      ? formatMoney(calc.sellingEach)
      : "";

    $("formUnitProfit").textContent = hasUnitPricing
      ? formatMoney(calc.unitProfit)
      : "";

    $("formStockCost").textContent = hasStockQuantity && hasAnyPricing
      ? formatMoney(calc.stockCost)
      : "";

    $("formSalesValue").textContent = hasStockQuantity && hasAnyPricing
      ? formatMoney(calc.salesValue)
      : "";

    $("formProfit").textContent = hasStockQuantity && hasAnyPricing
      ? formatMoney(calc.profit)
      : "";

    document.querySelectorAll("#itemForm .calc-item").forEach((card) => {
      const value = card.querySelector("strong")?.textContent?.trim();
      card.classList.toggle("calculation-empty", !value && !hasAnyEntry);
    });
  };

  [
    "itemCases",
    "itemUnitsPerCase",
    "itemLooseUnits",
    "itemCaseCost",
    "itemCaseMarkup",
    "itemCaseSelling",
    "itemUnitCost",
    "itemUnitMarkup",
    "itemSellingPrice"
  ].forEach((id) => $(id).addEventListener("input", preview));

  const autoCalcCases = () => {
    const unitsPerCase = integer($("itemUnitsPerCase").value);
    const loose = integer($("itemLooseUnits").value);
    if (unitsPerCase > 0 && loose >= unitsPerCase) {
      const extraCases = Math.floor(loose / unitsPerCase);
      const remaining = loose % unitsPerCase;
      const existingCases = integer($("itemCases").value);
      $("itemCases").value = existingCases + extraCases;
      $("itemLooseUnits").value = remaining;
      preview();
    }
  };

  $("itemLooseUnits").addEventListener("change", autoCalcCases);
  $("itemUnitsPerCase").addEventListener("change", autoCalcCases);

  const looseQuickAddPanel = $("looseQuickAddPanel");
  const looseQuickAddAmount = $("looseQuickAddAmount");
  const looseQuickAddMessage = $("looseQuickAddMessage");
  const openLooseQuickAdd = $("openLooseQuickAdd");

  const closeLooseQuickAdd = () => {
    looseQuickAddPanel.classList.add("hidden");
    openLooseQuickAdd.setAttribute("aria-expanded", "false");
    looseQuickAddAmount.value = "";
  };

  const showLooseQuickAdd = () => {
    looseQuickAddPanel.classList.remove("hidden");
    openLooseQuickAdd.setAttribute("aria-expanded", "true");
    looseQuickAddMessage.classList.add("hidden");
    looseQuickAddMessage.textContent = "";
    window.setTimeout(() => looseQuickAddAmount.focus(), 0);
  };

  const addLooseStock = () => {
    const amountToAdd = integer(looseQuickAddAmount.value);

    if (amountToAdd <= 0) {
      looseQuickAddMessage.textContent = "Enter how many loose units you want to add.";
      looseQuickAddMessage.className = "quick-add-message error";
      looseQuickAddAmount.focus();
      return;
    }

    const previousLooseUnits = integer($("itemLooseUnits").value);
    const updatedLooseUnits = previousLooseUnits + amountToAdd;

    $("itemLooseUnits").value = updatedLooseUnits;
    preview();

    looseQuickAddMessage.textContent =
      `${formatNumber(previousLooseUnits)} + ${formatNumber(amountToAdd)} = ${formatNumber(updatedLooseUnits)} loose units`;

    looseQuickAddMessage.className = "quick-add-message success";
    looseQuickAddAmount.value = "";

    toast(
      `${formatNumber(amountToAdd)} loose unit${amountToAdd === 1 ? "" : "s"} added. New loose quantity: ${formatNumber(updatedLooseUnits)}.`
    );

    window.setTimeout(() => {
      closeLooseQuickAdd();
      $("itemLooseUnits").focus();
    }, 850);
  };

  openLooseQuickAdd.addEventListener("click", () => {
    if (looseQuickAddPanel.classList.contains("hidden")) {
      showLooseQuickAdd();
    } else {
      closeLooseQuickAdd();
    }
  });

  $("confirmLooseQuickAdd").addEventListener("click", addLooseStock);
  $("cancelLooseQuickAdd").addEventListener("click", closeLooseQuickAdd);

  looseQuickAddAmount.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addLooseStock();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeLooseQuickAdd();
      openLooseQuickAdd.focus();
    }
  });

  $("applyCaseMarkup").addEventListener("click", () => {
    const caseCost = resolvedCaseCost(formValues());
    if (caseCost <= 0) {
      toast("Enter the case cost first.", "error");
      return;
    }
    if (!String($("itemCaseMarkup").value ?? "").trim()) {
      toast("Enter the case markup percentage.", "error");
      $("itemCaseMarkup").focus();
      return;
    }
    const markup = nonNegative($("itemCaseMarkup").value);
    $("itemCaseSelling").value = (caseCost * (1 + markup / 100)).toFixed(2);
    preview();
  });

  $("applyUnitMarkup").addEventListener("click", () => {
    const costEach = resolvedUnitCost(formValues());
    if (costEach <= 0) {
      toast("Enter the unit cost or the case cost and units per case first.", "error");
      return;
    }
    if (!String($("itemUnitMarkup").value ?? "").trim()) {
      toast("Enter the unit markup percentage.", "error");
      $("itemUnitMarkup").focus();
      return;
    }
    const markup = nonNegative($("itemUnitMarkup").value);
    $("itemSellingPrice").value = (costEach * (1 + markup / 100)).toFixed(2);
    preview();
  });

  preview();

  $("itemForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = productInput.value.trim();

    if (!name) {
      toast("Select or type a product name.", "error");
      productInput.focus();
      return;
    }

    if (!editing && productEntryMode === "catalog" && !$("itemCatalogId").value) {
      toast("Select a product from the master list before saving.", "error");
      productInput.focus();
      renderSuggestions();
      return;
    }

    const values = formValues();
    const incomingItem = {
      cases: values.cases,
      unitsPerCase: values.unitsPerCase,
      looseUnits: values.looseUnits,
      caseCost: values.caseCost,
      caseMarkup: values.caseMarkup,
      caseSellingPrice: values.caseSellingPrice,
      unitCost: values.unitCost,
      unitMarkup: values.unitMarkup,
      sellingPrice: values.sellingPrice
    };
    const incomingCalc = calculate(incomingItem);

    if (!editing && incomingCalc.quantity <= 0) {
      toast("Enter the cases or loose units received.", "error");
      return;
    }

    const saveButton = $("saveItemButton");
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";

    try {
      if (editing) {
        const itemId = current.id;

        const payload = {
          id: itemId,
          catalogId: $("itemCatalogId").value,
          name,
          category: $("itemCategory").value.trim() || "Other",
          size: $("itemSize").value.trim(),
          cases: values.cases,
          unitsPerCase: values.unitsPerCase,
          looseUnits: values.looseUnits,
          caseCost: values.caseCost,
          caseMarkup: values.caseMarkup,
          caseSellingPrice: values.caseSellingPrice,
          unitCost: values.unitCost,
          unitMarkup: values.unitMarkup,
          sellingPrice: values.sellingPrice,
          supplier: $("itemSupplier").value.trim(),
          reorderLevel: integer($("itemReorder").value),
          notes: $("itemNotes").value.trim(),
          entrySource: normalizeEntrySource(current.entrySource),
          manualAdded: normalizeEntrySource(current.entrySource) === "manual",
          createdAt: current.createdAt || serverTimestamp(),
          createdBy: current.createdBy || state.user.uid,
          createdByName: current.createdByName || state.profile?.displayName || "",
          lastCountSetId: current.lastCountSetId || "",
          lastCountSetName: current.lastCountSetName || "",
          updatedAt: serverTimestamp(),
          updatedBy: state.user.uid
        };

        await set(ref(database, `${PATHS.items}/${itemId}`), payload);

        await addAudit(
          "item_updated",
          `Updated ${name}`,
          { itemId, itemName: name }
        );

        closeModal();
        toast("Overall inventory item updated.");
        return;
      }

      const countSet = targetCountSetId
        ? state.countSets.find((s) => s.id === targetCountSetId)
        : activeCountSet();

      if (!countSet || countSet.status !== "open") {
        toast("The selected count set is not open.", "error");
        saveButton.disabled = false;
        saveButton.textContent = "Add Item";
        return;
      }

      const catalogId = $("itemCatalogId").value;
      const size = $("itemSize").value.trim();
      const normalizedName = normalizeSearchText(name);
      const normalizedSize = normalizeSearchText(size);

      const selectedSavedItem = selectedInventoryItemId
        ? state.items.find((savedItem) => savedItem.id === selectedInventoryItemId)
        : null;

      const existingItem = selectedSavedItem || state.items.find((item) => {
        if (catalogId && item.catalogId && item.catalogId === catalogId) return true;

        return (
          normalizeSearchText(item.name) === normalizedName &&
          normalizeSearchText(item.size) === normalizedSize
        );
      }) || null;

      const itemId = existingItem?.id || uid();
      const requestedSource = productEntryMode === "manual" || selectedInventoryItemId
        ? "manual"
        : catalogId
          ? "catalog"
          : "manual";
      const entrySource = existingItem
        ? normalizeEntrySource(existingItem.entrySource)
        : requestedSource;
      const existingTotal = existingItem ? totalQty(existingItem) : 0;
      const combinedTotal = existingTotal + incomingCalc.quantity;
      const unitsPerCase =
        integer(values.unitsPerCase) ||
        integer(existingItem?.unitsPerCase);

      const combinedCases = unitsPerCase > 0
        ? Math.floor(combinedTotal / unitsPerCase)
        : 0;

      const combinedLooseUnits = unitsPerCase > 0
        ? combinedTotal % unitsPerCase
        : combinedTotal;

      const hasValue = (id) => String($(id).value ?? "").trim() !== "";

      const aggregatePayload = {
        id: itemId,
        catalogId: catalogId || existingItem?.catalogId || "",
        name,
        category: $("itemCategory").value.trim() || existingItem?.category || "Other",
        size: size || existingItem?.size || "",
        brand: existingItem?.brand || "",
        cases: combinedCases,
        unitsPerCase,
        looseUnits: combinedLooseUnits,
        caseCost: hasValue("itemCaseCost") ? values.caseCost : nonNegative(existingItem?.caseCost),
        caseMarkup: hasValue("itemCaseMarkup") ? values.caseMarkup : nonNegative(existingItem?.caseMarkup),
        caseSellingPrice: hasValue("itemCaseSelling") ? values.caseSellingPrice : nonNegative(existingItem?.caseSellingPrice),
        unitCost: hasValue("itemUnitCost") ? values.unitCost : nonNegative(existingItem?.unitCost),
        unitMarkup: hasValue("itemUnitMarkup") ? values.unitMarkup : nonNegative(existingItem?.unitMarkup),
        sellingPrice: hasValue("itemSellingPrice") ? values.sellingPrice : nonNegative(existingItem?.sellingPrice),
        supplier: $("itemSupplier").value.trim() || existingItem?.supplier || "",
        reorderLevel: integer($("itemReorder").value) || integer(existingItem?.reorderLevel),
        notes: $("itemNotes").value.trim() || existingItem?.notes || "",
        entrySource,
        manualAdded: entrySource === "manual",
        createdAt: existingItem?.createdAt || serverTimestamp(),
        createdBy: existingItem?.createdBy || state.user.uid,
        createdByName: existingItem?.createdByName || state.profile?.displayName || "",
        updatedAt: serverTimestamp(),
        updatedBy: state.user.uid,
        lastCountSetId: countSet.id,
        lastCountSetName: countSet.name
      };

      const linePayload = {
        itemId,
        catalogId,
        entrySource,
        name,
        category: aggregatePayload.category,
        size: aggregatePayload.size,
        casesAdded: values.cases,
        unitsPerCase: values.unitsPerCase,
        looseUnitsAdded: values.looseUnits,
        totalUnitsAdded: incomingCalc.quantity,
        caseCost: incomingCalc.caseCostValue,
        caseSellingPrice: incomingCalc.caseSellingValue,
        unitCost: incomingCalc.costEach,
        unitSellingPrice: incomingCalc.sellingEach,
        stockCost: incomingCalc.stockCost,
        salesValue: incomingCalc.salesValue,
        potentialProfit: incomingCalc.profit,
        supplier: aggregatePayload.supplier,
        notes: $("itemNotes").value.trim(),
        addedAt: serverTimestamp(),
        addedBy: state.user.uid,
        addedByName: state.profile?.displayName || ""
      };

      const countSetMerge = await prepareCountSetLineMerge(countSet.id, linePayload);
      const updates = { ...countSetMerge.updates };
      updates[`${PATHS.items}/${itemId}`] = aggregatePayload;

      await update(ref(database), updates);

      await addAudit(
        countSetMerge.merged ? "item_quantity_increased_in_count_set" : "item_added_to_count_set",
        countSetMerge.merged
          ? `Increased ${name} by ${incomingCalc.quantity} unit${incomingCalc.quantity === 1 ? "" : "s"} in "${countSet.name}"`
          : `Added ${incomingCalc.quantity} unit${incomingCalc.quantity === 1 ? "" : "s"} of ${name} to "${countSet.name}"`,
        {
          countSetId: countSet.id,
          countSetName: countSet.name,
          itemId,
          itemName: name,
          unitsAdded: incomingCalc.quantity,
          entrySource,
          mergedIntoExistingLine: countSetMerge.merged,
          removedDuplicateLines: countSetMerge.removedDuplicateLines
        }
      );

      closeModal();

      toast(
        countSetMerge.merged
          ? `${name} was already in ${countSet.name}. The existing row was increased by ${formatNumber(incomingCalc.quantity)} units.`
          : existingItem
            ? `${formatNumber(incomingCalc.quantity)} units added to the existing ${name} stock and recorded in ${countSet.name}.`
            : `${name} added to ${countSet.name}${entrySource === "manual" ? " and marked MANUAL" : ""}.`
      );
    } catch (error) {
      console.error(error);
      toast(firebaseWriteMessage(error), "error");
      saveButton.disabled = false;
      saveButton.textContent = editing ? "Save Changes" : "Add Item";
    }
  });
}

async function deleteInventoryItem(itemId) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) return;
  if (!window.confirm(`Delete "${item.name}" from the alcohol inventory?`)) return;
  try {
    await remove(ref(database, `${PATHS.items}/${itemId}`));
    await addAudit("item_deleted", `Deleted ${item.name}`, { itemId, itemName: item.name });
    toast("Inventory item deleted.");
  } catch (error) {
    console.error(error);
    toast(firebaseWriteMessage(error), "error");
  }
}

function firebaseWriteMessage(error) {
  if (String(error?.code || "").includes("permission-denied")) {
    return "Firebase denied this change. Check the user's role and Realtime Database Rules.";
  }
  return error?.message || "The change could not be saved.";
}

const HEADER_ALIASES = {
  name: ["product name","product","item name","item","rum name","alcohol name","description","name"],
  category: ["category","type","alcohol type","product category"],
  size: ["size","bottle size","volume","ml"],
  cases: ["cases","case qty","case quantity","number of cases","case count"],
  unitsPerCase: ["units per case","qty per case","quantity per case","bottles per case","pieces per case","pack size","case pack","how much in a case"],
  looseUnits: ["loose units","loose qty","loose quantity","single units","loose bottles"],
  totalQty: ["qty","quantity","total qty","total quantity","stock qty","stock quantity","count"],
  caseCost: ["case cost","cost per case","cost price per case","wholesale case price"],
  caseMarkup: ["case markup","case markup %","markup per case"],
  caseSellingPrice: ["case selling price","selling price per case","case shelf price","retail case price"],
  unitCost: ["cost per unit","unit cost","cost price","buying price","unit price","cost price for one"],
  unitMarkup: ["unit markup","unit markup %","markup per unit","markup %"],
  sellingPrice: ["selling price","selling price per unit","selling price for one","shelf price","js shelf price","retail price","sale price"],
  supplier: ["supplier","vendor","distributor"],
  reorderLevel: ["reorder level","minimum stock","min stock","low stock level"],
  notes: ["notes","remarks","comment","comments"]
};

function normalizeHeader(value) {
  return String(value ?? "").trim().toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[_/-]+/g, " ")
    .replace(/[^a-z0-9% ]/g, "")
    .replace(/\s+/g, " ").trim();
}

function fieldForHeader(header) {
  const normalized = normalizeHeader(header);
  if (!normalized) return "";
  if (normalized.includes("total") && (normalized.includes("price") || normalized.includes("value"))) {
    if (HEADER_ALIASES.totalQty.includes(normalized)) return "totalQty";
    return "";
  }
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(normalized)) return field;
  }
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(alias) || alias.includes(normalized))) return field;
  }
  return "";
}

function detectHeaderRow(matrix) {
  let bestIndex = 0;
  let bestScore = -1;
  for (let rowIndex = 0; rowIndex < Math.min(matrix.length, 30); rowIndex += 1) {
    const row = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
    const fields = new Set(row.map(fieldForHeader).filter(Boolean));
    let score = fields.size + (fields.has("name") ? 5 : 0) + (fields.has("totalQty") || fields.has("cases") ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = rowIndex;
    }
  }
  return bestIndex;
}

async function parseImportFile(file) {
  if (!window.XLSX) throw new Error("The Excel import library did not load. Refresh and try again.");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error("No worksheet was found.");
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { header: 1, defval: "", raw: false, blankrows: false });
  if (!matrix.length) throw new Error("The uploaded file is empty.");

  const headerIndex = detectHeaderRow(matrix);
  const columnMap = {};
  (matrix[headerIndex] || []).forEach((header, index) => {
    const field = fieldForHeader(header);
    if (field && columnMap[field] === undefined) columnMap[field] = index;
  });
  if (columnMap.name === undefined) throw new Error("No Product Name, Item Name or Rum Name column was found.");

  const imported = [];
  for (const row of matrix.slice(headerIndex + 1)) {
    if (!Array.isArray(row)) continue;
    const getField = (field) => columnMap[field] === undefined ? "" : row[columnMap[field]];
    const name = String(getField("name") ?? "").trim();
    if (!name) continue;

    let cases = integer(getField("cases"));
    let unitsPerCase = integer(getField("unitsPerCase"));
    let looseUnits = integer(getField("looseUnits"));
    const suppliedTotal = integer(getField("totalQty"));

    if (suppliedTotal > 0) {
      if (cases > 0 && unitsPerCase > 0) {
        looseUnits = Math.max(0, suppliedTotal - cases * unitsPerCase);
      } else {
        cases = 0;
        looseUnits = suppliedTotal;
      }
    }

    imported.push(sanitizeItem({
      id: uid(),
      name,
      category: String(getField("category") || "Other").trim(),
      size: String(getField("size") || "").trim(),
      cases,
      unitsPerCase,
      looseUnits,
      caseCost: getField("caseCost"),
      caseMarkup: getField("caseMarkup"),
      caseSellingPrice: getField("caseSellingPrice"),
      unitCost: getField("unitCost"),
      unitMarkup: getField("unitMarkup"),
      sellingPrice: getField("sellingPrice"),
      supplier: getField("supplier"),
      reorderLevel: getField("reorderLevel"),
      notes: getField("notes"),
      entrySource: "imported",
      createdAt: Date.now(),
      createdBy: state.user.uid,
      createdByName: state.profile?.displayName || "",
      updatedAt: Date.now(),
      updatedBy: state.user.uid
    }));
  }
  if (!imported.length) throw new Error("No inventory rows with product names were found.");
  return imported;
}

function openImportModal() {
  openModal(`
    <div class="modal-header">
      <div><div class="eyebrow">FIREBASE IMPORT</div><h2>Upload Excel or CSV</h2></div>
      <button class="icon-btn" type="button" data-close-modal>×</button>
    </div>
    <div class="modal-body">
      <div class="file-drop">
        <strong>Select an inventory file</strong>
        <p class="muted">Accepted: .xlsx, .xls and .csv · Maximum 20 MB</p>
        <input id="importFile" type="file" accept=".xlsx,.xls,.csv">
      </div>
      <div class="field import-options">
        <label for="importMode">Import method</label>
        <select id="importMode">
          <option value="replace">Replace the current alcohol inventory</option>
          <option value="append">Add imported rows to the current inventory</option>
        </select>
      </div>
      <p class="help-text">Recognized headings include Product Name, Size, Qty, Cases, Units Per Case, Case Cost, Case Markup, Case Selling Price, Unit Cost, Unit Markup and Unit Selling Price.</p>
      <button id="downloadTemplate" class="text-btn" type="button">Download upload template</button>
      <div id="importMessage"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
      <button id="runImport" class="btn btn-primary" type="button">Import to Firebase</button>
    </div>
  `, true);

  $("downloadTemplate").addEventListener("click", downloadTemplate);
  $("runImport").addEventListener("click", async () => {
    const file = $("importFile").files[0];
    const message = $("importMessage");
    if (!file) {
      message.innerHTML = '<div class="message error">Select an Excel or CSV file.</div>';
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      message.innerHTML = '<div class="message error">The file is larger than 20 MB.</div>';
      return;
    }

    const button = $("runImport");
    button.disabled = true;
    button.textContent = "Importing…";
    try {
      const imported = await parseImportFile(file);
      const mode = $("importMode").value;
      if (mode === "replace" && state.items.length) {
        const approved = window.confirm(`Replace ${state.items.length} current items with ${imported.length} imported items?`);
        if (!approved) {
          button.disabled = false;
          button.textContent = "Import to Firebase";
          return;
        }
      }

      const dataObject = {};
      if (mode === "append") {
        imported.forEach((item) => {
          dataObject[item.id] = { ...item, updatedAt: serverTimestamp() };
        });
        await update(ref(database, PATHS.items), dataObject);
      } else {
        imported.forEach((item) => {
          dataObject[item.id] = { ...item, updatedAt: Date.now() };
        });
        await set(ref(database, PATHS.items), dataObject);
      }

      await addAudit("inventory_imported", `Imported ${imported.length} alcohol inventory items`, { count: imported.length, mode });
      message.innerHTML = `<div class="message success">${imported.length} items imported and synchronized.</div>`;
      window.setTimeout(closeModal, 900);
    } catch (error) {
      console.error(error);
      message.innerHTML = `<div class="message error">${escapeHtml(error.message || firebaseWriteMessage(error))}</div>`;
      button.disabled = false;
      button.textContent = "Import to Firebase";
    }
  });
}

function exportRows(items = state.items) {
  return items.map((item, index) => {
    const calc = calculate(item);

    return {
      "No.": index + 1,
      "Product Name": item.name,
      "Entry Source": entrySourceLabel(item.entrySource),
      "Category": item.category,
      "Size": item.size,
      "Cases": item.cases,
      "Units Per Case": item.unitsPerCase,
      "Loose Units": item.looseUnits,
      "Total Quantity": calc.quantity,
      "Cost Per Case": calc.caseCostValue,
      "Case Markup %": calc.caseMarkup,
      "Selling Price Per Case": calc.caseSellingValue,
      "Cost Per Unit": calc.costEach,
      "Unit Markup %": calc.unitMarkup,
      "Selling Price Per Unit": calc.sellingEach,
      "Total Stock Cost": calc.stockCost,
      "Total Sales Value": calc.salesValue,
      "Potential Profit": calc.profit,
      "Supplier": item.supplier,
      "Reorder Level": item.reorderLevel,
      "Added By": item.createdByName,
      "Added At": formatDateTime(item.createdAt),
      "Notes": item.notes
    };
  });
}

function downloadBlob(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function fileBase() {
  return `Price_King_Alcohol_Inventory_${state.settings.countDate || new Date().toISOString().slice(0,10)}`;
}

function exportCsv() {
  if (!state.items.length) return toast("There is no inventory to export.", "error");
  const rows = exportRows();
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
  ].join("\r\n");
  downloadBlob(`\uFEFF${csv}`, `${fileBase()}.csv`, "text/csv;charset=utf-8");
  addAudit("inventory_exported", "Exported alcohol inventory to CSV");
}

function exportExcel() {
  if (!state.items.length) return toast("There is no inventory to export.", "error");
  if (!window.XLSX) return exportCsv();
  const rows = exportRows();
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = Object.keys(rows[0]).map((header) => ({ wch: Math.min(36, Math.max(12, header.length + 2)) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Alcohol Inventory");
  XLSX.writeFile(workbook, `${fileBase()}.xlsx`);
  addAudit("inventory_exported", "Exported alcohol inventory to Excel");
}

function downloadTemplate() {
  const headers = [
    "Product Name",
    "Category",
    "Size",
    "Cases",
    "Units Per Case",
    "Loose Units",
    "Cost Per Case",
    "Case Markup %",
    "Selling Price Per Case",
    "Cost Per Unit",
    "Unit Markup %",
    "Selling Price Per Unit",
    "Supplier",
    "Reorder Level",
    "Notes"
  ];

  const sample = [
    "Johnnie Walker Black Label",
    "Whisky / Whiskey",
    "750 ml",
    2,
    12,
    3,
    36000,
    10,
    39600,
    1500,
    10,
    1650,
    "Supplier Name",
    6,
    ""
  ];

  const csv = `${headers.map(csvEscape).join(",")}\r\n${sample.map(csvEscape).join(",")}`;
  downloadBlob(`\uFEFF${csv}`, "Price_King_Alcohol_Inventory_Upload_Template.csv", "text/csv;charset=utf-8");
}

async function saveCountSnapshot() {
  if (!state.items.length) return toast("Add inventory items before saving a snapshot.", "error");
  const approved = window.confirm(`Save a permanent count snapshot for ${formatDate(state.settings.countDate)}?`);
  if (!approved) return;

  const sum = totals();
  const snapshotItems = {};
  state.items.forEach((item) => {
    snapshotItems[item.id] = { ...item, updatedAt: number(item.updatedAt) || Date.now() };
  });

  try {
    const newRef = push(ref(database, PATHS.counts));
    await set(newRef, {
      id: newRef.key,
      countDate: state.settings.countDate,
      createdAt: serverTimestamp(),
      createdBy: state.user.uid,
      createdByEmail: state.profile.loginName || state.profile.displayName || state.user.email,
      itemCount: sum.products,
      totalCases: sum.cases,
      totalUnits: sum.units,
      stockCost: sum.cost,
      salesValue: sum.sales,
      potentialProfit: sum.profit,
      items: snapshotItems
    });
    await addAudit("count_snapshot_saved", `Saved count snapshot for ${state.settings.countDate}`, { sessionId: newRef.key });
    toast("Count snapshot saved.");
  } catch (error) {
    console.error(error);
    toast(firebaseWriteMessage(error), "error");
  }
}

function sanitizeSale(raw = {}, key = "") {
  return {
    id: String(raw.id || key || uid()),
    itemId: String(raw.itemId || ""),
    itemName: String(raw.itemName || "").trim(),
    category: String(raw.category || "Other").trim() || "Other",
    size: String(raw.size || "").trim(),
    unitsPerCase: integer(raw.unitsPerCase),
    casesSold: integer(raw.casesSold),
    unitsSold: integer(raw.unitsSold),
    totalUnitsSold: integer(raw.totalUnitsSold),
    caseSellingPrice: nonNegative(raw.caseSellingPrice),
    unitSellingPrice: nonNegative(raw.unitSellingPrice),
    caseCost: nonNegative(raw.caseCost),
    unitCost: nonNegative(raw.unitCost),
    totalAmount: nonNegative(raw.totalAmount),
    totalCost: nonNegative(raw.totalCost),
    profit: number(raw.profit),
    saleDate: String(raw.saleDate || "").trim(),
    note: String(raw.note || "").trim(),
    status: String(raw.status || "completed"),
    createdAt: raw.createdAt || Date.now(),
    createdBy: String(raw.createdBy || ""),
    staffName: String(raw.staffName || ""),
    reversedAt: raw.reversedAt || null,
    reversedBy: String(raw.reversedBy || ""),
    reversedByName: String(raw.reversedByName || "")
  };
}

function activeSales() {
  return state.sales.filter((sale) => sale.status !== "reversed");
}

function dateAtStart(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function periodStart(period) {
  const today = dateAtStart(new Date());

  if (period === "today") return today.getTime();

  if (period === "7") {
    const date = new Date(today);
    date.setDate(date.getDate() - 6);
    return date.getTime();
  }

  if (period === "30") {
    const date = new Date(today);
    date.setDate(date.getDate() - 29);
    return date.getTime();
  }

  return 0;
}

function saleTime(sale) {
  if (sale.saleDate) {
    const parsed = new Date(`${sale.saleDate}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  }
  return number(sale.createdAt);
}

function periodSales(period = state.stockPeriod) {
  const start = periodStart(period);
  return activeSales().filter((sale) => saleTime(sale) >= start);
}

function salesSummary(sales) {
  return sales.reduce((acc, sale) => {
    acc.transactions += 1;
    acc.cases += integer(sale.casesSold);
    acc.units += integer(sale.totalUnitsSold);
    acc.amount += nonNegative(sale.totalAmount);
    acc.cost += nonNegative(sale.totalCost);
    acc.profit += number(sale.profit);
    return acc;
  }, {
    transactions: 0,
    cases: 0,
    units: 0,
    amount: 0,
    cost: 0,
    profit: 0
  });
}

function soldUnitsByItem(sales = activeSales()) {
  const map = new Map();
  sales.forEach((sale) => {
    map.set(sale.itemId, (map.get(sale.itemId) || 0) + integer(sale.totalUnitsSold));
  });
  return map;
}

function effectiveReorderLevel(item) {
  if (integer(item.reorderLevel) > 0) return integer(item.reorderLevel);
  if (integer(item.unitsPerCase) > 0) return integer(item.unitsPerCase);
  return 5;
}

function inventoryStatus(item) {
  const quantity = totalQty(item);
  if (quantity <= 0) return "out";
  if (quantity <= effectiveReorderLevel(item)) return "low";
  return "good";
}

function stockStatusLabel(status) {
  if (status === "out") return "Out of Stock";
  if (status === "low") return "Low Stock";
  return "In Stock";
}

function stockStatusBadge(status) {
  return `<span class="stock-badge ${status}">${stockStatusLabel(status)}</span>`;
}

function stockPeriodLabel(period) {
  if (period === "today") return "Today";
  if (period === "7") return "Last 7 Days";
  if (period === "30") return "Last 30 Days";
  return "All Time";
}

function renderStockTracker() {
  const target = $("section-stock");
  if (!target) return;

  const canWrite = canWriteInventory();
  const periodList = periodSales();
  const periodSummary = salesSummary(periodList);
  const allSoldMap = soldUnitsByItem();
  const periodSoldMap = soldUnitsByItem(periodList);

  const lowCount = state.items.filter((item) => inventoryStatus(item) === "low").length;
  const outCount = state.items.filter((item) => inventoryStatus(item) === "out").length;
  const currentTotals = totals();

  const search = state.stockSearch.trim().toLowerCase();

  const filteredItems = state.items.filter((item) => {
    const status = inventoryStatus(item);
    const matchesStatus =
      state.stockStatus === "all" ||
      state.stockStatus === status;

    const searchable = `${item.name} ${item.size} ${item.category} ${item.supplier}`;
    const matchesSearch = !search || matchesSearchQuery(searchable, search);

    return matchesStatus && matchesSearch;
  });

  target.innerHTML = `
    <section class="card stock-header-card">
      <div class="inventory-header">
        <div class="section-heading">
          <div>
            <div class="eyebrow">LIVE STOCK CONTROL</div>
            <h2>Stock & Sales Tracker</h2>
            <p>
              Sales automatically reduce the alcohol inventory.
              Low-stock items use the product's reorder level, or one case when no level is entered.
            </p>
          </div>

          <div class="section-actions">
            ${canWrite ? '<button id="recordSaleButton" class="btn btn-primary" type="button">＋ Record Sale</button>' : ""}
            <button id="exportSalesButton" class="btn btn-secondary" type="button">Export Sales</button>
          </div>
        </div>
      </div>

      <div class="toolbar stock-toolbar">
        <div class="toolbar-left">
          <input
            id="stockSearch"
            type="search"
            placeholder="Search product, size or category"
            value="${escapeHtml(state.stockSearch)}"
          >

          <select id="stockStatusFilter">
            <option value="all" ${state.stockStatus === "all" ? "selected" : ""}>All stock statuses</option>
            <option value="good" ${state.stockStatus === "good" ? "selected" : ""}>In stock</option>
            <option value="low" ${state.stockStatus === "low" ? "selected" : ""}>Low stock</option>
            <option value="out" ${state.stockStatus === "out" ? "selected" : ""}>Out of stock</option>
          </select>
        </div>

        <div class="toolbar-right">
          <label class="inline-filter-label" for="stockPeriod">Sales period</label>
          <select id="stockPeriod">
            <option value="today" ${state.stockPeriod === "today" ? "selected" : ""}>Today</option>
            <option value="7" ${state.stockPeriod === "7" ? "selected" : ""}>Last 7 days</option>
            <option value="30" ${state.stockPeriod === "30" ? "selected" : ""}>Last 30 days</option>
            <option value="all" ${state.stockPeriod === "all" ? "selected" : ""}>All time</option>
          </select>
        </div>
      </div>
    </section>

    <section class="kpi-grid stock-kpi-grid">
      <article class="kpi-card">
        <span>Current Units</span>
        <strong>${formatNumber(currentTotals.units)}</strong>
      </article>
      <article class="kpi-card">
        <span>Units Sold · ${escapeHtml(stockPeriodLabel(state.stockPeriod))}</span>
        <strong>${formatNumber(periodSummary.units)}</strong>
      </article>
      <article class="kpi-card gold">
        <span>Sales Amount</span>
        <strong>${formatMoney(periodSummary.amount)}</strong>
      </article>
      <article class="kpi-card green">
        <span>Sales Profit</span>
        <strong class="${periodSummary.profit < 0 ? "negative" : ""}">${formatMoney(periodSummary.profit)}</strong>
      </article>
      <article class="kpi-card low-card">
        <span>Low Stock</span>
        <strong>${formatNumber(lowCount)}</strong>
      </article>
      <article class="kpi-card out-card">
        <span>Out of Stock</span>
        <strong>${formatNumber(outCount)}</strong>
      </article>
    </section>

    <section class="card stock-table-card">
      <div class="section-heading stock-section-heading">
        <div>
          <div class="eyebrow">STOCK ON HAND</div>
          <h2>Current Inventory Status</h2>
          <p>${formatNumber(filteredItems.length)} product${filteredItems.length === 1 ? "" : "s"} shown.</p>
        </div>
      </div>

      <div class="table-scroll">
        <table class="stock-table">
          <thead>
            <tr>
              <th class="sticky-name">Product</th>
              <th>Size</th>
              <th>Category</th>
              <th class="number">Cases</th>
              <th class="number">Loose</th>
              <th class="number">Current Units</th>
              <th class="number">Sold · Period</th>
              <th class="number">Sold · All Time</th>
              <th class="number">Low Level</th>
              <th>Status</th>
              <th class="number">Stock Cost</th>
              <th class="number">Potential Sales</th>
              ${canWrite ? "<th>Action</th>" : ""}
            </tr>
          </thead>

          <tbody>
            ${filteredItems.length ? filteredItems.map((item) => {
              const calc = calculate(item);
              const status = inventoryStatus(item);

              return `
                <tr class="stock-row-${status}">
                  <td class="sticky-name" title="${escapeHtml(item.name)}">
                    <strong>${escapeHtml(item.name)}</strong>
                  </td>
                  <td>${escapeHtml(item.size || "—")}</td>
                  <td>${escapeHtml(item.category)}</td>
                  <td class="number">${formatNumber(item.cases)}</td>
                  <td class="number">${formatNumber(item.looseUnits)}</td>
                  <td class="number"><strong>${formatNumber(calc.quantity)}</strong></td>
                  <td class="number">${formatNumber(periodSoldMap.get(item.id) || 0)}</td>
                  <td class="number">${formatNumber(allSoldMap.get(item.id) || 0)}</td>
                  <td class="number">${formatNumber(effectiveReorderLevel(item))}</td>
                  <td>${stockStatusBadge(status)}</td>
                  <td class="number">${formatMoney(calc.stockCost)}</td>
                  <td class="number">${formatMoney(calc.salesValue)}</td>
                  ${canWrite ? `
                    <td>
                      <button
                        class="row-btn record-product-sale"
                        type="button"
                        data-id="${escapeHtml(item.id)}"
                        ${calc.quantity <= 0 ? "disabled" : ""}
                      >Record Sale</button>
                    </td>` : ""}
                </tr>
              `;
            }).join("") : `
              <tr>
                <td colspan="${canWrite ? 13 : 12}">
                  <div class="empty-state compact-empty">
                    <div class="icon">▦</div>
                    <h3>No products match this filter</h3>
                    <p>Change the search or stock-status filter.</p>
                  </div>
                </td>
              </tr>`}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card sales-history-card">
      <div class="section-heading stock-section-heading">
        <div>
          <div class="eyebrow">SALES MOVEMENT</div>
          <h2>Sales History · ${escapeHtml(stockPeriodLabel(state.stockPeriod))}</h2>
          <p>${formatNumber(periodSummary.transactions)} transaction${periodSummary.transactions === 1 ? "" : "s"} recorded.</p>
        </div>
      </div>

      <div class="table-scroll">
        <table class="data-table sales-history-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Product</th>
              <th>Size</th>
              <th class="number">Cases Sold</th>
              <th class="number">Single Units</th>
              <th class="number">Total Units</th>
              <th class="number">Amount</th>
              <th class="number">Profit</th>
              <th>Recorded By</th>
              <th>Note</th>
              <th>Status</th>
              ${canWrite ? "<th>Action</th>" : ""}
            </tr>
          </thead>

          <tbody>
            ${periodList.length ? periodList
              .slice()
              .sort((a, b) => saleTime(b) - saleTime(a))
              .map((sale) => `
                <tr class="${sale.status === "reversed" ? "reversed-sale" : ""}">
                  <td>${escapeHtml(formatDate(sale.saleDate || sale.createdAt))}</td>
                  <td><strong>${escapeHtml(sale.itemName)}</strong></td>
                  <td>${escapeHtml(sale.size || "—")}</td>
                  <td class="number">${formatNumber(sale.casesSold)}</td>
                  <td class="number">${formatNumber(sale.unitsSold)}</td>
                  <td class="number">${formatNumber(sale.totalUnitsSold)}</td>
                  <td class="number">${formatMoney(sale.totalAmount)}</td>
                  <td class="number ${sale.profit < 0 ? "negative" : "positive"}">${formatMoney(sale.profit)}</td>
                  <td>${escapeHtml(sale.staffName || "—")}</td>
                  <td>${escapeHtml(sale.note || "—")}</td>
                  <td><span class="sale-status ${sale.status}">${sale.status === "reversed" ? "Reversed" : "Completed"}</span></td>
                  ${canWrite ? `
                    <td>
                      ${sale.status === "reversed"
                        ? "—"
                        : `<button class="row-btn delete reverse-sale" type="button" data-id="${escapeHtml(sale.id)}">Reverse</button>`}
                    </td>` : ""}
                </tr>
              `).join("") : `
                <tr>
                  <td colspan="${canWrite ? 12 : 11}">
                    <div class="empty-state compact-empty">
                      <div class="icon">↕</div>
                      <h3>No sales in this period</h3>
                      <p>Record a sale to start tracking stock movement.</p>
                    </div>
                  </td>
                </tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;

  $("stockSearch").addEventListener("input", (event) => {
    state.stockSearch = event.target.value;
    renderStockTracker();
    window.requestAnimationFrame(() => {
      const field = $("stockSearch");
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    });
  });

  $("stockStatusFilter").addEventListener("change", (event) => {
    state.stockStatus = event.target.value;
    renderStockTracker();
  });

  $("stockPeriod").addEventListener("change", (event) => {
    state.stockPeriod = event.target.value;
    renderStockTracker();
  });

  $("recordSaleButton")?.addEventListener("click", () => openRecordSaleModal());
  $("exportSalesButton").addEventListener("click", exportSalesCsv);

  document.querySelectorAll(".record-product-sale").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.items.find((entry) => entry.id === button.dataset.id);
      openRecordSaleModal(item);
    });
  });

  document.querySelectorAll(".reverse-sale").forEach((button) => {
    button.addEventListener("click", () => reverseSale(button.dataset.id));
  });
}

function openRecordSaleModal(initialItem = null) {
  const availableItems = state.items
    .filter((item) => totalQty(item) > 0)
    .sort((a, b) => a.name.localeCompare(b.name) || a.size.localeCompare(b.size));

  if (!availableItems.length) {
    toast("There is no stock available to sell.", "error");
    return;
  }

  openModal(`
    <form id="saleForm">
      <div class="modal-header">
        <div>
          <div class="eyebrow">STOCK MOVEMENT</div>
          <h2>Record Alcohol Sale</h2>
        </div>
        <button class="icon-btn" type="button" data-close-modal>×</button>
      </div>

      <div class="modal-body">
        <div class="form-grid">
          <div class="field full-span product-combobox">
            <label for="saleProductSearch">Select product <em>*</em></label>
            <input
              id="saleProductSearch"
              type="text"
              value="${escapeHtml(initialItem?.name || "")}"
              placeholder="Type a product or size, then press Enter"
              autocomplete="off"
              role="combobox"
              aria-expanded="false"
              aria-controls="saleProductSuggestions"
              required
            >
            <input id="saleItemId" type="hidden" value="${escapeHtml(initialItem?.id || "")}">
            <div id="saleProductSuggestions" class="autocomplete-menu hidden" role="listbox"></div>
          </div>

          <div class="sale-selected-card full-span" id="saleSelectedCard">
            <div>
              <span>Selected Product</span>
              <strong id="saleSelectedName">${escapeHtml(initialItem?.name || "No product selected")}</strong>
            </div>
            <div>
              <span>Size</span>
              <strong id="saleSelectedSize">${escapeHtml(initialItem?.size || "—")}</strong>
            </div>
            <div>
              <span>Available Stock</span>
              <strong id="saleAvailableStock">${initialItem ? `${formatNumber(totalQty(initialItem))} units` : "—"}</strong>
            </div>
          </div>

          <div class="field">
            <label for="saleDate">Sale date</label>
            <input id="saleDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required>
          </div>

          <div class="field">
            <label for="saleNote">Reference / note</label>
            <input id="saleNote" type="text" placeholder="Optional receipt or note">
          </div>

          <section class="quantity-box full-span">
            <h3 class="box-title">Quantity Sold</h3>

            <div class="form-grid">
              <div class="field">
                <label for="saleCases">Full cases sold</label>
                <input id="saleCases" type="number" min="0" step="1" value="0">
              </div>

              <div class="field">
                <label for="saleUnits">Single units sold</label>
                <input id="saleUnits" type="number" min="0" step="1" value="0">
              </div>
            </div>

            <div class="calc-strip">
              <div class="calc-item"><span>Total Units Sold</span><strong id="saleTotalUnits">0</strong></div>
              <div class="calc-item"><span>Remaining Stock</span><strong id="saleRemainingUnits">—</strong></div>
              <div class="calc-item"><span>Units Per Case</span><strong id="salePackSize">—</strong></div>
            </div>
          </section>

          <section class="price-box full-span">
            <h3 class="box-title">Sale Calculation</h3>

            <div class="calc-strip total-preview-strip">
              <div class="calc-item"><span>Case Selling Price</span><strong id="saleCasePrice">${formatMoney(0)}</strong></div>
              <div class="calc-item"><span>Unit Selling Price</span><strong id="saleUnitPrice">${formatMoney(0)}</strong></div>
              <div class="calc-item"><span>Total Sale Amount</span><strong id="saleAmount">${formatMoney(0)}</strong></div>
            </div>

            <div class="calc-strip">
              <div class="calc-item"><span>Sale Cost</span><strong id="saleCost">${formatMoney(0)}</strong></div>
              <div class="calc-item"><span>Sale Profit</span><strong id="saleProfit">${formatMoney(0)}</strong></div>
              <div class="calc-item"><span>Recorded By</span><strong>${escapeHtml(state.profile?.displayName || "Staff")}</strong></div>
            </div>
          </section>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
        <button id="saveSaleButton" class="btn btn-primary" type="submit">Record Sale</button>
      </div>
    </form>
  `);

  let selectedItem = initialItem || null;
  let suggestions = [];
  let activeSuggestion = -1;

  const input = $("saleProductSearch");
  const menu = $("saleProductSuggestions");

  const hideSuggestions = () => {
    menu.classList.add("hidden");
    menu.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    suggestions = [];
    activeSuggestion = -1;
  };

  const updateSelectedCard = () => {
    $("saleSelectedName").textContent = selectedItem?.name || "No product selected";
    $("saleSelectedSize").textContent = selectedItem?.size || "—";
    $("saleAvailableStock").textContent = selectedItem
      ? `${formatNumber(totalQty(selectedItem))} units`
      : "—";
    updateSalePreview();
  };

  const selectItem = (item) => {
    selectedItem = item;
    $("saleItemId").value = item.id;
    input.value = item.name;
    hideSuggestions();
    updateSelectedCard();
    $("saleCases").focus();
  };

  const matchingItems = (query) => {
    const clean = String(query || "").trim();
    if (!clean) return availableItems.slice(0, 15);

    return availableItems
      .filter((item) =>
        matchesSearchQuery(
          `${item.name} ${item.size} ${item.category}`,
          clean
        )
      )
      .slice(0, 18);
  };

  const renderSuggestions = () => {
    suggestions = matchingItems(input.value);

    if (!suggestions.length) {
      menu.innerHTML = '<div class="autocomplete-empty">No in-stock product matches your search.</div>';
      menu.classList.remove("hidden");
      input.setAttribute("aria-expanded", "true");
      return;
    }

    if (activeSuggestion < 0 || activeSuggestion >= suggestions.length) activeSuggestion = 0;

    menu.innerHTML = suggestions.map((item, index) => `
      <button
        class="autocomplete-option ${index === activeSuggestion ? "active" : ""}"
        type="button"
        data-index="${index}"
      >
        <span class="autocomplete-name">${escapeHtml(item.name)}</span>
        <span class="autocomplete-meta">
          ${escapeHtml(item.size || "Size not listed")}
          · ${formatNumber(totalQty(item))} units available
          · ${escapeHtml(item.category)}
        </span>
      </button>
    `).join("");

    menu.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");

    menu.querySelectorAll(".autocomplete-option").forEach((button) => {
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        selectItem(suggestions[integer(button.dataset.index)]);
      });
    });
  };

  input.addEventListener("input", () => {
    selectedItem = null;
    $("saleItemId").value = "";
    activeSuggestion = 0;
    renderSuggestions();
    updateSelectedCard();
  });

  input.addEventListener("focus", renderSuggestions);

  input.addEventListener("blur", () => {
    window.setTimeout(hideSuggestions, 150);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!suggestions.length) renderSuggestions();
      activeSuggestion = Math.min(activeSuggestion + 1, suggestions.length - 1);
      renderSuggestions();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      activeSuggestion = Math.max(activeSuggestion - 1, 0);
      renderSuggestions();
    } else if (event.key === "Enter") {
      if (suggestions.length) {
        event.preventDefault();
        selectItem(suggestions[Math.max(activeSuggestion, 0)]);
      }
    } else if (event.key === "Escape") {
      hideSuggestions();
    }
  });

  function saleValues() {
    const casesSold = integer($("saleCases").value);
    const unitsSold = integer($("saleUnits").value);
    const pack = integer(selectedItem?.unitsPerCase);
    const totalUnitsSold = casesSold * pack + unitsSold;

    const caseSellingPrice = selectedItem ? resolvedCaseSelling(selectedItem) : 0;
    const unitSellingPrice = selectedItem ? nonNegative(selectedItem.sellingPrice) : 0;
    const caseCostValue = selectedItem ? resolvedCaseCost(selectedItem) : 0;
    const unitCostValue = selectedItem ? resolvedUnitCost(selectedItem) : 0;

    const totalAmount = casesSold * caseSellingPrice + unitsSold * unitSellingPrice;
    const totalCost = casesSold * caseCostValue + unitsSold * unitCostValue;
    const profit = totalAmount - totalCost;

    return {
      casesSold,
      unitsSold,
      pack,
      totalUnitsSold,
      caseSellingPrice,
      unitSellingPrice,
      caseCostValue,
      unitCostValue,
      totalAmount,
      totalCost,
      profit
    };
  }

  function updateSalePreview() {
    const values = saleValues();
    const available = selectedItem ? totalQty(selectedItem) : 0;
    const remaining = Math.max(0, available - values.totalUnitsSold);

    $("saleTotalUnits").textContent = formatNumber(values.totalUnitsSold);
    $("saleRemainingUnits").textContent = selectedItem ? formatNumber(remaining) : "—";
    $("salePackSize").textContent = selectedItem ? formatNumber(values.pack) : "—";
    $("saleCasePrice").textContent = formatMoney(values.caseSellingPrice);
    $("saleUnitPrice").textContent = formatMoney(values.unitSellingPrice);
    $("saleAmount").textContent = formatMoney(values.totalAmount);
    $("saleCost").textContent = formatMoney(values.totalCost);
    $("saleProfit").textContent = formatMoney(values.profit);

    $("saleRemainingUnits").classList.toggle(
      "negative",
      Boolean(selectedItem && values.totalUnitsSold > available)
    );
  }

  ["saleCases", "saleUnits"].forEach((id) => {
    $(id).addEventListener("input", updateSalePreview);
  });

  updateSelectedCard();

  $("saleForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!selectedItem) {
      toast("Select a product from the stock list.", "error");
      input.focus();
      return;
    }

    const values = saleValues();
    const available = totalQty(selectedItem);

    if (values.totalUnitsSold <= 0) {
      toast("Enter the quantity sold.", "error");
      return;
    }

    if (values.totalUnitsSold > available) {
      toast(`Only ${formatNumber(available)} units are currently in stock.`, "error");
      return;
    }

    const remaining = available - values.totalUnitsSold;
    const pack = integer(selectedItem.unitsPerCase);
    const remainingCases = pack > 0 ? Math.floor(remaining / pack) : 0;
    const remainingLoose = pack > 0 ? remaining % pack : remaining;

    const saleRef = push(ref(database, PATHS.sales));
    const saleId = saleRef.key;

    const updatedItem = {
      ...selectedItem,
      cases: remainingCases,
      looseUnits: remainingLoose,
      updatedAt: serverTimestamp(),
      updatedBy: state.user.uid
    };

    const salePayload = {
      id: saleId,
      itemId: selectedItem.id,
      itemName: selectedItem.name,
      category: selectedItem.category,
      size: selectedItem.size,
      unitsPerCase: pack,
      casesSold: values.casesSold,
      unitsSold: values.unitsSold,
      totalUnitsSold: values.totalUnitsSold,
      caseSellingPrice: values.caseSellingPrice,
      unitSellingPrice: values.unitSellingPrice,
      caseCost: values.caseCostValue,
      unitCost: values.unitCostValue,
      totalAmount: values.totalAmount,
      totalCost: values.totalCost,
      profit: values.profit,
      saleDate: $("saleDate").value,
      note: $("saleNote").value.trim(),
      status: "completed",
      createdAt: serverTimestamp(),
      createdBy: state.user.uid,
      staffName: state.profile?.displayName || ""
    };

    const saveButton = $("saveSaleButton");
    saveButton.disabled = true;
    saveButton.textContent = "Saving Sale…";

    try {
      const updates = {};
      updates[`${PATHS.items}/${selectedItem.id}`] = updatedItem;
      updates[`${PATHS.sales}/${saleId}`] = salePayload;

      await update(ref(database), updates);

      await addAudit(
        "sale_recorded",
        `Recorded sale of ${values.totalUnitsSold} unit${values.totalUnitsSold === 1 ? "" : "s"} of ${selectedItem.name}`,
        {
          saleId,
          itemId: selectedItem.id,
          itemName: selectedItem.name,
          totalUnitsSold: values.totalUnitsSold,
          totalAmount: values.totalAmount
        }
      );

      closeModal();
      toast("Sale recorded and stock updated.");
    } catch (error) {
      console.error(error);
      toast(firebaseWriteMessage(error), "error");
      saveButton.disabled = false;
      saveButton.textContent = "Record Sale";
    }
  });
}

async function reverseSale(saleId) {
  const sale = state.sales.find((entry) => entry.id === saleId);
  if (!sale || sale.status === "reversed") return;

  const item = state.items.find((entry) => entry.id === sale.itemId);
  if (!item) {
    toast("The original inventory product no longer exists.", "error");
    return;
  }

  const approved = window.confirm(
    `Reverse this sale and return ${formatNumber(sale.totalUnitsSold)} units of "${sale.itemName}" to stock?`
  );
  if (!approved) return;

  const restoredTotal = totalQty(item) + integer(sale.totalUnitsSold);
  const pack = integer(item.unitsPerCase);
  const restoredCases = pack > 0 ? Math.floor(restoredTotal / pack) : 0;
  const restoredLoose = pack > 0 ? restoredTotal % pack : restoredTotal;

  const updates = {};
  updates[`${PATHS.items}/${item.id}/cases`] = restoredCases;
  updates[`${PATHS.items}/${item.id}/looseUnits`] = restoredLoose;
  updates[`${PATHS.items}/${item.id}/updatedAt`] = serverTimestamp();
  updates[`${PATHS.items}/${item.id}/updatedBy`] = state.user.uid;
  updates[`${PATHS.sales}/${saleId}/status`] = "reversed";
  updates[`${PATHS.sales}/${saleId}/reversedAt`] = serverTimestamp();
  updates[`${PATHS.sales}/${saleId}/reversedBy`] = state.user.uid;
  updates[`${PATHS.sales}/${saleId}/reversedByName`] = state.profile?.displayName || "";

  try {
    await update(ref(database), updates);

    await addAudit(
      "sale_reversed",
      `Reversed sale of ${sale.totalUnitsSold} unit${sale.totalUnitsSold === 1 ? "" : "s"} of ${sale.itemName}`,
      {
        saleId,
        itemId: item.id,
        itemName: item.name,
        totalUnitsReturned: sale.totalUnitsSold
      }
    );

    toast("Sale reversed and stock restored.");
  } catch (error) {
    console.error(error);
    toast(firebaseWriteMessage(error), "error");
  }
}

function exportSalesCsv() {
  const sales = state.sales.slice().sort((a, b) => saleTime(b) - saleTime(a));

  if (!sales.length) {
    toast("There are no sales records to export.", "error");
    return;
  }

  const rows = sales.map((sale, index) => ({
    "No.": index + 1,
    "Sale Date": sale.saleDate,
    "Product Name": sale.itemName,
    "Category": sale.category,
    "Size": sale.size,
    "Cases Sold": sale.casesSold,
    "Single Units Sold": sale.unitsSold,
    "Total Units Sold": sale.totalUnitsSold,
    "Case Selling Price": sale.caseSellingPrice,
    "Unit Selling Price": sale.unitSellingPrice,
    "Total Sale Amount": sale.totalAmount,
    "Total Cost": sale.totalCost,
    "Profit": sale.profit,
    "Recorded By": sale.staffName,
    "Note": sale.note,
    "Status": sale.status,
    "Created At": formatDateTime(sale.createdAt)
  }));

  const headers = Object.keys(rows[0]);
  const csv = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
  ].join("\r\n");

  downloadBlob(
    `\uFEFF${csv}`,
    `Price_King_Alcohol_Sales_${new Date().toISOString().slice(0, 10)}.csv`,
    "text/csv;charset=utf-8"
  );

  addAudit("sales_exported", "Exported alcohol sales history");
}

function renderHistory() {
  const target = $("section-history");
  if (!target) return;
  target.innerHTML = `
    <div class="section-heading">
      <div><div class="eyebrow">COUNT RECORDS</div><h2>Saved Count Snapshots</h2><p>Snapshots preserve the inventory figures recorded on a specific count date.</p></div>
      <div class="section-actions">
        ${canWriteInventory() ? '<button id="historySaveSnapshot" class="btn btn-gold" type="button">Save Current Snapshot</button>' : ""}
      </div>
    </div>
    <section class="data-card card">
      ${state.sessions.length ? `
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr>
              <th>Count Date</th><th>Saved By</th><th class="number">Products</th><th class="number">Cases</th>
              <th class="number">Units</th><th class="number">Stock Cost</th><th class="number">Sales Value</th>
              <th class="number">Profit</th><th>Saved At</th><th>Actions</th>
            </tr></thead>
            <tbody>
              ${state.sessions.map((session) => `
                <tr>
                  <td><strong>${escapeHtml(formatDate(session.countDate))}</strong></td>
                  <td>${escapeHtml(session.createdByEmail || "—")}</td>
                  <td class="number">${formatNumber(session.itemCount)}</td>
                  <td class="number">${formatNumber(session.totalCases)}</td>
                  <td class="number">${formatNumber(session.totalUnits)}</td>
                  <td class="number">${formatMoney(session.stockCost)}</td>
                  <td class="number">${formatMoney(session.salesValue)}</td>
                  <td class="number ${number(session.potentialProfit) < 0 ? "negative" : "positive"}">${formatMoney(session.potentialProfit)}</td>
                  <td>${escapeHtml(formatDateTime(session.createdAt))}</td>
                  <td><div class="table-actions">
                    <button class="row-btn export-session" type="button" data-id="${escapeHtml(session.id)}">Export</button>
                    ${canWriteInventory() ? `<button class="row-btn restore-session" type="button" data-id="${escapeHtml(session.id)}">Restore</button>
                    <button class="row-btn delete delete-session" type="button" data-id="${escapeHtml(session.id)}">Delete</button>` : ""}
                  </div></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>` :
        `<div class="empty-state"><div class="icon">◷</div><h3>No count snapshots yet</h3><p>Save the current inventory to create the first historical record.</p></div>`}
    </section>
  `;

  $("historySaveSnapshot")?.addEventListener("click", saveCountSnapshot);
  document.querySelectorAll(".export-session").forEach((button) => button.addEventListener("click", () => exportSession(button.dataset.id)));
  document.querySelectorAll(".restore-session").forEach((button) => button.addEventListener("click", () => restoreSession(button.dataset.id)));
  document.querySelectorAll(".delete-session").forEach((button) => button.addEventListener("click", () => deleteSession(button.dataset.id)));
}

function sessionById(id) {
  return state.sessions.find((session) => session.id === id);
}

function exportSession(id) {
  const session = sessionById(id);
  if (!session?.items) return toast("This snapshot has no item details.", "error");
  const rows = exportRows(Object.entries(session.items).map(([key, item]) => sanitizeItem(item, key)));
  if (!rows.length) return toast("This snapshot is empty.", "error");
  const headers = Object.keys(rows[0]);
  const csv = [headers.map(csvEscape).join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\r\n");
  downloadBlob(`\uFEFF${csv}`, `Alcohol_Count_${session.countDate || id}.csv`, "text/csv;charset=utf-8");
}

async function restoreSession(id) {
  const session = sessionById(id);
  if (!session?.items) return;
  if (!window.confirm(`Replace the current inventory with the snapshot from ${formatDate(session.countDate)}?`)) return;
  try {
    const restored = {};
    Object.entries(session.items).forEach(([key, item]) => {
      restored[key] = { ...sanitizeItem(item, key), updatedAt: Date.now(), updatedBy: state.user.uid };
    });
    await set(ref(database, PATHS.items), restored);
    await addAudit("count_snapshot_restored", `Restored snapshot from ${session.countDate}`, { sessionId: id });
    toast("Snapshot restored to the current inventory.");
  } catch (error) {
    toast(firebaseWriteMessage(error), "error");
  }
}

async function deleteSession(id) {
  const session = sessionById(id);
  if (!session) return;
  if (!window.confirm(`Delete the saved snapshot from ${formatDate(session.countDate)}?`)) return;
  try {
    await remove(ref(database, `${PATHS.counts}/${id}`));
    await addAudit("count_snapshot_deleted", `Deleted snapshot from ${session.countDate}`, { sessionId: id });
    toast("Count snapshot deleted.");
  } catch (error) {
    toast(firebaseWriteMessage(error), "error");
  }
}

function renderAudit() {
  const target = $("section-audit");
  if (!target) return;
  target.innerHTML = `
    <div class="section-heading">
      <div><div class="eyebrow">AUDIT TRAIL</div><h2>System Activity Log</h2><p>Inventory and access changes recorded by Firebase.</p></div>
    </div>
    <section class="data-card card">
      ${state.logs.length ? `
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>Date & Time</th><th>User</th><th>Action</th><th>Description</th><th>Module</th></tr></thead>
            <tbody>${state.logs.map((log) => `
              <tr>
                <td>${escapeHtml(formatDateTime(log.timestamp))}</td>
                <td>${escapeHtml(log.userEmail || log.uid || "—")}</td>
                <td><strong>${escapeHtml(log.actionLabel || log.action || "Activity")}</strong></td>
                <td>${escapeHtml(log.description || "")}</td>
                <td>${escapeHtml(log.module || "alcohol")}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>` :
        `<div class="empty-state"><div class="icon">≡</div><h3>No activity recorded</h3><p>New system changes will appear here.</p></div>`}
    </section>
  `;
}

function renderUsers() {
  const target = $("section-users");
  if (!target) return;
  target.innerHTML = `
    <div class="section-heading">
      <div>
        <div class="eyebrow">ROLE-BASED ACCESS</div>
        <h2>User Access Management</h2>
        <p>Create the hidden Firebase Authentication account first, then add its UID and login name here.</p>
      </div>
      <div class="section-actions">
        <button id="addAccessButton" class="btn btn-primary" type="button">＋ Add Access Profile</button>
      </div>
    </div>
    <section class="data-card card">
      ${state.users.length ? `
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Login Name</th>
                <th>Firebase UID</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last Login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${state.users.map((user) => `
              <tr>
                <td><strong>${escapeHtml(user.displayName || "—")}</strong></td>
                <td>${escapeHtml(user.loginName || String(user.email || "").split("@")[0] || "—")}</td>
                <td><code>${escapeHtml(user.uid)}</code></td>
                <td><span class="role-badge ${user.role === "admin" ? "admin" : ""}">${escapeHtml(ROLES[user.role]?.label || user.role)}</span></td>
                <td><span class="role-badge ${user.active === false ? "inactive" : ""}">${user.active === false ? "Inactive" : "Active"}</span></td>
                <td>${escapeHtml(formatDateTime(user.lastLogin))}</td>
                <td><div class="table-actions">
                  <button class="row-btn edit-user" type="button" data-id="${escapeHtml(user.uid)}">Edit</button>
                  ${user.uid !== state.user.uid ? `<button class="row-btn delete delete-user" type="button" data-id="${escapeHtml(user.uid)}">Remove</button>` : ""}
                </div></td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>` :
        `<div class="empty-state">
          <div class="icon">♙</div>
          <h3>No access profiles found</h3>
          <p>Add a Firebase Authentication user's UID and login name to grant portal access.</p>
        </div>`}
    </section>
  `;

  $("addAccessButton").addEventListener("click", () => openUserModal());
  document.querySelectorAll(".edit-user").forEach((button) =>
    button.addEventListener("click", () =>
      openUserModal(state.users.find((user) => user.uid === button.dataset.id))
    )
  );
  document.querySelectorAll(".delete-user").forEach((button) =>
    button.addEventListener("click", () => deleteUserProfile(button.dataset.id))
  );
}

function openUserModal(user = null) {
  const editing = Boolean(user);
  const existingLoginName = user?.loginName || String(user?.email || "").split("@")[0] || "";

  openModal(`
    <form id="accessForm">
      <div class="modal-header">
        <div>
          <div class="eyebrow">USER ACCESS</div>
          <h2>${editing ? "Edit Access Profile" : "Add Access Profile"}</h2>
        </div>
        <button class="icon-btn" type="button" data-close-modal>×</button>
      </div>

      <div class="modal-body">
        <div class="form-grid">
          <div class="field full-span">
            <label for="accessUid">Firebase Authentication UID <em>*</em></label>
            <input id="accessUid" type="text" value="${escapeHtml(user?.uid || "")}" ${editing ? "readonly" : ""} required>
            <span class="help-text">Copy this from Firebase Console → Authentication → Users.</span>
          </div>

          <div class="field">
            <label for="accessName">Person's name <em>*</em></label>
            <input id="accessName" type="text" value="${escapeHtml(user?.displayName || "")}" required>
          </div>

          <div class="field">
            <label for="accessLoginName">Login name <em>*</em></label>
            <input
              id="accessLoginName"
              type="text"
              value="${escapeHtml(existingLoginName)}"
              autocapitalize="none"
              spellcheck="false"
              placeholder="Example: cindy"
              required
            >
            <span id="internalAccountHelp" class="help-text"></span>
          </div>

          <div class="field">
            <label for="accessRole">Role</label>
            <select id="accessRole">
              ${Object.entries(ROLES).map(([role, details]) =>
                `<option value="${role}" ${user?.role === role ? "selected" : ""}>${escapeHtml(details.label)}</option>`
              ).join("")}
            </select>
          </div>

          <div class="field">
            <label for="accessActive">Account status</label>
            <select id="accessActive">
              <option value="true" ${user?.active !== false ? "selected" : ""}>Active</option>
              <option value="false" ${user?.active === false ? "selected" : ""}>Inactive</option>
            </select>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
        <button id="saveAccessButton" class="btn btn-primary" type="submit">Save Access</button>
      </div>
    </form>
  `, true);

  const updateInternalHelp = () => {
    const loginName = $("accessLoginName").value;
    const internalEmail = loginNameToEmail(loginName);
    $("internalAccountHelp").textContent = internalEmail
      ? `Firebase Authentication account must use: ${internalEmail}`
      : "Enter a login name.";
  };

  $("accessLoginName").addEventListener("input", updateInternalHelp);
  updateInternalHelp();

  $("accessForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const userUid = $("accessUid").value.trim();
    const displayName = $("accessName").value.trim();
    const loginName = normalizeLoginName($("accessLoginName").value);
    const internalEmail = loginNameToEmail(loginName);
    const role = $("accessRole").value;
    const active = $("accessActive").value === "true";

    if (!userUid || !displayName || !loginName || !internalEmail) {
      return toast("Complete all required fields.", "error");
    }

    const duplicate = state.users.find(
      (entry) =>
        entry.uid !== userUid &&
        normalizeLoginName(entry.loginName || String(entry.email || "").split("@")[0]) === loginName
    );
    if (duplicate) {
      return toast("That login name is already assigned to another user.", "error");
    }

    const button = $("saveAccessButton");
    button.disabled = true;
    button.textContent = "Saving…";

    try {
      const existing = user || {};
      await set(ref(database, `${PATHS.users}/${userUid}`), {
        uid: userUid,
        displayName,
        loginName,
        email: internalEmail,
        role,
        active,
        createdAt: existing.createdAt || Date.now(),
        createdBy: existing.createdBy || state.user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: state.user.uid,
        lastLogin: existing.lastLogin || null
      });

      await addAudit(
        editing ? "user_access_updated" : "user_access_added",
        `${editing ? "Updated" : "Added"} access for ${loginName}`,
        { targetUid: userUid, role, loginName }
      );

      closeModal();
      toast("User access saved.");
    } catch (error) {
      toast(firebaseWriteMessage(error), "error");
      button.disabled = false;
      button.textContent = "Save Access";
    }
  });
}

async function deleteUserProfile(userUid) {
  const user = state.users.find((entry) => entry.uid === userUid);
  if (!user) return;
  if (!window.confirm(`Remove portal access for ${user.displayName || user.loginName || "this user"}? This does not delete the Firebase Authentication account.`)) return;
  try {
    await remove(ref(database, `${PATHS.users}/${userUid}`));
    await addAudit("user_access_removed", `Removed access for ${user.loginName || user.displayName || userUid}`, { targetUid: userUid });
    toast("Portal access removed.");
  } catch (error) {
    toast(firebaseWriteMessage(error), "error");
  }
}

async function addAudit(action, description, extra = {}) {
  if (!state.user || !state.profile?.active) return;
  const labels = {
    login: "Signed In",
    logout: "Signed Out",
    item_added: "Item Added",
    item_updated: "Item Updated",
    item_deleted: "Item Deleted",
    inventory_imported: "Inventory Imported",
    inventory_exported: "Inventory Exported",
    count_snapshot_saved: "Snapshot Saved",
    count_snapshot_restored: "Snapshot Restored",
    count_snapshot_deleted: "Snapshot Deleted",
    user_access_added: "Access Added",
    user_access_updated: "Access Updated",
    user_access_removed: "Access Removed",
    settings_updated: "Settings Updated",
    sale_recorded: "Sale Recorded",
    sale_reversed: "Sale Reversed",
    sales_exported: "Sales Exported",
    count_set_created: "Count Set Created",
    count_set_activated: "Count Set Activated",
    count_set_closed: "Count Set Closed",
    count_set_reopened: "Count Set Reopened",
    item_added_to_count_set: "Stock Added to Count Set"
  };
  try {
    const logRef = push(ref(database, PATHS.logs));
    await set(logRef, {
      id: logRef.key,
      uid: state.user.uid,
      userEmail: state.profile?.displayName || state.user.email || "",
      staffName: state.profile?.displayName || "",
      action,
      actionLabel: labels[action] || action,
      description,
      module: "alcohol",
      timestamp: serverTimestamp(),
      ...extra
    });
  } catch (error) {
    console.warn("Audit log could not be written:", error);
  }
}

function subscribeData() {
  unsubscribeData();

  state.subscriptions.push(onValue(ref(database, PATHS.items), (snapshot) => {
    const data = snapshot.val() || {};
    state.items = Object.entries(data)
      .map(([key, value]) => sanitizeItem(value, key))
      .filter((item) => item.name)
      .sort((a, b) => a.name.localeCompare(b.name) || a.size.localeCompare(b.size));
    if ($("section-overview")) renderCurrentSection();
  }, (error) => handleSubscriptionError(error, "inventory")));

  state.subscriptions.push(onValue(ref(database, PATHS.catalogItems), async (snapshot) => {
    const data = snapshot.val();

    if (data && typeof data === "object") {
      state.catalog = Object.entries(data)
        .map(([key, value]) => normalizeCatalogEntry(value, key))
        .filter((item) => item.name)
        .sort((a, b) => a.name.localeCompare(b.name) || a.size.localeCompare(b.size));

      state.catalogSource = "Firebase Master Alcohol List";
      state.catalogReady = true;
      state.catalogFallbackAttempted = false;

      await loadBundledCatalogue({
        mergeWithCurrent: true,
        force: true
      });
    } else {
      await loadBundledCatalogue({ force: true });
    }
  }, async (error) => {
    console.warn("Firebase catalogue unavailable; using included master list:", error);
    await loadBundledCatalogue();
  }));

  state.subscriptions.push(onValue(ref(database, PATHS.sales), (snapshot) => {
    const data = snapshot.val() || {};

    state.sales = Object.entries(data)
      .map(([key, value]) => sanitizeSale(value, key))
      .sort((a, b) => saleTime(b) - saleTime(a));

    if (state.currentSection === "stock") renderStockTracker();
    if (state.currentSection === "overview") renderOverview();
  }, (error) => handleSubscriptionError(error, "sales")));

  state.subscriptions.push(onValue(ref(database, PATHS.settings), (snapshot) => {
    state.settings = { ...state.settings, ...(snapshot.val() || {}) };
    state.activeCountSetId = String(state.settings.activeCountSetId || "");
    if ($("section-overview")) renderCurrentSection();
  }));

  state.subscriptions.push(onValue(ref(database, PATHS.countSets), (snapshot) => {
    const data = snapshot.val() || {};

    state.countSets = Object.entries(data)
      .map(([key, value]) => sanitizeCountSet(value, key))
      .sort((a, b) =>
        String(b.countDate).localeCompare(String(a.countDate)) ||
        number(b.createdAt) - number(a.createdAt)
      );

    if (state.currentSection === "countsets") renderCountSets();
    if (state.currentSection === "alcohol") renderAlcohol();
    if (state.currentSection === "products") renderProducts();
    if (state.currentSection === "overview") renderOverview();
  }, (error) => handleSubscriptionError(error, "count sets")));

  state.subscriptions.push(onValue(ref(database, PATHS.counts), (snapshot) => {
    const data = snapshot.val() || {};
    state.sessions = Object.entries(data)
      .map(([key, value]) => ({ id: key, ...value }))
      .sort((a, b) => number(b.createdAt) - number(a.createdAt));
    if (state.currentSection === "history") renderHistory();
  }));

  if (state.profile.role === "admin" && entryMode === "management") {
    state.subscriptions.push(onValue(ref(database, PATHS.logs), (snapshot) => {
      const data = snapshot.val() || {};
      state.logs = Object.entries(data)
        .map(([key, value]) => ({ id: key, ...value }))
        .sort((a, b) => number(b.timestamp) - number(a.timestamp))
        .slice(0, 500);
      if (state.currentSection === "overview") renderOverview();
      if (state.currentSection === "audit") renderAudit();
    }));
  }

  state.subscriptions.push(onValue(ref(database, ".info/connected"), async (snapshot) => {
    state.connected = snapshot.val() === true;
    updateSyncChip();

    if (state.connected && state.user) {
      const presenceRef = ref(database, `${PATHS.presence}/${state.user.uid}`);
      try {
        await onDisconnect(presenceRef).set({
          online: false,
          lastSeen: serverTimestamp(),
          email: state.user.email || ""
        });
        await set(presenceRef, {
          online: true,
          lastSeen: serverTimestamp(),
          email: state.user.email || ""
        });
      } catch (error) {
        console.warn("Presence update failed:", error);
      }
    }
  }));
}

function unsubscribeData() {
  state.subscriptions.forEach((unsubscribe) => {
    try { unsubscribe(); } catch {}
  });
  state.subscriptions = [];
}

function handleSubscriptionError(error, area) {
  console.error(`Firebase ${area} subscription failed:`, error);
  if (String(error?.code || "").includes("permission-denied")) {
    toast(`Firebase denied access to ${area}. Check the deployed database rules.`, "error");
  }
}

function buildSharedPortalProfile(staffName) {
  const isManagement = entryMode === "management";
  return {
    uid: state.user.uid,
    displayName: staffName,
    loginName: staffName,
    email: state.user.email || expectedPortalEmail(),
    role: isManagement ? "admin" : "alcohol_manager",
    active: true,
    sharedPortal: true
  };
}

function portalAccountMatches(user) {
  return String(user?.email || "").toLowerCase() === expectedPortalEmail();
}

onAuthStateChanged(auth, async (user) => {
  unsubscribeData();

  if (!user) {
    state.user = null;
    state.profile = null;
    state.items = [];
    state.sessions = [];
    state.countSets = [];
    state.activeCountSetId = "";
    state.sales = [];
    state.logs = [];
    state.users = [];
    renderLogin();
    return;
  }

  const staffName = cleanStaffName(localStorage.getItem(STAFF_NAME_KEY));

  if (!portalAccountMatches(user)) {
    await signOut(auth);
    renderLogin("This Firebase account belongs to the other portal. Use the correct login page.", "error");
    return;
  }

  if (!staffName) {
    await signOut(auth);
    renderLogin("Enter your name and PIN again.", "error");
    return;
  }

  state.user = user;
  state.profile = buildSharedPortalProfile(staffName);
  state.currentSection = "overview";

  renderAppShell();
  subscribeData();
  await addAudit("login", `Signed in through the ${entryMode} portal`, {
    staffName
  });
});
