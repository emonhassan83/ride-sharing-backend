# Split Ride Backend Project Overview

Welcome to the Split Ride backend documentation portal. This document provides a high-level overview of the system goals, technology stack, and architectural design patterns.

---

## 1. Project Overview
Split Ride is a scalable **ride-sharing platform** built using a monorepo structure. The core system matches passengers (riders) with providers (drivers), handles distance calculations and split-fare surcharges across multiple riders, processes secure credit card transactions via Stripe, and pushes push notifications using Firebase (FCM).

The repository is structured as a monorepo consisting of:
- **`server/`**: An Express and TypeScript REST API server.
  - **REST Endpoints**: Handles authentication, user profile management, wallet transactions, ride requests, bookings, and dashboard analytics.
  - **Socket.io Servers**: Manages real-time bidirection communication namespaces and rooms. Handles live driver location updates, socket events for ride accepts/rejects, and real-time chat messages between riders and drivers.
- **`worker/`**: A background job processor built with BullMQ and Redis.
  - **Asynchronous Queues**: Processes deferred operations like sending OTP verification emails, executing cron schedules for cleaning expired rides, sending batch push notifications, and processing asynchronous webhook events.
  - **Task Offloading**: Decouples resource-heavy computational work from the main Express event loop, keeping response times minimal.

---

## 2. Technology Stack

### Core Technologies
- **Runtime**: Node.js & TypeScript
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Real-Time Communication**: Socket.io (for chat and live ride updates)
- **Job Processing**: BullMQ (using Redis as the backend queue)
- **Payment Processor**: Stripe API
- **Push Notifications**: Firebase Cloud Messaging (FCM)
- **Validations**: Zod

---

## 3. Core Features & Business Logic

### User Roles & Authentication
- Supports three roles: `user` (Riders), `provider` (Drivers), and `admin`.
- Authenticates using JWT tokens (Access and Refresh token flow).
- Custom FCM token updates are supported during sign-up, login (email and phone), Google, and Apple social logins to ensure push notifications reach users.

### Ride Management & Rules
- Supports private and split-fare ride configurations.
- **Driver Ride Requests**: The driver rides search endpoint (`getDriverRides`) filters active rides according to passenger conditions:
  - Rides with **more than 1 active passenger** (split ride) are visible.
  - Rides with **exactly 1 active passenger** are visible only if that passenger's payment status is `'paid'`.
  - Rides with **0 active passengers** are hidden.

---

## 4. Key Documentation Index

For detailed guidelines on specific areas of the system, refer to the following documentation files:

* **Architecture and Layered Flows**: [ARCHITECTURE.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/ARCHITECTURE.md)
* **API Versioning & Error Formats**: [API_GUIDELINES.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/API_GUIDELINES.md)
* **Authentication & JWT Details**: [AUTHENTICATION.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/AUTHENTICATION.md)
* **TypeScript & Coding Guidelines**: [CODING_RULES.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/CODING_RULES.md)
* **Schema Design & Database Seeds**: [DATABASE_SEEDING.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/DATABASE_SEEDING.md)
* **Docker Infrastructure & Compose**: [DEPLOYMENT.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/DEPLOYMENT.md)
* **Monorepo Directory Layout**: [FOLDER_STRUCTURE.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/FOLDER_STRUCTURE.md)
* **Test Suites & Linting Processes**: [TESTING_WORKFLOW.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/TESTING_WORKFLOW.md)
* **AI Agent Instruction Rules**: [AI_SYSTEM_PROMPT.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/AI_SYSTEM_PROMPT.md)
