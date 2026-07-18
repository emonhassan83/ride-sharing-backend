# Authentication and JWT Session Management

This document details how user identity, session management, and authorization permissions are handled in the Split Ride system.

## 1. Authentication Flow
The system supports three main ways to register and authenticate:
1. **Credentials Registration / Login**: Users register with `name`, `email`, `phone`, `password`, and a specified `role` (e.g. `user`/rider or `provider`/driver).
2. **Phone & OTP Login**: Users enter phone numbers to request OTPs via Twilio SMS (or mock logs in development), verify OTP, and receive session tokens.
3. **Social Sign-In**: Registration or login using Google and Apple ID OAuth tokens.

---

## 2. JWT Session Management

### Access Token
- **Secret**: `JWT_ACCESS_SECRET`
- **Expiration**: Standard 30 days or short duration, configurable via `config.jwt.accessExpiration`.
- **Contents**: Encodes user ID, email, and user role. Used to access protected API endpoints.

### Refresh Token
- **Secret**: `JWT_REFRESH_SECRET`
- **Expiration**: Configurable via `config.jwt.refreshExpiration`.
- **Purpose**: Sent to `/api/v1/auth/refresh-auth` to retrieve a new Access Token.

---

## 3. OTP & Redis Verification
For email sign-up and phone login:
- OTP is generated dynamically using `generateOtp()`.
- The hashed OTP is stored in Redis via `OtpRedisService.saveOtp` with a 5-minute expiration time.
- Verification checks the user's input against the hashed Redis value.
- Upon successful verification, the user's status is changed (e.g., `isSignUpOtpVerified = true` or `isLoginOTPVerified = true`).

---

## 4. Role-Based Access Control (RBAC)
Endpoints are restricted using the `auth(...)` middleware:
- **`auth('user')`**: Limits access to Riders.
- **`auth('provider')`**: Limits access to Drivers.
- **`auth('admin')`**: Limits access to Administrators.
- **`auth('common')`**: Allows any authenticated user.

Example:
```typescript
router.get('/profile', auth('common'), UserController.getProfile);
```
