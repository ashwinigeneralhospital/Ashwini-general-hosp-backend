import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { generateAuditReport } from '../utils/auditReport.js';
import { uploadToR2 } from '../utils/r2.js';

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Get audit reports history (Admin only)
router.get('/reports', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('audit_reports')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    throw createError('Failed to fetch audit reports', 500);
  }

  res.json({
    success: true,
    data: { reports: data }
  });
}));

// Generate new audit report (Admin only)
router.post('/generate', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { start_date, end_date, report_type = 'comprehensive' } = req.body;

  if (!start_date || !end_date) {
    throw createError('Start date and end date are required', 400);
  }

  const startDate = new Date(start_date);
  const endDate = new Date(end_date);

  if (startDate >= endDate) {
    throw createError('Start date must be before end date', 400);
  }

  // Check if report already exists for this date range
  const { data: existingReport } = await supabase
    .from('audit_reports')
    .select('id')
    .eq('start_date', start_date)
    .eq('end_date', end_date)
    .eq('report_type', report_type)
    .single();

  if (existingReport) {
    throw createError('Audit report already exists for this date range', 409);
  }

  try {
    // Generate report data (only patients with include_in_audit = true)
    const reportData = await generateAuditReportData(startDate, endDate);
    
    // Generate PDF report
    const pdfBuffer = await generateAuditReport(reportData, {
      startDate,
      endDate,
      reportType: report_type,
      generatedBy: req.user!.email,
      hospitalName: process.env.HOSPITAL_NAME || 'Ashwini General Hospital'
    });

    // Upload to R2
    const fileName = `audit-reports/${report_type}-${start_date}-to-${end_date}-${Date.now()}.pdf`;
    const fileUrl = await uploadToR2(pdfBuffer, fileName, 'application/pdf');

    // Save report record
    const { data: reportRecord, error: saveError } = await supabase
      .from('audit_reports')
      .insert({
        report_type,
        start_date,
        end_date,
        file_url: fileUrl,
        file_name: fileName,
        patient_count: reportData.patients.length,
        admission_count: reportData.admissions.length,
        total_revenue: reportData.totalRevenue,
        generated_by: req.user!.staff_id,
        status: 'completed'
      })
      .select()
      .single();

    if (saveError) {
      throw createError('Failed to save audit report record', 500);
    }

    // Log audit action
    await logAuditAction({
      action: 'AUDIT_REPORT_GENERATED',
      details: {
        reportId: reportRecord.id,
        reportType: report_type,
        dateRange: { start_date, end_date },
        patientCount: reportData.patients.length,
        totalRevenue: reportData.totalRevenue
      },
      performedBy: req.user!.staff_id!
    });

    logger.info('Audit report generated', {
      reportId: reportRecord.id,
      dateRange: { start_date, end_date },
      generatedBy: req.user!.staff_id
    });

    res.json({
      success: true,
      data: { report: reportRecord }
    });

  } catch (error) {
    logger.error('Failed to generate audit report', {
      error: error.message,
      dateRange: { start_date, end_date },
      userId: req.user!.id
    });
    throw createError('Failed to generate audit report', 500);
  }
}));

// Get audit report by ID (Admin only)
router.get('/reports/:id', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('audit_reports')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    throw createError('Audit report not found', 404);
  }

  res.json({
    success: true,
    data: { report: data }
  });
}));

// Get audit logs (Admin only)
router.get('/logs', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = (page - 1) * limit;

  const { data, error, count } = await supabase
    .from('audit_logs')
    .select('*, staff(name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw createError('Failed to fetch audit logs', 500);
  }

  res.json({
    success: true,
    data: {
      logs: data,
      pagination: {
        page,
        limit,
        total: count,
        pages: Math.ceil((count || 0) / limit)
      }
    }
  });
}));

// Helper function to generate audit report data
async function generateAuditReportData(startDate: Date, endDate: Date) {
  // Get patients with include_in_audit = true
  const { data: patients, error: patientsError } = await supabase
    .from('patients')
    .select('*')
    .eq('include_in_audit', true)
    .gte('created_at', startDate.toISOString())
    .lte('created_at', endDate.toISOString());

  if (patientsError) {
    throw new Error('Failed to fetch patients for audit');
  }

  // Get admissions for these patients
  const patientIds = patients.map(p => p.id);
  const { data: admissions, error: admissionsError } = await supabase
    .from('admissions')
    .select(`
      *,
      patients!inner(id, name, patient_id, include_in_audit),
      rooms(name, room_type, rate_per_day)
    `)
    .in('patient_id', patientIds)
    .gte('admission_date', startDate.toISOString())
    .lte('admission_date', endDate.toISOString());

  if (admissionsError) {
    throw new Error('Failed to fetch admissions for audit');
  }

  // Get billing data
  const admissionIds = admissions.map(a => a.id);
  const { data: charges, error: chargesError } = await supabase
    .from('charges')
    .select('*')
    .in('admission_id', admissionIds);

  if (chargesError) {
    throw new Error('Failed to fetch charges for audit');
  }

  // Calculate total revenue
  const totalRevenue = charges.reduce((sum, charge) => sum + (charge.amount || 0), 0);

  return {
    patients,
    admissions,
    charges,
    totalRevenue,
    dateRange: { startDate, endDate }
  };
}

// Helper function to log audit actions
async function logAuditAction(logData: {
  action: string;
  details: any;
  performedBy: string;
}) {
  await supabase
    .from('audit_logs')
    .insert({
      action: logData.action,
      details: logData.details,
      performed_by: logData.performedBy,
      timestamp: new Date().toISOString()
    });
}

export default router;
