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

const MEDICATION_SELECT = '*';

// Get medications by patient ID with optional admission filter
router.get('/patient/:patientId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { patientId } = req.params;
  const admissionId = req.query.admissionId as string;

  let query = supabase
    .from('patient_medications')
    .select(MEDICATION_SELECT)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (admissionId) {
    query = query.eq('admission_id', admissionId);
  }

  const { data, error } = await query;

  if (error) {
    logger.error('Failed to fetch patient medications', {
      patientId,
      admissionId,
      error: error.message,
      details: error.details,
      hint: error.hint,
    });
    throw createError('Failed to fetch patient medications', 500);
  }

  res.json({
    success: true,
    data: { medications: data ?? [] }
  });
}));

// Get medications by admission ID
router.get('/admission/:admissionId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { admissionId } = req.params;

  const { data, error } = await supabase
    .from('patient_medications')
    .select(MEDICATION_SELECT)
    .eq('admission_id', admissionId)
    .order('created_at', { ascending: false });

  if (error) {
    throw createError('Failed to fetch admission medications', 500);
  }

  res.json({
    success: true,
    data: { medications: data ?? [] }
  });
}));

// Create new medication for patient
router.post('/', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    patient_id,
    admission_id,
    medication_catalog_id,
    name,
    dosage,
    frequency,
    duration,
    route,
    prescribed_date,
    notes,
    price_per_unit,
    units_per_dose,
    total_doses,
    billing_status = 'pending'
  } = req.body;

  if (!patient_id || !name || !dosage || !frequency) {
    throw createError('patient_id, name, dosage, and frequency are required', 400);
  }

  const pricePerUnit = price_per_unit !== undefined ? Number(price_per_unit) : 0;
  const unitsPerDose = units_per_dose !== undefined ? Number(units_per_dose) : 1;
  const totalDoses = total_doses !== undefined ? Number(total_doses) : null;

  const { data, error } = await supabase
    .from('patient_medications')
    .insert({
      patient_id,
      admission_id: admission_id || null,
      medication_catalog_id: medication_catalog_id || null,
      name,
      dosage,
      frequency,
      duration: duration || null,
      route: route || 'oral',
      prescribed_date: prescribed_date || new Date().toISOString().split('T')[0],
      prescribed_by: req.user!.staff_id,
      notes: notes || null,
      status: 'active',
      price_per_unit: pricePerUnit,
      units_per_dose: unitsPerDose,
      total_doses: totalDoses,
      doses_administered: 0,
      billing_status
    })
    .select(MEDICATION_SELECT)
    .single();

  if (error) {
    logger.error('Failed to create medication', { error, userId: req.user!.id });
    throw createError('Failed to create medication', 500);
  }

  logger.info('Medication created', {
    medicationId: data.id,
    patientId: patient_id,
    createdBy: req.user!.staff_id
  });

  res.status(201).json({
    success: true,
    data: { medication: data }
  });
}));

// Update medication
router.put('/:id', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    name,
    dosage,
    frequency,
    duration,
    route,
    prescribed_date,
    notes,
    status,
    price_per_unit,
    units_per_dose,
    total_doses,
    doses_administered,
    billing_status
  } = req.body;

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  };

  if (name !== undefined) updates.name = name;
  if (dosage !== undefined) updates.dosage = dosage;
  if (frequency !== undefined) updates.frequency = frequency;
  if (duration !== undefined) updates.duration = duration;
  if (route !== undefined) updates.route = route;
  if (prescribed_date !== undefined) updates.prescribed_date = prescribed_date;
  if (notes !== undefined) updates.notes = notes;
  if (status !== undefined) updates.status = status;
  if (price_per_unit !== undefined) updates.price_per_unit = Number(price_per_unit);
  if (units_per_dose !== undefined) updates.units_per_dose = Number(units_per_dose);
  if (total_doses !== undefined) updates.total_doses = total_doses !== null ? Number(total_doses) : null;
  if (doses_administered !== undefined) updates.doses_administered = Number(doses_administered);
  if (billing_status !== undefined) updates.billing_status = billing_status;

  const { data, error } = await supabase
    .from('patient_medications')
    .update(updates)
    .eq('id', req.params.id)
    .select(MEDICATION_SELECT)
    .single();

  if (error || !data) {
    throw createError('Medication not found or update failed', 404);
  }

  logger.info('Medication updated', {
    medicationId: data.id,
    updatedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { medication: data }
  });
}));

// List doses for a medication
router.get('/:id/doses', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('patient_medication_doses')
    .select('*')
    .eq('patient_medication_id', id)
    .order('administered_at', { ascending: false });

  if (error) {
    logger.error('Failed to fetch medication doses', { medicationId: id, error: error.message });
    throw createError('Failed to fetch medication doses', 500);
  }

  res.json({
    success: true,
    data: { doses: data ?? [] }
  });
}));

// Log a dose administered for a medication
router.post('/:id/doses', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { units_administered, notes, administered_at } = req.body;

  const { data: medication, error: medicationError } = await supabase
    .from('patient_medications')
    .select('id, doses_administered, total_doses')
    .eq('id', id)
    .single();

  if (medicationError || !medication) {
    throw createError('Medication not found', 404);
  }

  const units = units_administered !== undefined ? Number(units_administered) : 1;
  const nextDoseNumber = (medication.doses_administered ?? 0) + 1;

  const { data: dose, error: doseError } = await supabase
    .from('patient_medication_doses')
    .insert({
      patient_medication_id: id,
      administered_by: req.user!.staff_id,
      administered_at: administered_at || new Date().toISOString(),
      units_administered: units,
      dose_number: nextDoseNumber,
      notes: notes || null,
    })
    .select('*')
    .single();

  if (doseError) {
    logger.error('Failed to log medication dose', { medicationId: id, error: doseError.message });
    throw createError('Failed to log medication dose', 500);
  }

  const updates: Record<string, unknown> = {
    doses_administered: nextDoseNumber,
    last_administered_at: dose.administered_at,
    updated_at: new Date().toISOString(),
  };

  if (medication.total_doses && nextDoseNumber >= medication.total_doses) {
    updates.billing_status = 'ready';
  }

  const { data: updatedMedication, error: updateError } = await supabase
    .from('patient_medications')
    .update(updates)
    .eq('id', id)
    .select(MEDICATION_SELECT)
    .single();

  if (updateError || !updatedMedication) {
    logger.error('Failed to update medication after dosing', { medicationId: id, error: updateError?.message });
    throw createError('Failed to update medication after dosing', 500);
  }

  res.status(201).json({
    success: true,
    data: {
      dose,
      medication: updatedMedication,
    },
  });
}));

// Delete medication
router.delete('/:id', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('patient_medications')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .single();

  if (error || !data) {
    throw createError('Medication not found or deletion failed', 404);
  }

  logger.info('Medication deleted', {
    medicationId: data.id,
    deletedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { medication: data }
  });
}));

export default router;
