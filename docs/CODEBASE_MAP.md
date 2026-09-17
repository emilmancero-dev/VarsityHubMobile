# VarsityHub Mobile — Codebase Map

**Last updated:** 2026-03-18
**Purpose:** Session briefing document for AI assistants. Read this before making any changes.
**Related docs:** `docs/FRONT_BACKEND_WIRING_AUDIT.md`, `docs/SYSTEM_ARCHITECTURE_AUDIT.md`

---

## 1. FOLDER STRUCTURE

```
VarsityHubMobile/
├── app/                        # Expo Router file-based routing (all screens)
│   ├── _layout.tsx             # Root layout — wraps all providers
│   ├── index.tsx               # Splash/loading screen; passive redirect (auth handled by AuthProvider)
│   ├── (tabs)/                 # Tab group — includes hidden detail screens
│   │   ├── _layout.tsx         # Tab bar config (5 visible tabs + many hidden screens)
│   │   ├── feed/index.tsx      # Re-exports app/feed.tsx
│   │   ├── highlights/index.tsx # Re-exports app/highlights.tsx
│   │   ├── discover/
│   │   │   ├── index.tsx       # Re-exports discover/mobile-community.tsx
│   │   │   └── mobile-community.tsx # The real Discover screen
│   │   ├── profile/index.tsx   # Re-exports app/profile.tsx
│   │   ├── notifications/index.tsx # Full inline Notifications screen
│   │   ├── messages/index.tsx  # Re-exports app/messages.tsx
│   │   ├── post-detail.tsx     # Post detail / comment thread
│   │   ├── user-profile.tsx    # Re-exports app/profile.tsx (alias)
│   │   ├── team-profile.tsx    # Re-exports app/profile.tsx (alias)
│   │   ├── message-thread.tsx  # DM thread screen
│   │   ├── game-detail.tsx     # Re-exports app/game-details/GameDetailsScreen
│   │   ├── team-hub.tsx        # Event hub / event discovery for coaches
│   │   ├── edit-profile.tsx    # Edit profile form
│   │   ├── organization.tsx    # Organization detail/profile
│   │   ├── admin-users.tsx     # Re-exports app/admin-users.tsx
│   │   ├── admin-ads.tsx       # Re-exports app/admin-ads.tsx
│   │   ├── create-post.tsx     # Create post modal-style screen
│   │   └── (many more hidden tabs — see _layout.tsx)
│   ├── feed.tsx                # Main Feed screen (games/events carousel, highlights, ads)
│   ├── highlights.tsx          # Highlights tab (vertical video feed TikTok-style)
│   ├── profile.tsx             # Profile screen (own and others based on params)
│   ├── messages.tsx            # Conversations list
│   ├── game-detail.tsx         # Re-exports GameDetailsScreen
│   ├── sign-in.tsx             # Email/password + Google/Apple sign-in
│   ├── sign-up.tsx             # Email/password + Google/Apple registration
│   ├── forgot-password.tsx     # Request password reset code
│   ├── reset-password.tsx      # Confirm reset with code + new password
│   ├── verify.tsx              # Email verification landing
│   ├── admin-users.tsx         # Admin: user management
│   ├── admin-ads.tsx           # Admin: ad management
│   ├── onboarding/             # 3-step onboarding (see onboardingReducer.ts)
│   │   ├── _layout.tsx
│   │   ├── index.tsx            # Redirects to next incomplete step
│   │   ├── step-1-role.tsx      # Select Fan or Coach
│   │   ├── step-2-basic.tsx     # Username, DOB, zip, affiliation
│   │   ├── step-3-league.tsx    # Coach application/final-setup screen (server-directed)
│   │   ├── league-pending-approval.tsx # Coach created league — waiting approval
│   │   ├── pending-approval.tsx # Coach requested to join — waiting approval
│   │   ├── parental-consent.tsx # COPPA consent for under-18 users
│   │   └── components/OnboardingLayout.tsx # Shared layout (back, step indicator, continue)
│   ├── settings/               # Settings area
│   │   └── index.tsx           # Settings screen (notifications, privacy, account)
│   ├── game-details/           # Game detail sub-screens (separate folder)
│   │   ├── GameDetailsScreen.tsx
│   │   └── GameVerticalFeedScreen.tsx
│   └── (many other screens: billing, events-calendar, report-abuse, etc.)
│
├── api/                        # Frontend API client layer
│   ├── http.ts                 # Core fetch wrapper (auth headers, retry, 502 handling)
│   ├── auth.ts                 # Auth functions (login, register, token storage)
│   ├── entities.ts             # Re-exports: User, Game, Post, Event, Message, Organization, Team, TeamMemberships, TeamInvites, Notification, Payments, Subscriptions, Report, Support, Advertisement, Search, Highlights, GroupChat
│   ├── groupChats.ts            # GroupChat API (list, getMessages, sendMessage, markRead, create)
│   ├── teams.ts                 # Team, TeamMemberships, TeamInvites API
│   ├── organizations.ts        # Organization API (CRUD, invites, join requests, coaches)
│   ├── posts.ts                # Post API (CRUD, comments, upvotes, bookmarks)
│   ├── games.ts                # Game API (CRUD, votes, stories, scores)
│   ├── events.ts               # Event API (CRUD, RSVP, approval)
│   ├── payments.ts             # Payments + Subscriptions API
│   ├── notifications.ts        # Notification API
│   ├── messages.ts             # Message/DM API
│   ├── user.ts                 # User API (profile, follow, block, search)
│   ├── misc.ts                 # Advertisement, Report, Support, Search, Highlights
│   ├── settings.ts             # SecureStore/localStorage wrapper for app settings
│   └── upload.ts               # File upload (tries direct-to-Cloudinary first, falls back to server proxy)
│
├── components/                 # Reusable React Native components
│   ├── PostCard.tsx            # Core post card (upvote, bookmark, comment, share)
│   ├── HapticTab.tsx           # Tab bar button with haptic feedback
│   ├── BannerAd.tsx            # Feed ad banner component
│   ├── EventMap.tsx            # Map component for event locations
│   ├── VideoPlayer.tsx         # Video playback component
│   ├── ErrorBoundary.tsx       # Root error boundary
│   ├── ErrorToast.tsx          # Toast notification for errors
│   ├── OfflineBanner.tsx       # Banner shown when offline
│   ├── PollCard.tsx            # Poll display and voting
│   ├── QuickAddGameModal.tsx   # Quick game creation modal
│   ├── MasonryPostCard.tsx     # Grid/masonry post card (feed grid view)
│   ├── VideoTrimmer.tsx        # Native video trimming (requires EAS build)
│   ├── StoryCameraButton.tsx   # Camera button for game stories
│   └── ui/                     # Low-level UI primitives
│       ├── button.tsx          # Base Button component
│       ├── input.tsx           # Text input
│       ├── PrimaryButton.tsx   # Primary action button
│       ├── MentionInput.tsx    # Text input with @mention autocomplete
│       ├── GameCard.tsx        # Game card component
│       ├── TeamCard.tsx        # Team card component
│       ├── IconSymbol.tsx      # SF Symbols / MaterialIcons wrapper
│       ├── TabBarBackground.tsx # Tab bar visual background
│       ├── tokens.ts           # Design tokens (spacing, type sizes, radius)
│       └── (many others)
│
├── context/                    # React context providers
│   ├── AuthProvider.tsx        # Auth state + routing logic (single source of truth)
│   ├── PostCacheContext.tsx    # In-memory post cache (Map<id, post>)
│   └── OnboardingContext.tsx   # Multi-step onboarding state (persisted to AsyncStorage)
│
├── hooks/                      # Custom React hooks
│   ├── useGoogleAuth.ts        # Google OAuth via expo-auth-session
│   ├── useAppleAuth.ts         # Apple Sign In via expo-apple-authentication
│   ├── useDeviceLocation.ts    # GPS location with 10-min cache
│   ├── useUser.ts              # Load/refresh current user from /me
│   ├── useShareLink.ts         # Generate shareable deep links
│   ├── useColorScheme.ts       # Light/dark mode detection
│   ├── useCustomColorScheme.tsx # Custom theme override
│   ├── useAnalytics.ts         # Event tracking (tap, view, etc.)
│   ├── useRequireAdmin.ts      # Redirect if not admin
│   ├── useTeamInvites.ts       # Fetch + manage team invites
│   └── (others)
│
├── constants/
│   └── Colors.ts               # Light/dark color palette
│
├── utils/                      # Utility functions
│   ├── deepLinks.ts            # Deep link parsing and navigation
│   ├── links.ts                # URL generation (AppLinks.post(), AppLinks.game(), etc.)
│   ├── format.ts               # timeAgo(), formatCount(), getCountryFlag()
│   ├── formUtils.ts            # validateEmail(), validatePassword(), sanitizeEmail(), etc.
│   ├── sentry.ts               # Sentry init, captureException, captureBreadcrumb
│   ├── rankingUtils.ts         # calculateRanking() for highlights scoring
│   ├── pushNotifications.ts    # Expo push token registration + sync to server
│   ├── picker.ts               # ImagePicker media type helpers
│   ├── dmRestrictions.ts       # DM restriction checks
│   ├── events.ts               # App event bus (emitter for cross-screen events)
│   ├── theme.ts                # getGradientForColor() and theme utilities
│   └── (others)
│
├── shared/
│   └── plan-definitions.json   # Canonical plan config (used by both frontend and server)
│
├── server/                     # Express.js backend
│   ├── src/
│   │   ├── app.ts              # Express app config (CORS, middleware, route mounting)
│   │   ├── index.ts            # Server entry point (listen, queues, shutdown)
│   │   ├── routes/             # Route handlers
│   │   ├── middleware/         # Auth, requireAuth, rateLimiters, etc.
│   │   ├── lib/                # Shared server utilities
│   │   ├── jobs/               # Background job queues (BullMQ)
│   │   └── services/           # Email service, etc.
│   └── prisma/
│       └── schema.prisma       # Database schema (PostgreSQL via Prisma)
│
├── docs/                       # Documentation (large number of files — audit trail)
├── plugins/                    # Expo config plugins (Android manifest, Google Maps, etc.)
├── scripts/                    # Build, deploy, and validation scripts
├── tools/                      # Patch tools (postinstall fixes)
├── assets/                     # Images, fonts, animations
├── locales/                    # i18n (en.json)
├── config/
│   └── env.ts                  # App-side env config accessor (getConfig())
├── app.json                    # Expo app configuration
├── package.json                # Dependencies and scripts
└── .env.example                # Environment variable template
```

---

## 2. FRONTEND SCREENS

### Auth

#### `app/sign-in.tsx` — Sign In

**Purpose:** Email/password login with Google OAuth and Apple Sign In options.
**API calls:**

- `User.loginViaEmailPassword(email, password)` → `POST /auth/login`
- `User.loginViaGoogle(idToken)` → `POST /auth/google`
- `User.loginViaApple(identityToken)` → `POST /auth/apple`
  **Key state:** `email`, `password`, `loading`, `error`
  **Navigation:** On success → calls `checkAuth()` which routes to `/(tabs)` or `/onboarding/step-1-role`. "Sign up" → `/sign-up`. "Forgot password" → `/forgot-password`.

#### `app/sign-up.tsx` — Sign Up

**Purpose:** New account registration with email/password, Google, or Apple.
**API calls:**

- `User.register(email, password)` → `POST /auth/register`
- `User.loginViaGoogle(idToken)` → `POST /auth/google`
- `User.loginViaApple(identityToken)` → `POST /auth/apple`
  **Key state:** `email`, `password`, `passwordStrength`, `showEmailForm`, `retryCount`
  **Navigation:** On success → calls `checkAuth()` → routed to onboarding. "Sign in" link → `/sign-in`.

#### `app/forgot-password.tsx` — Forgot Password

**Purpose:** Request a password reset code via email.
**API calls:**

- `User.requestPasswordReset(email)` → `POST /auth/password/forgot`
  **Key state:** `email`, `loading`, `error`, `info`
  **Navigation:** Back button → `/sign-in`.

---

### Onboarding

All onboarding screens share `OnboardingContext` for state. Steps progress in sequence via `nextIncompleteStep()` from `onboardingReducer.ts`. State is persisted to AsyncStorage.

#### `app/onboarding/step-1-role.tsx` — Select Role

**Purpose:** User picks "Fan" or "Coach". Controls which steps follow (fans: 1→2→done; coaches: 1→2→3→pending).
**API calls:** `User.me()` to check existing role; `User.updatePreferences({ role })` → `PATCH /me/preferences`
**Navigation:** Next → `step-2-basic`

#### `app/onboarding/step-2-basic.tsx` — Basic Info

**Purpose:** Username, date of birth, zip code, affiliation. Real-time username availability.
**API calls:**

- `User.me()` → `GET /me`
- `User.usernameAvailable(username)` → `GET /users/username-available?username=...`
- `User.updatePreferences({...})` → `PATCH /me/preferences`
  **Navigation:** Next → `step-3-league` (coach) or complete onboarding (fan)

#### `app/onboarding/step-3-league.tsx` — League / Final Setup

**Purpose:** Coach joins existing organization, creates a new league application, or finishes server-directed final setup when `/auth/me` returns `coach_final_setup_required`.
**API calls:**

- `Organization.list(q)`, `Organization.checkDuplicate(name)`, `Organization.joinRequests` / `Organization.create`, etc.
- `User.completeOnboarding(data)` → `POST /me/complete-onboarding` when finishing
  **Navigation:** On success → `league-pending-approval` or `pending-approval`; after approval → `/(tabs)`

---

### Main Tabs

The tab bar has **5 visible tabs**: Feed, Highlights, Create (center), Discover, Profile.

#### `app/feed.tsx` — Feed (Main Tab)

**Purpose:** Displays a scrollable list of upcoming and past games/events (NOT a social posts feed). Also shows highlights reel at top, banner ads, and notification indicator. Requests location for nearby event filtering.
**API calls:**

- `Game.list(sort, { lat, lng, distance })` → `GET /games?...`
- `Event.rsvpStatus(eventId)` → `GET /events/:id/rsvp`
- `Event.rsvp(eventId, going)` → `POST /events/:id/rsvp`
- `Highlights.fetch({ lat, lng, country })` → `GET /highlights?v2=1&...`
- `Advertisement.forFeed(date, zip, limit)` → `GET /ads/for-feed?...`
- `NotificationApi.listPage(null, 1, true)` → `GET /notifications?limit=1&unread=1` (badge count polling)
- `Post.trendingPage()` → `GET /posts/trending` (falls back to `GET /posts?sort=-created_at`)
  **Key state:** `games`, `highlights`, `ads`, `loadingGames`, `location`, `activeView` ('grid' | 'vertical'), `unreadCount`
  **Navigation:** Game card → `/game-detail?id=...`. Bell icon → `/notifications`. Highlights item → detail. Ad → `Linking.openURL()`.

#### `app/highlights.tsx` — Highlights (Main Tab)

**Purpose:** TikTok-style vertical video/image feed of top sports posts. Tabs: Trending, Recent, Top. Shows national + local highlights ranked with `calculateRanking()`.
**API calls:**

- `Highlights.fetch({ lat, lng, country, limit })` → `GET /highlights?v2=1&...`
- `Post.trendingPage()` → `GET /posts/trending`
- `Post.toggleUpvote(id)` → `POST /posts/:id/upvote`
- `Event.rsvpStatus(eventId)`, `Event.rsvp(eventId, going)`
- `Post.share(id)` → `POST /posts/:id/share`
  **Key state:** `items`, `activeTab` ('trending'|'recent'|'top'), `currentIndex`, location
  **Navigation:** Post card → `/post-detail?id=...`. Author → `/user-profile?userId=...`.

#### `app/(tabs)/discover/mobile-community.tsx` — Discover (Main Tab)

**Purpose:** Browse games, posts, users, teams, organizations. Has map view, calendar view, and vertical post feed. Uses device location. Includes `QuickAddGameModal` for fast game creation.
**API calls:**

- `Game.list(sort, { lat, lng })` → `GET /games?...`
- `Post.trendingPage()` or `Post.listPage()` → `GET /posts?...`
- `Search.unified(q)` → `GET /search?q=...`
- `Team.list(q)` → `GET /teams?q=...`
- `Organization.list(q)` → `GET /organizations?q=...`
- `User.searchForMentions(q)` → `GET /users/search/mentions?q=...`
- `Game.create(data)` → `POST /games`
  **Key state:** `query`, `activeTab` ('games'|'posts'|'people'), `games`, `posts`, `calendarView`, `mapView`, location
  **Navigation:** Game → `/game-detail?id=...`. Post → vertical feed. User → `/user-profile?userId=...`.

#### `app/profile.tsx` — Profile (Main Tab + detail)

**Purpose:** Shows own profile or another user's profile (based on `useLocalSearchParams` `id`). Displays posts, replies, upvotes tabs; team chips; followers/following. Edit button for own profile.
**API calls:**

- `User.me()` → `GET /me`
- `User.getPublic(id)` → `GET /users/:id`
- `User.postsForProfile(id, opts)` → `GET /users/:id/posts?...`
- `User.followers(id)`, `User.following(id)` → `GET /users/:id/followers`, `GET /users/:id/following`
- `User.follow(id)` → `POST /users/:id/follow`
- `User.unfollow(id)` → `DELETE /users/:id/follow`
- `Team.list(undefined, true)` → `GET /teams?mine=1`
- `Organization.mine()` → `GET /organizations/mine`
  **Key state:** `me`, `posts`, `replies`, `upvotes`, `activeTab` ('posts'|'replies'|'upvotes'), `isFollowing`, `followers_count`, `following_count`
  **Navigation:** Edit → `/edit-profile`. Settings → `/settings`. Team chip → `/team-profile`. Post → post viewer or `/post-detail`.

---

### Detail Screens (Hidden Tabs — accessible via navigation, not tab bar)

#### `app/(tabs)/notifications/index.tsx` — Notifications

**Purpose:** Paginated list of notifications (follows, upvotes, comments, messages, etc.) with mark-as-read.
**API calls:**

- `Notification.listPage(cursor, limit)` → `GET /notifications?...`
- `Notification.markRead(id)` → `POST /notifications/:id/read`
- `Notification.markAllRead()` → `POST /notifications/mark-read-all`
  **Navigation:** Notification tap → routes to `/post-detail`, `/user-profile`, `/messages`, or `/event-detail` based on type.

#### `app/messages.tsx` — Messages (DM Inbox)

**Purpose:** Conversation list showing all DMs. Compose new DM. Supports share-post prefill via `sharePost` param.
**API calls:**

- `User.me()` → `GET /me`
- `Message.list()` → `GET /messages?sort=-created_at&limit=50`
- `Message.send(data)` → `POST /messages`
- `User.searchForMentions(q)` → for compose recipient search
  **Key state:** `me`, `messages`, `conversations` (grouped client-side), `query`, `composeOpen`
  **Navigation:** Conversation → `/message-thread?conversation_id=...`. New DM → compose modal.

#### `app/(tabs)/message-thread.tsx` — Message Thread

**Purpose:** Individual DM conversation with real-time-like polling (no WebSocket). Supports DM restriction checks.
**API calls:**

- `User.me()` → `GET /me`
- `MessageApi.threadByConversation(id)` → `GET /messages?conversation_id=...`
- `MessageApi.threadWith(email)` → `GET /messages?with=...`
- `MessageApi.send({ content, conversation_id, recipient_id })` → `POST /messages`
- `MessageApi.markReadByConversation(id)` → `POST /messages/mark-read`
  **Key state:** `me`, `msgs`, `text`, `loading`
  **Navigation:** Back → `/messages`.

#### `app/(tabs)/create-post.tsx` — Create Post

**Purpose:** Full post creation screen with image/video upload, game/event tagging, mention support, geolocation, caption.
**API calls:**

- `uploadFile(file)` → `POST /uploads` (multipart)
- `Post.create(data)` → `POST /posts` (long timeout: 180s)
- `Game.list()` → `GET /games` (for game tag)
- `User.me()` → `GET /me`
  **Key state:** `content`, `mediaUri`, `selectedGame`, `location`, `uploading`, `progress`
  **Navigation:** On success → back or `/post-detail`. Cancel → back.

#### `app/(tabs)/post-detail.tsx` — Post Detail

**Purpose:** Full post view with comment thread, inline reply, upvote, bookmark, share. Supports swipe between posts (`postIds` param).
**API calls:**

- `PostApi.get(id)` → `GET /posts/:id`
- `PostApi.comments(id)` → `GET /posts/:id/comments`
- `PostApi.addComment(id, content, parentId)` → `POST /posts/:id/comments`
- `PostApi.toggleUpvote(id)` → `POST /posts/:id/upvote`
- `PostApi.toggleBookmark(id)` → `POST /posts/:id/bookmark`
- `PostApi.share(id)` → `POST /posts/:id/share`
- `PostApi.delete(id)` → `DELETE /posts/:id`
- `PostApi.update(id, data)` → `PATCH /posts/:id`
- `User.follow(id)`, `User.unfollow(id)` → `POST/DELETE /users/:id/follow`
  **Key state:** `post`, `comments`, `text`, `replyTo`, `upvoted`, `bookmarked`
  **Navigation:** Author → `/user-profile?userId=...`. Back → previous.

#### `app/game-detail.tsx` — Game Detail

**Purpose:** Full game screen with tabs: Feed (posts), Media (stories), Info (venue/date), Votes (fan voting A vs B). Delegates to `GameDetailsScreen.tsx`.
**API calls:**

- `Game.get(id)` → `GET /games/:id`
- `Game.summary(id)` → `GET /games/:id/summary`
- `Game.posts(id)` → `GET /games/:id/posts`
- `Game.media(id)` → `GET /games/:id/media`
- `Game.stories(id)` → `GET /games/:id/stories`
- `Game.addStory(id, data)` → `POST /games/:id/stories`
- `Game.votesSummary(id)` → `GET /games/:id/votes/summary`
- `Game.castVote(id, team)` → `POST /games/:id/votes`
- `Game.clearVote(id)` → `DELETE /games/:id/votes`
  **Navigation:** Back to Feed or Discover.

#### `app/(tabs)/team-hub.tsx` — Team Hub

**Purpose:** Event management hub for coaches. Lists events, allows creation and RSVP.
**API calls:**

- `Event.filter({ ... })` → `GET /events?...`
  **Navigation:** Event → `/event-detail`. Create → `/create-fan-event`.

#### `app/(tabs)/edit-profile.tsx` — Edit Profile

**Purpose:** Edit display name, full name, bio, sport, position, graduation year, zip code, avatar, header image, theme color.
**API calls:**

- `User.me()` → `GET /me`
- `User.updateMe(data)` → `PUT /auth/me`
- `uploadFile(file)` → `POST /uploads`
  **Navigation:** Back → `/profile`. Settings → `/settings`.

#### `app/(tabs)/organization.tsx` — Organization Detail

**Purpose:** Shows organization profile, teams, posts, members. Allows follow/unfollow.
**API calls:**

- `Organization.get(id)` → `GET /organizations/:id`
- `Organization.follow(id)` → `POST /organizations/:id/follow`
- `Organization.unfollow(id)` → `DELETE /organizations/:id/follow`
- `Organization.members(id)` → `GET /organizations/:id/members`
- `Game.list()`, `Post.list()`, `Team.list()`
  **Navigation:** Team → `/team-profile`. Post → `/post-detail`.

---

### Settings

#### `app/settings/index.tsx` — Settings

**Purpose:** Toggle notifications (by type), privacy settings (comment permission, private account), account management (change password, blocked users, data export, delete account). Links to help and legal pages.
**API calls:**

- `User.me()` → `GET /me`
- `User.updatePreferences(patch)` → `PATCH /me/preferences`
- `Event.filter({ ... })` → used to load RSVP history data
- `User.exportMyData()` → `GET /users/me/export`
- `DELETE /users/me` for account deletion (in users.ts, not auth.ts)
  **Key state:** `preferences`, notification toggles, `loading`
  **Navigation:** Uses `router.push` to child settings screens (edit-username, billing, blocked-users, etc.).

---

### Admin Screens

#### `app/admin-users.tsx` — Admin Users

**Purpose:** Admin-only. List all users, search, ban/unban users.
**API calls:**

- `User.listAll(q, limit, banned)` → `GET /users?q=...&limit=...&banned=1`
- `User.ban(id)` → `POST /users/:id/ban`
- `User.unban(id)` → `POST /users/:id/unban`
  **Access:** Only shown if `EXPO_PUBLIC_ADMIN_EMAILS` includes current user's email.

#### `app/admin-ads.tsx` — Admin Ads

**Purpose:** Admin-only. Review, approve/reject (with optional note), and manage all ads.
**API calls:**

- `Advertisement.listAll()` → `GET /ads?all=1`
- `Advertisement.review(id, action, note?)` → `POST /ads/:id/review` (approve/reject with optional admin_note)
- `Advertisement.update(id, data)` → `PUT /ads/:id`
- `Advertisement.delete(id)` → `DELETE /ads/:id`

---

## 3. BACKEND ROUTES

Production server: `https://api-production-8ac3.up.railway.app`
Server entry: `server/src/index.ts` → `server/src/app.ts`

### Auth Routes (`/auth`, `/me`) — `routes/auth.ts`

| Method | Path                    | Auth              | Description                                                                            | Used by                                |
| ------ | ----------------------- | ----------------- | -------------------------------------------------------------------------------------- | -------------------------------------- |
| POST   | /auth/register          | No (rate-limited) | Create account (email/password)                                                        | sign-up                                |
| POST   | /auth/login             | No (rate-limited) | Email/password login → returns access_token + refresh_token                            | sign-in                                |
| POST   | /auth/google            | No (rate-limited) | Google OAuth login (id_token in body)                                                  | useGoogleAuth                          |
| POST   | /auth/apple             | No (rate-limited) | Apple Sign In (identity_token in body)                                                 | useAppleAuth                           |
| POST   | /auth/refresh           | No (rate-limited) | Refresh access token using refresh_token                                               | api/auth.ts                            |
| GET    | /me                     | Required          | Get current user profile (includes `auth_provider`: 'apple'\|'google'\|'apple,google') | AuthProvider, everywhere               |
| PUT    | /auth/me                | Required          | Update profile (display_name, bio, avatar_url, etc.)                                   | edit-profile                           |
| PATCH  | /me                     | Required          | Partial update of profile                                                              | profile screen                         |
| PATCH  | /me/preferences         | Required          | Update user preferences JSON blob                                                      | settings, onboarding                   |
| POST   | /me/complete-onboarding | Required          | Finalize onboarding; sets onboarding_completed=true                                    | step-3-league, league-pending-approval |
| POST   | /auth/verify/request    | Required          | Send email verification code                                                           | verify flow                            |
| POST   | /auth/verify/confirm    | Required          | Confirm email with code                                                                | verify flow                            |
| POST   | /auth/password/forgot   | No (rate-limited) | Request password reset email                                                           | forgot-password                        |
| POST   | /auth/password/reset    | No (rate-limited) | Reset password with code                                                               | reset-password                         |
| POST   | /auth/password/change   | Required          | Change password (requires current_password)                                            | settings                               |
| DELETE | /users/me               | Required          | Delete/anonymize account (GDPR) — in users.ts                                          | settings                               |

### Posts Routes — `routes/posts.ts`

| Method | Path                           | Auth                | Description                                                                              | Used by                 |
| ------ | ------------------------------ | ------------------- | ---------------------------------------------------------------------------------------- | ----------------------- |
| GET    | /posts                         | Optional            | List/filter posts (sort, limit, cursor, game_id, user_id, followed_only, followed_teams) | feed, discover, profile |
| GET    | /posts/trending                | Optional            | Trending posts (time-decay score)                                                        | highlights, discover    |
| GET    | /posts/count                   | Optional            | Count posts by filter                                                                    | stats                   |
| POST   | /posts                         | Required            | Create post (content, media_url, game_id, title, lat, lng, country_code)                 | create-post             |
| GET    | /posts/:id                     | Optional            | Get single post with comments, upvote status                                             | post-detail             |
| PATCH  | /posts/:id                     | Required            | Update post content/title (author only, 5-min undo window)                               | post-detail             |
| DELETE | /posts/:id                     | Required            | Soft-delete post (author or coach of associated team)                                    | post-detail             |
| POST   | /posts/:id/restore             | Required            | Restore soft-deleted post                                                                | admin                   |
| GET    | /posts/:id/comments            | Optional            | List comments for post                                                                   | post-detail             |
| POST   | /posts/:id/comments            | Required + verified | Add comment (requireVerified)                                                            | post-detail             |
| PATCH  | /posts/:id/comments/:commentId | Required            | Edit own comment                                                                         | post-detail             |
| DELETE | /posts/:id/comments/:commentId | Required            | Delete own comment                                                                       | post-detail             |
| POST   | /posts/:id/upvote              | Required            | Toggle upvote (returns count)                                                            | PostCard, post-detail   |
| POST   | /posts/:id/bookmark            | Required            | Toggle bookmark                                                                          | PostCard                |
| POST   | /posts/:id/share               | Required            | Record share, notify author                                                              | PostCard                |
| POST   | /posts/:id/poll                | Required            | Create poll on post                                                                      | create-post             |
| POST   | /posts/:id/poll/vote           | Required            | Vote on poll option                                                                      | PollCard                |
| POST   | /posts/collage                 | Required            | Disabled (501); collage creation is not implemented                                      | No active caller        |

### Games Routes — `routes/games.ts`

| Method | Path                      | Auth                                | Description                                                           | Used by               |
| ------ | ------------------------- | ----------------------------------- | --------------------------------------------------------------------- | --------------------- |
| GET    | /games                    | Optional                            | List games (sort, lat/lng/distance, dateFrom/dateTo, approval_status) | feed, discover        |
| POST   | /games                    | Verified + onboarded + rate-limited | Create game (coach only)                                              | discover, create-game |
| GET    | /games/votes-summary      | Optional                            | Batch vote summary for multiple game IDs                              | feed                  |
| GET    | /games/:id                | Optional                            | Get single game                                                       | game-detail           |
| GET    | /games/:id/summary        | Optional                            | Get game summary (score, teams, event info)                           | game-detail           |
| PUT    | /games/:id                | Required                            | Update game (coach/owner of associated team)                          | edit-game             |
| DELETE | /games/:id                | Required                            | Delete game (creator, team coach, or admin only)                      | game-detail, admin    |
| PATCH  | /games/:id/result         | Required                            | Set game score and winner                                             | game-detail           |
| PUT    | /games/:id/approve        | Required (admin)                    | Approve/reject game                                                   | admin                 |
| GET    | /games/:id/posts          | Optional                            | Posts associated with game                                            | game-detail           |
| GET    | /games/:id/media          | Optional                            | Game media/stories                                                    | game-detail           |
| DELETE | /games/:id/media/:mediaId | Required                            | Delete a game media item                                              | game-detail           |
| GET    | /games/:id/votes/summary  | Optional                            | Vote counts for a specific game                                       | game-detail           |
| POST   | /games/:id/votes          | Required                            | Cast vote (team A or B)                                               | game-detail           |
| DELETE | /games/:id/votes          | Required                            | Clear own vote                                                        | game-detail           |
| GET    | /games/:id/stories        | Optional                            | List stories for game                                                 | game-detail           |
| POST   | /games/:id/stories        | Required                            | Add story to game                                                     | game-detail           |

### Users Routes — `routes/users.ts`

| Method | Path                      | Auth       | Description                            | Used by                   |
| ------ | ------------------------- | ---------- | -------------------------------------- | ------------------------- |
| GET    | /users                    | Admin only | List all users (search, banned filter) | admin-users               |
| GET    | /users/me/export          | Required   | GDPR data export (all user data)       | settings                  |
| GET    | /users/blocked            | Required   | List blocked users                     | settings                  |
| GET    | /users/username-available | No         | Check username availability            | onboarding step-2         |
| GET    | /users/lookup             | No         | Lookup user by email or username       | messaging                 |
| GET    | /users/search/mentions    | Optional   | Search users for @mention autocomplete | create-post, MentionInput |
| GET    | /users/:id                | Optional   | Get public user profile                | user-profile              |
| GET    | /users/:id/posts          | Optional   | Get user's posts (paginated, sortable) | profile                   |
| GET    | /users/:id/interactions   | Required   | Get user's liked/commented posts       | profile                   |
| GET    | /users/:id/followers      | Optional   | Get user's followers                   | profile                   |
| GET    | /users/:id/following      | Optional   | Get user's following                   | profile                   |
| GET    | /users/:id/teams          | Optional   | Get user's team memberships            | profile                   |
| GET    | /users/:id/full           | Admin only | Full user detail with ads              | admin-users               |
| POST   | /users/:id/follow         | Required   | Follow a user                          | profile, user-profile     |
| DELETE | /users/:id/follow         | Required   | Unfollow a user                        | profile, user-profile     |
| POST   | /users/:id/block          | Required   | Block a user                           | settings, message-thread  |
| DELETE | /users/:id/block          | Required   | Unblock a user                         | settings                  |
| POST   | /users/:id/ban            | Admin only | Ban a user                             | admin-users               |
| POST   | /users/:id/unban          | Admin only | Unban a user                           | admin-users               |

### Teams Routes — `routes/teams.ts`

| Method | Path                             | Auth                                               | Description                                                | Used by                |
| ------ | -------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- | ---------------------- |
| GET    | /teams                           | Optional                                           | List/search teams                                          | discover, profile      |
| GET    | /teams/managed                   | Required                                           | Teams where current user has management role               | profile, create-post   |
| GET    | /teams/limits                    | Required                                           | Plan-based team limits for current user                    | subscription-paywall   |
| GET    | /teams/members/all               | Required                                           | All members across managed teams                           | team management        |
| GET    | /teams/invites/me                | Required                                           | Pending team invites for current user                      | team-invites screen    |
| POST   | /teams                           | Verified + onboarded + plan(rookie)                | Create basic team                                          | team creation          |
| POST   | /teams/create                    | Verified + onboarded + plan(rookie) + rate-limited | Create team with full options (authorized users, org link) | onboarding             |
| GET    | /teams/:id                       | Optional                                           | Get team details                                           | team-profile           |
| PUT    | /teams/:id                       | Required                                           | Update team                                                | edit-team              |
| DELETE | /teams/:id                       | Required                                           | Delete team                                                | team management        |
| POST   | /teams/:id/follow                | Required                                           | Follow a team                                              | team-profile           |
| DELETE | /teams/:id/follow                | Required                                           | Unfollow a team                                            | team-profile           |
| GET    | /teams/:id/members               | Optional                                           | List team members                                          | team-profile, team-hub |
| POST   | /teams/:id/invite                | Required                                           | Invite user to team by email                               | team management        |
| PATCH  | /teams/:id/members/:userId       | Required                                           | Update member role/position                                | team management        |
| DELETE | /teams/:id/members/:userId       | Required                                           | Remove member from team                                    | team management        |
| POST   | /teams/invites/:inviteId/accept  | Required                                           | Accept team invite                                         | team-invites           |
| POST   | /teams/invites/:inviteId/decline | Required                                           | Decline team invite                                        | team-invites           |
| POST   | /teams/:id/transfer-ownership    | Required (owner)                                   | Transfer team ownership to another member                  | team management        |

### Notifications Routes — `routes/notifications.ts`

| Method | Path                         | Auth     | Description                                           | Used by                          |
| ------ | ---------------------------- | -------- | ----------------------------------------------------- | -------------------------------- |
| GET    | /notifications               | Required | List notifications (cursor pagination, unread filter) | notifications screen, feed badge |
| POST   | /notifications/:id/read      | Required | Mark single notification read                         | notifications screen             |
| POST   | /notifications/mark-read-all | Required | Mark all notifications read                           | notifications screen             |

### Messages Routes — `routes/messages.ts`

| Method | Path                | Auth     | Description                                              | Used by                  |
| ------ | ------------------- | -------- | -------------------------------------------------------- | ------------------------ |
| GET    | /messages           | Required | List messages (by conversation_id, with, or all owned)   | messages, message-thread |
| POST   | /messages           | Required | Send DM (content, conversation_id or recipient_id/email) | message-thread, messages |
| POST   | /messages/mark-read | Required | Mark messages read (by conversation_id or with)          | message-thread           |

### Events Routes — `routes/events.ts`

| Method | Path                | Auth                                | Description                                                                 | Used by                        |
| ------ | ------------------- | ----------------------------------- | --------------------------------------------------------------------------- | ------------------------------ |
| POST   | /events             | Verified + onboarded + rate-limited | Create event (fan-created events go through approval workflow)              | create-fan-event, team-hub     |
| GET    | /events             | Optional                            | Filter events (status, approval_status, event_type, q, zip, lat/lng/radius) | team-hub, feed                 |
| GET    | /events/my-rsvps    | Required                            | Events user has RSVP'd to                                                   | rsvp-history                   |
| GET    | /events/my-events   | Required                            | Events created by user                                                      | create-fan-event               |
| GET    | /events/pending     | Required                            | Pending events (for approval by org/league admin)                           | event-approvals                |
| GET    | /events/:id         | Optional                            | Get single event                                                            | event-detail, team-hub         |
| PUT    | /events/:id/approve | Verified + onboarded                | Approve event                                                               | event-approvals                |
| PUT    | /events/:id/reject  | Verified + onboarded                | Reject event                                                                | event-approvals                |
| PATCH  | /events/:id         | Required + onboarded                | Update event                                                                | team-hub                       |
| PATCH  | /events/:id/cancel  | Required + onboarded                | Cancel event                                                                | team-hub                       |
| GET    | /events/:id/rsvp    | Optional                            | Check user's RSVP status for event                                          | feed (RSVPBadge)               |
| POST   | /events/:id/rsvp    | Required                            | RSVP to event (going: true/false)                                           | feed (RSVPBadge), event-detail |

### Organizations Routes — `routes/organizations.ts`

| Method | Path                                            | Auth             | Description                                | Used by                                        |
| ------ | ----------------------------------------------- | ---------------- | ------------------------------------------ | ---------------------------------------------- |
| GET    | /organizations                                  | Optional         | List organizations (search by name prefix) | discover, organization screen                  |
| POST   | /organizations                                  | Required         | Create organization                        | onboarding step-4                              |
| POST   | /organizations/create                           | Required         | Create org with teams in one call          | onboarding                                     |
| GET    | /organizations/mine                             | Required         | Organizations the user belongs to          | profile                                        |
| GET    | /organizations/invites/me                       | Required         | Pending org invites                        | org management                                 |
| GET    | /organizations/:id                              | Optional         | Get org detail                             | organization screen                            |
| POST   | /organizations/:id/follow                       | Required         | Follow organization                        | organization screen                            |
| DELETE | /organizations/:id/follow                       | Required         | Unfollow organization                      | organization screen                            |
| GET    | /organizations/:id/members                      | Optional         | List org members                           | organization screen                            |
| POST   | /organizations/:id/invite                       | Required         | Invite user to org by email                | org management                                 |
| POST   | /organizations/:id/join-requests                | Required         | Request to join org                        | request-join screen                            |
| GET    | /organizations/:id/join-requests                | Required         | List join requests (admin)                 | org admin                                      |
| POST   | /organizations/invites/:id/accept               | Required         | Accept org invite                          | org invites                                    |
| POST   | /organizations/invites/:id/decline              | Required         | Decline org invite                         | org invites                                    |
| POST   | /organizations/join-requests/:requestId/approve | Required         | Approve join request (admin)               | organization-join-requests                     |
| POST   | /organizations/join-requests/:requestId/deny    | Required         | Deny join request (admin)                  | organization-join-requests (rejectJoinRequest) |
| POST   | /organizations/:id/transfer-ownership           | Required (owner) | Transfer org ownership to another member   | settings                                       |

### Ads Routes — `routes/ads.ts` (+ app-level route)

| Method | Path                         | Auth                | Description                                                            | Used by           |
| ------ | ---------------------------- | ------------------- | ---------------------------------------------------------------------- | ----------------- |
| POST   | /ads/:id/submit-for-approval | Required + verified | Submit ad for approval (app-level route, registered before ads router) | submit-ad, my-ads |
| GET    | /ads                         | Optional            | List ads (mine=1 for own ads, all=1 for admin)                         | my-ads, admin-ads |
| POST   | /ads                         | Required + verified | Create ad                                                              | submit-ad         |
| GET    | /ads/for-feed                | No                  | Get active ads for feed (by date/zip/radius)                           | feed, discover    |
| GET    | /ads/reservations            | No                  | Get reserved dates (for calendar)                                      | ad-calendar       |
| POST   | /ads/reservations            | Required            | Reserve dates for an ad                                                | ad-calendar       |
| GET    | /ads/:id                     | Optional            | Get single ad                                                          | edit-ad           |
| PUT    | /ads/:id                     | Required            | Update ad                                                              | edit-ad           |
| DELETE | /ads/:id                     | Required            | Delete ad                                                              | my-ads, admin-ads |

### Payments Routes — `routes/payments.ts`

| Method | Path                                   | Auth                               | Description                                                                                                                     | Used by                           |
| ------ | -------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| GET    | /payments/config                       | No                                 | Stripe publishable key + plan definitions                                                                                       | onboarding step-3, paywall        |
| POST   | /payments/checkout                     | Required + verified + rate-limited | Create Stripe checkout session (plan or ad). Holds ad slots during checkout.                                                    | onboarding step-3, ad booking     |
| POST   | /payments/create-payment-sheet         | Required + verified + rate-limited | Create PaymentIntent for mobile in-app PaymentSheet (subscriptions + ads)                                                       | subscription-paywall, ad-calendar |
| POST   | /payments/cancel-intent                | Required + verified + rate-limited | Cancel abandoned PaymentIntent, release ad holds, cancel incomplete subscriptions                                               | subscription-paywall, ad-calendar |
| POST   | /payments/subscribe                    | Required + verified + rate-limited | Alias for checkout (subscriptions only)                                                                                         | legacy                            |
| POST   | /payments/finalize-session             | Required + rate-limited            | Finalize Stripe session after redirect                                                                                          | payment-success                   |
| POST   | /payments/subscription/cancel          | Required + verified + rate-limited | Cancel subscription                                                                                                             | billing screen                    |
| POST   | /payments/update-subscription-quantity | Required + verified + rate-limited | Update team count on subscription (validates actual team ownership)                                                             | billing                           |
| GET    | /payments/subscription/summary         | Required                           | Current subscription status                                                                                                     | billing, profile                  |
| POST   | /payments/webhook                      | No (Stripe sig)                    | Stripe webhook: handles checkout.session.completed, subscription events, payment_intent.succeeded/failed, ad slot hold releases | Stripe → server                   |
| POST   | /payments/apple/verify-receipt         | Required + rate-limited            | Apple IAP subscription receipt validation                                                                                       | useIAP (iOS)                      |
| POST   | /payments/apple/verify-ad-receipt      | Required + rate-limited            | Apple IAP ad slot receipt validation                                                                                            | useAdIAP (iOS)                    |
| POST   | /payments/google/verify-purchase       | Required + rate-limited            | Google Play purchase validation                                                                                                 | useIAP (Android)                  |

### Search Route — `routes/search.ts`

| Method | Path    | Auth     | Description                                       | Used by  |
| ------ | ------- | -------- | ------------------------------------------------- | -------- |
| GET    | /search | Optional | Unified search across users, teams, organizations | discover |

### Highlights Route — `routes/highlights.ts`

| Method | Path        | Auth     | Description                                                | Used by              |
| ------ | ----------- | -------- | ---------------------------------------------------------- | -------------------- |
| GET    | /highlights | Optional | Top media posts (national + local, v2=1 for 90-day window) | highlights tab, feed |

### Uploads Routes — `routes/uploads.ts` + `routes/upload.ts`

| Method | Path                          | Auth                    | Description                                                   | Used by                              |
| ------ | ----------------------------- | ----------------------- | ------------------------------------------------------------- | ------------------------------------ |
| GET    | /uploads/cloudinary-signature | Required                | Get signed params for direct-to-Cloudinary upload             | upload.ts (client)                   |
| POST   | /uploads                      | Required                | Upload file (multipart) → Cloudinary or local disk (fallback) | create-post, edit-profile, submit-ad |
| GET    | /uploads/sign                 | Required + rate-limited | Sign a local media path for access                            | media display                        |
| POST   | /upload                       | Required                | Alternate upload endpoint                                     | some screens                         |

### Admin Routes — `routes/admin.ts`

| Method | Path                | Auth  | Description                                         | Used by         |
| ------ | ------------------- | ----- | --------------------------------------------------- | --------------- |
| GET    | /admin/dashboard    | Admin | Platform stats (users, teams, ads, posts, messages) | admin-dashboard |
| GET    | /admin/transactions | Admin | Transaction log                                     | admin           |
| GET    | /admin/metrics      | Admin | Founder metrics report                              | admin           |

### Follows Routes — `routes/follows.ts`

| Method | Path           | Auth     | Description                   | Used by |
| ------ | -------------- | -------- | ----------------------------- | ------- |
| GET    | /follows/teams | Required | Teams the user is a member of | profile |

### Support Routes — `routes/support.ts`

| Method | Path              | Auth     | Description                 | Used by        |
| ------ | ----------------- | -------- | --------------------------- | -------------- |
| POST   | /support/contact  | No       | Submit support contact form | settings, help |
| POST   | /support/feedback | Optional | Submit app feedback         | settings       |

### Team Memberships — `routes/team-memberships.ts`

| Method | Path                  | Auth     | Description             | Used by         |
| ------ | --------------------- | -------- | ----------------------- | --------------- |
| POST   | /team-memberships     | Required | Add membership directly | team management |
| PATCH  | /team-memberships/:id | Required | Update role/position    | team management |
| DELETE | /team-memberships/:id | Required | Remove membership       | team management |

### Team Invites — `routes/team-invites.ts`

| Method | Path          | Auth     | Description        | Used by         |
| ------ | ------------- | -------- | ------------------ | --------------- |
| POST   | /team-invites | Required | Create team invite | team management |

### RSVP Routes — `routes/rsvps.ts`

| Method | Path   | Auth     | Description                | Used by      |
| ------ | ------ | -------- | -------------------------- | ------------ |
| GET    | /rsvps | Required | Get user's RSVPs (history) | rsvp-history |

### Geocoding — `routes/geocoding.ts`

| Method | Path                    | Auth     | Description                          | Used by                       |
| ------ | ----------------------- | -------- | ------------------------------------ | ----------------------------- |
| GET    | /geocoding/autocomplete | Optional | Address autocomplete via Google Maps | LocationPicker, game creation |

### Health — `routes/health.ts`

| Method | Path    | Auth | Description         | Used by                  |
| ------ | ------- | ---- | ------------------- | ------------------------ |
| GET    | /health | No   | Server health check | AuthProvider health ping |

### Reports — `routes/reports.ts`

| Method | Path     | Auth     | Description         | Used by             |
| ------ | -------- | -------- | ------------------- | ------------------- |
| POST   | /reports | Required | Submit abuse report | report-abuse screen |

### Group Chats — `routes/group-chats.ts`

| Method | Path                          | Auth     | Description                                  | Used by                                 |
| ------ | ----------------------------- | -------- | -------------------------------------------- | --------------------------------------- |
| GET    | /group-chats                  | Required | List group chats for current user            | api/groupChats.ts GroupChat.list        |
| POST   | /group-chats                  | Required | Create group chat (name, teamId?, memberIds) | api/groupChats.ts GroupChat.create      |
| GET    | /group-chats/:chatId/messages | Required | Get messages for a group chat (last 100)     | api/groupChats.ts GroupChat.getMessages |
| POST   | /group-chats/:chatId/messages | Required | Send message (content)                       | api/groupChats.ts GroupChat.sendMessage |
| POST   | /group-chats/:chatId/read     | Required | Mark chat as read                            | api/groupChats.ts GroupChat.markRead    |

---

## 4. DATABASE MODELS

From `server/prisma/schema.prisma`. Database: PostgreSQL.

### User

Key fields: `id` (cuid), `email` (unique), `password_hash`, `google_id`, `apple_id`, `display_name`, `username`, `avatar_url`, `bio`, `email_verified`, `banned`, `preferences` (JSON blob), `subscription_tier` (free|premium|pro), `subscription_status`, `stripe_customer_id`, `max_teams`.

Relations: `memberships`, `orgMemberships`, `rsvps`, `stories`, `ads`, `posts`, `following`/`followers` (Follows), `messagesSent`/`messagesReceived`, `notifications`, `blocking`/`blockedBy`, `groupChats`, `pollVotes`, `gameVotes`, `postUpvotes`, `postBookmarks`.

### Game

Key fields: `id`, `title`, `date`, `location`, `latitude`, `longitude`, `home_team_id`, `away_team_id`, `home_team`, `away_team`, `cover_image_url`, `banner_url`, `appearance`, `event_type` (game|fundraiser|watch_party|team_trip|meeting|other), `approval_status` (approved|pending|rejected), `home_score`, `away_score`, `winner`.

Relations: `posts`, `stories`, `events`, `votes`, `homeTeam`/`awayTeam` (Team).

### Post

Key fields: `id`, `author_id`, `title`, `content`, `type`, `media_url`, `upvotes_count`, `country_code`, `lat`, `lng`, `game_id`, `team_id`, `is_pinned`, `created_at`, `deleted_at` (soft delete).

Relations: `author` (User), `game` (Game), `team` (Team), `comments`, `upvotes`, `bookmarks`, `poll`, `notifications`.

### Poll / PollOption / PollVote

`Poll` has `post_id` (unique), optional `expires_at`. `PollOption` has `text`, `votes_count`. `PollVote` unique on `(poll_option_id, user_id)`.

### Event

Key fields: `id`, `title`, `date`, `location`, `latitude`, `longitude`, `banner_url`, `game_id`, `status` (draft|approved|rejected|cancelled), `capacity`, `creator_id`, `creator_role`, `approval_status` (pending|approved|rejected), `event_type`, `description`, `max_attendees`.

Relations: `game` (Game), `creator` (User), `rsvps` (EventRsvp).

### Message

Key fields: `id`, `conversation_id`, `sender_id`, `recipient_id`, `content`, `read`, `created_at`.

### BlockedUser

Unique on `(blocker_id, blocked_id)`.

### GroupChat / GroupChatMember / GroupChatMessage

Group chat support (team-based). `GroupChat` has `team_id`, `created_by`.

### Comment

Key fields: `id`, `post_id`, `parent_id` (for replies), `author_id`, `content`, `created_at`.

### PostUpvote / PostBookmark

Composite primary keys `(post_id, user_id)`.

### EventRsvp

Unique on `(event_id, user_id)`.

### Ad / AdReservation

`Ad`: contact info, `banner_url`, `target_url`, `target_zip_code`, `radius`, `status` (draft|active|archived|pending), `payment_status` (unpaid|hold|paid|refunded). `hold` is a temporary state during checkout to prevent slot race conditions — released on expiry/failure.
`AdReservation`: `ad_id`, `date`. Unique on `(ad_id, date)`.

### Category / CategoryFollow / CategoryAssignment

Sport/topic categories for post tagging. Users can follow categories.

### GameVote

Unique on `(game_id, user_id)`. `team` field: "A" or "B".

### Story

24-hour game stories: `game_id`, `user_id`, `media_url`, `caption`, `expires_at`, lat/lng.

### Notification

Type enum: `FOLLOW`, `UPVOTE`, `COMMENT`, `TEAM_INVITE`, `MESSAGE`, `MENTION`, `COMMENT_REPLY`, `SHARE`, `GAME_REMINDER`.
Fields: `user_id`, `actor_id`, `post_id`, `comment_id`, `message_id`, `meta` (JSON), `read_at`.

### Team

Key fields: `id`, `name`, `description`, `logo_url`, `sport`, `club_type` (sport|extracurricular), `extracurricular_category`, `organization_id`, `season_start`, `season_end`, `city`, `state`, `league`, `venue_*` fields.

Relations: `organization`, `memberships` (TeamMembership), `invites` (TeamInvite), `followers` (TeamFollow), `groupChats`, `posts`, `homeGames`, `awayGames`.

### Organization

Key fields: `id`, `name`, `description`, `sport`, `org_type` (school|club|league|other), `location`, `zip_code`, `season_start`, `season_end`. Unique on `(name, zip_code)`.

Relations: `teams`, `memberships` (OrganizationMembership), `invites` (OrganizationInvite), `joinRequests` (OrganizationJoinRequest), `followers` (OrganizationFollow).

### TeamMembership

Roles: owner|manager|coach|assistant_coach|equipment|health_wellness|player|parent|member.
Status: active|invited|archived. Unique on `(team_id, user_id)`.

### TeamInvite

Status: pending|accepted|declined|revoked. Unique on `(team_id, email)`.

### OrganizationMembership / OrganizationInvite / OrganizationJoinRequest

Similar patterns to team equivalents.

### Follows / TeamFollow / OrganizationFollow

Social graph. `Follows` is user→user. `TeamFollow` and `OrganizationFollow` are user→entity (schema exists but API for TeamFollow/OrganizationFollow is partially implemented).

### PromoCode / PromoRedemption

Promotional codes (PERCENT_OFF, COMPLIMENTARY) for subscriptions/ads with redemption tracking.

### TransactionLog

Full Stripe transaction audit trail: `transaction_type`, `status`, Stripe IDs, amounts in cents (subtotal, tax, stripe_fee, discount, total, net).

### AdminActivityLog

Admin action audit trail: `admin_id`, `action`, `target_type`, `target_id`, `description`, `metadata`.

### AbuseReport

User-submitted abuse reports: `reporter_id`, `subject`, `message`, `status` (pending|reviewed|resolved|dismissed), `reviewed_by`, `resolution_note`.

---

## 5. SHARED UTILITIES

### Hooks (`hooks/`)

| Hook                         | Purpose                                                                                                            | Returns                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------- |
| `useGoogleAuth.ts`           | Google OAuth via expo-auth-session. **DO NOT MODIFY** (fixed 2026-02-24). Handles iOS native vs web proxy routing. | `{ signInWithGoogle, loading, ready }`                                                                 |
| `useAppleAuth.ts`            | Apple Sign In via expo-apple-authentication. Simulator fallback with stable mock credential.                       | `{ signInWithApple, loading, available, ready }`                                                       |
| `useDeviceLocation.ts`       | GPS location with 10-min cache. Handles permission denial gracefully.                                              | `{ location, loading, error, permissionGranted, isPrecise, requestPermission, openSettings, refresh }` |
| `useUser.ts`                 | Loads current user via `User.me()`.                                                                                | `{ user, loading, error, loadUser, refresh }`                                                          |
| `useShareLink.ts`            | Generates shareable deep links for posts, games, events, teams, users.                                             | `{ shareLink, copyLink }`                                                                              |
| `useColorScheme.ts`          | Light/dark mode from system.                                                                                       | `'light'                                                                                               | 'dark'` |
| `useCustomColorScheme.tsx`   | Override color scheme with custom theme.                                                                           | `{ colorScheme, setColorScheme }`                                                                      |
| `useAnalytics.ts`            | Lightweight event tracking.                                                                                        | `{ trackTap, trackView }`                                                                              |
| `useRequireAdmin.ts`         | Redirects to feed if user is not an admin.                                                                         | (side-effect only)                                                                                     |
| `useTeamInvites.ts`          | Fetches and manages pending team invites.                                                                          | `{ invites, loading, accept, decline }`                                                                |
| `useTeamOptions.ts`          | Loads teams for create-post team picker.                                                                           | `{ teams, loading }`                                                                                   |
| `useUploadProgress.ts`       | Tracks file upload progress state.                                                                                 | `{ progress, setProgress }`                                                                            |
| `useUnsavedChanges.ts`       | Warns user before leaving screen with unsaved changes.                                                             | `{ confirmLeave }`                                                                                     |
| `useProfileData.ts`          | Loads full profile data for profile screen.                                                                        | `{ profile, loading, refresh }`                                                                        |
| `useProfilePosts.ts`         | Loads posts for profile tab.                                                                                       | `{ posts, loading, loadMore }`                                                                         |
| `useProfileInteractions.ts`  | Loads liked/commented posts for profile.                                                                           | `{ interactions, loading }`                                                                            |
| `useProfileOrganizations.ts` | Loads user's organizations.                                                                                        | `{ organizations, loading }`                                                                           |
| `useOrganizationSearch.ts`   | Search organizations with debounce.                                                                                | `{ results, loading, search }`                                                                         |

### Context (`context/`)

#### `AuthProvider.tsx`

Manages authentication state. Single source of truth for `user`, `loading`, `healthOk`, `isAdmin`. On mount, calls `User.me()` to restore session. Routes to `/sign-in`, `/onboarding/step-1-role`, or `/(tabs)` based on auth state. Registers push token after login. Exposes:

- `user` — current user (null if not authenticated)
- `loading` — auth check in progress
- `healthOk` — server reachable
- `isAdmin` — email matches `EXPO_PUBLIC_ADMIN_EMAILS`
- `checkAuth(opts)` — re-run auth check (call after login/logout)
- `signOut()` — clear tokens, navigate to sign-in
- `markOnboardingCompleteLocally()` — set local flag to avoid re-onboarding

#### `PostCacheContext.tsx`

In-memory cache for post objects (Map). Prevents redundant API calls when navigating between list and detail. Provides `get(id)`, `set(id, post)`, `setBatch(posts[])`, `clear()`.

#### `OnboardingContext.tsx`

Multi-step onboarding state persisted to AsyncStorage. Uses `onboardingReducer.ts` for state transitions. Manages:

- `state: OnboardingState` (role, username, plan, teamId, organizationId, sport, etc.)
- `progress: number` (current step index)
- `dispatch(event: OnboardingEvent)` (advance/retreat steps)
- `canNavigate` (validation for "next" button)
- `clearOnboarding()` (reset after completion)

### API Layer (`api/`)

#### `api/http.ts`

Core fetch wrapper. Features:

- Auth token injection via `Authorization: Bearer` header
- Automatic token clearing on 401
- Retry logic: 3-5 retries for GET; 0 retries for PUT/PATCH/DELETE (state-change protection)
- 502 Bad Gateway retry with exponential backoff (up to 5 retries, special Railway infra detection)
- 429 Rate Limit handling with `retryAfter`
- Request timeout (default 30s for GET, 15s for POST/PUT/PATCH/DELETE, 180s for long-timeout POST)
- Cache-Control: no-store headers for personalized endpoints
- Sentry breadcrumb and exception capture

Exports: `httpGet`, `httpPost`, `httpPostLongTimeout`, `httpPostWithOptions`, `httpPut`, `httpPatch`, `httpDelete`, `getApiBaseUrl`, `setAuthToken`, `clearAuthToken`, `getAuthToken`

#### `api/auth.ts`

Authentication operations with token storage in SecureStore (iOS/Android) or localStorage (web). Token: 1-hour JWT. Refresh token persisted for silent re-auth. Exports:

- `auth.register(email, password, display_name?)`
- `auth.login(email, password)`
- `auth.loginWithGoogle(idToken)`
- `auth.loginWithApple(identityToken)`
- `auth.me()` — loads token from storage first; auto-refreshes on 401
- `auth.logout()` — clears both access and refresh tokens
- `auth.clearTokensOnly()` — clear tokens locally only (no server call); use before OAuth to avoid mixed provider state
- `auth.requestEmailVerification()`
- `auth.verifyEmail(code)`
- `auth.requestPasswordReset(email)`
- `auth.resetPassword(email, code, password)`
- `auth.changePassword(currentPassword, newPassword)`
- `loadToken()` — exported for AuthProvider

#### `api/entities.ts`

All entity API call wrappers. Named exports: `User`, `Game`, `Post`, `Event`, `Message`, `Organization`, `Team`, `TeamMemberships`, `TeamInvites`, `Notification`, `Payments`, `Subscriptions`, `Report`, `Support`, `Advertisement`, `Search`, `Highlights`, `GroupChat`.

Each is a plain object with methods that delegate to `httpGet`/`httpPost`/etc. This is the primary import for all screens.

#### `api/settings.ts`

SecureStore/localStorage key-value store for app settings. Key prefix: `vh_settings_`. Exports: `getBool`, `setBool`, `getJson`, `setJson`, `getString`, `setString`, `SETTINGS_KEYS`.

`SETTINGS_KEYS`: `PRIVATE_ACCOUNT`, `DM_POLICY`, `BLOCKED_USERS`, `NOTIFY_MSG`, `NOTIFY_FOLLOW`, `LOCAL_ADS`, `POST_DRAFT`, `SAMPLE_EVENT_POSTS`.

### Utils (`utils/`)

| File                   | Purpose                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------ |
| `deepLinks.ts`         | Parse `varsityhubmobile://` and `https://varsityhub.app/` URLs. Route map covers: post, game, team, profile, event. `handleInitialDeepLink()` + `setupDeepLinkListener()`. |
| `links.ts`             | Generate shareable URLs. `AppLinks.post(id)`, `.game(id)`, `.event(id)`, `.team(id)`, `.user(id)`. Returns `{ webUrl, deepLink, shareMessage }`.                           |
| `format.ts`            | `timeAgo(date)` → "2h ago". `formatCount(n)` → "1.2K". `getCountryFlag(code)` → "🇺🇸".                                                                                      |
| `formUtils.ts`         | `validateEmail()`, `validatePassword()`, `sanitizeEmail()`, `calculatePasswordStrength()`, `validateZipCode()`, `validateYear()`.                                          |
| `sentry.ts`            | `initSentry()`, `captureException(error, context)`, `captureBreadcrumb(msg, category, data)`. Only active in production (no-op in dev).                                    |
| `rankingUtils.ts`      | `calculateRanking(item, index, tab, nationalTop, ranked, userLocation)` → determines `RankingType` (trending                                                               | recent | top) and badge for highlights. |
| `pushNotifications.ts` | `setupPushNotifications(userId)` → registers Expo push token, syncs to server via `PATCH /me/preferences`. Lazy-loads expo-notifications.                                  |
| `dmRestrictions.ts`    | `checkDMRestriction(me, other)` → checks DM policy settings before allowing message send.                                                                                  |
| `picker.ts`            | `pickerMediaTypeFor(type)` + `pickerMediaTypesProp()` — ImagePicker media type helpers per platform.                                                                       |
| `theme.ts`             | `getGradientForColor(hex)` → generates gradient array for team/org color themes.                                                                                           |
| `events.ts`            | Simple event emitter for cross-screen communication (e.g., post deleted → feed removes it).                                                                                |
| `accessibility.ts`     | `calculateContrastRatio(fg, bg)` → WCAG contrast check.                                                                                                                    |
| `uploadUtils.ts`       | Upload progress tracking utilities.                                                                                                                                        |
| `navigation.ts`        | Navigation utility helpers.                                                                                                                                                |
| `roles.ts`             | Role-based permission checks.                                                                                                                                              |
| `userRole.ts`          | User role classification utilities.                                                                                                                                        |

### Shared (`shared/`)

#### `plan-definitions.json`

Single source of truth for subscription plans used by both frontend and server.

- **rookie**: Free, max 2 teams, 1 staff/team, 50 athletes/team
- **veteran**: $0.99/mo per additional team (3+), 5 staff/team, 100 athletes/team. Stripe priceId: `price_1SVco4GJt8CsPE1EBNNlHYPB`
- **legend**: $20/yr flat, unlimited teams/staff/roster, extracurricular support. Stripe priceId: `prod_RNLdYADy7i6dB5`

---

## 6. KEY DEPENDENCIES

### Navigation

| Package                          | Version | Use                            |
| -------------------------------- | ------- | ------------------------------ |
| `expo-router`                    | ~6.0.22 | File-based routing, deep links |
| `@react-navigation/native`       | ^7.1.6  | Core navigation                |
| `@react-navigation/bottom-tabs`  | ^7.3.10 | Tab bar                        |
| `@react-navigation/native-stack` | ^7.3.10 | Stack navigation               |

### Auth & Social Login

| Package                                     | Version | Use                        |
| ------------------------------------------- | ------- | -------------------------- |
| `expo-apple-authentication`                 | ~8.0.7  | Apple Sign In (iOS only)   |
| `expo-auth-session`                         | ~7.0.9  | OAuth session (Google)     |
| `expo-secure-store`                         | ~15.0.7 | Secure token storage       |
| `@react-native-async-storage/async-storage` | 2.2.0   | Onboarding state, settings |

### Media & Uploads

| Package                  | Version                   | Use                                        |
| ------------------------ | ------------------------- | ------------------------------------------ |
| `expo-image-picker`      | ~17.0.10                  | Photo/video picker                         |
| `expo-image-manipulator` | ~14.0.7                   | Image resize/compress before upload        |
| `expo-image`             | ~3.0.8                    | Optimized image display (lazy load, cache) |
| `expo-video`             | ~3.0.14                   | Video playback                             |
| `expo-media-library`     | ~18.2.0                   | Save to device media library               |
| `expo-camera`            | (via image-picker plugin) | Camera access                              |

### Location & Maps

| Package             | Version | Use                    |
| ------------------- | ------- | ---------------------- |
| `expo-location`     | ~19.0.7 | GPS location           |
| `react-native-maps` | 1.20.1  | Event/game map display |

### Payments

| Package                       | Version | Use                                         |
| ----------------------------- | ------- | ------------------------------------------- |
| `@stripe/stripe-react-native` | 0.50.3  | In-app PaymentSheet for subscriptions + ads |
| `expo-web-browser`            | ~15.0.9 | Opens Stripe Checkout in browser            |
| (Server) `stripe`             | ~17.x   | Stripe SDK for payment processing           |

### Analytics & Monitoring

| Package                | Version | Use                              |
| ---------------------- | ------- | -------------------------------- |
| `@sentry/react-native` | ~7.2.0  | Error tracking (production only) |

### UI & Animation

| Package                        | Version   | Use                                           |
| ------------------------------ | --------- | --------------------------------------------- |
| `expo-linear-gradient`         | ~15.0.7   | Gradient backgrounds                          |
| `expo-blur`                    | ~15.0.7   | Blur effects                                  |
| `expo-haptics`                 | ~15.0.7   | Haptic feedback on tab presses, upvotes       |
| `expo-symbols`                 | ~1.0.7    | SF Symbols (iOS)                              |
| `@expo/vector-icons`           | ^15.0.2   | Ionicons and other icon sets                  |
| `lottie-react-native`          | ~7.3.1    | Lottie animations                             |
| `react-native-reanimated`      | ~4.1.1    | Gesture animations                            |
| `react-native-gesture-handler` | ~2.28.0   | Gesture detection                             |
| `react-native-calendars`       | ^1.1313.0 | Calendar views (ad booking, event scheduling) |
| `expo-font`                    | ~14.0.11  | Custom fonts (SpaceMono)                      |

### Notifications

| Package              | Version  | Use                            |
| -------------------- | -------- | ------------------------------ |
| `expo-notifications` | ~0.32.15 | Push notifications (Expo push) |

### Utilities

| Package                  | Version  | Use                         |
| ------------------------ | -------- | --------------------------- |
| `date-fns`               | ^4.1.0   | Date formatting             |
| `expo-linking`           | ~8.0.8   | Deep link handling          |
| `expo-clipboard`         | ~8.0.7   | Copy to clipboard           |
| `expo-constants`         | ~18.0.12 | App config/constants access |
| `expo-application`       | ~7.0.7   | App version info            |
| `expo-device`            | ~8.0.9   | Device info                 |
| `expo-updates`           | ~29.0.15 | OTA updates                 |
| `react-native-view-shot` | 4.0.3    | Screenshot capture          |

### Server-side (in `server/package.json`, not listed above)

| Package                                   | Use                                           |
| ----------------------------------------- | --------------------------------------------- |
| `express`                                 | HTTP server                                   |
| `@prisma/client` + `prisma`               | ORM + migrations                              |
| `bcrypt`                                  | Password hashing                              |
| `jsonwebtoken`                            | JWT signing/verification                      |
| `stripe`                                  | Payment processing                            |
| `@sendgrid/mail`                          | Transactional email                           |
| `cloudinary` (via undici fetch)           | Media file storage                            |
| `expo-server-sdk`                         | Expo push notifications                       |
| `express-rate-limit` + `rate-limit-redis` | Rate limiting                                 |
| `ioredis`                                 | Redis client (rate limiting, queues)          |
| `bullmq`                                  | Background job queues (email, game reminders) |
| `helmet`                                  | Security headers                              |
| `cors`                                    | CORS                                          |
| `zod`                                     | Schema validation (env, request bodies)       |
| `pino` + `pino-http`                      | Structured logging                            |
| `swagger-ui-express`                      | API documentation at `/api-docs`              |

---

## 7. KNOWN WORKING — DO NOT TOUCH

The following features have been confirmed stable and should not be modified without explicit testing:

### Google OAuth (`hooks/useGoogleAuth.ts`)

- **DO NOT MODIFY** — marked with warning comment. Fixed 2026-02-24.
- iOS native uses iOS client ID with native redirect scheme
- Web/Expo proxy uses Web client ID with `auth.expo.io` redirect
- Changing client ID routing logic will break Google Sign In

### Apple Sign In (`hooks/useAppleAuth.ts`)

- Working on real iOS devices; uses stable mock credential in simulator
- Configured in `app.json` (`usesAppleSignIn: true`)

### JWT Auth + Refresh Token Flow (`api/auth.ts`)

- Access tokens expire in 1 hour
- Refresh tokens handled silently on 401 via `auth.me()` → `refreshAccessToken()`
- Token stored in SecureStore (iOS/Android) / localStorage (web)

### Cloudinary File Uploads (`server/src/routes/uploads.ts`)

- Production uses Cloudinary (required; throws on startup if not configured)
- **Direct upload path (fast):** Client gets signature via `GET /uploads/cloudinary-signature`, then uploads straight to Cloudinary CDN — server never touches the file
- **Fallback path:** If signature fails, client proxies through server (`POST /uploads` → memory buffer → Cloudinary)
- Local disk storage only in development

### Stripe Subscription Flow

- Rookie plan = free (no Stripe call)
- Veteran/Legend → `POST /payments/checkout` → opens Stripe Checkout in WebBrowser (or `POST /payments/create-payment-sheet` for in-app PaymentSheet)
- `POST /payments/finalize-session` called after return redirect
- Webhook at `POST /payments/webhook` handles: subscription lifecycle events, ad slot hold releases on checkout expiry/payment failure, promo code redemption with retry
- `getUserPlan()` in `middleware/subscription.ts` auto-downgrades expired subscriptions (checks `subscription_end_date` / `plan_expiry_date`)
- Ad slot race prevention: slots are held (`payment_status: 'hold'`) during checkout and released on failure/expiry/cancel
- Incomplete subscriptions from abandoned PaymentSheet are cleaned up via `cancel-intent` endpoint

### COPPA Age Gating (`server/src/routes/auth.ts`)

- `isUnder13(dob)` check on registration; under-13 users are blocked

### Content Filtering (`server/src/lib/contentFilter.ts`)

- `validateContent(text)` blocks profanity, bullying phrases, excessive caps/repetition
- Applied to posts, comments, event creation

### Geofencing (`server/src/lib/geofencing.ts`)

- Story posts: 24-hour window ±12h from game, within 1km
- Regular posts: 4-day window, within 3km
- Sample events (IDs starting with "sample-") bypass all geofencing

### Rate Limiting (`server/src/middleware/rateLimiters.ts`)

- Auth: 20 attempts/15min per IP
- Posts: 20/hour per user
- Messages: 60/minute per user
- Uploads: 30/hour per user
- Redis store in production; memory store fallback

### Tab Navigation

- 5 visible tabs: Feed, Highlights, Create (center `+`), Discover, Profile

---

## AUDIT CONFIRMATION (2026-03-18)

Front and backend audit against codebase map and recent security fixes. **Confirmed working as intended** unless noted.

### Backend — Auth & middleware

- **authMiddleware** (`server/src/middleware/auth.ts`): Runs on every request. Reads `Authorization: Bearer <token>`, verifies JWT via `verifyJwt()`, loads user from DB. Rejects banned/suspended users and tokens issued before `password_changed_at`. Sets `req.user = { id }`.
- **requireAuth**: Returns 401 if `!req.user`. Used on /me, /me/preferences, /logout, /upgrade-to-coach, /me/complete-onboarding, etc.
- **requireVerified**: Returns 403 "Email verification required" unless `email_verified` or narrow bypass (teams POST / or /create with `onboarding === true` during onboarding). **upgrade-to-coach** uses `requireVerified` (only email-verified users can upgrade).
- **requireOnboarded**: Returns 403 if `onboarding_completed !== true`; blocks coaches with `approval_status !== 'APPROVED'`; verifies coach org `admin_approved`; blocks paid coaches who haven’t completed checkout when required. Used on games POST/PATCH/DELETE, teams POST/PUT/DELETE/invite, posts POST/PATCH/DELETE, organizations PATCH/invite/transfer, etc.

### Backend — Key routes

- **POST /auth/upgrade-to-coach**: `requireVerified` + requireAuth. Sets role coach, onboarding_completed false, approval_status PENDING. No role elevation without verification.
- **POST /me/complete-onboarding**: requireAuth only (user may complete before verify in some flows). Validates coach has org or join_request_pending; sets coaches to PENDING unless org already admin_approved. Re-completion blocked (409).
- **Organizations POST / and POST /create**: requireAuth only (correct — org is created during onboarding before completion). Coach approval and org admin_approved enforced by requireOnboarded on all mutating coach actions.

### Frontend — Auth & routing

- **AuthProvider**: Single source of truth. Redirects from the server contract first: `account_state` + `next_step` decide coach recovery, agreement, final setup, and pending approval routing. AsyncStorage is only a local hint and must never override server auth state.
- **app/index.tsx**: Passive splash; 3s fallback redirect if still on index (sign-in / verify / onboarding / tabs).
- **app/onboarding/\_layout.tsx**: Guards all onboarding: if !user after loading, redirect to sign-in; shows loading while loading or when !user.

### Frontend — Coach UI gating

- **Create screen** (`app/create.tsx`): "Create Team" and "Create Event" label only when `role === 'coach'` **and** `approval_status === 'APPROVED'` (isApprovedCoach). Prevents pending coaches from seeing coach-only options (backend would 403; UI now matches).
- **Discover** (`app/(tabs)/discover/mobile-community.tsx`): Quick Add Game and userRole for game creation check `role === 'coach' && approval_status === 'APPROVED'`.
- **create-fan-event**, **profile**, **event-approvals**, **manage-teams**, **create-team**, **my-team**: Use role and/or approval_status/onboarding_completed where appropriate.

### Reference

- Recent commits: security audit fixes, token invalidation, verification audit, back button migration, PDF LAST 101% fixes. See `git log --oneline -20`.
- Backend audit details: `server/BACKEND_AUDIT_REPORT.md`.

---

## 10. HIGH-CONFIDENCE VERIFICATION COMMANDS

Run these from repo root to verify core P0 setup repeatedly:

```bash
# Consolidated foundation verification (security audit + limiter coverage + payment confidence tests)
npm run verify:p0:foundation

# Validate production health + payment config readiness
BASE_URL="https://api-production-8ac3.up.railway.app" \
npm --prefix server run verify:production-health

# Load smoke against target API (set token for auth-required scenarios)
BASE_URL="https://api-production-8ac3.up.railway.app" \
LOAD_CONCURRENCY=2 \
LOAD_REQUESTS=10 \
npm --prefix server run load:smoke

# Distributed lock multi-process validation (requires REDIS_URL in environment)
npm --prefix server run load:validate-lock
```

- Many screens are hidden tabs (no tab bar icon) navigated via `router.push`

---

## 8. KNOWN ISSUES

> **Last verified:** 2026-02-24. Items marked ✅ Fixed have been confirmed in code, not just claimed.

---

### ✅ FIXED — Sawtooth Zigzag on Feed Screen

- **Fixed:** 2026-02-24
- **Was:** `overflow: 'hidden'` on `tabBarStyle` clipped the `CenterTabButton` floating via `top: -6`, anti-aliasing the circular button against a rectangular clip boundary and producing a zigzag edge.
- **Fix:** `app/(tabs)/_layout.tsx` → `overflow: 'visible'`; removed `overflow: 'hidden'` from `wrapper` and `buttonContainer` in `components/ui/CenterTabButton.tsx`.
- **Do not re-add `overflow: 'hidden'` to either of these.**

### ✅ FIXED — Google OAuth on iOS

- **Fixed:** 2026-02-24
- **Was:** Google Sign-In failing on iOS due to incorrect client ID / redirect URI config.
- **Fix:** `hooks/useGoogleAuth.ts` and `app.json` updated with correct native iOS client ID and redirect scheme.
- **Do not modify `hooks/useGoogleAuth.ts` without testing on a physical device.**

### ✅ FIXED — Post Owner Cannot Delete Comments

- **Fixed:** Already implemented (confirmed 2026-02-24)
- **Was:** Audit assumed only comment authors could delete. Code was already updated.
- **Current state:** `DELETE /posts/:postId/comments/:commentId` checks `isCommentAuthor || isPostOwner`. Post owners can moderate comments on their own posts.
- **File:** `server/src/routes/posts.ts` line ~1325.

### ✅ FIXED — Private Profile Not Enforced Server-Side

- **Fixed:** Already implemented (confirmed 2026-02-24)
- **Was:** Audit assumed `profile_private` was a local-only setting.
- **Current state:** `server/src/routes/users.ts` reads `prefs.profile_private` and, when `true`, returns only `display_name` and `avatar_url` to non-followers. Fully server-enforced.
- **File:** `server/src/routes/users.ts` line ~224 (`isProfilePrivate` helper) and ~750 (enforcement in GET /users/:id).

### ✅ FIXED — No Server-Side Followed Feed Filter

- **Fixed:** Already implemented (confirmed 2026-02-24)
- **Was:** Audit said `GET /posts` had no server-side `followed_only` filter.
- **Current state:** `GET /posts?followed_only=true` performs a real DB query (`WHERE author_id IN (SELECT following_id FROM Follows WHERE follower_id = currentUserId)`). Also `?followed_teams=true` is implemented using the `TeamFollow` model.
- **File:** `server/src/routes/posts.ts` line ~90.

### ✅ FIXED — Comment Permissions Not Enforced

- **Fixed:** Already implemented (confirmed 2026-02-24)
- **Was:** Audit said anyone could comment on any post.
- **Current state:** `POST /posts/:id/comments` reads `post.author.preferences.comment_permission` (`everyone` | `following` | `none`) and enforces it server-side. Users who don't meet the permission get a 403 with `COMMENTS_DISABLED` or `COMMENTS_FOLLOWING_ONLY` code.
- **File:** `server/src/routes/posts.ts` line ~923.

### ✅ FIXED — Push Permission Requested Immediately After Login

- **Fixed:** Already resolved (confirmed 2026-02-24)
- **Was:** Audit said `checkAuth` called `setupPushNotifications()` on every login.
- **Current state:** `checkAuth` no longer calls push setup. Comment in code explicitly states: "Push notifications are requested during onboarding step 9 (with pre-prompt), not immediately after login." Push is registered only via the explicit `registerPushToken()` callback.
- **File:** `context/AuthProvider.tsx` line ~180.

### ✅ FIXED — Duplicate iCloud Sync Files (` 4.tsx`, ` 5.tsx` variants)

- **Fixed:** 2026-02-24
- **Was:** 777+ iCloud conflict-copy files (`edit-team 4.tsx`, etc.) were tracked in git.
- **Fix:** All duplicate files deleted and removal committed. Working tree is clean.

---

### ✅ FIXED — Team Follow API vs Schema Mismatch

- **Fixed:** 2026-02-24
- **Was:** `GET /follows/teams` queried `TeamMembership` and returned a `role` field. `GET /posts?followed_teams=true` correctly used `TeamFollow`. The two read paths were inconsistent.
- **Fix:** `server/src/routes/follows.ts` — swapped `prisma.teamMembership.findMany` for `prisma.teamFollow.findMany`. Response shape is now `{ id, name, description }` (no `role` — `TeamFollow` has none).
- **Files changed:** `server/src/routes/follows.ts` only.

### 🟡 IN PROGRESS — Accessibility Labels

- **Status:** In progress — medium priority; improved 2026-03-18
- **Done:** Tab bar, sign-in, sign-up, Create menu, profile (team chips, avatar viewer, report modal), onboarding (OnboardingLayout back/verify/continue, step-2 affiliation), feed (RSVP, notifications, messages, retry, map, promo, game cards, discover, highlights, close). Reset-password shows correct copy for OAuth/linked accounts using `auth_provider` from `/me`.
- **Remaining:** Additional screens can follow the same pattern (accessibilityRole, accessibilityLabel, accessibilityHint). See `docs/SUBMISSION_READINESS_AUDIT.md` gap #7.

### ℹ️ BY DESIGN — Main Feed Tab Shows Games, Not Social Posts

- **This is intentional product design, not a bug.**
- The "Feed" tab (`app/feed.tsx`) shows upcoming/past games, sponsored ads, and highlights — a sports schedule feed.
- User-created social posts appear in the **Discover** tab (`mobile-community.tsx`), split into "From people you follow" and "Discover".
- New engineers often expect the Feed tab to be a Twitter-style post feed. It is not.

---

## 9. ENVIRONMENT VARIABLES

### Frontend (Expo — prefix `EXPO_PUBLIC_`)

| Variable                                | Used In                                                                       | Purpose                                                                        | Where Set                |
| --------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------ |
| `EXPO_PUBLIC_API_URL`                   | `api/http.ts`                                                                 | Backend API base URL. Production: `https://api-production-8ac3.up.railway.app` | `.env`, `app.json extra` |
| `EXPO_PUBLIC_APP_SCHEME`                | `utils/deepLinks.ts`, `utils/links.ts`                                        | App URL scheme: `varsityhubmobile`                                             | `.env`, `app.json extra` |
| `EXPO_PUBLIC_NODE_ENV`                  | Various                                                                       | Environment name                                                               | `.env`, `app.json extra` |
| `EXPO_PUBLIC_USE_LOCAL_API`             | `api/http.ts`                                                                 | Force localhost API in dev                                                     | `.env` only              |
| `EXPO_PUBLIC_FORCE_REMOTE_API`          | `api/http.ts`                                                                 | Force production API even in dev                                               | `app.json extra`         |
| `EXPO_PUBLIC_SENTRY_DSN`                | `utils/sentry.ts`                                                             | Sentry error tracking DSN                                                      | `.env`, `app.json extra` |
| `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | `utils/sentry.ts`                                                             | Sentry performance sampling                                                    | `.env`                   |
| `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`       | (maps plugin)                                                                 | Google Maps SDK key                                                            | `.env`                   |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`  | `hooks/useGoogleAuth.ts`                                                      | Google OAuth Android client                                                    | `.env`, `app.json extra` |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`      | `hooks/useGoogleAuth.ts`                                                      | Google OAuth iOS client                                                        | `.env`, `app.json extra` |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`      | `hooks/useGoogleAuth.ts`                                                      | Google OAuth web client                                                        | `.env`, `app.json extra` |
| `EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID`     | `hooks/useGoogleAuth.ts`                                                      | Google OAuth Expo client                                                       | `.env`, `app.json extra` |
| `EXPO_PUBLIC_GOOGLE_FORCE_PROXY`        | `hooks/useGoogleAuth.ts`                                                      | Force auth.expo.io proxy                                                       | `app.json extra`         |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`    | Stripe PaymentSheet (subscription-paywall, billing, create-team, ad-calendar) | Stripe publishable key                                                         | `.env`, `app.json extra` |
| `EXPO_PUBLIC_ADMIN_EMAILS`              | `context/AuthProvider.tsx`                                                    | Comma-separated admin emails                                                   | `app.json extra`         |
| `EXPO_PUBLIC_WEB_BASE_URL`              | `utils/links.ts`                                                              | Web base URL for shareable links                                               | `app.json extra`         |
| `EXPO_PUBLIC_EXPO_PROJECT_FULL_NAME`    | `hooks/useGoogleAuth.ts`                                                      | Expo project name for OAuth redirect                                           | `app.json extra`         |

### Server (Node.js — no prefix)

| Variable                                                             | Used In                                                         | Purpose                                                                                         | Where Set                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `DATABASE_URL`                                                       | Prisma                                                          | PostgreSQL connection string. **Required.**                                                     | Railway, `.env`                                     |
| `JWT_SECRET`                                                         | `server/src/lib/jwt.ts`                                         | JWT signing secret. **Required.** Min 32 chars.                                                 | Railway, `.env`                                     |
| `NODE_ENV`                                                           | Throughout                                                      | `development`\|`test`\|`production`                                                             | Railway, `.env`                                     |
| `PORT`                                                               | `server/src/index.ts`                                           | HTTP port (default 4000)                                                                        | Railway, `.env`                                     |
| `HOST`                                                               | `server/src/index.ts`                                           | Bind address (default 0.0.0.0)                                                                  | `.env`                                              |
| `ALLOWED_ORIGINS`                                                    | `server/src/app.ts`                                             | Comma-separated allowed CORS origins                                                            | Railway, `.env`                                     |
| `RATE_LIMIT_DISABLE`                                                 | `server/src/app.ts`, rateLimiters                               | Set to `1` to disable rate limiting                                                             | `.env`                                              |
| `ENABLE_SERVER_DEBUG_LOGS`                                           | Various                                                         | Enable verbose server logs                                                                      | `.env`                                              |
| `UPLOADS_PUBLIC`                                                     | `server/src/app.ts`                                             | Set to `1` to serve uploads without auth                                                        | `.env`                                              |
| `APP_BASE_URL`                                                       | `server/src/lib/email.ts`                                       | App base URL for email links                                                                    | Railway, `.env`                                     |
| `FRONTEND_URL`                                                       | Email links                                                     | Frontend URL                                                                                    | `.env`                                              |
| `APP_SCHEME`                                                         | Email links                                                     | Deep link scheme                                                                                | `.env`                                              |
| `ADMIN_EMAILS`                                                       | `middleware/requireAdmin.ts`                                    | Comma-separated admin email addresses                                                           | Railway, `.env`                                     |
| `TRANSACTION_REPORT_EMAIL`                                           | Finance reports                                                 | Email for transaction reports                                                                   | Railway, `.env`                                     |
| `METRICS_REPORT_EMAIL`                                               | Metrics reports                                                 | Email for metrics reports                                                                       | Railway, `.env`                                     |
| `SENTRY_DSN`                                                         | `server/src/lib/sentry.ts`                                      | Sentry DSN for server errors                                                                    | Railway, `.env`                                     |
| `GOOGLE_OAUTH_CLIENT_IDS`                                            | `server/src/routes/auth.ts`                                     | Comma-separated Google OAuth audience                                                           | Railway, `.env`                                     |
| `GOOGLE_MAPS_API_KEY`                                                | `server/src/routes/geocoding.ts`, `server/src/lib/geocoding.ts` | Google Maps Geocoding API                                                                       | Railway, `.env`                                     |
| `APPLE_KEY_ID`                                                       | `server/src/routes/auth.ts`                                     | Apple Sign In key ID                                                                            | Railway, `.env`                                     |
| `APPLE_TEAM_ID`                                                      | Apple Sign In                                                   | Apple team ID                                                                                   | Railway, `.env`                                     |
| `APPLE_CLIENT_ID`                                                    | Apple Sign In                                                   | Apple service ID                                                                                | Railway, `.env`                                     |
| `APPLE_PRIVATE_KEY`                                                  | Apple Sign In                                                   | Apple private key (PEM)                                                                         | Railway, `.env`                                     |
| `APPLE_BUNDLE_ID`                                                    | Apple Sign In                                                   | App bundle ID                                                                                   | Railway, `.env`                                     |
| `CLOUDINARY_CLOUD_NAME`                                              | `server/src/lib/cloudinary.ts`                                  | Cloudinary cloud name                                                                           | Railway, `.env`                                     |
| `CLOUDINARY_API_KEY`                                                 | `server/src/lib/cloudinary.ts`                                  | Cloudinary API key                                                                              | Railway, `.env`                                     |
| `CLOUDINARY_API_SECRET`                                              | `server/src/lib/cloudinary.ts`                                  | Cloudinary API secret                                                                           | Railway, `.env`                                     |
| `STRIPE_SECRET_KEY`                                                  | `server/src/routes/payments.ts`                                 | Stripe secret key                                                                               | Railway, `.env`                                     |
| `STRIPE_WEBHOOK_SECRET`                                              | `server/src/routes/payments.ts`                                 | Stripe webhook signing secret                                                                   | Railway, `.env`                                     |
| `STRIPE_PRICE_VETERAN`                                               | Payments                                                        | Veteran plan Stripe price ID                                                                    | Railway, `.env`                                     |
| `STRIPE_PRICE_LEGEND`                                                | Payments                                                        | Legend plan Stripe price ID                                                                     | Railway, `.env`                                     |
| `STRIPE_PRICE_AD_WEEKDAY`                                            | Payments                                                        | Ad weekday price ID                                                                             | Railway, `.env`                                     |
| `STRIPE_PRICE_AD_WEEKEND`                                            | Payments                                                        | Ad weekend price ID                                                                             | Railway, `.env`                                     |
| `APPLE_IAP_SHARED_SECRET`                                            | `server/src/routes/payments.ts`                                 | iOS in-app purchase receipt verification (App Store Connect → App → App-Specific Shared Secret) | Railway, `.env` (optional; server warns if missing) |
| `EMAIL_PROVIDER`                                                     | `server/src/lib/email.ts`                                       | Email provider: `sendgrid`                                                                      | Railway, `.env`                                     |
| `EMAIL_FROM`                                                         | Email                                                           | From address for emails                                                                         | Railway, `.env`                                     |
| `CUSTOMER_SERVICE_EMAIL`                                             | Email templates                                                 | Support email address                                                                           | Railway, `.env`                                     |
| `SENDGRID_API_KEY`                                                   | `server/src/lib/email.ts`                                       | SendGrid API key                                                                                | Railway, `.env`                                     |
| `SENDGRID_*_TEMPLATE_ID`                                             | `server/src/lib/email.ts`                                       | ~30 SendGrid dynamic template IDs                                                               | Railway, `.env`                                     |
| `REDIS_URL`                                                          | `server/src/middleware/rateLimiters.ts`, BullMQ queues          | Redis connection URL                                                                            | Railway, `.env`                                     |
| `TWILIO_ACCOUNT_SID`                                                 | SMS (optional)                                                  | Twilio account SID                                                                              | Railway, `.env`                                     |
| `TWILIO_AUTH_TOKEN`                                                  | SMS (optional)                                                  | Twilio auth token                                                                               | Railway, `.env`                                     |
| `TWILIO_VERIFY_SERVICE_SID`                                          | SMS (optional)                                                  | Twilio verify service                                                                           | Railway, `.env`                                     |
| `EXPO_PUBLIC_API_URL`                                                | `server/src/lib/env.ts`                                         | API URL (used by server for self-reference)                                                     | Railway, `.env`                                     |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3 uploads (optional)                                           | S3 credentials if using S3 instead of Cloudinary                                                | `.env`                                              |
| `SEED_PASSWORD`                                                      | Tests/seeding                                                   | Password for seeded users                                                                       | `.env`                                              |
| `TEST_PASSWORD`                                                      | Tests                                                           | Test user password                                                                              | `.env`                                              |
| `SKIP_SERVER_DB_TESTS`                                               | Tests                                                           | Skip DB-dependent tests                                                                         | `.env`                                              |

---

_End of Codebase Map. This document was generated by reading every key file listed in the specification._
