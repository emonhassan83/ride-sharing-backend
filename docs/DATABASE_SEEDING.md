# Database Schema and Seeding

This document outlines the core database models, schema design rules, and data seeding protocols.

## 1. Database Schema Guidelines

We use **MongoDB** with **Mongoose ODM**. Follow these rules when designing or modifying schemas:
- **Indexes**: Explicitly create indexes for frequently queried fields (e.g. `driverId` and `status` in `Ride`).
- **Timestamps**: Always pass `{ timestamps: true }` to the schema options.
- **Strict Typing**: Map schema interfaces to TypeScript interfaces (`TRide`, `TPassenger`, etc.).
- **Unverified Document TTL**: Users or temporary docs can employ TTL indexes (e.g., `expireAt`) to auto-delete unverified records.

---

## 2. Main Models
- **User**: Manages Riders, Drivers, and Admins. Contains configuration options, registration types, statuses, wallets, and profile documents.
- **Ride**: Represents a ride offering. Features locations, total seats, booked seats, and status details.
- **Passenger**: Connects a User/Rider to a Ride. Stores user locations, distance, pricing charges, and payment statuses.
- **Booking**: Represents a payment invoice/transaction record for a Passenger.
- **Vehicle**: Contains details of vehicles registered by providers (drivers).

---

## 3. Data Seeding

### Seeding Script
The seeder connects to MongoDB and initializes required system data:
1. **Admin User**: Creates a default system administrator user if none exists.
2. **System Settings**: Calls `settingSeeder` to seed global application metadata settings.

### How to Run Seeder
Run the database seeder script using:
```bash
npm run seeder
```

In `package.json`, this maps to:
```json
"seeder": "ts-node src/app/seeder/seed.ts"
```
Ensure your `.env` contains valid values for `MONGODB_URL` and `ADMIN_PASS` prior to running the seed script.
