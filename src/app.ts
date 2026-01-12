import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { errorHandler } from './middlewares/errorHandler.js';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';

// Routes
import authRoutes from './routes/auth.js';
import staffRoutes from './routes/staff.js';
import patientRoutes from './routes/patients.js';
import roomRoutes from './routes/rooms.js';
import admissionRoutes from './routes/admissions.js';
import billingRoutes from './routes/billing.js';
import insuranceRoutes from './routes/insurance.js';
import rosterRoutes from './routes/roster.js';
import auditRoutes from './routes/audit.js';
import uploadRoutes from './routes/upload.js';
import storageRoutes from './routes/storage.js';
import medicationsRoutes from './routes/medications.js';
import medicationCatalogRoutes from './routes/medication-catalog.js';
import labReportsRoutes from './routes/lab-reports.js';
import doctorNotesRoutes from './routes/doctor-notes.js';
import bedsRoutes from './routes/beds.js';
import dashboardRoutes from './routes/dashboard.js';
import emailTemplateRoutes from './routes/email-templates.js';
import billingPdfRoutes from './routes/billing-pdf.js';
import roomHistoryRoutes from './routes/room-history.js';
import twoFactorRoutes from './routes/two-factor.js';
import admissionSummariesRoutes from './routes/admission-summaries.js';

dotenv.config();

const app = express();

const defaultDevOrigins = ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001'];
const defaultProdOrigins = ['https://ashwinihospital.com', 'https://app.ashwinigeneralhospital.com'];

const corsOrigins =
  env.CORS_ALLOWED_ORIGINS.length > 0
    ? env.CORS_ALLOWED_ORIGINS
    : process.env.NODE_ENV === 'production'
      ? defaultProdOrigins
      : defaultDevOrigins;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: corsOrigins,
  credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Ashwini Hospital ERP Backend'
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/admissions', admissionRoutes);
app.use('/api/billing', billingPdfRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/insurance', insuranceRoutes);
app.use('/api/roster', rosterRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/medications', medicationsRoutes);
app.use('/api/medication-catalog', medicationCatalogRoutes);
app.use('/api/lab-reports', labReportsRoutes);
app.use('/api/doctor-notes', doctorNotesRoutes);
app.use('/api/beds', bedsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/email-templates', emailTemplateRoutes);
app.use('/api/billing-pdf', billingPdfRoutes);
app.use('/api/room-history', roomHistoryRoutes);
app.use('/api/two-factor', twoFactorRoutes);
app.use('/api/admission-summaries', admissionSummariesRoutes);

// 404 handler (must not use legacy wildcard syntax in Express 5)
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    path: req.originalUrl 
  });
});

// Global error handler
app.use(errorHandler);

export default app;
