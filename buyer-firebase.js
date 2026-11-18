// buyer-firebase.js — Buyer page Firebase logic with Persistent Conversation Architecture & Scoped Order Tracking
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, collection, addDoc, getDocs, getDoc, doc, setDoc,
  updateDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ── Init Firebase (reuse if already initialized) ───────────
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const db  = getFirestore(app);

// Expose globally
window.db = db;
window.firestoreFns = {
  collection, addDoc, getDocs, getDoc, doc, setDoc,
  updateDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp
};

// ── Auth Guard via localStorage ────────────────────────────
export function checkAuth() {
  const saved = localStorage.getItem("makan_user");
  if (!saved) {
    window.location.href = "login.html";
    return null;
  }
  try {
    const user = JSON.parse(saved);
    window.currentUser = user;
    const nameEl = document.getElementById("nav-username");
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

const currentBuyer = checkAuth();

// ── Sign-out helper ───────────────────────────────────────
window.handleLogout = function() {
  localStorage.removeItem("makan_user");
  window.location.href = "login.html";
};

// ============================================================
// CONVERSATION ARCHITECTURE HELPERS
// ============================================================

/**
 * Deterministic conversation identifier for buyer-seller pair.
 * Ensures Buyer A + Seller X always maps to conv_{buyerA}_{sellerX}.
 */
export function getConversationId(buyerId, sellerId) {
  const cleanB = String(buyerId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanS = String(sellerId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return `conv_${cleanB}_${cleanS}`;
}

window.getConversationId = getConversationId;

/**
 * Resolves default/primary seller from Firestore or fallback.
 */
export async function getDefaultSeller() {
  try {
    const q = query(collection(db, "users"), where("role", "==", "seller"), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const d = snap.docs[0];
      return { id: d.id, name: d.data().name || "Makan.ai Kitchen", email: d.data().email || "admin@admin.com" };
    }
  } catch (err) {
    console.warn("Could not query default seller, using fallback:", err);
  }
  return { id: "seller_default", name: "Makan.ai Kitchen", email: "admin@admin.com" };
}

window.getDefaultSeller = getDefaultSeller;

/**
 * Idempotently get or create a persistent conversation between buyer and seller.
 */
export async function getOrCreateConversation(buyer, seller) {
  if (!buyer || !buyer.id) throw new Error("Buyer identity required");
  if (!seller || !seller.id) throw new Error("Seller identity required");

  const convId = getConversationId(buyer.id, seller.id);
  const convRef = doc(db, "conversations", convId);

  const snap = await getDoc(convRef);
  if (snap.exists()) {
    return { id: convId, ...snap.data() };
  }

  // Safe initial creation
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

window.getOrCreateConversation = getOrCreateConversation;

// ============================================================
// BUYER CHAT IMPLEMENTATION
// ============================================================

let buyerChatMessagesUnsubscribe = null;
window.currentBuyerConversationId = null;
window.currentBuyerTargetSeller = null;

/**
 * Opens conversation with a merchant.
 * @param {string|object} sellerOrSellerId - Seller ID or Seller object
 * @param {object} [context] - Optional order context { orderId: "..." }
 */
window.openBuyerChat = async function(sellerOrSellerId, context = null) {
  const buyer = window.currentUser || checkAuth();
  if (!buyer) {
    alert("Please log in first.");
    return;
  }

  const modal = document.getElementById("buyerChatModal");
  if (!modal) return;
  modal.classList.remove("hidden");

  // Show loading indicator in chat body
  const chatBody = document.getElementById("buyerChatBody");
  if (chatBody) {
    chatBody.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full text-center py-8 text-white/40">
        <div class="w-6 h-6 border-2 border-white/20 border-t-white rounded-full animate-spin mb-3"></div>
        <p class="text-xs">Connecting to secure conversation...</p>
      </div>`;
  }

  try {
    // Resolve seller
    let seller = null;
    if (sellerOrSellerId && typeof sellerOrSellerId === "object" && sellerOrSellerId.id) {
      seller = sellerOrSellerId;
    } else if (typeof sellerOrSellerId === "string" && sellerOrSellerId && sellerOrSellerId !== "default") {
      try {
        const sellerDoc = await getDoc(doc(db, "users", sellerOrSellerId));
        if (sellerDoc.exists()) {
          seller = { id: sellerDoc.id, ...sellerDoc.data() };
        }
      } catch (e) {
        console.warn("Could not fetch seller doc:", e);
      }
    }

    if (!seller) {
      seller = await getDefaultSeller();
    }

    window.currentBuyerTargetSeller = seller;

    // Get or create conversation document
    const conv = await getOrCreateConversation(buyer, seller);
    const convId = conv.id;
    window.currentBuyerConversationId = convId;

    // Update modal header
    const titleEl = document.getElementById("buyerChatSellerTitle");
    const subEl   = document.getElementById("buyerChatSubtitle");
    if (titleEl) titleEl.textContent = seller.name || "Makan.ai Kitchen";
    if (subEl) {
      if (context && context.orderId) {
        subEl.textContent = `Order #${context.orderId.slice(-5).toUpperCase()} · Live Merchant Chat`;
      } else {
        subEl.textContent = "Direct Merchant Conversation";
      }
    }

    // Reset unread count for buyer
    try {
      await updateDoc(doc(db, "conversations", convId), { unreadCountBuyer: 0 });
    } catch (e) {
      // Ignore if document not editable yet
    }

    // Teardown previous listener
    if (buyerChatMessagesUnsubscribe) {
      buyerChatMessagesUnsubscribe();
      buyerChatMessagesUnsubscribe = null;
    }

    // Listen to messages subcollection in chronological order
    const msgsRef = collection(db, "conversations", convId, "messages");
    const q = query(msgsRef, orderBy("createdAt", "asc"));

    buyerChatMessagesUnsubscribe = onSnapshot(q, (snapshot) => {
      if (!chatBody) return;

      if (snapshot.empty) {
        chatBody.innerHTML = `
          <div class="flex flex-col items-center justify-center h-full text-center py-10 px-4">
            <div class="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-2xl mb-3">💬</div>
            <p class="text-sm font-bold text-white/80">No messages yet</p>
            <p class="text-xs text-white/40 mt-1 max-w-[220px]">Send a message to ${seller.name || "the merchant"} to ask about your food, delivery, or ingredients!</p>
          </div>`;
        return;
      }

      chatBody.innerHTML = snapshot.docs.map(docSnap => {
        const m = docSnap.data();
        const isBuyer = m.senderRole === "buyer" || m.senderId === buyer.id;
        const timeStr = m.createdAt ? new Date(m.createdAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "";
        const senderLabel = isBuyer ? "YOU" : (seller.name || "RESTAURANT").toUpperCase();

        return `
          <div class="flex flex-col ${isBuyer ? "items-end" : "items-start"} animate-in">
            <span class="text-[9px] font-bold ${isBuyer ? "text-[#A5A69A]" : "text-emerald-400/80"} mb-0.5 tracking-wider">
              ${senderLabel} ${timeStr ? "· " + timeStr : ""}
            </span>
            <div class="px-3.5 py-2.5 rounded-2xl max-w-[85%] text-sm leading-relaxed shadow-md
              ${isBuyer
                ? "bg-gradient-to-br from-[#365C50] to-[#14243A] text-white border border-[#365C50]/50 rounded-tr-sm"
                : "bg-white/10 backdrop-blur-md text-[#EAEDE8] border border-white/10 rounded-tl-sm"}">
              ${escapeHtml(m.text || "")}
            </div>
          </div>`;
      }).join("");

      // Auto-scroll to bottom smoothly
      chatBody.scrollTop = chatBody.scrollHeight;
    }, (error) => {
      console.error("Error listening to chat messages:", error);
      if (chatBody) {
        chatBody.innerHTML = `<div class="p-4 text-center text-xs text-red-400">Failed to load messages. Please try again.</div>`;
      }
    });

    // Focus input
    setTimeout(() => {
      document.getElementById("buyerChatInput")?.focus();
    }, 150);

  } catch (err) {
    console.error("openBuyerChat error:", err);
    if (chatBody) {
      chatBody.innerHTML = `<div class="p-4 text-center text-xs text-red-400">Error connecting to chat: ${err.message}</div>`;
    }
  }
};

window.closeBuyerChat = function() {
  const modal = document.getElementById("buyerChatModal");
  if (modal) modal.classList.add("hidden");
  if (buyerChatMessagesUnsubscribe) {
    buyerChatMessagesUnsubscribe();
    buyerChatMessagesUnsubscribe = null;
  }
  window.currentBuyerConversationId = null;
};

window.sendBuyerChat = async function() {
  const input = document.getElementById("buyerChatInput");
  const sendBtn = document.getElementById("buyerChatSendBtn");
  const val = input ? input.value.trim() : "";
  const convId = window.currentBuyerConversationId;
  const buyer = window.currentUser || checkAuth();

  if (!val || !convId || !buyer) return;

  input.value = "";
  if (sendBtn) sendBtn.disabled = true;

  try {
    const now = Date.now();
    const msgsRef = collection(db, "conversations", convId, "messages");

    // Add message subcollection document
    await addDoc(msgsRef, {
      conversationId: convId,
      senderId: buyer.id,
      senderRole: "buyer",
      senderName: buyer.name || buyer.email?.split("@")[0] || "Buyer",
      text: val,
      createdAt: now,
      timestamp: serverTimestamp(),
      read: false
    });

    // Update parent conversation meta
    const convRef = doc(db, "conversations", convId);
    const convDoc = await getDoc(convRef);
    const currentUnread = convDoc.exists() ? (convDoc.data().unreadCountSeller || 0) : 0;

    await updateDoc(convRef, {
      lastMessage: val,
      lastMessageTime: now,
      lastSenderRole: "buyer",
      unreadCountSeller: currentUnread + 1,
      updatedAt: now
    });

  } catch (err) {
    console.error("sendBuyerChat error:", err);
    alert("Could not send message: " + err.message);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    input?.focus();
  }
};

/**
 * Open chat from navbar or quick button:
 * Opens the buyer's conversation with their latest order merchant, or default merchant.
 */
window.openBuyerChatLatest = async function() {
  const buyer = window.currentUser || checkAuth();
  if (!buyer) return;

  try {
    // Find latest order for THIS buyer only
    const q = query(
      collection(db, "orders"),
      where("customerId", "==", buyer.id),
      orderBy("timestamp", "desc"),
      limit(1)
    );
    let snap = await getDocs(q);

    // Fallback query by email if customerId didn't match older orders
    if (snap.empty && buyer.email) {
      const qEmail = query(
        collection(db, "orders"),
        where("customerEmail", "==", buyer.email),
        orderBy("timestamp", "desc"),
        limit(1)
      );
      snap = await getDocs(qEmail);
    }

    if (!snap.empty) {
      const latestOrder = { id: snap.docs[0].id, ...snap.docs[0].data() };
      const sellerId = latestOrder.sellerId || "default";
      window.openBuyerChat(sellerId, { orderId: latestOrder.id });
    } else {
      // No orders yet: open chat with default restaurant concierge
      window.openBuyerChat("default", null);
    }
  } catch (err) {
    console.error("openBuyerChatLatest error:", err);
    window.openBuyerChat("default", null);
  }
};

// ── Unread Badge Realtime Notifier Scoped to Authenticated Buyer ──
let buyerUnreadUnsubscribe = null;

export function startBuyerMsgNotifier() {
  const buyer = window.currentUser || checkAuth();
  if (!buyer || !buyer.id) return;

  if (buyerUnreadUnsubscribe) buyerUnreadUnsubscribe();

  // Listen strictly to conversations where this user is the buyer
  const q = query(
    collection(db, "conversations"),
    where("buyerId", "==", buyer.id)
  );

  buyerUnreadUnsubscribe = onSnapshot(q, (snapshot) => {
    let unreadCount = 0;
    snapshot.docs.forEach(docSnap => {
      const data = docSnap.data();
      const count = data.unreadCountBuyer || 0;
      if (count > 0 && window.currentBuyerConversationId !== docSnap.id) {
        unreadCount += count;
      }
    });

    const badge = document.getElementById("buyer-chat-badge");
    if (badge) {
      if (unreadCount > 0) {
        badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
    }
  }, (err) => {
    console.warn("Unread notifier listener:", err);
  });
}

window.startBuyerMsgNotifier = startBuyerMsgNotifier;

// ============================================================
// ORDER TRACKING IMPLEMENTATION (SCOPED & MULTI-ORDER)
// ============================================================

let currentOrderTrackerUnsubscribe = null;
let currentDeliveryMap = null;
let currentDriverMarker = null;
let currentHomeMarker = null;
let currentRouteLine = null;

/**
 * Open the dedicated Order Tracking Modal.
 * Scoped strictly to authenticated buyer's orders.
 * @param {string} [specificOrderId] - Specific order to focus on, or defaults to latest active.
 */
window.openOrderTracking = async function(specificOrderId = null) {
  const buyer = window.currentUser || checkAuth();
  if (!buyer) {
    alert("Please log in to track your orders.");
    return;
  }

  const modal = document.getElementById("orderTrackingModal");
  if (!modal) return;
  modal.classList.remove("hidden");

  // Show loading in tracking body
  const bodyEl = document.getElementById("orderTrackingBody");
  if (bodyEl) {
    bodyEl.innerHTML = `
      <div class="flex flex-col items-center justify-center py-16 text-center text-white/50">
        <div class="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin mb-3"></div>
        <p class="text-sm font-semibold">Retrieving your orders...</p>
      </div>`;
  }

  try {
    // 1. Fetch only this buyer's orders
    let orders = [];
    const qId = query(
      collection(db, "orders"),
      where("customerId", "==", buyer.id),
      orderBy("timestamp", "desc")
    );
    let snap = await getDocs(qId);

    // Fallback query by email if customerId yields nothing
    if (snap.empty && buyer.email) {
      const qEmail = query(
        collection(db, "orders"),
        where("customerEmail", "==", buyer.email),
        orderBy("timestamp", "desc")
      );
      snap = await getDocs(qEmail);
    }

    orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (orders.length === 0) {
      renderEmptyTrackingState(bodyEl);
      return;
    }

    // Determine which order to display
    let selectedOrder = null;
    if (specificOrderId) {
      selectedOrder = orders.find(o => o.id === specificOrderId);
    }
    if (!selectedOrder) {
      // Prefer active order, otherwise latest
      selectedOrder = orders.find(o => !["delivered", "selesai", "completed", "rejected", "cancelled"].includes((o.status || "").toLowerCase())) || orders[0];
    }

    renderTrackingDashboard(orders, selectedOrder.id);

  } catch (err) {
    console.error("Order tracking error:", err);
    if (bodyEl) {
      bodyEl.innerHTML = `
        <div class="p-6 text-center text-red-400 text-sm">
          Failed to load tracking: ${escapeHtml(err.message)}
          <div class="mt-4">
            <button onclick="openOrderTracking()" class="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-xl text-white text-xs font-bold transition-all">Retry</button>
          </div>
        </div>`;
    }
  }
};

window.closeOrderTracking = function() {
  const modal = document.getElementById("orderTrackingModal");
  if (modal) modal.classList.add("hidden");
  if (currentOrderTrackerUnsubscribe) {
    currentOrderTrackerUnsubscribe();
    currentOrderTrackerUnsubscribe = null;
  }
  if (currentDeliveryMap) {
    try { currentDeliveryMap.remove(); } catch(e){}
    currentDeliveryMap = null;
  }
};

function renderEmptyTrackingState(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="flex flex-col items-center justify-center py-12 px-6 text-center">
      <div class="w-16 h-16 rounded-3xl bg-white/5 border border-white/10 flex items-center justify-center text-3xl mb-4 shadow-xl">🛵</div>
      <h3 class="text-base font-bold text-white mb-1">No Orders Found</h3>
      <p class="text-xs text-white/50 max-w-xs leading-relaxed mb-6">You haven't placed any orders yet. Discover our delicious meals and start satisfying your cravings!</p>
      <button onclick="closeOrderTracking(); setQuery('📖 Menu');" class="px-5 py-2.5 bg-gradient-to-r from-[#365C50] to-[#14243A] text-white font-extrabold text-xs rounded-full shadow-lg hover:scale-105 transition-all flex items-center gap-2">
        <span>📖</span> Browse All Menu
      </button>
    </div>`;
}

/**
 * Renders the multi-order tabs and detail view for the selected order, with real-time updates.
 */
function renderTrackingDashboard(orders, activeOrderId) {
  const bodyEl = document.getElementById("orderTrackingBody");
  if (!bodyEl) return;

  const activeOrders = orders.filter(o => !["delivered", "selesai", "completed", "rejected", "cancelled"].includes((o.status || "").toLowerCase()));
  const pastOrders   = orders.filter(o => ["delivered", "selesai", "completed", "rejected", "cancelled"].includes((o.status || "").toLowerCase()));

  // Setup tabs html
  let selectorHtml = `
    <div class="flex items-center gap-2 overflow-x-auto pb-3 mb-4 custom-scroll border-b border-white/5">
      ${orders.map(o => {
        const isSelected = o.id === activeOrderId;
        const norm = (o.status || "processing").toLowerCase();
        const isActive = !["delivered", "selesai", "completed", "rejected", "cancelled"].includes(norm);
        const statusEmoji = norm.includes("deliver") || norm.includes("selesai") ? "✅" : norm.includes("way") ? "🛵" : norm.includes("prepar") ? "🍳" : norm.includes("reject") ? "✕" : "⏳";

        return `
          <button onclick="switchTrackedOrder('${o.id}')"
            class="px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all flex items-center gap-2
              ${isSelected
                ? "bg-gradient-to-r from-[#365C50] to-[#14243A] text-white border border-[#365C50]/60 shadow-lg scale-102"
                : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white border border-white/5"}">
            <span>${statusEmoji}</span>
            <span>#${o.id.slice(-5).toUpperCase()}</span>
            ${isActive ? `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>` : ""}
          </button>`;
      }).join("")}
    </div>`;

  bodyEl.innerHTML = selectorHtml + `<div id="trackedOrderDetailContainer" class="space-y-4">Connecting live feed...</div>`;

  // Start realtime listener for the selected order
  if (currentOrderTrackerUnsubscribe) currentOrderTrackerUnsubscribe();

  currentOrderTrackerUnsubscribe = onSnapshot(doc(db, "orders", activeOrderId), (docSnap) => {
    if (!docSnap.exists()) return;
    const order = { id: docSnap.id, ...docSnap.data() };
    renderTrackedOrderDetail(order);
  });
}

window.switchTrackedOrder = async function(orderId) {
  if (currentOrderTrackerUnsubscribe) {
    currentOrderTrackerUnsubscribe();
    currentOrderTrackerUnsubscribe = null;
  }
  if (currentDeliveryMap) {
    try { currentDeliveryMap.remove(); } catch(e){}
    currentDeliveryMap = null;
  }

  // Update button active state
  openOrderTracking(orderId);
};

function renderTrackedOrderDetail(order) {
  const container = document.getElementById("trackedOrderDetailContainer");
  if (!container) return;

  const rawStatus = (order.status || "Processing");
  const normStatus = rawStatus.toLowerCase();
  const isRejected = normStatus.includes("reject") || normStatus.includes("cancel") || normStatus.includes("batal");
  const isDelivered = normStatus.includes("deliver") || normStatus.includes("selesai") || normStatus.includes("completed");

  const steps = [
    { key: "processing", label: "Order Placed", desc: "Sent to kitchen", icon: "📋" },
    { key: "preparing",  label: "Preparing",    desc: "Chef is cooking",  icon: "🍳" },
    { key: "ontheway",   label: "On the Way",   desc: "Driver is riding", icon: "🛵" },
    { key: "delivered",  label: "Delivered",    desc: "Enjoy your food",  icon: "🎉" }
  ];

  let currentStepIdx = 0;
  if (normStatus.includes("prepar")) currentStepIdx = 1;
  else if (normStatus.includes("way") || normStatus.includes("ship") || normStatus.includes("ready")) currentStepIdx = 2;
  else if (isDelivered) currentStepIdx = 3;

  const orderTimeStr = order.timestamp?.toDate
    ? order.timestamp.toDate().toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "Recently placed";

  const items = order.items || [];
  const totalPrice = order.totalPrice || items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
  const address = order.location?.address || "Delivery address not provided";
  const notes = order.notes || "";
  const paymentMethod = order.method || "QRIS";
  const sellerName = order.sellerName || "Makan.ai Kitchen";
  const sellerId = order.sellerId || "default";

  container.innerHTML = `
    <!-- Status Header & Stage Indicator -->
    <div class="bg-white/5 border border-white/10 rounded-2xl p-4 shadow-xl">
      <div class="flex justify-between items-start mb-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="text-xs font-mono font-bold text-gray-300">#${order.id.slice(-5).toUpperCase()}</span>
            <span class="text-[10px] font-bold px-2.5 py-0.5 rounded-full border
              ${isRejected ? "bg-red-500/15 text-red-400 border-red-500/30"
                : isDelivered ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                : "bg-[#365C50]/20 text-[#EAEDE8] border-[#365C50]/40"}">
              ${isRejected ? "✕ Order Cancelled" : rawStatus}
            </span>
          </div>
          <p class="text-[11px] text-white/50 mt-1">${orderTimeStr} · Merchant: <strong class="text-white/80">${escapeHtml(sellerName)}</strong></p>
        </div>

        <button onclick="window.openBuyerChat('${sellerId}', { orderId: '${order.id}' })"
          class="px-3 py-1.5 bg-[#365C50]/20 hover:bg-[#365C50]/40 text-[#EAEDE8] border border-[#365C50]/40 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm">
          <span>💬</span> Chat Merchant
        </button>
      </div>

      ${isRejected ? `
        <div class="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-300">
          <strong>Notice:</strong> This order was cancelled or rejected by the merchant. Any payment made will be processed according to your payment provider's refund policy.
        </div>
      ` : `
        <!-- Step Progression Bar -->
        <div class="relative pt-2 pb-4">
          <div class="grid grid-cols-4 gap-2 relative z-10">
            ${steps.map((s, idx) => {
              const isPastOrCurrent = idx <= currentStepIdx;
              const isCurrent = idx === currentStepIdx;
              return `
                <div class="flex flex-col items-center text-center">
                  <div class="w-9 h-9 rounded-2xl flex items-center justify-center text-sm font-bold transition-all
                    ${isCurrent ? "bg-gradient-to-tr from-[#365C50] to-emerald-600 text-white shadow-lg shadow-emerald-500/30 scale-110 ring-2 ring-emerald-400"
                      : isPastOrCurrent ? "bg-[#365C50] text-white"
                      : "bg-white/5 border border-white/10 text-white/30"}">
                    ${s.icon}
                  </div>
                  <span class="text-[11px] font-bold mt-2 ${isPastOrCurrent ? "text-white" : "text-white/30"}">${s.label}</span>
                  <span class="text-[9px] text-white/40 hidden sm:block">${s.desc}</span>
                </div>`;
            }).join("")}
          </div>
        </div>
      `}
    </div>

    <!-- Live GPS Map Section (Active when On the Way) -->
    ${normStatus.includes("way") || normStatus.includes("ship") ? `
      <div class="bg-white/5 border border-white/10 rounded-2xl p-4 shadow-xl">
        <div class="flex justify-between items-center mb-3">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping"></span>
            <span class="text-xs font-bold text-white uppercase tracking-wider">Live Driver GPS</span>
          </div>
          <span id="buyer-tracker-eta" class="text-xs font-extrabold text-[#EAEDE8] bg-[#365C50]/20 px-2.5 py-1 rounded-lg border border-[#365C50]/30">
            Calculating ETA...
          </span>
        </div>
        <div id="buyer-tracking-map" class="w-full h-44 rounded-xl border border-white/10 overflow-hidden relative z-0"></div>
      </div>
    ` : ""}

    <!-- Order Items Summary -->
    <div class="bg-white/5 border border-white/10 rounded-2xl p-4 shadow-xl">
      <h4 class="text-xs font-bold text-white/80 uppercase tracking-wider mb-3">Ordered Items (${items.length})</h4>
      <div class="space-y-2 mb-3">
        ${items.map(i => `
          <div class="flex justify-between items-center text-xs">
            <div class="flex items-center gap-2">
              <span class="font-bold text-[#EAEDE8]">${i.quantity}x</span>
              <span class="text-white">${i.emoji || "🍽️"} ${escapeHtml(i.name)}</span>
            </div>
            <span class="text-white/60 font-mono">Rp ${(i.price * i.quantity).toLocaleString()}</span>
          </div>
        `).join("")}
      </div>

      <div class="border-t border-white/10 pt-3 flex justify-between items-baseline">
        <span class="text-xs text-white/60">Total Amount (${paymentMethod})</span>
        <span class="text-base font-extrabold text-[#EAEDE8]">Rp ${totalPrice.toLocaleString()}</span>
      </div>

      <div class="mt-3 pt-3 border-t border-white/5 text-xs text-white/50 space-y-1">
        <p>📍 <strong>Deliver to:</strong> ${escapeHtml(address)}</p>
        ${notes ? `<p>📝 <strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
      </div>
    </div>`;

  // Render Map if status is On the Way
  if (normStatus.includes("way") || normStatus.includes("ship")) {
    setTimeout(() => {
      initBuyerDeliveryMap(order);
    }, 120);
  }
}

function initBuyerDeliveryMap(order) {
  const mapContainer = document.getElementById("buyer-tracking-map");
  if (!mapContainer || !window.L) return;

  const driverLat = order.driverLat || -6.2849;
  const driverLng = order.driverLng || 107.1706;
  const homeLat   = order.location?.lat || -6.2856;
  const homeLng   = order.location?.lng || 107.1710;

  if (currentDeliveryMap) {
    try { currentDeliveryMap.remove(); } catch(e){}
    currentDeliveryMap = null;
  }

  const map = L.map("buyer-tracking-map", { zoomControl: false }).setView([driverLat, driverLng], 15);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);

  const driverIcon = L.divIcon({ className: "bg-transparent", html: '<div class="text-2xl drop-shadow-md">🛵</div>', iconSize: [28, 28] });
  const homeIcon   = L.divIcon({ className: "bg-transparent", html: '<div class="text-2xl drop-shadow-md">🏠</div>', iconSize: [28, 28] });

  currentDriverMarker = L.marker([driverLat, driverLng], { icon: driverIcon }).addTo(map);
  currentHomeMarker   = L.marker([homeLat, homeLng], { icon: homeIcon }).addTo(map);
  currentRouteLine    = L.polyline([[driverLat, driverLng], [homeLat, homeLng]], {
    color: "#365C50", weight: 4, dashArray: "6, 6"
  }).addTo(map);

  currentDeliveryMap = map;

  // Calculate distance & ETA
  const distMeters = map.distance([driverLat, driverLng], [homeLat, homeLng]);
  const etaEl = document.getElementById("buyer-tracker-eta");
  if (etaEl) {
    if (distMeters < 50) {
      etaEl.textContent = "Driver Arrived! 🛵";
      etaEl.className = "text-xs font-extrabold text-emerald-400 bg-emerald-500/20 px-2.5 py-1 rounded-lg border border-emerald-500/30";
    } else {
      const mins = Math.max(1, Math.ceil(distMeters / ((30 * 1000) / 60)));
      const distKm = (distMeters / 1000).toFixed(1);
      etaEl.textContent = `ETA: ~${mins} min (${distKm} km)`;
    }
  }

  const bounds = L.latLngBounds([[driverLat, driverLng], [homeLat, homeLng]]);
  map.fitBounds(bounds, { padding: [25, 25] });
  map.invalidateSize();
}

// Helper to escape HTML characters
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Legacy Chat Non-Destructive Migration Helper ─────────────
export async function migrateLegacyChats() {
  try {
    const ordersSnap = await getDocs(collection(db, "orders"));
    const defaultSeller = await getDefaultSeller();
    let migratedCount = 0;

    for (const docSnap of ordersSnap.docs) {
      const order = docSnap.data();
      const legacyMsgs = order.chatMessages || [];
      if (!legacyMsgs.length) continue;

      const buyerId = order.customerId || (order.customerEmail ? order.customerEmail.replace(/[^a-zA-Z0-9_-]/g, "_") : null);
      if (!buyerId) continue;

      const sellerId = order.sellerId || defaultSeller.id;
      const convId = getConversationId(buyerId, sellerId);

      // Ensure conversation exists
      await getOrCreateConversation(
        { id: buyerId, name: order.customerName || "Customer", email: order.customerEmail || "" },
        defaultSeller
      );

      // Check existing messages in subcollection
      const msgsRef = collection(db, "conversations", convId, "messages");
      const existingSnap = await getDocs(msgsRef);
      const existingTexts = new Set(existingSnap.docs.map(d => d.data().text + "_" + d.data().createdAt));

      for (const m of legacyMsgs) {
        const text = m.text || "";
        const time = m.time || Date.now();
        const key = text + "_" + time;

        if (!existingTexts.has(key)) {
          await addDoc(msgsRef, {
            conversationId: convId,
            senderId: m.sender === "buyer" ? buyerId : sellerId,
            senderRole: m.sender || "buyer",
            senderName: m.sender === "buyer" ? (order.customerName || "Buyer") : defaultSeller.name,
            text: text,
            createdAt: time,
            timestamp: serverTimestamp(),
            read: true,
            migratedFromOrder: docSnap.id
          });
          migratedCount++;
        }
      }
    }

    if (migratedCount > 0) {
      console.log(`Successfully migrated ${migratedCount} legacy chat messages into conversations collection.`);
    }
  } catch (err) {
    console.warn("Legacy chat migration check:", err);
  }
}

window.migrateLegacyChats = migrateLegacyChats;

// ── Start Notifiers & Checks on Load ─────────────────────────
window.addEventListener("load", () => {
  startBuyerMsgNotifier();
  migrateLegacyChats();
});
