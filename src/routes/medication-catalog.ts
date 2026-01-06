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

// Get all medication catalog entries
router.get('/', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const includeInactive = (req.query.includeInactive as string) === 'true';

  let query = supabase
    .from('medication_catalog')
    .select('*')
    .order('name');

  if (!includeInactive) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;

  if (error) {
    throw createError('Failed to fetch medication catalog', 500);
  }

  res.json({
    success: true,
    data: { medications: data ?? [] }
  });
}));

// Create new medication catalog entry
router.post('/', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    name,
    default_dosage,
    default_frequency,
    default_route,
    default_duration,
    notes,
    price_per_unit,
    default_units_per_dose
  } = req.body;

  if (!name) {
    throw createError('Name is required', 400);
  }

  const pricePerUnit = price_per_unit !== undefined ? Number(price_per_unit) : 0;
  const unitsPerDose = default_units_per_dose !== undefined ? Number(default_units_per_dose) : 1;

  const { data, error } = await supabase
    .from('medication_catalog')
    .insert({
      name,
      default_dosage: default_dosage || null,
      default_frequency: default_frequency || null,
      default_route: default_route || 'oral',
      default_duration: default_duration || null,
      notes: notes || null,
      price_per_unit: pricePerUnit,
      default_units_per_dose: unitsPerDose,
      is_active: true
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      throw createError('Medication with this name already exists', 409);
    }
    logger.error('Failed to create medication catalog entry', { error, userId: req.user!.id });
    throw createError('Failed to create medication catalog entry', 500);
  }

  logger.info('Medication catalog entry created', {
    medicationId: data.id,
    name,
    createdBy: req.user!.staff_id
  });

  res.status(201).json({
    success: true,
    data: { medication: data }
  });
}));

// Update medication catalog entry
router.put('/:id', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    name,
    default_dosage,
    default_frequency,
    default_route,
    default_duration,
    notes,
    is_active,
    price_per_unit,
    default_units_per_dose
  } = req.body;

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  };

  if (name !== undefined) updates.name = name;
  if (default_dosage !== undefined) updates.default_dosage = default_dosage;
  if (default_frequency !== undefined) updates.default_frequency = default_frequency;
  if (default_route !== undefined) updates.default_route = default_route;
  if (default_duration !== undefined) updates.default_duration = default_duration;
  if (notes !== undefined) updates.notes = notes;
  if (is_active !== undefined) updates.is_active = is_active;
  if (price_per_unit !== undefined) updates.price_per_unit = Number(price_per_unit);
  if (default_units_per_dose !== undefined) updates.default_units_per_dose = Number(default_units_per_dose);

  const { data, error } = await supabase
    .from('medication_catalog')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) {
    throw createError('Medication catalog entry not found or update failed', 404);
  }

  logger.info('Medication catalog entry updated', {
    medicationId: data.id,
    updatedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { medication: data }
  });
}));

// Delete medication catalog entry (soft delete)
router.delete('/:id', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('medication_catalog')
    .update({
      is_active: false,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select('id, name')
    .single();

  if (error || !data) {
    throw createError('Medication catalog entry not found or deletion failed', 404);
  }

  logger.info('Medication catalog entry deleted', {
    medicationId: data.id,
    name: data.name,
    deletedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { medication: data }
  });
}));

export default router;
