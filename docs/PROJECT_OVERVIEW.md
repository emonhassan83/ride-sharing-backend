# Split Ride Backend Project Overview

## Welcome to Split Ride

As a new developer on the Split Ride backend project, this document will help you understand the project structure, key technologies, and how to get started quickly.

## Project Overview

Split Ride is a **ride-sharing backend system** built with Node.js, Express, TypeScript, and MongoDB. It manages ride operations, user accounts, driver management, payments, real-time communication, and more. The platform connects riders with drivers, handles ride requests, payments, and provides a comprehensive dashboard for administration.

## Tech Stack

### Core Technologies

- **TypeScript** - Type-safe development
- **Node.js** - Server-side runtime
- **Express** - Web application framework
- **MongoDB** - NoSQL database with Mongoose ODM
- **Socket.io** - Real-time communication (chat, ride updates)
- **Stripe** - Payment processing
- **Bull** - Job queue system
- **Winston** - Logging framework
- **Multer** - File upload handling
- **i18next** - Multi-language support
- **Zod** - Data validation
- **Firebase Admin** - Push notifications

## Project Structure

```bash
src/
 app/
    ├── app.ts                    # Express app configuration
    ├── server.ts                 # Server startup and socket.io setup
    ├── config/                   # Configuration management
    ├── common/                   # Common utilities and plugins
    ├── helpers/                  # Helper functions (email, cron, socket, etc.)
    ├── middlewares/              # Express middlewares (auth, error handling)
    ├── errors/                   # Error handling utilities
    ├── shared/                   # Shared utilities (catchAsync, logger, etc.)
    ├── modules/                  # Application modules (each with own business logic)
    │   ├── auth/                 # Authentication and authorization
    │   ├── user/                 # User management (riders)
    │   ├── provider/             # Provider/driver management
    │   ├── jobs/                 # Ride/job management
    │   ├── payment/              # Payment processing
    │   ├── messages/             # Chat system
    │   ├── notification/         # Notifications (push, in-app)
    │   ├── balance/              # Balance and withdrawal management
    │   ├── promo/                # Promotions and discounts
    │   ├── report/               # Reports and analytics
    │   ├── vehicle/              # Vehicles management
    │   ├── review/               # Ratings and reviews
    │   ├── dashboard/            # Admin dashboard
    │   ├── settings/             # Application settings
    │   └── upload/               # File upload management
    ├── routes/                   # API route definitions
    ├── types/                    # TypeScript type definitions
    └── i18n/                     # Multi-language translations
```

## Key Features

### User Management

- Rider and driver registration/login
- User profiles and settings
- Email and OTP verification
- Password reset functionality
- Role-based access control

### Ride Management

- Create ride requests
- Accept, reject, and cancel rides
- Track ride status and location
- Split rides feature (shared rides)
- Private ride options
- Luggage tracking
- Ride history

### Payment System

- Stripe integration for payments
- Wallet balance management
- Withdrawal requests and processing
- Transaction history
- Webhook handling for payment events

### Communication

- Real-time chat between riders and drivers
- Push notifications for ride updates
- Email notifications
- FCM (Firebase Cloud Messaging) for push notifications

### Administration

- Admin dashboard with analytics
- User and driver management
- Ride monitoring and reporting
- Promotional code management
- System settings configuration

## Development Setup

### Prerequisites

1. Node.js (v16 or higher)
2. npm or yarn
3. MongoDB (local or cloud instance)
4. Stripe account for payment testing

### Installation

1. **Clone the repository**
2. **Install dependencies**: `npm install`
3. **Create .env file** (copy from .env.example)
4. **Start development server**: `npm run dev`
5. **Run database seeder** (if needed): `npm run seeder`

### Environment Variables

Key configuration variables:

- `PORT` - Server port (default: 8083)
- `MONGODB_URL` - MongoDB connection string
- `JWT_ACCESS_SECRET` - JWT access token secret
- `JWT_REFRESH_SECRET` - JWT refresh token secret
- `STRIPE_SECRET_KEY` - Stripe API key
- `FIREBASE_ADMIN_CONFIG` - Firebase Admin SDK configuration
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` - Redis configuration

## API Architecture

### API Versioning

All APIs are prefixed with `/api/v1/`

### Key Endpoints

#### Authentication

- `POST /api/v1/auth/register` - User registration
- `POST /api/v1/auth/login` - User login
- `POST /api/v1/auth/verify-email` - Email verification
- `POST /api/v1/auth/reset-password` - Password reset

#### Users

- `GET /api/v1/user/profile` - Get user profile
- `PUT /api/v1/user/profile` - Update user profile
- `GET /api/v1/user/settings` - Get user settings

#### Rides

- `POST /api/v1/job` - Create ride request
- `GET /api/v1/job` - Get all rides (with filters)
- `GET /api/v1/job/:id` - Get ride details
- `PUT /api/v1/job/:id` - Update ride status
- `DELETE /api/v1/job/:id` - Cancel ride

#### Payments

- `POST /api/v1/payment/initiate` - Initiate payment
- `POST /api/v1/payment/withdraw` - Request withdrawal
- `GET /api/v1/balance` - Get user balance

#### Chat

- `GET /api/v1/message/threads` - Get message threads
- `GET /api/v1/message/thread/:id` - Get thread messages
- `POST /api/v1/message/send` - Send message

## Key Concepts for New Developers

### Authentication and Authorization

- JWT tokens for authentication
- Role-based access control (user, provider, admin)
- Token refresh mechanism
- Password hashing with bcrypt

### Error Handling

- Global error handler middleware
- Custom error types (ApiError)
- Validation error handling (Zod)
- Duplicate key error handling

### Database Operations

- Mongoose ODM for MongoDB
- Query helpers and plugins
- Indexing for performance
- Transaction support

### Real-time Communication

- Socket.io for bidirectional communication
- Namespace and room management
- Event emission for ride updates and chat

### Background Jobs

- Bull queue system for async tasks
- Cron jobs for scheduled tasks
- Job processing and monitoring

## Development Workflow

### Code Style Guidelines

- TypeScript strict type checking
- ESLint for linting
- Prettier for code formatting
- Husky for git hooks

### Testing

- Test scripts configured in package.json
- Unit and integration testing recommended

### Deployment

- Docker containerization
- Docker Compose for development
- Production deployment guidelines in README

## Getting Help

- Check README.md for detailed documentation
- Review existing issues for common problems
- Ask team members for assistance with complex features
- Use Postman collection for API testing

## Next Steps

1. Set up your development environment
2. Review the README.md for detailed instructions
3. Explore the Postman collection to understand API endpoints
4. Familiarize yourself with existing modules and their interfaces
5. Start with small tasks to understand the codebase structure
