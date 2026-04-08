// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCqrRwKF88BPCkIt8bNAiAD4t9APUm20co",
  authDomain: "ridesync-d6154.firebaseapp.com",
  projectId: "ridesync-d6154",
  storageBucket: "ridesync-d6154.firebasestorage.app",
  messagingSenderId: "1011982189838",
  appId: "1:1011982189838:web:4d72ecaa5ac56b7f5e435f",
  measurementId: "G-N3TTSJJGDR"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);