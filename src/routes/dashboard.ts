import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Get dashboard statistics
router.get('/stats', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { data: rawSummary, error } = await supabase
      .from('dashboard_summary')
      .select('*')
      .single();

    if (error || !rawSummary) {
      logger.error('Failed to fetch dashboard summary', { error });
      throw createError('Failed to fetch dashboard statistics', 500);
    }

    const summary = {
      totalPatients: Number(rawSummary.total_patients ?? 0),
      availableBeds: Number(rawSummary.available_beds ?? 0),
      occupiedBeds: Number(rawSummary.occupied_beds ?? 0),
      totalBeds: Number(rawSummary.total_beds ?? 0),
      pendingBillsTotal: Number(rawSummary.pending_bills_total ?? 0),
      activeClaims: Number(rawSummary.active_claims ?? 0),
      doctorsOnDuty: Number(rawSummary.doctors_on_duty ?? 0),
      nursesOnDuty: Number(rawSummary.nurses_on_duty ?? 0),
    };

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    logger.error('Failed to fetch dashboard stats', { error, userId: req.user?.id });
    throw createError('Failed to fetch dashboard statistics', 500);
  }
}));

// Get revenue data for the last 6 months
router.get('/revenue', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('dashboard_monthly_revenue')
      .select('*')
      .order('month_start', { ascending: true });

    if (error) {
      logger.error('Failed to fetch revenue data', { error });
      throw createError('Failed to fetch revenue data', 500);
    }

    const revenueData = (data ?? []).map((row: any) => ({
      month: row.month_label,
      revenue: Number(row.revenue) || 0,
      target: 50000
    }));

    res.json({
      success: true,
      data: { revenueData }
    });
  } catch (error) {
    logger.error('Failed to fetch revenue data', { error, userId: req.user?.id });
    throw createError('Failed to fetch revenue data', 500);
  }
}));

// Get doctor performance data
router.get('/doctors', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('dashboard_doctor_performance')
      .select('*')
      .order('patients_last_30d', { ascending: false })
      .limit(5);

    if (error) {
      logger.error('Failed to fetch doctor performance data', { error });
      throw createError('Failed to fetch doctor performance data', 500);
    }

    const doctorPerformance = (data ?? []).map((row: any) => ({
      name: `Dr. ${row.first_name} ${row.last_name}`,
      patients: row.patients_last_30d,
      rating: 4.5 + Math.random() * 0.4
    }));

    res.json({
      success: true,
      data: { doctorPerformance }
    });
  } catch (error) {
    logger.error('Failed to fetch doctor performance data', { error, userId: req.user?.id });
    throw createError('Failed to fetch doctor performance data', 500);
  }
}));

// Get system alerts
router.get('/alerts', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const alerts = [];

    // Check bed occupancy
    const { count: totalBeds } = await supabase
      .from('beds')
      .select('*', { count: 'exact', head: true });

    const { count: occupiedBeds } = await supabase
      .from('beds')
      .select('*', { count: 'exact', head: true })
      .eq('is_available', false);

    if (totalBeds && occupiedBeds) {
      const occupancyRate = (occupiedBeds / totalBeds) * 100;
      if (occupancyRate > 85) {
        alerts.push({
          id: 'bed-occupancy',
          title: 'High bed occupancy',
          description: `Hospital at ${occupancyRate.toFixed(0)}% capacity`,
          severity: occupancyRate > 95 ? 'error' : 'warning',
          time: 'Current'
        });
      }
    }

    // Check overdue invoices
    const { data: overdueInvoices } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('status', 'overdue')
      .limit(1);

    if (overdueInvoices && overdueInvoices.length > 0) {
      alerts.push({
        id: 'overdue-payment',
        title: 'Overdue payments',
        description: `${overdueInvoices.length} invoice(s) overdue`,
        severity: 'error',
        time: 'Current'
      });
    }

    // Check recent insurance claims
    const { data: recentClaims } = await supabase
      .from('insurance_claims')
      .select('claim_number')
      .eq('status', 'submitted')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if (recentClaims && recentClaims.length > 0) {
      alerts.push({
        id: 'new-claims',
        title: 'New insurance claims',
        description: `${recentClaims.length} new claim(s) submitted`,
        severity: 'info',
        time: 'Last 24h'
      });
    }

    res.json({
      success: true,
      data: { alerts }
    });
  } catch (error) {
    logger.error('Failed to fetch alerts', { error, userId: req.user?.id });
    throw createError('Failed to fetch alerts', 500);
  }
}));

export default router;
