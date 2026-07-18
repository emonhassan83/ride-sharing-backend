# AI System Prompt for Code Modifications

You are an expert AI agent assisting in the development of the Split Ride monorepo-backend project. When modifications are requested, you must follow these rules strictly to maintain architectural integrity, code style consistency, and type safety.

---

## 1. Architectural Integrity

### Layered Separation
Ensure clear boundaries between architectural layers:
- **Routes (`*.routes.ts`)**: Keep routes thin. Only plug in validation middlewares and controller calls.
- **Controllers (`*.controller.ts`)**: Extract requests, call service functions, and return response data using the `sendResponse` utility. Do not write business logic or direct mongoose database calls inside controllers. Wrap functions in `catchAsync`.
- **Services (`*.service.ts`)**: Place all business calculations, validation logic, and Mongoose database operations here.
- **Models (`*.model.ts`)**: Define schema fields, indexes, Mongoose validation options, and virtual properties.

---

## 2. Coding and Type Standards

### TypeScript
- Ensure code compiles cleanly with TypeScript in strict mode. Run `npx tsc --noEmit` to verify.
- Explicitly declare types for parameters and return values. Avoid using `any` unless required.
- Do not modify existing type definitions without analyzing downstream impacts.

### Naming & Style
- Follow existing casing rules (camelCase for files, PascalCase for classes/interfaces, UPPER_SNAKE_CASE for constants).
- Run linting and formatting fixes after every change:
  ```bash
  npm run lint:fix
  npm run prettier:fix
  ```

---

## 3. API Guidelines

### Input Validation
- All request parameters (body, query, params) must be validated using Zod schemas before hitting controllers.
- Use `.strict()` on body validation schemas for resource creation (e.g. sign-up, ride booking) to prevent clients from passing undocumented parameters.

### Errors and Exceptions
- Use `ApiError` with appropriate HTTP status codes from `http-status-codes` to represent operational errors.
- Never bubble raw or unformatted Mongoose errors to the client.

---

## 4. Session memory updates
At the end of every significant task or when asked to update summary, append a concise bulleted list mapping date, completed tasks, key changes, and next steps to the top of `.agent/SUMMARY.md`.

---

## Fixes on 2026-07-05

### Ride Cancellation and Refund Logic

- **File Modified:** `server/src/app/utils/splitFare.utils.ts`
- **Issue:** The `calculateCancellationRefund` function in `rideCancelAfterAccept.handler.ts` was not correctly handling refunds, especially when a rider cancels a ride. This could lead to no refund being issued even when one was due.
- **Fix Details:**
    - Updated `calculateCancellationRefund` to be more robust.
    - Added a check to ensure no refund is given if the ride is cancelled *after* the departure time.
    - Added a check to handle cases where the initial paid amount is zero.
    - The new logic correctly calculates full refunds, 50% penalty refunds, or no refund based on when the cancellation occurs relative to the booking and departure times.
- **Related Files Checked:**
    - `server/src/app/job/noDriverFound.job.ts`: No changes were needed. The refund logic for system-cancelled rides (due to no driver) was already correct.
    - `server/src/app/socket/handlers/ride/driverCancelRide.handler.ts`: No changes were needed. The refund logic for driver-cancelled rides was already correct.
- **Outcome:** The refund system is now more reliable, especially for cancellations initiated by the rider. The user's wallet will be correctly credited with the refund amount as per the cancellation policy.
