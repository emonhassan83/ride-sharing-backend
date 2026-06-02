# Split Ride Backend

Split Ride is a comprehensive backend system for managing auto service operations, built with Node.js, Express, TypeScript, and MongoDB. It supports user and mechanic management, job assignments, payments, notifications, chat, file uploads, and more. This project is designed for auto service platforms, garages, or marketplaces connecting customers with mechanics and service providers.

## Features

- **User & Mechanic Management**: Registration, authentication, profiles, and role-based access for customers and mechanics.
- **Job Management**: Create, assign, and track service jobs, including job processes and history.
- **Payment Integration**: Secure payments and webhooks via Stripe, with balance and withdrawal management.
- **Chat & Messaging**: Real-time messaging between users and mechanics.
- **Notifications**: In-app and push notifications for job updates, payments, and more.
- **File Uploads**: Upload and manage images, documents, and videos (e.g., car photos, reports).
- **Car Models & Services**: Manage car models, available services, and tools.
- **Dashboard & Analytics**: Admin dashboard for monitoring platform activity.
- **Localization**: Multi-language support using i18next.
- **Security**: JWT authentication, rate limiting, helmet, xss-clean, and bcrypt password hashing.
- **Logging**: Winston-based logging with daily rotation.
- **Background Jobs**: Bull for task queues and cron jobs.
- **Email & OTP**: Email notifications and OTP verification for sensitive actions.

## Tech Stack

- **TypeScript**, **Node.js**, **Express**
- **MongoDB** (via Mongoose)
- **Socket.io** (real-time chat)
- **Stripe** (payments)
- **Bullmq** (job queues)
- **Winston** (logging)
- **Multer** (file uploads)
- **i18next** (localization)
- **Zod** (validation)
- **Firebase Admin** (push notifications)
- **dotenv**, **helmet**, **xss-clean**, **bcrypt**, **jsonwebtoken**

## Main Modules

- User, Mechanic, Customer, OTP, Token
- Jobs, Job Processes, Services, Car Models, Tools
- Payment, Balance, Withdraw, Transaction
- Chat/Messages, Notification, FCM Token
- File Uploads
- Dashboard & Analytics

## Getting Started

### Prerequisites

Ensure you have the following installed:

- **Node.js**
- **npm** or **yarn**
- **MongoDB**

### Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/sparktechagency/ride-sharing-backend-v2.git
   cd ride-sharing-backend-v2

   ```

2. **Install dependencies:**

   Using npm:

   ```bash
   npm install
   ```

   Using yarn:

   ```bash
   yarn install
   ```

3. **Create a `.env` file:**

In the root directory of the project, create a `.env` file and add the following variables. Adjust the values according to your setup.

```env
# Application Environment
NODE_ENV=development
PORT=8080
SOCKET=8080

# Database Configuration
MONGODB_URL=your_mongodb_url

# JWT Configuration
JWT_ACCESS_SECRET=YOUR_ACCESS_SECRET
JWT_REFRESH_SECRET=YOUR_REFRESH_SECRET
JWT_ACCESS_EXPIRATION_TIME=5d
JWT_REFRESH_EXPIRATION_TIME=365d

# Verify Email and Token
TOKEN_SECRET=YOUR_TOKEN_SECRET
VERIFY_EMAIL_TOKEN_EXPIRATION_TIME=10m
RESET_PASSWORD_TOKEN_EXPIRATION_TIME=5m

# Authentication Settings
MAX_LOGIN_ATTEMPTS=5
LOCK_TIME=1
JOB_PROCESS_STATUS_DELAY=30

# OTP Configuration
VERIFY_EMAIL_OTP_EXPIRATION_TIME=10
RESET_PASSWORD_OTP_EXPIRATION_TIME=5
MAX_OTP_ATTEMPTS=5
ATTEMPT_WINDOW_MINUTES=3

# Bcrypt Configuration
BCRYPT_SALT_ROUNDS=12

# SMTP Email Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=YOUR_SMTP_EMAIL
SMTP_PASSWORD=YOUR_SMTP_PASSWORD
EMAIL_FROM=YOUR_SMTP_EMAIL

# Client URL
CLIENT_URL=http://localhost:3000

# Backend IP
BACKEND_IP=example

# Stripe Configuration
STRIPE_SECRET_KEY=YOUR_STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET=YOUR_STRIPE_WEBHOOK_SECRET

# Test twilio credentials
TWILIO_ACCOUNT_SID=YOUR_TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN=YOUR_TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER=YOUR_TWILIO_PHONE_NUMBER

# Firebase Configuration
FIREBASE_TYPE=
FIREBASE_PROJECT_ID=
FIREBASE_PRIVATE_KEY_ID=
FIREBASE_PRIVATE_KEY=
FIREBASE_CLIENT_EMAIL=
FIREBASE_CLIENT_ID=
FIREBASE_CLIENT_CERT_URL=

# Redis Configuration
REDIS_HOST=
REDIS_PORT=
REDIS_PASSWORD=
REDIS_URL=
```

4. **Run the project:**

Using npm:

```bash
npm run dev
```

Using yarn:

```bash
yarn run dev
```

### Running the Tests

Explain how to run the automated tests for this system.

```bash
npm test
```