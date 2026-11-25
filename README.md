# Pawan TV — Secure Architecture Setup Guide

Is setup mein client-side (`public/index.html`) se saara sensitive data hata diya gaya hai:
- **No Firebase SDK / config** in browser (Firestore Rules `allow read, write: if false;` se 100% locked).
- **No Archive profile / URLs** (`@aaa_a316` aur `archive.org` sirf Vercel backend mein hain).
- **No Ad secret keys / Ad tag URLs** in browser (Cloudflare Worker secrets mein move kiye gaye hain).
- **AES-256-GCM encrypted Media Tokens** (`/stream?t=...` 15-min expiry, `/poster?t=...` 24-hour cacheable).
- **Server-side Points (`ptv_session`) & Likes (`ptv_likes`)** in signed `HttpOnly` cookies + Ad timing/anti-replay verification.

---

## Step 1: 4 Random Secrets Generate Karein

Terminal (ya Node) se 4 alag random 64-character hex secrets generate karein:

```bash
node -e "['STREAM_SIGNING_SECRET','AD_WORKER_SECRET','SESSION_SECRET','OPAQUE_ID_SECRET'].forEach(k => console.log(k + '=' + require('crypto').randomBytes(32).toString('hex')))"
```

---

## Step 2: Firebase Firestore Lock Karein + Service Account Nikalein

1. **Firestore Rules Update Karein:**
   - Firebase Console -> **Firestore Database -> Rules** mein `firestore.rules` ka content paste karke **Publish** karein:
     ```js
     rules_version = '2';
     service cloud.firestore {
       match /databases/{database}/documents {
         match /{document=**} {
           allow read, write: if false;
         }
       }
     }
     ```
2. **Service Account Key Download Karein:**
   - Firebase Console -> **Project Settings -> Service Accounts -> Generate new private key**.
   - Download hui `.json` file ko single-line string ya base64 mein convert karein:
     ```bash
     node -e "console.log(Buffer.from(require('fs').readFileSync('service-account.json')).toString('base64'))"
     ```

---

## Step 3: Cloudflare Worker Deploy Karein (`cloudflare-worker/`)

1. Cloudflare Dashboard mein Worker banayein (ya purane worker `sorryt-a7c9...workers.dev` par `cloudflare-worker/worker.js` code replace karein).
2. Worker ke **Settings -> Variables and Secrets** mein ye **Secrets** add karein:
   - `STREAM_SIGNING_SECRET` = Step 1 wala `STREAM_SIGNING_SECRET`
   - `AD_WORKER_SECRET` = Step 1 wala `AD_WORKER_SECRET`
   - `AD_TAG_URLS` = Aapke VAST ad tag URLs ka JSON array, e.g. `["https://your-vast-tag-url"]`
   - `ALLOWED_ORIGINS` = `https://pawan-tv.vercel.app` (agar custom domain ho toh comma se dono add karein)
3. Purana `PawanTV_SuperSecretKey_2026` bilkul use na karein (kyunki wo pehle leak ho chuka hai).

---

## Step 4: Vercel Project Deploy Karein

1. Is poore `pawan-tv-fixed/` folder ko apne GitHub repo ya `vercel --prod` se Vercel par deploy karein.
2. Vercel Project **Settings -> Environment Variables** mein ye variables add karein:
   - `FIREBASE_SERVICE_ACCOUNT_BASE64` = Step 2 wala base64 string (ya raw JSON in `FIREBASE_SERVICE_ACCOUNT`)
   - `ARCHIVE_PROFILE` = `@aaa_a316`
   - `CF_WORKER_URL` = Aapke Cloudflare Worker ka URL (without trailing slash, e.g. `https://sorryt-a7c9.aaa39269012.workers.dev`)
   - `STREAM_SIGNING_SECRET` = Step 1 wala (exact same as Cloudflare Worker)
   - `AD_WORKER_SECRET` = Step 1 wala (exact same as Cloudflare Worker)
   - `SESSION_SECRET` = Step 1 wala `SESSION_SECRET`
   - `OPAQUE_ID_SECRET` = Step 1 wala `OPAQUE_ID_SECRET`
   - `PUBLIC_APP_URL` = `https://pawan-tv.vercel.app`
3. Redeploy karein taaki saare Environment Variables active ho jayein.

---

## Verification Checklist

Deploy ke baad browser mein check karein:
1. **View Page Source** mein `firebase`, `archive.org`, `@aaa_a316`, `AD_SECRET_KEY`, ya `adTagUrls` kahin nahi dikhega.
2. **Network tab** mein `/api/stories` aur `/api/story` mein sirf `s_...` opaque IDs aur encrypted `/poster?t=...` URLs aayenge (episode URLs nahi).
3. Video `<video src>` mein sirf `https://<worker>/stream?t=<encrypted>` dikhega jo 15 min mein expire hota hai.
4. `Application -> Local Storage` mein sirf `pawanTV_lastPlayback` (with opaque `storyId`) hoga — `points` ya `archiveId` nahi.
