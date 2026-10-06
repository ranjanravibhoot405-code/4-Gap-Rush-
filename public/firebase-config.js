// Copy your Firebase Web App config from Firebase Console > Project settings > Your apps.
// This file is public by design: Firebase web config identifies the project, it is not a server secret.
export const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_FIREBASE_APP_ID"
};
// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCf76898CAnqWqd_HS7nF6wuvFyeyNEBlg",
  authDomain: "gap-rush-c4ca1.firebaseapp.com",
  projectId: "gap-rush-c4ca1",
  storageBucket: "gap-rush-c4ca1.firebasestorage.app",
  messagingSenderId: "327058061677",
  appId: "1:327058061677:web:f5feab44488ff61c5ec264",
  measurementId: "G-PCLF23F2F8"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);