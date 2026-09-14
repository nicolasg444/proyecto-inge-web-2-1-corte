import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA_6DQ7XCnx1cxbcZhAPZCDfsZhLVG9Mvs",
  authDomain: "wayture-37479.firebaseapp.com",
  projectId: "wayture-37479",
  storageBucket: "wayture-37479.firebasestorage.app",
  messagingSenderId: "311863644027",
  appId: "1:311863644027:web:db11d6e75fd14d9706b7de",
  measurementId: "G-1YLZBQCNGL"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };
