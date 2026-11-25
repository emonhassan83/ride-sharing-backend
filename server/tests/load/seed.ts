import 'dotenv/config'; // reads ./.env of the cwd (tests/load/runtime)
/* Load-test seeder. Run from tests/load/runtime (cwd decides which .env is read):
 *   cd tests/load/runtime && node ../../../node_modules/ts-node/dist/bin.js --transpile-only -P ../../../tsconfig.json ../seed.ts
 * Safe-guard: refuses to run unless MONGODB_URL is a local 127.0.0.1 / localhost URL.
 */
import mongoose, { Types } from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';

const url = process.env.MONGODB_URL || '';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('REFUSING to seed: MONGODB_URL is not local:', url.replace(/\/\/[^@]*@/, '//***@'));
  process.exit(2);
}

const RIDERS = Number(process.env.SEED_RIDERS || 2000);
const DRIVERS = Number(process.env.SEED_DRIVERS || 400);
const HISTORY_PER_RIDER = Number(process.env.SEED_HISTORY || 25);
const NOTIFS_PER_USER = Number(process.env.SEED_NOTIFS || 40);
const CENTER = { lat: 35.1856, lng: 33.3823 };
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const point = () => ({ lat: CENTER.lat + rnd(-0.1, 0.1), lng: CENTER.lng + rnd(-0.12, 0.12) });

async function insertBatches(col: any, docs: any[], size = 5000) {
  for (let i = 0; i < docs.length; i += size) await col.insertMany(docs.slice(i, i + size), { ordered: false });
}

(async () => {
  const t0 = Date.now();
  await mongoose.connect(url);
  const { User } = await import('../../src/app/modules/user/user.model');
  const { Vehicle } = await import('../../src/app/modules/vehicle/vehicle.model');
  const { Ride } = await import('../../src/app/modules/ride/ride.model');
  const { Passenger } = await import('../../src/app/modules/passenger/passenger.model');
  const { Booking } = await import('../../src/app/modules/booking/booking.model');
  const { Notification } = await import('../../src/app/modules/notification/notification.model');
  await mongoose.connection.dropDatabase();
  for (const m of [User, Vehicle, Ride, Passenger, Booking, Notification]) await (m as any).init();

  const pwd = await bcrypt.hash('LoadTest#123', 12);
  const mkUser = (i: number, role: 'user' | 'provider') => {
    const p = point();
    return {
      _id: new Types.ObjectId(), name: `${role}${i}`, email: `${role}${i}@load.test`, password: pwd,
      role, status: 'active', isSignUpOtpVerified: true, isProfileComplete: true, isKycVerified: true,
      phone: `+3579${String(1000000 + i)}`, countryCode: '+357', wallet: 500, isDeleted: false,
      location: { type: 'Point', coordinates: [p.lng, p.lat] }, language: 'en',
      avgRating: 4 + Math.random(), createdAt: new Date(), updatedAt: new Date(),
    };
  };
  const riders = Array.from({ length: RIDERS }, (_, i) => mkUser(i, 'user'));
  const drivers = Array.from({ length: DRIVERS }, (_, i) => mkUser(i, 'provider'));
  await insertBatches((User as any).collection, [...riders, ...drivers]);
  await insertBatches((Vehicle as any).collection, drivers.map((d, i) => ({
    _id: new Types.ObjectId(), userId: d._id, name: 'Toyota Prius', number: `LD${String(i).padStart(5, '0')}`,
    year: 2020, seats: 4, carPapers: [], isDefault: true, isDeleted: false, createdAt: new Date(), updatedAt: new Date(),
  })));

  const rides: any[] = [], pax: any[] = [], books: any[] = [];
  const now = Date.now();
  for (const r of riders) {
    for (let k = 0; k < HISTORY_PER_RIDER; k++) {
      const d = drivers[(Math.random() * drivers.length) | 0];
      const a = point(), b = point();
      const when = new Date(now - (k + 1) * 86400000 * rnd(0.5, 3));
      const dd = when.toISOString().slice(0, 10), dt = '10:30';
      const rideId = new Types.ObjectId(), pid = new Types.ObjectId();
      rides.push({ _id: rideId, id: `RD${rides.length}`, driverId: d._id, rideCreatedBy: r._id, type: 'private', status: 'completed',
        pickup: { address: 'A', coordinates: { type: 'Point', coordinates: [a.lng, a.lat] } },
        destination: { address: 'B', coordinates: { type: 'Point', coordinates: [b.lng, b.lat] } },
        departureDate: dd, departureTime: dt, totalSeats: 4, bookedSeats: 1, malePassengers: 1, femalePassengers: 0,
        driverEarningCredited: true, isDeleted: false, createdAt: when, updatedAt: when });
      pax.push({ _id: pid, userId: r._id, rideId, status: 'completed',
        pickup: { address: 'A', coordinates: { type: 'Point', coordinates: [a.lng, a.lat] } },
        destination: { address: 'B', coordinates: { type: 'Point', coordinates: [b.lng, b.lat] } },
        departureDate: dd, departureTime: dt, requestedSeats: 1, malePassengers: 1, femalePassengers: 0,
        estimatedFare: 12.5, totalFare: 12.5, paidAmount: 12.5, paymentStatus: 'paid', isDeleted: false, createdAt: when, updatedAt: when });
      books.push({ _id: new Types.ObjectId(), id: `BK${books.length}`, passengerId: pid, rideId, userId: r._id, driverId: d._id,
        totalFare: 12.5, amountPaid: 12.5, bookingStatus: 'completed', paymentStatus: 'paid', createdAt: when, updatedAt: when });
    }
  }
  await insertBatches((Ride as any).collection, rides);
  await insertBatches((Passenger as any).collection, pax);
  await insertBatches((Booking as any).collection, books);

  const notifs: any[] = [];
  for (const u of [...riders, ...drivers]) for (let k = 0; k < NOTIFS_PER_USER; k++)
    notifs.push({ _id: new Types.ObjectId(), receiver: u._id, message: `Notification ${k}`, description: 'x', read: k % 3 === 0,
      type: 'ride', date: new Date(now - k * 3600000), data: {}, createdAt: new Date(now - k * 3600000), updatedAt: new Date() });
  await insertBatches((Notification as any).collection, notifs);

  const secret = process.env.JWT_ACCESS_SECRET as string;
  const tok = (u: any) => jwt.sign({ userId: u._id.toString(), email: u.email, role: u.role, iatMs: Date.now() }, secret, { expiresIn: '30d' });
  const out = {
    center: CENTER,
    riders: riders.map((u) => ({ id: u._id.toString(), email: u.email, token: tok(u) })),
    drivers: drivers.map((u) => ({ id: u._id.toString(), email: u.email, token: tok(u), lat: u.location.coordinates[1], lng: u.location.coordinates[0] })),
  };
  fs.writeFileSync(path.join(process.cwd(), 'tokens.json'), JSON.stringify(out));
  console.log(JSON.stringify({ riders: RIDERS, drivers: DRIVERS, rides: rides.length, passengers: pax.length, bookings: books.length, notifications: notifs.length, seconds: ((Date.now() - t0) / 1000).toFixed(1) }));
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
