/**
 * Firebase Configuration for TikunCRM
 * Handles Firebase initialization and FCM messaging
 */

import { initializeApp, getApps, FirebaseApp } from "firebase/app"
import { getMessaging, getToken, onMessage, Messaging, MessagePayload } from "firebase/messaging"
import { withTimeout } from "@/lib/with-timeout"

// Firebase public web config (env vars take precedence; fallback matches public/firebase-messaging-sw.js)
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyCubNWyMpGr9PwjjrMXHF0NKzmtcLpZ_oA",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "tikuncrm.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "tikuncrm",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "tikuncrm.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "241604704783",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:241604704783:web:cc054d12805a9bcbfe417a",
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || "G-1FDL2ZXSXC",
}

const DEFAULT_FIREBASE_VAPID_KEY =
  "BGD_FPovlvqQF9YnEtuBlrInOtXyUI1BqzzJGs7IV2tjJnTCwmm4bHBjdstPqD76KjiHa8pgN-0dIYtHABluibw"

const FCM_SW_PATH = "/firebase-messaging-sw.js"
const SW_READY_TIMEOUT_MS = 12_000
const GET_TOKEN_TIMEOUT_MS = 15_000

// Singleton instances
let firebaseApp: FirebaseApp | null = null
let messaging: Messaging | null = null

/**
 * Check if Firebase is properly configured
 */
export function isFirebaseConfigured(): boolean {
  return !!(
    firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    firebaseConfig.messagingSenderId &&
    firebaseConfig.appId
  )
}

/**
 * Initialize Firebase app (singleton)
 */
export function getFirebaseApp(): FirebaseApp | null {
  if (typeof window === "undefined") return null
  
  if (!isFirebaseConfigured()) {
    console.warn("[Firebase] Firebase is not configured. Check environment variables.")
    return null
  }

  if (!firebaseApp && getApps().length === 0) {
    try {
      firebaseApp = initializeApp(firebaseConfig)
      console.log("[Firebase] App initialized")
    } catch (error) {
      console.error("[Firebase] Failed to initialize app:", error)
      return null
    }
  } else if (!firebaseApp) {
    firebaseApp = getApps()[0]
  }

  return firebaseApp
}

/**
 * Get Firebase Messaging instance (singleton)
 */
export function getFirebaseMessaging(): Messaging | null {
  if (typeof window === "undefined") return null
  
  // Check if service worker and notifications are supported
  if (!("serviceWorker" in navigator) || !("Notification" in window)) {
    console.warn("[Firebase] Service workers or notifications not supported")
    return null
  }

  const app = getFirebaseApp()
  if (!app) return null

  if (!messaging) {
    try {
      messaging = getMessaging(app)
      console.log("[Firebase] Messaging initialized")
    } catch (error) {
      console.error("[Firebase] Failed to initialize messaging:", error)
      return null
    }
  }

  return messaging
}

async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    let registration = await navigator.serviceWorker.getRegistration("/")

    if (!registration) {
      registration = await withTimeout(
        navigator.serviceWorker.register(FCM_SW_PATH, { scope: "/" }),
        SW_READY_TIMEOUT_MS,
        "Service worker registration timed out"
      )
    }

    await withTimeout(
      navigator.serviceWorker.ready,
      SW_READY_TIMEOUT_MS,
      "Service worker ready timed out"
    )

    console.log("[Firebase] FCM service worker ready")
    return registration
  } catch (error) {
    console.error("[Firebase] Service worker setup failed:", error)
    return null
  }
}

/**
 * Request permission and get FCM token
 */
export async function getFCMToken(): Promise<string | null> {
  try {
    const messagingInstance = getFirebaseMessaging()
    if (!messagingInstance) {
      return null
    }

    const permission = Notification.permission
    if (permission === "denied") {
      console.log("[Firebase] Notification permission denied")
      return null
    }

    if (permission === "default") {
      const result = await Notification.requestPermission()
      if (result !== "granted") {
        console.log("[Firebase] Notification permission denied")
        return null
      }
    }

    const swRegistration = await getServiceWorkerRegistration()
    if (!swRegistration) {
      return null
    }

    const fcmVapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || DEFAULT_FIREBASE_VAPID_KEY
    if (!fcmVapidKey) {
      console.error("[Firebase] VAPID key not configured")
      return null
    }
    
    const token = await withTimeout(
      getToken(messagingInstance, {
        serviceWorkerRegistration: swRegistration,
        vapidKey: fcmVapidKey,
      }),
      GET_TOKEN_TIMEOUT_MS,
      "FCM getToken timed out"
    )

    if (token) {
      console.log("[Firebase] FCM token obtained")
      return token
    }

    console.warn("[Firebase] No token returned from Firebase")
    return null
  } catch (error) {
    console.error("[Firebase] Failed to get FCM token:", error)
    return null
  }
}

/**
 * Set up foreground message handler
 * Called when a message is received while the app is in the foreground
 */
export function onForegroundMessage(callback: (payload: MessagePayload) => void): (() => void) | null {
  try {
    const messagingInstance = getFirebaseMessaging()
    if (!messagingInstance) {
      return null
    }

    // Set up listener for foreground messages
    const unsubscribe = onMessage(messagingInstance, (payload) => {
      console.log("[Firebase] Foreground message received:", payload)
      callback(payload)
    })

    return unsubscribe
  } catch (error) {
    console.error("[Firebase] Failed to set up foreground handler:", error)
    return null
  }
}
