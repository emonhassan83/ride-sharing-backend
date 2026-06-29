Date/Session: 2026-06-29

Completed Tasks:
- Updated outdated server and worker dependencies to their latest versions (including `bullmq`, `convert-csv-to-json`, `eslint`, `i18next`, `mongoose` in server; and `prisma`, `firebase-admin`, `bullmq`, `eslint`, `typescript`, `uuid`, etc. in worker).
- Added typescript compiler override options (`ignoreDeprecations: "6.0"`) and resolved firebase-admin v14 messaging import breaking changes in worker to ensure clean compiles post-upgrade.
- Checked and verified that typescript compilation is clean on both server and worker.

Key Changes:
- Modified [package.json](file:///c:/bdcalling/explore/ride-sharing-backend/server/package.json) dependencies.
- Modified [package.json](file:///c:/bdcalling/explore/ride-sharing-backend/worker/package.json) dependencies.
- Modified [tsconfig.json](file:///c:/bdcalling/explore/ride-sharing-backend/worker/tsconfig.json) options.
- Modified [push-notification.service.ts](file:///c:/bdcalling/explore/ride-sharing-backend/worker/src/app/utils/push-notification.service.ts) to use modular imports.
- Modified [notification.workers.ts](file:///c:/bdcalling/explore/ride-sharing-backend/worker/src/app/workers/notification.workers.ts) to remove unused variables.

Pending/Next Steps:
- None.

---

Date/Session: 2026-06-29

Completed Tasks:
- Updated `PROJECT_OVERVIEW.md` to provide a complete overview of the project, adding detailed information about project goals, monorepo components (REST routes, Socket.io communication in server, BullMQ offloading in worker), recent enhancements (FCM tokens, driver ride queries), and links to new documentation files.

Key Changes:
- Modified [PROJECT_OVERVIEW.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/PROJECT_OVERVIEW.md) content.

Pending/Next Steps:
- None.

---

Date/Session: 2026-06-29

Completed Tasks:
- Generated comprehensive system architecture, API guidelines, coding rules, deployment infrastructure, and AI system prompt documentation.

Key Changes:
- Created files inside the `docs/` directory: [ARCHITECTURE.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/ARCHITECTURE.md), [API_GUIDELINES.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/API_GUIDELINES.md), [AUTHENTICATION.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/AUTHENTICATION.md), [CODING_RULES.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/CODING_RULES.md), [DATABASE_SEEDING.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/DATABASE_SEEDING.md), [DEPLOYMENT.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/DEPLOYMENT.md), [FOLDER_STRUCTURE.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/FOLDER_STRUCTURE.md), [TESTING_WORKFLOW.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/TESTING_WORKFLOW.md), and [AI_SYSTEM_PROMPT.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/AI_SYSTEM_PROMPT.md).

Pending/Next Steps:
- None.

---

Date/Session: 2026-06-29

Completed Tasks:
- Filtered driver rides returned by `getDriverRides` based on active passenger count and passenger payment status.
- Added FCM token support during user registration (sign-up) and login validations.

Key Changes:
- Modified `getDriverRides` in [ride.service.ts](file:///c:/bdcalling/explore/ride-sharing-backend/server/src/app/modules/ride/ride.service.ts) to filter rides using active passenger count and paid statuses.
- Added `fcmToken: z.string().optional()` to `createUserValidationSchema` in [user.validation.ts](file:///c:/bdcalling/explore/ride-sharing-backend/server/src/app/modules/user/user.validation.ts).
- Added `fcmToken: z.string().optional()` to `loginValidationSchema` and `loginWithPhoneValidationSchema` in [auth.validations.ts](file:///c:/bdcalling/explore/ride-sharing-backend/server/src/app/modules/auth/auth.validations.ts).
- Updated `createUser` in [auth.service.ts](file:///c:/bdcalling/explore/ride-sharing-backend/server/src/app/modules/auth/auth.service.ts) to destructure and save `fcmToken`.

Pending/Next Steps:
- None.
