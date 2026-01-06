import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireMedicalStaff } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const LAB_REPORT_SELECT = `
  *,
  patients (
    id,
    patient_id,
    first_name,
    last_name
  ),
  admissions (
    id,
    admission_date,
    status
  ),
  staff:staff!lab_reports_ordered_by_fkey (
    id,
    first_name,
    last_name,
    role
  )
`;

// Get lab reports by patient ID with optional admission filter
router.get('/patient/:patientId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { patientId } = req.params;
  const admissionId = req.query.admissionId as string;

  let query = supabase
    .from('lab_reports')
    .select(LAB_REPORT_SELECT)
    .eq('patient_id', patientId)
    .order('test_date', { ascending: false });

  if (admissionId) {
    query = query.eq('admission_id', admissionId);
  }

  const { data, error } = await query;

  if (error) {
    throw createError('Failed to fetch lab reports', 500);
  }

  res.json({
    success: true,
    data: { labReports: data ?? [] }
  });
}));

// Get lab reports by admission ID
router.get('/admission/:admissionId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { admissionId } = req.params;

  const { data, error } = await supabase
    .from('lab_reports')
    .select(LAB_REPORT_SELECT)
    .eq('admission_id', admissionId)
    .order('test_date', { ascending: false });

  if (error) {
    throw createError('Failed to fetch admission lab reports', 500);
  }

  res.json({
    success: true,
    data: { labReports: data ?? [] }
  });
}));

// Create new lab report
router.post('/', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    patient_id,
    admission_id,
    test_type,
    test_date,
    result_summary,
    result_details,
    normal_range,
    status,
    notes
  } = req.body;

  if (!patient_id || !test_type || !test_date) {
    throw createError('patient_id, test_type, and test_date are required', 400);
  }

  const { data, error } = await supabase
    .from('lab_reports')
    .insert({
      patient_id,
      admission_id: admission_id || null,
      test_type,
      test_date: new Date(test_date).toISOString(),
      result_summary: result_summary || null,
      result_details: result_details || null,
      normal_range: normal_range || null,
      status: status || 'pending',
      notes: notes || null,
      ordered_by: req.user!.staff_id
    })
    .select(LAB_REPORT_SELECT)
    .single();

  if (error) {
    logger.error('Failed to create lab report', { error, userId: req.user!.id });
    throw createError('Failed to create lab report', 500);
  }

  logger.info('Lab report created', {
    labReportId: data.id,
    patientId: patient_id,
    createdBy: req.user!.staff_id
  });

  res.status(201).json({
    success: true,
    data: { labReport: data }
  });
}));

// Update lab report
router.put('/:id', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    test_type,
    test_date,
    result_summary,
    result_details,
    normal_range,
    status,
    notes
  } = req.body;

  const { data, error } = await supabase
    .from('lab_reports')
    .update({
      test_type,
      test_date: test_date ? new Date(test_date).toISOString() : undefined,
      result_summary,
      result_details,
      normal_range,
      status,
      notes,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select(LAB_REPORT_SELECT)
    .single();

  if (error || !data) {
    throw createError('Lab report not found or update failed', 404);
  }

  logger.info('Lab report updated', {
    labReportId: data.id,
    updatedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { labReport: data }
  });
}));

// Delete lab report
router.delete('/:id', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('lab_reports')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .single();

  if (error || !data) {
    throw createError('Lab report not found or deletion failed', 404);
  }

  logger.info('Lab report deleted', {
    labReportId: data.id,
    deletedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { labReport: data }
  });
}));

export default router;
