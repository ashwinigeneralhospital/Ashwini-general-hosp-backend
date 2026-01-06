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

const DOCTOR_NOTE_SELECT = `
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
  staff:staff!doctor_notes_created_by_fkey (
    id,
    first_name,
    last_name,
    role
  )
`;

// Get doctor notes by patient ID with optional admission filter
router.get('/patient/:patientId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { patientId } = req.params;
  const admissionId = req.query.admissionId as string;

  let query = supabase
    .from('doctor_notes')
    .select(DOCTOR_NOTE_SELECT)
    .eq('patient_id', patientId)
    .order('note_date', { ascending: false });

  if (admissionId) {
    query = query.eq('admission_id', admissionId);
  }

  const { data, error } = await query;

  if (error) {
    throw createError('Failed to fetch doctor notes', 500);
  }

  res.json({
    success: true,
    data: { doctorNotes: data ?? [] }
  });
}));

// Get doctor notes by admission ID
router.get('/admission/:admissionId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { admissionId } = req.params;

  const { data, error } = await supabase
    .from('doctor_notes')
    .select(DOCTOR_NOTE_SELECT)
    .eq('admission_id', admissionId)
    .order('note_date', { ascending: false });

  if (error) {
    throw createError('Failed to fetch admission doctor notes', 500);
  }

  res.json({
    success: true,
    data: { doctorNotes: data ?? [] }
  });
}));

// Create new doctor note
router.post('/', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    patient_id,
    admission_id,
    note_date,
    note_time,
    note_content,
    note_type,
    is_private
  } = req.body;

  if (!patient_id || !note_content) {
    throw createError('patient_id and note_content are required', 400);
  }

  const { data, error } = await supabase
    .from('doctor_notes')
    .insert({
      patient_id,
      admission_id: admission_id || null,
      note_date: note_date ? new Date(note_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      note_time: note_time || new Date().toTimeString().split(' ')[0],
      note_content,
      note_type: note_type || 'general',
      is_private: is_private || false,
      created_by: req.user!.staff_id
    })
    .select(DOCTOR_NOTE_SELECT)
    .single();

  if (error) {
    logger.error('Failed to create doctor note', { error, userId: req.user!.id });
    throw createError('Failed to create doctor note', 500);
  }

  logger.info('Doctor note created', {
    doctorNoteId: data.id,
    patientId: patient_id,
    createdBy: req.user!.staff_id
  });

  res.status(201).json({
    success: true,
    data: { doctorNote: data }
  });
}));

// Update doctor note
router.put('/:id', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    note_date,
    note_time,
    note_content,
    note_type,
    is_private
  } = req.body;

  const { data, error } = await supabase
    .from('doctor_notes')
    .update({
      note_date: note_date ? new Date(note_date).toISOString().split('T')[0] : undefined,
      note_time,
      note_content,
      note_type,
      is_private,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select(DOCTOR_NOTE_SELECT)
    .single();

  if (error || !data) {
    throw createError('Doctor note not found or update failed', 404);
  }

  logger.info('Doctor note updated', {
    doctorNoteId: data.id,
    updatedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { doctorNote: data }
  });
}));

// Delete doctor note
router.delete('/:id', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('doctor_notes')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .single();

  if (error || !data) {
    throw createError('Doctor note not found or deletion failed', 404);
  }

  logger.info('Doctor note deleted', {
    doctorNoteId: data.id,
    deletedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { doctorNote: data }
  });
}));

export default router;
