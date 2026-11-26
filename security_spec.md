# Firestore Security Specification (Phase 0 — Payload-First Security TDD)

## 1. Data Invariants
1. **Strict Ownership & PII Isolation**: `/users/{userId}/private/profile` contains PII (`email`, `displayName`) and is readable/writable ONLY by the authenticated, email-verified user whose `request.auth.uid == userId` and `data.uid == request.auth.uid`. Blanket `isSignedIn()` reads and `list` operations on private profiles are strictly denied.
2. **Verified Identity for All Writes**: Every create, update, and delete requires `request.auth != null && request.auth.token.email_verified == true`.
3. **Path Variable Hardening**: Every single-document path variable (`userId`, `docId`, `bookmarkId`) must satisfy `isValidId()` (`^[a-zA-Z0-9_\-]+$`, max 128 chars). For `/users/{userId}/private/{docId}`, `docId` must equal `'profile'`.
4. **Strict Schema & No Shadow Fields**: Every create enforces exact `hasAll` + `hasOnly` key allowlists and per-field `.size()` limits verbatim from `firebase-blueprint.json`. Every update begins with `isValid[Entity](incoming())` and uses `incoming().diff(existing()).affectedKeys().hasOnly(...)` inside explicit action branches.
5. **Immutable & Server-Validated Timestamps**: `uid` and `createdAt` are immutable after creation. `createdAt == request.time` on create; `updatedAt == request.time` on create and update.
6. **Terminal State Locking**: Once a `StudyBookmark` has `status == 'archived'`, no subsequent updates are allowed.
7. **Secure List Queries**: `allow list` on `/users/{userId}/studyBookmarks` explicitly validates `isOwner(userId) && existing().uid == request.auth.uid` with zero `get()`/`exists()` lookups inside `list`.

## 2. The "Dirty Dozen" Adversarial Payloads (All Must Return PERMISSION_DENIED)

| # | Attack Category | Target Path | Malicious Payload / Context | Violated Law |
|---|---|---|---|---|
| 1 | Unauthenticated Read | `/users/u1/private/profile` | `auth: null`, `GET` | Auth Gate |
| 2 | Cross-User PII Read | `/users/u1/private/profile` | `auth: u2 (verified)`, `GET` | PII Isolation |
| 3 | Unverified Email Write | `/users/u1/private/profile` | `auth: u1 (email_verified: false)`, valid create payload | Verified Users |
| 4 | Identity Spoofing | `/users/u1/private/profile` | `auth: u1`, `{ "uid": "u2", ... }` | Identity Integrity |
| 5 | Shadow / Ghost Field Injection | `/users/u1/private/profile` | `auth: u1`, valid fields + `{ "isAdmin": true }` | Strict Keys (`hasOnly`) |
| 6 | Client Timestamp Forgery | `/users/u1/private/profile` | `auth: u1`, `createdAt: "2020-01-01T00:00:00Z"` | Temporal Integrity (`request.time`) |
| 7 | Path ID Poisoning | `/users/u1/studyBookmarks/bad$id..` | `auth: u1`, invalid `bookmarkId` characters or >128 chars | Path Hardening (`isValidId`) |
| 8 | Oversized String / DoW | `/users/u1/studyBookmarks/bm1` | `auth: u1`, `note: "A".repeat(1001)` | Boundary Limits (`size() <= 1000`) |
| 9 | Immutable Field Tampering | `/users/u1/studyBookmarks/bm1` | `auth: u1`, update changing `uid` or `createdAt` | Immortal Field Rule |
| 10 | Value Poisoning on Allowed Update Key | `/users/u1/studyBookmarks/bm1` | `auth: u1`, update setting `note: 12345` (non-string) | Anti-Update-Gap (`isValidStudyBookmark`) |
| 11 | Terminal State Bypass | `/users/u1/studyBookmarks/bm1` | `auth: u1`, update `note` when `existing.status == 'archived'` | Terminal State Locking |
| 12 | Unauthorized Cross-User List Scrape | `/users/u1/studyBookmarks` | `auth: u2 (verified)`, `LIST` query | Secure List Queries |
