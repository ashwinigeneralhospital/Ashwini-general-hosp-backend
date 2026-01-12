import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.get('/admission/:admissionId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { admissionId } = req.params;

  const { data: summary, error } = await supabase
    .from('admission_summaries')
    .select(`
      *,
      created_by_staff:created_by (
        id,
        first_name,
        last_name,
        role
      ),
      updated_by_staff:updated_by (
        id,
        first_name,
        last_name,
        role
      )
    `)
    .eq('admission_id', admissionId)
    .maybeSingle();

  if (error) {
    logger.error('Failed to fetch admission summary', { admissionId, error });
    throw createError('Failed to fetch admission summary', 500);
  }

  res.json({
    success: true,
    data: summary
  });
}));

router.get('/patient/:patientId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { patientId } = req.params;

  const { data: summaries, error } = await supabase
    .from('admission_summaries')
    .select(`
      *,
      admissions (
        id,
        admission_id,
        admission_date,
        discharge_date,
        reason
      ),
      created_by_staff:created_by (
        id,
        first_name,
        last_name,
        role
      )
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Failed to fetch patient admission summaries', { patientId, error });
    throw createError('Failed to fetch admission summaries', 500);
  }

  res.json({
    success: true,
    data: summaries || []
  });
}));

router.post('/', authenticateToken, requireRole(['doctor', 'admin']), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    admission_id,
    patient_id,
    chief_complaint,
    diagnosis,
    treatment_provided,
    outcome,
    recommendations
  } = req.body;

  if (!admission_id || !patient_id || !chief_complaint || !diagnosis || !treatment_provided || !outcome) {
    throw createError('Missing required fields', 400);
  }

  const { data: summary, error } = await supabase
    .from('admission_summaries')
    .insert({
      admission_id,
      patient_id,
      chief_complaint,
      diagnosis,
      treatment_provided,
      outcome,
      recommendations: recommendations || null,
      created_by: req.user!.staff_id,
      updated_by: req.user!.staff_id
    })
    .select()
    .single();

  if (error) {
    logger.error('Failed to create admission summary', { admission_id, error });
    throw createError('Failed to create admission summary', 500);
  }

  logger.info('Admission summary created', {
    summaryId: summary.id,
    admissionId: admission_id,
    createdBy: req.user!.staff_id
  });

  res.status(201).json({
    success: true,
    data: summary
  });
}));

router.put('/:id', authenticateToken, requireRole(['doctor', 'admin']), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const {
    chief_complaint,
    diagnosis,
    treatment_provided,
    outcome,
    recommendations
  } = req.body;

  const updateData: any = {
    updated_by: req.user!.staff_id
  };

  if (chief_complaint !== undefined) updateData.chief_complaint = chief_complaint;
  if (diagnosis !== undefined) updateData.diagnosis = diagnosis;
  if (treatment_provided !== undefined) updateData.treatment_provided = treatment_provided;
  if (outcome !== undefined) updateData.outcome = outcome;
  if (recommendations !== undefined) updateData.recommendations = recommendations;

  const { data: summary, error } = await supabase
    .from('admission_summaries')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    logger.error('Failed to update admission summary', { id, error });
    throw createError('Failed to update admission summary', 500);
  }

  logger.info('Admission summary updated', {
    summaryId: id,
    updatedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: summary
  });
}));

router.delete('/:id', authenticateToken, requireRole(['admin']), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('admission_summaries')
    .delete()
    .eq('id', id);

  if (error) {
    logger.error('Failed to delete admission summary', { id, error });
    throw createError('Failed to delete admission summary', 500);
  }

  logger.info('Admission summary deleted', {
    summaryId: id,
    deletedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    message: 'Admission summary deleted successfully'
  });
}));

export default router;
