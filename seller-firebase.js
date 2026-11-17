import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getFirestore, collection, addDoc, updateDoc, doc } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);
window.db = db;

// Save new menu to Firestore
window.saveMenuToFirestore = async function(item) {
  return await addDoc(collection(db, "products"), item);
};

// Update stock
window.updateStockFirestore = async function(id, stock) {
  return await updateDoc(doc(db, "products", id), { stock });
};
