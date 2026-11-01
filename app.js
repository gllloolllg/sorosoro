import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, setPersistence, browserLocalPersistence, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, getDocs, doc, setDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAPQmDt1uP2iG-Kezw8IAgw6vbr_Ut_MzI",
  authDomain: "sorosoro-12469.firebaseapp.com",
  projectId: "sorosoro-12469",
  storageBucket: "sorosoro-12469.firebasestorage.app",
  messagingSenderId: "632274769717",
  appId: "1:632274769717:web:e58e7b0ea14e2a49ed1e7c"
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
auth.useDeviceLanguage();
const cloudDB = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

const COLORS = ["transparent", "#9AB3B3", "#9FAFC2", "#AEA7BC", "#C2B590", "#D27572"];
const LEGACY_COLORS = {
  "#8EAE9D": "#9AB3B3",
  "#89A9C2": "#9FAFC2",
  "#A69ABA": "#AEA7BC",
  "#D5A07E": "#C2B590",
  "#C2AA78": "#C2B590",
  "#E35F63": "#D27572"
};
const DB_NAME = "sorosoro-db";
const DB_VERSION = 1;
let db;
let currentUser = null;
let items = [];
let records = [];
let toastTimer;
let loadingCount = 0;
let loadingStartedAt = 0;
let loadingHideTimer;

const $ = (selector, root = document) => root.querySelector(selector);
const todayString = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const parseDate = value => new Date(`${value}T00:00:00`);
const daysBetween = (from, to = todayString()) => Math.floor((parseDate(to) - parseDate(from)) / 86400000);
const id = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const dateJa = value => parseDate(value).toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });

function withLoading(promise) {
  loadingCount += 1;
  clearTimeout(loadingHideTimer);
  if (loadingCount === 1) {
    loadingStartedAt = performance.now();
    $("#dataLoading").hidden = false;
  }
  return promise.finally(() => {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount > 0) return;
    const delay = Math.max(0, 300 - (performance.now() - loadingStartedAt));
    loadingHideTimer = setTimeout(() => {
      if (loadingCount === 0) $("#dataLoading").hidden = true;
    }, delay);
  });
}

function openDB() {
  return withLoading(new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const next = request.result;
      if (!next.objectStoreNames.contains("items")) next.createObjectStore("items", { keyPath: "id" });
      if (!next.objectStoreNames.contains("records")) {
        const store = next.createObjectStore("records", { keyPath: "id" });
        store.createIndex("itemId", "itemId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

function localStoreRequest(storeName, mode, action) {
  return withLoading(new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = action(store);
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

async function loadData() {
  const uid = currentUser.uid;
  const [itemSnapshot, recordSnapshot] = await withLoading(Promise.all([
    getDocs(collection(cloudDB, "users", uid, "items")),
    getDocs(collection(cloudDB, "users", uid, "records"))
  ]));
  items = itemSnapshot.docs.map(value => value.data());
  records = recordSnapshot.docs.map(value => value.data());
  await migrateLocalData(uid);
  renderItems();
}

async function readLocalData() {
  if (!db) return { localItems: [], localRecords: [] };
  const [localItems, localRecords] = await Promise.all([
    localStoreRequest("items", "readonly", store => store.getAll()),
    localStoreRequest("records", "readonly", store => store.getAll())
  ]);
  localItems.forEach(item => { if (LEGACY_COLORS[item.color]) item.color = LEGACY_COLORS[item.color]; });
  return { localItems, localRecords };
}

async function migrateLocalData(uid) {
  const { localItems, localRecords } = await readLocalData();
  if (!localItems.length && !localRecords.length) return;
  const claimedBy = localStorage.getItem("sorosoro-legacy-claimed-by");
  if (claimedBy) return;
  if (!items.length && !records.length) {
    await withLoading(Promise.all([
      ...localItems.map(item => setDoc(doc(cloudDB, "users", uid, "items", item.id), item)),
      ...localRecords.map(record => setDoc(doc(cloudDB, "users", uid, "records", record.id), record))
    ]));
    items = localItems;
    records = localRecords;
    showToast("端末のデータを引き継ぎました");
  }
  localStorage.setItem("sorosoro-legacy-claimed-by", uid);
}

function cloudDoc(type, valueId) {
  return doc(cloudDB, "users", currentUser.uid, type, valueId);
}

function putCloud(type, value) {
  return withLoading(setDoc(cloudDoc(type, value.id), value));
}

function deleteCloud(type, valueId) {
  return withLoading(deleteDoc(cloudDoc(type, valueId)));
}

const latestRecord = itemId => records.filter(r => r.itemId === itemId).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))[0];

function itemState(item) {
  const latest = latestRecord(item.id);
  const showElapsed = Boolean(item.showElapsed);
  const showRemaining = item.showRemaining !== false;
  if (!latest) return { priority: Infinity, progress: 0, label: showElapsed || showRemaining ? "未記録" : "", className: "is-unrecorded" };
  const elapsed = Math.max(0, daysBetween(latest.date));
  const remaining = item.interval - elapsed;
  const priority = elapsed / item.interval;
  const progress = Math.min(100, Math.max(0, priority * 100));
  const soonDays = Math.min(7, Math.max(1, Math.ceil(item.interval * .1)));
  const labels = [];
  if (showElapsed) labels.push(`${elapsed}日たった`);
  if (showRemaining) labels.push(remaining >= 0 ? `あと${remaining}日` : `${Math.abs(remaining)}日すぎた`);
  const className = remaining < 0 ? "is-due is-overdue" : remaining === 0 ? "is-due" : remaining <= soonDays ? "is-soon" : "";
  return { priority, progress, label: labels.join("　"), className };
}

function sortedItems() {
  return [...items].sort((a, b) => {
    const sa = itemState(a), sb = itemState(b);
    return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || sb.priority - sa.priority || a.createdAt.localeCompare(b.createdAt);
  });
}

function iconGear() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.1 13.1c.04-.36.04-.73 0-1.1l2-1.55-2-3.46-2.47 1a7.3 7.3 0 0 0-.95-.55L15.3 4.8h-4l-.38 2.64c-.34.16-.66.35-.96.56l-2.47-1-2 3.45L7.5 12a7.5 7.5 0 0 0 0 1.1l-2.01 1.55 2 3.46 2.47-1c.3.22.62.4.96.56l.38 2.64h4l.38-2.64c.34-.16.66-.34.95-.56l2.47 1 2-3.46-2-1.55ZM13.3 15.2a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4Z"/></svg>`;
}

function renderItems() {
  const list = $("#itemList");
  const ordered = sortedItems();
  list.innerHTML = "";
  ordered.forEach((item, index) => {
    const state = itemState(item);
    const card = document.createElement("article");
    card.className = `item-card ${item.pinned ? "is-locked" : ""} ${state.className}`;
    card.dataset.itemId = item.id;
    card.style.setProperty("--item-color", item.color);
    card.style.setProperty("--progress", `${state.progress}%`);
    card.style.animationDelay = `${Math.min(index * 35, 210)}ms`;
    card.innerHTML = `
      <div class="item-main">
        <div class="item-name"></div>
        <div class="item-status"></div>
      </div>
      <button class="card-action settings-button" aria-label="項目を設定">${iconGear()}</button>`;
    $(".item-name", card).textContent = item.name;
    $(".item-status", card).textContent = state.label;
    card.addEventListener("click", () => openRecordModal(item));
    $(".settings-button", card).addEventListener("click", event => { event.stopPropagation(); openItemModal(item); });
    list.appendChild(card);
  });
  $("#emptyState").hidden = ordered.length !== 0;
}

function cloneTemplate(name) {
  const fragment = $(`#${name}`).content.cloneNode(true);
  const layer = $("[data-modal]", fragment);
  $("#modalRoot").replaceChildren(fragment);
  const active = $("[data-modal]", $("#modalRoot"));
  active.addEventListener("click", event => { if (event.target === active) closeModal(); });
  active.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeModal));
  requestAnimationFrame(() => active.querySelector("input, textarea, button")?.focus({ preventScroll: true }));
  return active;
}

function closeModal() {
  const layer = $("[data-modal]", $("#modalRoot"));
  if (!layer || layer.classList.contains("is-closing")) return;
  layer.classList.add("is-closing");
  setTimeout(() => $("#modalRoot").replaceChildren(), 190);
}

function openRecordModal(item) {
  const modal = cloneTemplate("recordModalTemplate");
  $("#recordTitle", modal).textContent = item.name;
  const note = $("#recordItemMemo", modal);
  const itemMemo = String(item.memo ?? "").trim();
  note.textContent = itemMemo;
  note.hidden = itemMemo.length === 0;
  const date = $("#recordDate", modal);
  date.value = todayString();
  date.max = todayString();
  $("#historyButton", modal).addEventListener("click", () => openHistoryModal(item));
  $("#saveRecordButton", modal).addEventListener("click", async event => {
    if (!date.value || date.value > todayString()) return;
    const record = { id: id(), itemId: item.id, date: date.value, memo: $("#recordMemo", modal).value.trim(), createdAt: new Date().toISOString() };
    event.currentTarget.disabled = true;
    closeModal();
    const card = [...document.querySelectorAll(".item-card")].find(value => value.dataset.itemId === item.id);
    const previousProgress = card?.style.getPropertyValue("--progress");
    if (card) requestAnimationFrame(() => card.style.setProperty("--progress", "0%"));
    try {
      await Promise.all([
        putCloud("records", record),
        new Promise(resolve => setTimeout(resolve, 1050))
      ]);
      records.push(record);
      renderItems();
    } catch (error) {
      if (card && previousProgress) card.style.setProperty("--progress", previousProgress);
      console.error(error);
      showToast("記録できませんでした");
    }
  });
}

function openItemModal(item = null) {
  const modal = cloneTemplate("itemModalTemplate");
  const editing = Boolean(item);
  let pinned = Boolean(item?.pinned);
  const lockButton = $("#itemLockButton", modal);
  const renderLock = () => {
    lockButton.classList.toggle("is-locked", pinned);
    lockButton.setAttribute("aria-pressed", String(pinned));
    lockButton.setAttribute("aria-label", pinned ? "上部への固定を解除" : "上部に固定");
  };
  renderLock();
  lockButton.addEventListener("click", () => {
    pinned = !pinned;
    renderLock();
    lockButton.classList.remove("is-bouncing");
    requestAnimationFrame(() => lockButton.classList.add("is-bouncing"));
  });
  lockButton.addEventListener("animationend", () => lockButton.classList.remove("is-bouncing"));
  $("#itemModalTitle", modal).textContent = editing ? "項目の設定" : "項目をつくる";
  $("#saveItemButton", modal).textContent = editing ? "保存する" : "作成する";
  const picker = $("#colorPicker", modal);
  COLORS.forEach((color, index) => {
    const label = document.createElement("label");
    label.className = "color-option";
    label.style.setProperty("--swatch", color);
    label.innerHTML = `<input type="radio" name="itemColor" value="${color}" ${(item?.color || COLORS[0]) === color ? "checked" : ""}><span aria-label="色${index + 1}"></span>`;
    picker.appendChild(label);
  });
  if (editing) {
    $("#itemName", modal).value = item.name;
    $("#itemMemo", modal).value = item.memo || "";
    $("#itemInterval", modal).value = item.interval;
    $("#itemShowElapsed", modal).checked = Boolean(item.showElapsed);
    $("#itemShowRemaining", modal).checked = item.showRemaining !== false;
    const deleteButton = $("#deleteItemButton", modal);
    deleteButton.hidden = false;
    deleteButton.addEventListener("click", () => deleteItem(item));
  }
  $("#itemForm", modal).addEventListener("submit", async event => {
    event.preventDefault();
    const nextItem = {
      id: item?.id || id(),
      name: $("#itemName", modal).value.trim(),
      memo: $("#itemMemo", modal).value.trim(),
      interval: Number($("#itemInterval", modal).value),
      showElapsed: $("#itemShowElapsed", modal).checked,
      showRemaining: $("#itemShowRemaining", modal).checked,
      color: $("input[name='itemColor']:checked", modal).value,
      pinned,
      createdAt: item?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!nextItem.name || nextItem.interval < 1) return;
    await putCloud("items", nextItem);
    items = editing ? items.map(value => value.id === nextItem.id ? nextItem : value) : [...items, nextItem];
    closeModal();
    renderItems();
    showToast(editing ? "設定を保存しました" : `${nextItem.name}を追加しました`);
  });
}

async function deleteItem(item) {
  if (!confirm(`「${item.name}」とすべての履歴を削除しますか？`)) return;
  const deletedRecords = records.filter(r => r.itemId === item.id);
  const batch = writeBatch(cloudDB);
  batch.delete(cloudDoc("items", item.id));
  deletedRecords.forEach(record => batch.delete(cloudDoc("records", record.id)));
  await withLoading(batch.commit());
  items = items.filter(value => value.id !== item.id);
  records = records.filter(record => record.itemId !== item.id);
  closeModal();
  renderItems();
  showToast(`${item.name}を削除しました`, async () => {
    await withLoading(Promise.all([
      setDoc(cloudDoc("items", item.id), item),
      ...deletedRecords.map(record => setDoc(cloudDoc("records", record.id), record))
    ]));
    items.push(item); records.push(...deletedRecords); renderItems(); showToast("元に戻しました");
  });
}

function openHistoryModal(item) {
  const modal = cloneTemplate("historyModalTemplate");
  $("#historyTitle", modal).textContent = `${item.name}の履歴`;
  renderHistory(item, modal);
}

function renderHistory(item, modal) {
  const list = $("#historyList", modal);
  const rows = records.filter(r => r.itemId === item.id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  if (!rows.length) { list.innerHTML = `<div class="history-empty">まだ履歴はありません</div>`; return; }
  list.innerHTML = "";
  rows.forEach((record, index) => {
    const row = document.createElement("div");
    row.className = "history-row";
    row.style.animationDelay = `${index * 25}ms`;
    row.innerHTML = `<div class="history-name"></div><time class="history-date"></time><button class="history-delete" aria-label="履歴を削除">×</button>${record.memo ? '<p class="history-memo"></p>' : ''}`;
    $(".history-name", row).textContent = item.name;
    $(".history-date", row).textContent = dateJa(record.date);
    if (record.memo) $(".history-memo", row).textContent = record.memo;
    $(".history-delete", row).addEventListener("click", async () => {
      await deleteCloud("records", record.id);
      records = records.filter(value => value.id !== record.id);
      renderHistory(item, modal); renderItems();
      showToast("履歴を削除しました", async () => {
        await putCloud("records", record);
        records.push(record); renderHistory(item, modal); renderItems(); showToast("元に戻しました");
      });
    });
    list.appendChild(row);
  });
}

function showToast(message, undo) {
  clearTimeout(toastTimer);
  const region = $("#toastRegion");
  region.innerHTML = `<div class="toast"><span></span>${undo ? "<button>元に戻す</button>" : ""}</div>`;
  $(".toast span", region).textContent = message;
  if (undo) $(".toast button", region).addEventListener("click", async () => { clearTimeout(toastTimer); await undo(); });
  toastTimer = setTimeout(() => {
    $(".toast", region)?.classList.add("is-leaving");
    setTimeout(() => region.replaceChildren(), 210);
  }, 4500);
}

document.addEventListener("keydown", event => { if (event.key === "Escape") closeModal(); });
window.addEventListener("unhandledrejection", event => {
  console.error(event.reason);
  showToast("通信できませんでした。もう一度お試しください");
});
$("#addButton").addEventListener("click", () => openItemModal());
$("#emptyAddButton").addEventListener("click", () => openItemModal());
$("#googleSignInButton").addEventListener("click", async () => {
  try {
    await setPersistence(auth, browserLocalPersistence);
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    if (error.code !== "auth/popup-closed-by-user") {
      console.error(error);
      showToast("Googleにログインできませんでした");
    }
  }
});
$("#accountButton").addEventListener("click", () => {
  const modal = cloneTemplate("accountModalTemplate");
  $("#accountEmail", modal).textContent = currentUser?.email || "";
  $("#signOutButton", modal).addEventListener("click", () => signOut(auth));
});
$("#todayLabel").textContent = new Date().toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });

(async () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
  try { db = await openDB(); } catch (error) { console.warn("端末データを開けませんでした", error); }
  await navigator.storage?.persist?.();
  let firstAuthState = true;
  await withLoading(new Promise(resolve => {
    onAuthStateChanged(auth, async user => {
      currentUser = user;
      closeModal();
      if (!user) {
        items = [];
        records = [];
        $("#appShell").hidden = true;
        $("#authGate").hidden = false;
      } else {
        $("#authGate").hidden = true;
        $("#appShell").hidden = false;
        $("#accountButton").hidden = false;
        $("#accountInitial").textContent = (user.displayName || user.email || "G").trim().charAt(0).toUpperCase();
        try { await loadData(); }
        catch (error) {
          console.error(error);
          showToast("データを読み込めませんでした");
        }
      }
      if (firstAuthState) { firstAuthState = false; resolve(); }
    });
  }));
})();
