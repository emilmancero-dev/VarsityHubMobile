# Smoke Checklist (App + API)

Use this list to validate real-world functionality after deploy.

## Mobile App (Manual)

1. Auth
   - Sign up with email/password
   - Verify email code
   - Log in, log out, log back in
2. Onboarding
   - Complete onboarding steps and confirm /me reflects updates
3. Feed + Posts
   - Load feed
   - Create post with image/video
   - Like, comment, bookmark
4. Teams + Orgs
   - Create team and org
   - Invite member and accept invite
   - Update member role
5. Events
   - Create event
   - RSVP and verify attendee count
6. Ads
   - Create ad, reserve dates
   - Confirm ad appears in feed when active
7. Notifications
   - In-app notifications list loads
   - Mark single and all as read
8. Uploads
   - Upload profile avatar
   - Upload team logo
9. Payments
   - Start checkout
   - Verify subscription summary

## API (Quick Contract Spot-Checks)

Run against the deployed API base URL.

- Health
  - GET /health

- Auth
  - POST /auth/register
  - POST /auth/login
  - GET /me
  - PATCH /me
  - PATCH /me/preferences
  - POST /me/complete-onboarding

- Users
  - GET /users/username-available?username=...
  - GET /users/lookup?email=...
  - GET /users/:id
  - POST /users/:id/follow
  - DELETE /users/:id/follow

- Posts
  - GET /posts?sort=trending
  - GET /posts/trending
  - POST /posts
  - POST /posts/collage — disabled; expect 501 for an authorized caller, not a created post
  - POST /posts/:id/comments

- Events
  - GET /events
  - POST /events
  - GET /events/:id/rsvp
  - POST /events/:id/rsvp

- Teams
  - GET /teams
  - GET /teams/managed
  - GET /teams/limits
  - POST /teams
  - POST /teams/create
  - POST /teams/:id/invite
  - GET /teams/invites/me
  - POST /teams/invites/:inviteId/accept

- Team Memberships
  - POST /team-memberships
  - PATCH /team-memberships/:id
  - DELETE /team-memberships/:id

- Organizations
  - GET /organizations
  - POST /organizations
  - POST /organizations/:id/invite
  - GET /organizations/invites/me
  - POST /organizations/invites/:inviteId/accept
  - POST /organizations/join-requests

- Notifications
  - GET /notifications
  - POST /notifications/:id/read
  - POST /notifications/mark-read-all

- Uploads
  - POST /uploads
  - POST /uploads/files

- Ads
  - GET /ads/for-feed
  - POST /ads
  - POST /ads/reservations

- Payments
  - POST /payments/checkout
  - POST /payments/finalize-session
  - POST /payments/subscription/cancel
  - POST /payments/update-subscription-quantity
  - GET /payments/subscription/summary

- Geocoding
  - POST /geocoding/location
  - GET /geocoding/autocomplete
