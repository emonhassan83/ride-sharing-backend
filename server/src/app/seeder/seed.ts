import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User } from '../modules/user/user.model';
import settingSeeder from '../modules/settings/settings.seeder';
import { USER_ROLE, USER_STATUS } from '../modules/user/user.constant';
import { config } from '../config/env.config';

// Load environment variables
dotenv.config();

// Connect to MongoDB
const connectToDatabase = async () => {
  if (!process.env.MONGODB_URL) throw new Error('MONGODB_URL missing');
  await mongoose.connect(process.env.MONGODB_URL);
  console.log('Connected to MongoDB');
};

// Function to seed users
const adminSeeder = async () => {
  const admin = await User.findOne({ role: USER_ROLE.admin });
  if (!admin) {
    await User.create({
      name: 'SPLIT RIDE',
      email: 'admin.splitride@example.com',
      password: config.admin_pass,
      role: USER_ROLE.admin,
      status: USER_STATUS.active,
      isSignUpOtpVerified: true,
      isLoginOTPVerified: true,
      expireAt: null
    });
      console.log('✅ Admin user created');
  } else {
    console.log('Admin user already exists');
  }
}

// Main function to seed the database
const seedDatabase = async () => {
  try {
    await connectToDatabase();
    await adminSeeder();
    await settingSeeder();
    console.log('--------------> Database seeding completed <--------------');
  } catch (err) {
    console.error('Error seeding database:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
};

// Execute seeding
seedDatabase();
