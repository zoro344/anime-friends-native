# Anime Friends — Android + backend

Anime Friends is an anime-only social app. The project contains a native Android client (Kotlin + Jetpack Compose) and a Node.js API backend.

## Included

- Username/password signup and login (passwords hashed with bcrypt).
- Anime search through AniList's public GraphQL API.
- Personal anime library (planning list in this starter release).
- Anime news RSS aggregation (configure your chosen RSS feed URL).
- Community feed with posts, upvotes/downvotes and comments API.
- Friend requests and accepted-friend listing API.
- Watchium bridge that keeps the Watchium API token on the backend and creates a room through the same HTTP endpoints used by AnymeX.
- Launches `anymex://watchium/join/ROOM_CODE` after room creation.
- No manga screens or manga endpoints are included.

## Requirements

- Android Studio with Android SDK 35 and JDK 17.
- Node.js 20 or newer for the backend.
- A reachable Watchium server and its API token for real room creation.
- AnymeX installed on the Android device, and the user logged into a compatible AniList/MAL/Simkl account inside AnymeX, to join a room.

## Run the backend

```bash
cd backend
cp .env.example .env
```

Edit `.env` and set a long random `JWT_SECRET`. Set `PORT=3000`. For Watch Together, configure `WATCHIUM_SERVER_URL` and `WATCHIUM_API_TOKEN` using credentials/configuration you are authorized to use. Also set `WATCHIUM_ALLOWED_IDENTITIES` to explicitly approved identities (for example `anilist:12345`). Only add an identity after verifying that the account belongs to that user. For News, set `ANIME_NEWS_RSS_URL` to an anime-news RSS feed you are permitted to consume.

Then run:

```bash
npm install
npm start
```

The health check is `http://YOUR_SERVER:3000/health`.

## Run the Android app

Open the project root (`AnimeFriends`) in Android Studio and sync Gradle. Build the `android` app module.

The default backend URL in the Android app is `http://10.0.2.2:3000`, which is the Android emulator's route to the host computer. On a physical Android phone, enter your computer/server LAN address, for example `http://192.168.1.20:3000`, in the Backend URL field. Both devices must be able to reach that server. For internet deployment, use HTTPS and configure CORS narrowly.

## Watchium integration — important facts from the supplied AnymeX source

The uploaded AnymeX source (version 3.2.0+42) contains:

- `lib/controllers/watchium/watchium_service.dart`: `login()` posts to `/api/auth/login`; `createRoom()` posts to `/api/watch-party` and then joins the room over Socket.IO.
- `lib/widgets/watchium/watchium_create_dialog.dart`: builds the room's episode content and available server list from the selected player episode.
- `lib/utils/deeplink.dart`: accepts `anymex://watchium/join/ABC123`, requires a six-character room code, waits for Watchium and service authentication, then calls the room join flow.
- `android/app/src/main/AndroidManifest.xml`: declares the `anymex://watchium/join/` intent filter.

The bridge in this project follows the HTTP login + room creation shape. The API token is kept in the backend environment, not embedded in the APK. The app collects a provider identity and a compatible stream entry because AnymeX's room creation is not just a room-code-only request.

**Limitations:**

1. The AnymeX ZIP contains the client, not the Watchium server. This project cannot supply or guarantee a working Watchium server.
2. The user must use a provider identity that Watchium accepts and must be signed into the same provider in AnymeX.
3. A compatible episode stream and its required metadata/headers may be needed. Localhost/local-proxy streams are not shareable. This starter UI accepts a direct stream URL but does not extract streams from AnymeX extensions.
4. The app does not control AnymeX playback after launching the deep link. AnymeX/Watchium handles room playback synchronization.
5. The API token must never be placed in Android resources, source code, or APK configuration. The Watchium form currently accepts a manually entered provider ID; the backend allowlist reduces exposure, but it is not proof of ownership. Before public release, replace manual identity entry with a verified AniList/MAL/Simkl OAuth account-linking flow.

## Current implementation status

This is a functional starter foundation, not a production-ready release. The backend provides real auth, feed, votes, comments, friends, AniList search, library storage, RSS parsing and Watchium proxy routes. The Android UI currently exposes auth, anime search, news, feed, Watch Together and profile screens. Some social API features (friend request management, profile customization, image uploads, real-time chat, moderation/reporting, richer anime detail pages, and native comment-thread UI) remain to be built. Data is stored in a local JSON file; use PostgreSQL or another managed database before production deployment.

## Security and deployment

- Change `JWT_SECRET` before use outside development.
- Use HTTPS in production; do not expose a development server directly to the public internet.
- Configure `CORS_ORIGIN` to your app's trusted web origins if needed.
- Add database backups, account recovery, moderation tools, abuse reporting and privacy policy before public launch.
- Do not publish or share stream URLs unless you have permission to distribute them.
