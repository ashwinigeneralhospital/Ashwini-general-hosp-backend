import dotenv from 'dotenv';

dotenv.config();

export const env = {
  // Database
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  
  // Cloudflare R2
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID!,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID!,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY!,
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME!,
  
  // SMTP
  SMTP_HOST: process.env.SMTP_HOST!,
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587'),
  SMTP_USER: process.env.SMTP_USER!,
  SMTP_PASS: process.env.SMTP_PASS!,
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  
  // App Config
  PORT: parseInt(process.env.PORT || '3001'),
  NODE_ENV: process.env.NODE_ENV || 'development',
  JWT_SECRET: process.env.JWT_SECRET || 'your_jwt_secret_key',
  HOSPITAL_NAME: process.env.HOSPITAL_NAME || 'Ashwini General Hospital',
  HOSPITAL_ADDRESS: process.env.HOSPITAL_ADDRESS || 'Your Hospital Address',
  HOSPITAL_PHONE: process.env.HOSPITAL_PHONE || '+91-XXXXXXXXXX',
  HOSPITAL_EMAIL: process.env.HOSPITAL_EMAIL || 'info@ashwinihospital.com',
  PORTAL_URL: process.env.PORTAL_URL || 'http://localhost:3000',
  
  // Seed Admin
  SEED_ADMIN_NAME: process.env.SEED_ADMIN_NAME || 'Ashwini Super Admin',
  SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL || 'admin@ashwinihospital.com',
  SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD || 'Admin@123'
};
