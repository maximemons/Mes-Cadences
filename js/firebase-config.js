import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

// La clé "apiKey" d'une app web Firebase n'est pas un secret : elle identifie le projet.
// La protection des données repose sur les règles Firestore (voir firestore.rules).
export const firebaseConfig = {
  apiKey: "AIzaSyDN4cCG7XqM6IKIsiII0L9B-wXNzryvHvI",
  authDomain: "mes-cadences.firebaseapp.com",
  projectId: "mes-cadences",
  storageBucket: "mes-cadences.firebasestorage.app",
  messagingSenderId: "434791599036",
  appId: "1:434791599036:web:28430979745b74a645f9b9"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Cache local persistant : l'appli reste utilisable à la salle même avec un mauvais réseau.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// Clé publique Web Push (console Firebase › Paramètres du projet › Cloud Messaging ›
// Certificats Web Push › Générer). Sans elle, les rappels ne fonctionnent que lorsque
// l'appli est ouverte ou réveillée par le navigateur (voir README, « Rappels de séance »).
export const vapidKey = "";

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });
