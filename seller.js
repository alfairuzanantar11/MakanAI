// seller.js — Seller Dashboard Firebase logic
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, collection, addDoc, getDocs, getDoc, setDoc, updateDoc, deleteDoc,
  doc, onSnapshot, arrayUnion, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ── Init Firebase ─────────────────────────────────────────
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const db  = getFirestore(app);

window.db = db;

// ── Auth Guard (Seller role required) ─────────────────────
function checkSellerAuth() {
  const saved = localStorage.getItem("makan_user");
  if (!saved) {
    window.location.href = "login.html";
    return null;
  }
  try {
    const user = JSON.parse(saved);
    if (user.role !== "seller" && !user.email.toLowerCase().endsWith("@admin.com")) {
      alert("Akses ditolak! Halaman ini hanya untuk akun Seller (@admin.com).");
      window.location.href = "index.html";
      return null;
    }
    window.currentUser = user;
    const nameEl = document.getElementById("seller-nav-username");
    if (nameEl) {
      nameEl.textContent = "👤 " + (user.name || user.email);
    }
    return user;
  } catch (e) {
    localStorage.removeItem("makan_user");
    window.location.href = "login.html";
    return null;
  }
}

const currentSeller = checkSellerAuth();

// ── Sign-out ──────────────────────────────────────────────
window.handleLogout = function() {
  localStorage.removeItem("makan_user");
  window.location.href = "login.html";
};

// ── Inventory ─────────────────────────────────────────────
let menuData = [];

window.toggleModal = function() {
  document.getElementById("menuModal").classList.toggle("hidden");
};

window.saveNewMenu = async function() {
  const name  = document.getElementById("newName").value.trim();
  const price = parseInt(document.getElementById("newPrice").value);
  const stock = parseInt(document.getElementById("newStock").value);
  const emoji = document.getElementById("newEmoji").value || "🍛";
  const tags  = document.getElementById("newTags").value.split(",").map(t => t.trim());

  if (!name || isNaN(price) || isNaN(stock)) {
    alert("Mohon isi semua field dengan benar!");
    return;
  }

  try {
    await addDoc(collection(db, "products"), {
      name, price, stock, emoji, tags,
      createdAt: Date.now()
    });

    alert("Menu berhasil ditambahkan ke Firebase!");
    window.toggleModal();
    // clear input
    document.getElementById("newName").value = "";
    document.getElementById("newPrice").value = "";
    document.getElementById("newStock").value = "";
    loadInventory();
  } catch (err) {
    alert("Gagal menambahkan menu: " + err.message);
  }
};

async function loadInventory() {
  try {
    const snapshot = await getDocs(collection(db, "products"));
    menuData = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderInventory();
  } catch (err) {
    console.error("Error loading products:", err);
  }
}

window.editStock = async function(id) {
  const item  = menuData.find(m => m.id === id);
  if (!item) return;
  const input = prompt("Update stock " + item.name + ":", item.stock);
  if (input === null) return;
  const newStock = parseInt(input);
  if (isNaN(newStock)) return;

  try {
    await updateDoc(doc(db, "products", id), { stock: newStock });
    loadInventory();
  } catch (err) {
    alert("Gagal update stok: " + err.message);
  }
};

window.deleteProduct = async function(id) {
  const item = menuData.find(m => m.id === id);
  if (!item) return;

  const confirmed = confirm(`Hapus "${item.name}" dari menu?\n\nTindakan ini akan menghapus produk secara permanen dari database.`);
  if (!confirmed) return;

  try {
    await deleteDoc(doc(db, "products", id));
    loadInventory();
  } catch (err) {
    alert("Gagal menghapus produk: " + err.message);
  }
};

function renderInventory() {
  const tbody = document.getElementById("inventory-body");
  if (!tbody) return;

  let lowStock = 0, outOfStock = 0;

  tbody.innerHTML = menuData.map(item => {
    if (item.stock === 0)       outOfStock++;
    else if (item.stock <= 5)   lowStock++;

    return `
      <tr class="table-row">
        <td class="p-3 text-sm font-medium text-white">${item.emoji || "🍽️"} ${item.name}</td>
        <td class="p-3 text-sm text-gray-400">${(item.tags || []).join(", ")}</td>
        <td class="p-3 text-sm text-right font-medium text-orange-400">Rp ${(item.price || 0).toLocaleString()}</td>
        <td class="p-3 text-sm text-center">
          ${item.stock === 0
            ? '<span class="badge-low">OUT</span>'
            : item.stock <= 5
              ? `<span class="badge-low">${item.stock}</span>`
              : item.stock}
        </td>
        <td class="p-3 text-right">
          <div class="flex items-center justify-end gap-1.5 flex-wrap">
            <button onclick="editStock('${item.id}')"
              class="btn-edit"
              title="Edit stock ${item.name}">
              Edit
            </button>
            <button onclick="deleteProduct('${item.id}')"
              class="btn-delete-product"
              title="Hapus ${item.name}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              Delete
            </button>
          </div>
        </td>
      </tr>`;
  }).join("");

  const totalEl = document.getElementById("total-items");
  const lowEl   = document.getElementById("low-stock-count");
  const outEl   = document.getElementById("out-of-stock-count");

  if (totalEl) totalEl.innerText = menuData.length;
  if (lowEl)   lowEl.innerText   = lowStock;
  if (outEl)   outEl.innerText   = outOfStock;
}

// ── Orders (Grouped by Customer) ──────────────────────────
window.activeOrders = {};
window.allIncomingOrders = [];
window.ordersSearchQuery = "";
window.ordersActiveFilter = "all";
window.customerAccordionState = {}; // customerKey -> boolean (true: open, false: closed)

function normalizeOrderStatus(rawStatus) {
  const s = (rawStatus || "Processing").toLowerCase().trim();
  if (s === "processing" || s === "pending" || s === "paid") return "pending";
  if (s === "preparing") return "preparing";
  if (s === "on the way" || s === "ready" || s === "shipping") return "ontheway";
  if (s === "delivered" || s === "selesai" || s === "completed") return "completed";
  if (s === "cancelled" || s === "rejected" || s === "batal") return "rejected";
  return "pending";
}

function getCustomerInfo(order) {
  let name = (order.customerName || order.userName || "").trim();
  let email = (order.customerEmail || order.userEmail || "").trim();
  let id = (order.customerId || order.userId || "").trim();

  if (!name && email) {
    const localPart = email.split('@')[0];
    name = localPart.charAt(0).toUpperCase() + localPart.slice(1);
  }
  if (!name && order.location?.address) {
    const parts = order.location.address.split(',');
    name = parts[0].trim();
  }
  if (!name) {
    name = "Customer #" + (order.id ? order.id.slice(-4).toUpperCase() : "GUEST");
  }

  const key = (email || id || name).toLowerCase().trim();

  // Generate 1-2 letter initials
  const initials = name.split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('') || "👤";

  return { key, name, email, initials };
}

function formatOrderDate(timestamp) {
  if (!timestamp) return "Recent";
  const date = timestamp.toDate ? timestamp.toDate() : new Date((timestamp.seconds || 0) * 1000);
  if (isNaN(date.getTime())) return "Recent";
  
  const now = new Date();
  const diffMinutes = Math.floor((now - date) / 60000);
  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  
  return date.toLocaleString('id-ID', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderStatusBadge(status) {
  const norm = normalizeOrderStatus(status);
  if (norm === "pending") {
    return `<span class="status-badge status-processing"><span class="orders-live-dot" style="margin-right:5px;background:#a5b4fc;"></span>Processing</span>`;
  } else if (norm === "preparing") {
    return `<span class="status-badge status-preparing">👨‍🍳 Preparing</span>`;
  } else if (norm === "ontheway") {
    return `<span class="status-badge status-onway">🛵 On the Way</span>`;
  } else if (norm === "completed") {
    return `<span class="status-badge status-delivered">✅ Delivered</span>`;
  } else if (norm === "rejected") {
    return `<span class="status-badge status-cancelled">✕ Rejected</span>`;
  }
  return `<span class="status-badge status-processing">${status || "Processing"}</span>`;
}

function renderActionButtons(order) {
  const norm = normalizeOrderStatus(order.status);
  const orderId = order.id;
  const customerInfo = getCustomerInfo(order);
  const buyerId = order.customerId || customerInfo.key;
  const buyerName = customerInfo.name;
  const buyerEmail = customerInfo.email;

  let html = `<div class="order-actions-group">`;

  // Always offer Chat Buyer button linked to Buyer Account
  html += `
    <button type="button" onclick="openBuyerConversation('${buyerId}', '${buyerName.replace(/'/g, "\\'")}', '${buyerEmail}', '${orderId}')"
      class="action-btn-chat" title="Chat with ${buyerName}">
      💬
    </button>`;

  if (norm === "pending") {
    html += `
      <button type="button" onclick="rejectOrder('${orderId}')"
        class="action-btn action-btn-reject" title="Reject this order">
        ✕ Reject
      </button>
      <button type="button" onclick="updateOrderStatus('${orderId}','Preparing')"
        class="action-btn action-btn-accept" title="Accept and start preparing">
        ✓ Accept & Prepare
      </button>`;
  } else if (norm === "preparing") {
    html += `
      <button type="button" onclick="rejectOrder('${orderId}')"
        class="action-btn action-btn-reject" title="Cancel/Reject this order">
        ✕ Cancel
      </button>
      <button type="button" onclick="updateOrderStatus('${orderId}','On the Way')"
        class="action-btn action-btn-ship" title="Mark order as ready and dispatch driver">
        🛵 Ready & Ship It
      </button>`;
  } else if (norm === "ontheway") {
    html += `
      <button type="button" onclick="openTrackerModal('${orderId}')"
        class="action-btn-track" title="Track driver live coordinates">
        📍 Track GPS
      </button>
      <button type="button" onclick="updateOrderStatus('${orderId}','Delivered')"
        class="action-btn action-btn-finish" title="Mark order as completed/delivered">
        ✓ Mark Completed
      </button>`;
  } else if (norm === "completed") {
    html += `<span class="status-badge status-delivered">Completed ✓</span>`;
  } else if (norm === "rejected") {
    html += `<span class="status-badge status-cancelled">Rejected ✕</span>`;
  }

  html += `</div>`;
  return html;
}

window.toggleCustomerGroup = function(customerKey) {
  const current = window.customerAccordionState[customerKey] !== false; // default true
  window.customerAccordionState[customerKey] = !current;
  renderCustomerOrders();
};

window.setOrdersFilter = function(filterName) {
  window.ordersActiveFilter = filterName;

  // Update tab buttons
  document.querySelectorAll(".orders-tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-filter") === filterName);
  });

  // Update summary card highlight
  document.querySelectorAll(".orders-summary-card").forEach(card => {
    card.classList.remove("active-filter");
  });
  const activeCard = document.getElementById(`summary-card-${filterName}`);
  if (activeCard) activeCard.classList.add("active-filter");

  renderCustomerOrders();
};

window.handleOrdersSearch = function(query) {
  window.ordersSearchQuery = (query || "").trim().toLowerCase();
  const clearBtn = document.getElementById("orders-search-clear");
  if (clearBtn) clearBtn.style.display = window.ordersSearchQuery ? "flex" : "none";
  renderCustomerOrders();
};

window.clearOrdersSearch = function() {
  const input = document.getElementById("orders-search-input");
  const clearBtn = document.getElementById("orders-search-clear");
  if (input) input.value = "";
  if (clearBtn) clearBtn.style.display = "none";
  window.ordersSearchQuery = "";
  renderCustomerOrders();
};

window.rejectOrder = async function(orderId) {
  const confirmed = confirm("Are you sure you want to reject/cancel this order? The customer will see the rejected status.");
  if (!confirmed) return;
  await window.updateOrderStatus(orderId, "Rejected");
};

function renderCustomerOrders() {
  const container = document.getElementById("customer-orders-container");
  if (!container) return;

  const orders = window.allIncomingOrders || [];

  // Compute overall status counts
  const counts = { total: orders.length, pending: 0, preparing: 0, ontheway: 0, completed: 0, rejected: 0 };
  orders.forEach(o => {
    const norm = normalizeOrderStatus(o.status);
    if (counts[norm] !== undefined) counts[norm]++;
  });

  // Update summary numbers
  const totalEl     = document.getElementById("orders-count-total");
  const pendingEl   = document.getElementById("orders-count-pending");
  const preparingEl = document.getElementById("orders-count-preparing");
  const onthewayEl  = document.getElementById("orders-count-ontheway");
  const completedEl = document.getElementById("orders-count-completed");
  const newBadgeEl  = document.getElementById("orders-badge-new");

  if (totalEl)     totalEl.innerText     = counts.total;
  if (pendingEl)   pendingEl.innerText   = counts.pending;
  if (preparingEl) preparingEl.innerText = counts.preparing;
  if (onthewayEl)  onthewayEl.innerText  = counts.ontheway;
  if (completedEl) completedEl.innerText = counts.completed;
  if (newBadgeEl)  newBadgeEl.style.display = counts.pending > 0 ? "inline-block" : "none";

  // Update tab counts
  const tabAll       = document.getElementById("tab-count-all");
  const tabPending   = document.getElementById("tab-count-pending");
  const tabPreparing = document.getElementById("tab-count-preparing");
  const tabOntheway  = document.getElementById("tab-count-ontheway");
  const tabCompleted = document.getElementById("tab-count-completed");
  const tabRejected  = document.getElementById("tab-count-rejected");

  if (tabAll)       tabAll.innerText       = counts.total;
  if (tabPending)   tabPending.innerText   = counts.pending;
  if (tabPreparing) tabPreparing.innerText = counts.preparing;
  if (tabOntheway)  tabOntheway.innerText  = counts.ontheway;
  if (tabCompleted) tabCompleted.innerText = counts.completed;
  if (tabRejected)  tabRejected.innerText  = counts.rejected;

  // Group orders by Customer
  const customerMap = new Map();
  orders.forEach(order => {
    const info = getCustomerInfo(order);
    if (!customerMap.has(info.key)) {
      customerMap.set(info.key, {
        key: info.key,
        name: info.name,
        email: info.email,
        initials: info.initials,
        orders: [],
        latestTimestamp: 0,
        hasPending: false
      });
    }
    const group = customerMap.get(info.key);
    group.orders.push(order);
    const ts = order.timestamp?.seconds || 0;
    if (ts > group.latestTimestamp) group.latestTimestamp = ts;
    if (normalizeOrderStatus(order.status) === "pending") group.hasPending = true;
  });

  const query = (window.ordersSearchQuery || "").toLowerCase();
  const filter = window.ordersActiveFilter || "all";

  // Filter groups
  const filteredGroups = [];
  customerMap.forEach(group => {
    // Filter matching orders inside group
    const matchingOrders = group.orders.filter(order => {
      // 1. Status Filter
      if (filter !== "all") {
        const norm = normalizeOrderStatus(order.status);
        if (norm !== filter) return false;
      }

      // 2. Search Query Filter
      if (query) {
        const orderIdMatch   = (order.id || "").toLowerCase().includes(query);
        const nameMatch      = group.name.toLowerCase().includes(query);
        const emailMatch     = group.email.toLowerCase().includes(query);
        const addressMatch   = (order.location?.address || "").toLowerCase().includes(query);
        const itemsMatch     = (order.items || []).some(item => (item.name || "").toLowerCase().includes(query));
        const statusMatch    = (order.status || "").toLowerCase().includes(query);
        if (!orderIdMatch && !nameMatch && !emailMatch && !addressMatch && !itemsMatch && !statusMatch) {
          return false;
        }
      }

      return true;
    });

    if (matchingOrders.length > 0) {
      filteredGroups.push({
        ...group,
        displayOrders: matchingOrders
      });
    }
  });

  // Sort groups: customers with pending orders first, then by latest order timestamp
  filteredGroups.sort((a, b) => {
    if (a.hasPending && !b.hasPending) return -1;
    if (!a.hasPending && b.hasPending) return 1;
    return b.latestTimestamp - a.latestTimestamp;
  });

  // Empty state handling
  if (filteredGroups.length === 0) {
    const isSearching = query.length > 0;
    const isFiltered = filter !== "all";
    container.innerHTML = `
      <div class="orders-empty-state">
        <div class="orders-empty-icon">${isSearching ? "🔍" : isFiltered ? "📋" : "🍽️"}</div>
        <div class="text-white/80 font-bold text-sm">
          ${isSearching
            ? `No orders found matching "${window.ordersSearchQuery}"`
            : isFiltered
              ? `No ${filter} orders found`
              : "No incoming orders yet"}
        </div>
        <div class="text-white/40 text-xs mt-1">
          ${isSearching || isFiltered
            ? `<button onclick="setOrdersFilter('all'); clearOrdersSearch();" class="text-orange-400 hover:underline mt-2 inline-block">Reset search & filters</button>`
            : "When buyers place food orders, they will appear here grouped by customer in real-time."}
        </div>
      </div>`;
    return;
  }

  // Render Groups
  container.innerHTML = filteredGroups.map(group => {
    // Accordion state: default open if undefined
    const isOpen = window.customerAccordionState[group.key] !== false;
    const totalGroupOrders = group.orders.length;
    const displayCount = group.displayOrders.length;
    const latestOrder = group.orders[0];
    const latestTimeStr = formatOrderDate(latestOrder.timestamp);

    // Summary of statuses for this customer
    const customerStatusCounts = {};
    group.orders.forEach(o => {
      const norm = normalizeOrderStatus(o.status);
      customerStatusCounts[norm] = (customerStatusCounts[norm] || 0) + 1;
    });

    let statusPills = [];
    if (customerStatusCounts.pending)   statusPills.push(`<span class="status-badge status-processing text-[10px] py-0.5">${customerStatusCounts.pending} Pending</span>`);
    if (customerStatusCounts.preparing) statusPills.push(`<span class="status-badge status-preparing text-[10px] py-0.5">${customerStatusCounts.preparing} Preparing</span>`);
    if (customerStatusCounts.ontheway)  statusPills.push(`<span class="status-badge status-onway text-[10px] py-0.5">${customerStatusCounts.ontheway} On the Way</span>`);
    if (customerStatusCounts.completed) statusPills.push(`<span class="status-badge status-delivered text-[10px] py-0.5">${customerStatusCounts.completed} Done</span>`);
    if (customerStatusCounts.rejected)  statusPills.push(`<span class="status-badge status-cancelled text-[10px] py-0.5">${customerStatusCounts.rejected} Rejected</span>`);

    return `
      <div class="customer-group-card ${group.hasPending ? 'has-pending' : ''}">
        <!-- Customer Card Header -->
        <div class="customer-card-header" onclick="toggleCustomerGroup('${group.key}')">
          <div class="customer-info-left">
            <div class="customer-avatar">${group.initials}</div>
            <div class="customer-details">
              <div class="customer-name-row">
                <span class="customer-name">${group.name}</span>
                <span class="customer-orders-badge">${totalGroupOrders} ${totalGroupOrders > 1 ? 'Orders' : 'Order'}</span>
                ${group.hasPending ? '<span class="orders-new-pill">NEW</span>' : ''}
              </div>
              <div class="customer-meta-sub">
                ${group.email ? `<span>${group.email}</span> · ` : ''}
                <span>Latest: ${latestTimeStr}</span>
              </div>
            </div>
          </div>

          <div class="customer-header-right">
            <div class="flex items-center gap-1.5 flex-wrap">
              ${statusPills.join('')}
            </div>
            <button type="button" class="customer-chevron ${isOpen ? 'open' : ''}" aria-label="Toggle orders">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>
          </div>
        </div>

        <!-- Customer Orders Body -->
        ${isOpen ? `
          <div class="customer-orders-body">
            ${group.displayOrders.map(order => {
              const norm = normalizeOrderStatus(order.status);
              const orderTime = formatOrderDate(order.timestamp);
              const items = order.items || [];
              const address = order.location?.address || "No address provided";
              const notes = order.notes || order.location?.details || "";
              const paymentMethod = order.method || order.paymentMethod || "QRIS";
              const totalPrice = order.totalPrice || 0;

              return `
                <div class="order-card order-card-${norm}">
                  <!-- Order Top Bar -->
                  <div class="order-top-bar">
                    <div class="flex items-center gap-2">
                      <span class="order-id-badge">#${order.id.slice(-5).toUpperCase()}</span>
                      <span class="text-xs text-white/50">${orderTime}</span>
                    </div>
                    <div class="order-meta-info">
                      <span class="order-payment-pill">💳 ${paymentMethod}</span>
                      ${renderStatusBadge(order.status)}
                    </div>
                  </div>

                  <!-- Order Items List -->
                  <div class="order-items-grid">
                    ${items.length > 0 ? items.map(item => `
                      <div class="order-item-row">
                        <div class="order-item-name-col">
                          <span class="order-item-qty">${item.quantity}x</span>
                          <span>${item.emoji || "🍽️"} ${item.name}</span>
                        </div>
                        <span class="order-item-price">Rp ${((item.price || 0) * (item.quantity || 1)).toLocaleString()}</span>
                      </div>
                    `).join('') : '<div class="text-xs text-white/40 italic">No items listed in order</div>'}
                  </div>

                  <!-- Address & Notes -->
                  <div class="order-details-grid">
                    <div>
                      <div class="order-address-box">
                        <span style="color:#ff8c33; flex-shrink:0;">📍</span>
                        <span>${address}</span>
                      </div>
                      ${notes ? `
                        <div class="order-notes-box">
                          <span>📝</span>
                          <span><strong>Note:</strong> ${notes}</span>
                        </div>
                      ` : ''}
                    </div>
                  </div>

                  <!-- Order Footer & Management Actions -->
                  <div class="order-footer">
                    <div class="order-total-amount">
                      <span>Total:</span>
                      Rp ${totalPrice.toLocaleString()}
                    </div>
                    ${renderActionButtons(order)}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function loadOrders() {
  onSnapshot(collection(db, "orders"), (snap) => {
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    window.activeOrders = orders.reduce((acc, o) => { acc[o.id] = o; return acc; }, {});

    orders.sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
    window.allIncomingOrders = orders;

    // Render grouped customer UI
    renderCustomerOrders();
  });
}

// Attach Search input listener
document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.getElementById("orders-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      window.ordersSearchQuery = e.target.value.trim().toLowerCase();
      const clearBtn = document.getElementById("orders-search-clear");
      if (clearBtn) clearBtn.style.display = window.ordersSearchQuery ? "flex" : "none";
      renderCustomerOrders();
    });
  }
});

window.updateOrderStatus = async function(orderId, status) {
  try {
    await updateDoc(doc(db, "orders", orderId), { status });
    if (status === "On the Way") {
      await updateDoc(doc(db, "orders", orderId), {
        driverLat: -6.2849,
        driverLng: 107.1706
      });
    }
  } catch (e) {
    console.error("Error updating status:", e);
    alert("Gagal update status: " + e.message);
  }
};

// ── Conversation Architecture Helpers ──────────────────────
function getConversationId(buyerId, sellerId) {
  const cleanB = String(buyerId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanS = String(sellerId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return `conv_${cleanB}_${cleanS}`;
}

async function getOrCreateConversation(buyer, seller) {
  if (!buyer || !buyer.id) throw new Error("Buyer identity required");
  if (!seller || !seller.id) throw new Error("Seller identity required");

  const convId = getConversationId(buyer.id, seller.id);
  const convRef = doc(db, "conversations", convId);

  const snap = await getDoc(convRef);
  if (snap.exists()) {
    return { id: convId, ...snap.data() };
  }

  const initialData = {
    id: convId,
    buyerId: buyer.id,
    buyerName: buyer.name || buyer.email?.split("@")[0] || "Customer",
    buyerEmail: buyer.email || "",
    sellerId: seller.id,
    sellerName: seller.name || "Makan.ai Kitchen",
    sellerEmail: seller.email || "admin@admin.com",
    participants: [buyer.id, seller.id],
    lastMessage: "",
    lastMessageTime: Date.now(),
    lastSenderRole: "",
    unreadCountBuyer: 0,
    unreadCountSeller: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await setDoc(convRef, initialData, { merge: true });
  return initialData;
}

// ── Seller Chat & Consolidated Inbox ──────────────────────
window.currentInboxConvId   = null;
window.inboxChatUnsubscribe = null;
window.inboxConvosCache     = [];
let inboxUnsubscribe        = null;

/**
 * Open a persistent buyer conversation in the consolidated Chat Inbox.
 * Accessible from order cards, inbox list, or dashboard.
 */
window.openBuyerConversation = async function(buyerId, buyerName, buyerEmail, contextOrderId = null) {
  if (!currentSeller) return;

  const convId = getConversationId(buyerId, currentSeller.id);
  window.openChatInbox();

  // Show conversation detail panel inside inbox drawer
  const detailEl = document.getElementById("inboxChatDetail");
  const titleEl  = document.getElementById("inboxDetailTitle");
  const subEl    = document.getElementById("inboxDetailSub");

  if (titleEl) titleEl.textContent = buyerName || "Customer";
  if (subEl) {
    if (contextOrderId) {
      subEl.textContent = `${buyerEmail || "Buyer"} · Order #${contextOrderId.slice(-5).toUpperCase()}`;
    } else {
      subEl.textContent = `${buyerEmail || "Buyer"} · Direct Conversation`;
    }
  }

  if (detailEl) {
    detailEl.style.display = "flex";
    detailEl.classList.remove("hidden");
  }

  // Ensure conversation exists in Firestore
  try {
    await getOrCreateConversation(
      { id: buyerId, name: buyerName, email: buyerEmail },
      currentSeller
    );
  } catch (err) {
    console.warn("getOrCreateConversation in seller:", err);
  }

  window.openInboxDetail(convId);
};

// Backwards-compatibility wrapper: forward legacy openChatModal directly into unified inbox
window.openChatModal = function(orderId) {
  const order = window.activeOrders[orderId] || window.allIncomingOrders?.find(o => o.id === orderId);
  if (order) {
    const info = getCustomerInfo(order);
    const buyerId = order.customerId || info.key;
    window.openBuyerConversation(buyerId, info.name, info.email, orderId);
  } else {
    window.openChatInbox();
  }
};

window.closeChatModal = function() {
  window.closeChatInbox();
};

// ── Map Tracker ───────────────────────────────────────────
let driverMarker = null, driverMap = null;
window.currentMapOrderId = null;

window.openTrackerModal = function(orderId) {
  document.getElementById("trackerModal").classList.remove("hidden");
  window.currentMapOrderId = orderId;

  const order = window.activeOrders[orderId];
  if (!driverMap) {
    driverMap   = L.map("sellerMap").setView([-6.2849, 107.1706], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(driverMap);
    driverMarker = L.marker([-6.2849, 107.1706], { draggable: true }).addTo(driverMap);

    driverMarker.on("dragend", async () => {
      if (!window.currentMapOrderId) return;
      const pos = driverMarker.getLatLng();
      await updateDoc(doc(db, "orders", window.currentMapOrderId), {
        driverLat: pos.lat, driverLng: pos.lng
      });
    });
  }

  const lat = order?.driverLat || -6.2849;
  const lng = order?.driverLng || 107.1706;
  driverMarker.setLatLng([lat, lng]);
  driverMap.setView([lat, lng], 15);
  setTimeout(() => driverMap.invalidateSize(), 200);
};

window.closeTrackerModal = function() {
  document.getElementById("trackerModal").classList.add("hidden");
  window.currentMapOrderId = null;
};

// Start loading when page ready
if (currentSeller) {
  loadInventory();
  loadOrders();
  initChatInbox();
}

// ── Consolidated Chat Inbox (Buyer-Seller Architecture) ────

/** Initialise realtime listener for conversations belonging to this seller */
function initChatInbox() {
  if (!currentSeller || !currentSeller.id) return;
  if (inboxUnsubscribe) inboxUnsubscribe();

  // Listen to conversations collection where sellerId matches current seller
  const q = query(
    collection(db, "conversations"),
    where("sellerId", "==", currentSeller.id)
  );

  inboxUnsubscribe = onSnapshot(q, (snap) => {
    let convos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Fallback: if user is admin@admin.com, also match "seller_default"
    if (currentSeller.email === "admin@admin.com" || currentSeller.role === "seller") {
      // In case some conversations were keyed under seller_default
    }

    // Sort by last message time descending
    convos.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));

    window.inboxConvosCache = convos;
    renderChatInboxSection(convos);
    renderInboxConvoList(convos);
    updateSellerUnreadBadge(convos);
  }, (err) => {
    console.warn("Conversations listener error:", err);
  });
}

/** Count total unread messages from buyers and update UI badges */
function updateSellerUnreadBadge(convos) {
  let totalUnread = 0;
  convos.forEach(c => {
    totalUnread += (c.unreadCountSeller || 0);
  });

  const navBadge  = document.getElementById("chat-unread-badge");
  const inboxPill = document.getElementById("inbox-unread-pill");

  if (navBadge) {
    navBadge.textContent = totalUnread > 9 ? "9+" : String(totalUnread);
    if (totalUnread > 0) { navBadge.classList.remove("hidden"); }
    else                 { navBadge.classList.add("hidden"); }
  }
  if (inboxPill) {
    inboxPill.textContent = `${totalUnread} unread`;
    if (totalUnread > 0) { inboxPill.classList.remove("hidden"); }
    else                 { inboxPill.classList.add("hidden"); }
  }
}

/** Render the on-page dashboard Inbox Section */
function renderChatInboxSection(convos) {
  const listEl = document.getElementById("chat-inbox-list");
  if (!listEl) return;

  if (convos.length === 0) {
    listEl.innerHTML = `
      <div style="padding:2.5rem 1rem; text-align:center; color:#666; font-size:0.85rem;">
        <div style="font-size:2rem; margin-bottom:0.5rem; opacity:0.6;">💬</div>
        No buyer conversations yet.<br>When customers message your kitchen, their persistent conversations will appear here.
      </div>`;
    return;
  }

  listEl.innerHTML = convos.map(c => {
    const isUnread = (c.unreadCountSeller || 0) > 0;
    const timeStr  = c.lastMessageTime ? new Date(c.lastMessageTime).toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'}) : "";
    const preview  = c.lastMessage ? (c.lastMessage.length > 55 ? c.lastMessage.slice(0, 55) + "…" : c.lastMessage) : "No messages yet";
    const senderTag = c.lastSenderRole === "seller" ? "You" : (c.buyerName || "Buyer");
    const initials = (c.buyerName || "Customer").split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "👤";

    return `
      <div onclick="openInboxDetail('${c.id}')"
        style="display:flex; align-items:center; gap:14px; padding:1rem 1.25rem; border-bottom:1px solid rgba(255,255,255,0.05); cursor:pointer; transition:background 0.2s; ${isUnread ? 'background:rgba(54,92,80,0.08);' : ''}"
        onmouseover="this.style.background='rgba(255,255,255,0.03)'"
        onmouseout="this.style.background='${isUnread ? 'rgba(54,92,80,0.08)' : 'transparent'}'">
        <div style="width:42px; height:42px; border-radius:14px; background:${isUnread ? 'rgba(54,92,80,0.25)' : 'rgba(255,255,255,0.06)'}; display:flex; align-items:center; justify-content:center; font-size:0.9rem; font-weight:800; color:#EAEDE8; flex-shrink:0; border:1px solid ${isUnread ? 'rgba(54,92,80,0.5)' : 'rgba(255,255,255,0.08)'}">
          ${initials}
        </div>
        <div style="flex:1; min-width:0;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
            <span style="font-size:0.85rem; font-weight:${isUnread ? '800' : '600'}; color:${isUnread ? '#fff' : 'rgba(255,255,255,0.8)'};">${c.buyerName || "Customer"}</span>
            <span style="font-size:0.65rem; color:#666;">${timeStr}</span>
          </div>
          <div style="font-size:0.75rem; color:#888; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            <span style="color:${isUnread ? '#EAEDE8' : '#666'}; font-weight:${isUnread ? '700' : '500'};">${senderTag}:</span> ${preview}
          </div>
          <div style="margin-top:3px; font-size:0.65rem; color:#555;">${c.buyerEmail || ""}</div>
        </div>
        ${isUnread ? `
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="font-size:9px; background:#ef4444; color:white; font-weight:800; padding:2px 7px; border-radius:99px;">${c.unreadCountSeller} new</span>
          </div>
        ` : ''}
      </div>`;
  }).join("");
}

/** Refresh inbox manually */
window.refreshChatInbox = function() {
  initChatInbox();
};

/** Open the floating slide-in inbox panel */
window.openChatInbox = function() {
  const panel = document.getElementById("chatInboxPanel");
  const inner = document.getElementById("chatInboxPanelInner");
  if (!panel || !inner) return;
  panel.classList.remove("hidden");
  setTimeout(() => { inner.style.transform = "translateX(0)"; }, 10);
  renderInboxConvoList(window.inboxConvosCache);
};

/** Close the floating slide-in inbox panel */
window.closeChatInbox = function() {
  const inner = document.getElementById("chatInboxPanelInner");
  if (inner) inner.style.transform = "translateX(100%)";
  setTimeout(() => {
    const panel = document.getElementById("chatInboxPanel");
    if (panel) panel.classList.add("hidden");
    closeInboxDetailSilent();
  }, 350);
};

window.closeChatInboxOnBg = function(e) {
  if (e.target === document.getElementById("chatInboxPanel")) window.closeChatInbox();
};

/** Render conversation list inside the slide-in panel */
function renderInboxConvoList(convos) {
  const listEl = document.getElementById("inboxConvoList");
  if (!listEl) return;

  if (convos.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center; padding:3.5rem 1rem; color:#666; font-size:0.82rem; line-height:1.6;">
        <div style="font-size:2.2rem; margin-bottom:0.75rem;">💬</div>
        No buyer messages yet.<br>Conversations with your customers will appear here in real-time.
      </div>`;
    return;
  }

  listEl.innerHTML = convos.map(c => {
    const isUnread = (c.unreadCountSeller || 0) > 0;
    const isSelected = window.currentInboxConvId === c.id;
    const timeStr  = c.lastMessageTime ? new Date(c.lastMessageTime).toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'}) : "";
    const preview  = c.lastMessage ? (c.lastMessage.length > 40 ? c.lastMessage.slice(0, 40) + "…" : c.lastMessage) : "No messages yet";
    const senderTag = c.lastSenderRole === "seller" ? "You" : (c.buyerName || "Buyer");
    const initials = (c.buyerName || "Customer").split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "👤";

    return `
      <div onclick="openInboxDetail('${c.id}')"
        style="display:flex; align-items:center; gap:12px; padding:0.85rem; border-radius:14px; cursor:pointer; transition:all 0.15s; margin-bottom:6px;
          ${isSelected
            ? 'background:rgba(54,92,80,0.18); border:1px solid rgba(54,92,80,0.5);'
            : isUnread
              ? 'background:rgba(54,92,80,0.1); border:1px solid rgba(54,92,80,0.25);'
              : 'background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05);'}"
        onmouseover="this.style.background='rgba(255,255,255,0.06)'"
        onmouseout="this.style.background='${isSelected ? 'rgba(54,92,80,0.18)' : isUnread ? 'rgba(54,92,80,0.1)' : 'rgba(255,255,255,0.03)'}'">
        <div style="width:40px; height:40px; border-radius:12px; background:${isUnread ? 'rgba(54,92,80,0.3)' : 'rgba(255,255,255,0.08)'}; display:flex; align-items:center; justify-content:center; font-size:0.85rem; font-weight:800; color:#EAEDE8; flex-shrink:0;">
          ${initials}
        </div>
        <div style="flex:1; min-width:0;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
            <span style="font-size:0.82rem; font-weight:${isUnread ? '800' : '600'}; color:${isUnread ? '#fff' : 'rgba(255,255,255,0.75)'};">${c.buyerName || "Customer"}</span>
            <span style="font-size:0.62rem; color:#666;">${timeStr}</span>
          </div>
          <div style="font-size:0.7rem; color:#888; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            <span style="color:${isUnread ? '#EAEDE8' : '#666'}; font-weight:${isUnread ? '700' : '500'};">${senderTag}:</span> ${preview}
          </div>
          <div style="margin-top:2px; font-size:0.62rem; color:#555;">${c.buyerEmail || ""}</div>
        </div>
        ${isUnread ? `
          <div style="width:8px; height:8px; border-radius:50%; background:#ef4444; box-shadow:0 0 6px #ef4444; flex-shrink:0;"></div>
        ` : ''}
      </div>`;
  }).join("");
}

/** Open a specific conversation inside the slide-in panel */
window.openInboxDetail = async function(convId) {
  window.currentInboxConvId = convId;
  const detailEl = document.getElementById("inboxChatDetail");
  const titleEl  = document.getElementById("inboxDetailTitle");
  const subEl    = document.getElementById("inboxDetailSub");
  if (!detailEl) return;

  const conv = window.inboxConvosCache.find(c => c.id === convId);
  if (conv) {
    if (titleEl) titleEl.textContent = conv.buyerName || "Customer";
    if (subEl)   subEl.textContent   = (conv.buyerEmail || "Buyer") + " · Persistent Chat";
  }

  detailEl.style.display = "flex";
  detailEl.classList.remove("hidden");

  // Show loading indicator
  const box = document.getElementById("inboxChatBody");
  if (box) {
    box.innerHTML = `<div style="text-align:center; color:#555; font-size:0.8rem; padding:2rem;">Loading messages...</div>`;
  }

  // Reset seller unread count in Firestore
  try {
    await updateDoc(doc(db, "conversations", convId), { unreadCountSeller: 0 });
  } catch(e) {}

  // Subscribe to realtime messages subcollection
  if (window.inboxChatUnsubscribe) window.inboxChatUnsubscribe();

  const msgsRef = collection(db, "conversations", convId, "messages");
  const q = query(msgsRef, orderBy("createdAt", "asc"));

  window.inboxChatUnsubscribe = onSnapshot(q, (snapshot) => {
    const msgs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderInboxMessages(msgs);
  }, (err) => {
    console.error("Inbox messages listener error:", err);
  });

  setTimeout(() => {
    document.getElementById("inboxChatInput")?.focus();
  }, 100);
};

/** Render messages in the inbox detail view */
function renderInboxMessages(msgs) {
  const box = document.getElementById("inboxChatBody");
  if (!box) return;

  if (msgs.length === 0) {
    box.innerHTML = `
      <div style="text-align:center; color:#555; font-size:0.8rem; padding:3rem 1rem;">
        <div style="font-size:1.8rem; margin-bottom:0.5rem; opacity:0.5;">💬</div>
        No messages yet in this conversation.<br>Send a message below to reach the buyer directly.
      </div>`;
    return;
  }

  box.innerHTML = msgs.map(m => {
    const isSeller = m.senderRole === "seller" || m.senderId === currentSeller.id;
    const time = m.createdAt ? new Date(m.createdAt).toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'}) : "";
    return `
      <div style="display:flex; flex-direction:column; align-items:${isSeller ? 'flex-end' : 'flex-start'};">
        <span style="font-size:0.6rem; color:#555; margin-bottom:3px; padding-right:4px; padding-left:4px;">
          ${isSeller ? 'YOU' : 'BUYER'} ${time ? '· ' + time : ''}
        </span>
        <div style="max-width:82%; padding:0.65rem 1rem; border-radius:${isSeller ? '16px 16px 2px 16px' : '16px 16px 16px 2px'}; font-size:0.82rem; line-height:1.45;
          ${isSeller
            ? 'background:linear-gradient(135deg,#365C50,#14243A); color:#EAEDE8; border:1px solid rgba(54,92,80,0.5);'
            : 'background:rgba(255,255,255,0.08); color:white; border:1px solid rgba(255,255,255,0.08);'}">
          ${escapeHtml(m.text || "")}
        </div>
      </div>`;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

/** Send a reply from the seller inbox detail panel */
window.sendInboxReply = async function() {
  const input = document.getElementById("inboxChatInput");
  if (!input) return;
  const val = input.value.trim();
  const convId = window.currentInboxConvId;

  if (!val || !convId || !currentSeller) return;

  input.value = "";

  try {
    const now = Date.now();
    const msgsRef = collection(db, "conversations", convId, "messages");

    await addDoc(msgsRef, {
      conversationId: convId,
      senderId: currentSeller.id,
      senderRole: "seller",
      senderName: currentSeller.name || "Makan.ai Kitchen",
      text: val,
      createdAt: now,
      timestamp: serverTimestamp(),
      read: false
    });

    const convRef = doc(db, "conversations", convId);
    const convSnap = await getDoc(convRef);
    const currentUnread = convSnap.exists() ? (convSnap.data().unreadCountBuyer || 0) : 0;

    await updateDoc(convRef, {
      lastMessage: val,
      lastMessageTime: now,
      lastSenderRole: "seller",
      unreadCountBuyer: currentUnread + 1,
      updatedAt: now
    });

  } catch (err) {
    console.error("sendInboxReply error:", err);
    alert("Could not send reply: " + err.message);
  } finally {
    input.focus();
  }
};

/** Go back to conversation list from detail */
window.closeInboxDetail = function() {
  closeInboxDetailSilent();
  renderInboxConvoList(window.inboxConvosCache);
};

function closeInboxDetailSilent() {
  const detailEl = document.getElementById("inboxChatDetail");
  if (detailEl) { detailEl.style.display = "none"; detailEl.classList.add("hidden"); }
  if (window.inboxChatUnsubscribe) { window.inboxChatUnsubscribe(); window.inboxChatUnsubscribe = null; }
  window.currentInboxConvId = null;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
