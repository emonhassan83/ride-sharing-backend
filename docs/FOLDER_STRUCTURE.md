# Project Folder Structure and Module Design

This document details the layout of the Split Ride monorepo codebase and maps where each resource is stored.

## 1. Monorepo Root Layout

- **`docs/`**: Documentation files, architecture plans, and diagrams.
- **`server/`**: The main Node.js Express REST API server codebase.
- **`worker/`**: Background service processor handling BullMQ queues.
- **`docker-compose.yml`**: Orchestration profile for Redis, server, and worker.

---

## 2. Server Module Layout

The application utilizes a modular design inside `server/src/app/modules/`. Each feature domain (e.g. `ride`, `auth`, `user`) contains its own logic:

```bash
server/src/app/modules/ride/
  ├── ride.constant.ts       # Enum lists, constants, and custom typescript types
  ├── ride.interface.ts      # TypeScript interfaces defining document schemas
  ├── ride.model.ts          # Mongoose Schema and model creation
  ├── ride.routes.ts         # Express routers and authentication rules
  ├── ride.controller.ts     # Request parsing and standard response emission
  ├── ride.service.ts        # Database operations and core business logic
  ├── ride.validation.ts     # Zod schema definitions for body parameters
  └── ride.utils.ts          # Module helper functions (distance calculations, formats)
```

---

## 3. General Server Layout
Inside `server/src/app/`:
- **`config/`**: Dynamic environmental variables loaders (`env.config.ts`).
- **`middlewares/`**: Global express middlewares (`globalErrorHandler.ts`, `auth.ts`, `validateRequest.ts`).
- **`errors/`**: Error definitions and `ApiError` class.
- **`utils/`**: General helper files (`catchAsync.ts`, `sendResponse.ts`, `generateOtp.ts`).
- **`builder/`**: Helper builders like `QueryBuilder.ts`.
- **`routes/`**: Aggregator of module routes (`index.ts`).
