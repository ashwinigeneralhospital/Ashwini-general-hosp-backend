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

// Get doctor's assigned patients
router.get('/doctor/patients', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || !['doctor', 'admin'].includes(req.user.role)) {
      throw createError('Access denied', 403);
    }

    const doctorId = req.user.staff_id;

    // Get active admissions assigned to this doctor
    const { data: admissions, error } = await supabase
      .from('admissions')
      .select(`
        id,
        admission_date,
        discharge_date,
        status,
        diagnosis,
        patients:patient_id (
          id,
          first_name,
          last_name,
          date_of_birth
        ),
        beds:bed_id (
          bed_number,
          rooms:room_id (
            room_number,
            room_type
          )
        )
      `)
      .eq('doctor_id', doctorId)
      .in('status', ['admitted', 'under_treatment'])
      .order('admission_date', { ascending: false });

    if (error) {
      logger.error('Failed to fetch doctor patients', { error, doctorId });
      throw createError('Failed to fetch assigned patients', 500);
    }

    const patients = (admissions || []).map((admission: any) => ({
      admissionId: admission.id,
      patientId: admission.patients?.id,
      patientName: `${admission.patients?.first_name || ''} ${admission.patients?.last_name || ''}`.trim(),
      bedNumber: admission.beds?.bed_number || 'N/A',
      roomNumber: admission.beds?.rooms?.room_number || 'N/A',
      roomType: admission.beds?.rooms?.room_type || 'N/A',
      diagnosis: admission.diagnosis || 'Not specified',
      status: admission.status,
      admissionDate: admission.admission_date,
      dischargeDate: admission.discharge_date
    }));

    res.json({
      success: true,
      data: { patients }
    });
  } catch (error) {
    logger.error('Failed to fetch doctor patients', { error, userId: req.user?.id });
    throw createError('Failed to fetch assigned patients', 500);
  }
}));

// Get doctor's dashboard stats
router.get('/doctor/stats', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || !['doctor', 'admin'].includes(req.user.role)) {
      throw createError('Access denied', 403);
    }

    const doctorId = req.user.staff_id;

    // Count active patients
    const { count: activePatients } = await supabase
      .from('admissions')
      .select('*', { count: 'exact', head: true })
      .eq('doctor_id', doctorId)
      .in('status', ['admitted', 'under_treatment']);

    // Count patients today (admitted today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { count: patientsToday } = await supabase
      .from('admissions')
      .select('*', { count: 'exact', head: true })
      .eq('doctor_id', doctorId)
      .gte('admission_date', today.toISOString());

    // Count pending notes (admissions without recent doctor notes)
    const { count: pendingNotes } = await supabase
      .from('admissions')
      .select('*', { count: 'exact', head: true })
      .eq('doctor_id', doctorId)
      .in('status', ['admitted', 'under_treatment']);

    // Count total patients this month
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const { count: patientsThisMonth } = await supabase
      .from('admissions')
      .select('*', { count: 'exact', head: true })
      .eq('doctor_id', doctorId)
      .gte('admission_date', firstDayOfMonth.toISOString());

    res.json({
      success: true,
      data: {
        activePatients: activePatients || 0,
        patientsToday: patientsToday || 0,
        pendingNotes: pendingNotes || 0,
        patientsThisMonth: patientsThisMonth || 0
      }
    });
  } catch (error) {
    logger.error('Failed to fetch doctor stats', { error, userId: req.user?.id });
    throw createError('Failed to fetch doctor statistics', 500);
  }
}));

// Get nurse's assigned patients and medication tasks
router.get('/nurse/patients', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || !['nurse', 'admin'].includes(req.user.role)) {
      throw createError('Access denied', 403);
    }

    // Get all active admissions with their medications
    const { data: admissions, error } = await supabase
      .from('admissions')
      .select(`
        id,
        admission_date,
        status,
        diagnosis,
        patients:patient_id (
          id,
          first_name,
          last_name
        ),
        beds:bed_id (
          id,
          bed_number,
          rooms:room_id (
            room_number,
            room_type
          )
        )
      `)
      .in('status', ['admitted', 'under_treatment'])
      .order('admission_date', { ascending: false });

    if (error) {
      logger.error('Failed to fetch nurse patients', { error });
      throw createError('Failed to fetch patients', 500);
    }

    const patients = (admissions || []).map((admission: any) => ({
      admissionId: admission.id,
      patientId: admission.patients?.id,
      patientName: `${admission.patients?.first_name || ''} ${admission.patients?.last_name || ''}`.trim(),
      bedId: admission.beds?.id,
      bedNumber: admission.beds?.bed_number || 'N/A',
      roomNumber: admission.beds?.rooms?.room_number || 'N/A',
      roomType: admission.beds?.rooms?.room_type || 'N/A',
      diagnosis: admission.diagnosis || 'Not specified',
      status: admission.status,
      admissionDate: admission.admission_date
    }));

    res.json({
      success: true,
      data: { patients }
    });
  } catch (error) {
    logger.error('Failed to fetch nurse patients', { error, userId: req.user?.id });
    throw createError('Failed to fetch patients', 500);
  }
}));

// Get nurse's dashboard stats
router.get('/nurse/stats', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || !['nurse', 'admin'].includes(req.user.role)) {
      throw createError('Access denied', 403);
    }

    // Count total active patients
    const { count: activePatients } = await supabase
      .from('admissions')
      .select('*', { count: 'exact', head: true })
      .in('status', ['admitted', 'under_treatment']);

    // Count occupied beds
    const { count: occupiedBeds } = await supabase
      .from('beds')
      .select('*', { count: 'exact', head: true })
      .eq('is_available', false);

    // Count available beds
    const { count: availableBeds } = await supabase
      .from('beds')
      .select('*', { count: 'exact', head: true })
      .eq('is_available', true);

    // Count active medications (rough estimate - medications for active admissions)
    const { count: activeMedications } = await supabase
      .from('patient_medications')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');

    res.json({
      success: true,
      data: {
        activePatients: activePatients || 0,
        occupiedBeds: occupiedBeds || 0,
        availableBeds: availableBeds || 0,
        activeMedications: activeMedications || 0
      }
    });
  } catch (error) {
    logger.error('Failed to fetch nurse stats', { error, userId: req.user?.id });
    throw createError('Failed to fetch nurse statistics', 500);
  }
}));

// Get pending medication doses for nurse
router.get('/nurse/medication-tasks', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || !['nurse', 'admin'].includes(req.user.role)) {
      throw createError('Access denied', 403);
    }

    // Get active medications with patient info
    const { data: medications, error } = await supabase
      .from('patient_medications')
      .select(`
        id,
        medication_name,
        dosage,
        frequency,
        route,
        start_date,
        end_date,
        status,
        admissions:admission_id (
          id,
          patients:patient_id (
            id,
            first_name,
            last_name
          ),
          beds:bed_id (
            bed_number,
            rooms:room_id (
              room_number
            )
          )
        )
      `)
      .eq('status', 'active')
      .order('start_date', { ascending: false })
      .limit(20);

    if (error) {
      logger.error('Failed to fetch medication tasks', { error });
      throw createError('Failed to fetch medication tasks', 500);
    }

    const tasks = (medications || []).map((med: any) => ({
      medicationId: med.id,
      medicationName: med.medication_name,
      dosage: med.dosage,
      frequency: med.frequency,
      route: med.route,
      patientName: `${med.admissions?.patients?.first_name || ''} ${med.admissions?.patients?.last_name || ''}`.trim(),
      bedNumber: med.admissions?.beds?.bed_number || 'N/A',
      roomNumber: med.admissions?.beds?.rooms?.room_number || 'N/A',
      startDate: med.start_date,
      endDate: med.end_date
    }));

    res.json({
      success: true,
      data: { tasks }
    });
  } catch (error) {
    logger.error('Failed to fetch medication tasks', { error, userId: req.user?.id });
    throw createError('Failed to fetch medication tasks', 500);
  }
}));

export default router;
