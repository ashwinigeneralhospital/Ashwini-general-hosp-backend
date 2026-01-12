import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireAdmin } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Get room history for an admission
router.get('/admission/:admissionId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { admissionId } = req.params;

  const { data: roomHistory, error } = await supabase
    .from('room_history')
    .select(`
      *,
      rooms (
        id,
        room_number,
        room_type
      ),
      beds (
        id,
        bed_number
      )
    `)
    .eq('admission_id', admissionId)
    .order('start_date', { ascending: false });

  if (error) {
    logger.error('Failed to fetch room history', { admissionId, error });
    throw createError('Failed to fetch room history', 500);
  }

  res.json({
    success: true,
    data: roomHistory
  });
}));

// Add new room history entry (manual room change)
router.post('/admission/:admissionId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { admissionId } = req.params;
  const { roomId, bedId, roomType, ratePerDay, startDate } = req.body;

  const nowIso = new Date().toISOString();

  // Determine current active room entry to release associated bed
  const { data: activeEntries, error: activeError } = await supabase
    .from('room_history')
    .select('bed_id')
    .eq('admission_id', admissionId)
    .is('end_date', null);

  if (activeError) {
    logger.error('Failed to fetch active room entries before update', { admissionId, error: activeError });
    throw createError('Failed to prepare room history update', 500);
  }

  // Fetch admission to access patient for bed assignment
  const { data: admissionRecord, error: admissionError } = await supabase
    .from('admissions')
    .select('patient_id')
    .eq('id', admissionId)
    .maybeSingle();

  if (admissionError || !admissionRecord) {
    logger.error('Failed to fetch admission for room history update', { admissionId, error: admissionError });
    throw createError('Admission not found for room history update', 404);
  }

  // First, close any existing room history entries
  await supabase
    .from('room_history')
    .update({ end_date: nowIso })
    .eq('admission_id', admissionId)
    .is('end_date', null);

  // Release any previously occupied beds
  if (activeEntries?.length) {
    const bedIdsToRelease = activeEntries
      .map((entry) => entry.bed_id)
      .filter((value): value is string => Boolean(value));

    if (bedIdsToRelease.length) {
      const { error: releaseError } = await supabase
        .from('beds')
        .update({
          current_patient_id: null,
          status: 'available',
          updated_at: nowIso,
        })
        .in('id', bedIdsToRelease);

      if (releaseError) {
        logger.error('Failed to release previous beds during room history update', { admissionId, releaseError });
      }
    }
  }

  // Create new room history entry
  const { data: newEntry, error } = await supabase
    .from('room_history')
    .insert({
      admission_id: admissionId,
      room_id: roomId,
      bed_id: bedId || null,
      room_type: roomType,
      rate_per_day: ratePerDay,
      start_date: startDate || new Date().toISOString(),
      created_by: req.user?.id
    })
    .select(`
      *,
      rooms (
        id,
        room_number,
        room_type
      ),
      beds (
        id,
        bed_number
      )
    `)
    .single();

  if (error) {
    logger.error('Failed to create room history entry', { admissionId, error });
    throw createError('Failed to create room history entry', 500);
  }

  // Update admission with new room
  await supabase
    .from('admissions')
    .update({
      room_id: roomId,
      bed_id: bedId,
      updated_by: req.user?.id,
      updated_at: nowIso
    })
    .eq('id', admissionId);

  // Assign patient to new bed if provided
  if (bedId) {
    const { error: assignError } = await supabase
      .from('beds')
      .update({
        current_patient_id: admissionRecord.patient_id,
        status: 'occupied',
        updated_at: nowIso,
      })
      .eq('id', bedId);

    if (assignError) {
      logger.error('Failed to assign patient to new bed during room history update', {
        admissionId,
        bedId,
        assignError,
      });
    }
  }

  logger.info('Room history entry created', { admissionId, roomId, userId: req.user?.id });

  res.status(201).json({
    success: true,
    message: 'Room history entry created successfully',
    data: newEntry
  });
}));

// Update room history entry
router.put('/:id', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { roomId, bedId, roomType, ratePerDay, startDate, endDate } = req.body;

  const nowIso = new Date().toISOString();

  const { data: existingEntry, error: existingError } = await supabase
    .from('room_history')
    .select('admission_id, bed_id, end_date')
    .eq('id', id)
    .maybeSingle();

  if (existingError || !existingEntry) {
    logger.error('Failed to fetch existing room history entry for update', { id, existingError });
    throw createError('Room history entry not found', 404);
  }

  const { data: admissionRecord, error: admissionError } = await supabase
    .from('admissions')
    .select('patient_id')
    .eq('id', existingEntry.admission_id)
    .maybeSingle();

  if (admissionError || !admissionRecord) {
    logger.error('Failed to fetch admission for room history edit', { id, admissionError });
    throw createError('Admission not found for room history edit', 404);
  }

  const { data: updatedEntry, error } = await supabase
    .from('room_history')
    .update({
      room_id: roomId,
      bed_id: bedId,
      room_type: roomType,
      rate_per_day: ratePerDay,
      start_date: startDate,
      end_date: endDate,
      updated_at: nowIso
    })
    .eq('id', id)
    .select(`
      *,
      rooms (
        id,
        room_number,
        room_type
      ),
      beds (
        id,
        bed_number
      )
    `)
    .single();

  if (error) {
    logger.error('Failed to update room history entry', { id, error });
    throw createError('Failed to update room history entry', 500);
  }

  const wasActive = existingEntry.end_date === null;
  const isActive = updatedEntry.end_date === null;
  const previousBedId = existingEntry.bed_id;
  const newBedId = updatedEntry.bed_id;

  // Release old bed if it was active and either bed changed or entry ended
  if (wasActive && previousBedId && (previousBedId !== newBedId || !isActive)) {
    const { error: releaseError } = await supabase
      .from('beds')
      .update({
        current_patient_id: null,
        status: 'available',
        updated_at: nowIso,
      })
      .eq('id', previousBedId);

    if (releaseError) {
      logger.error('Failed to release previous bed during room history edit', { id, releaseError });
    }
  }

  // Assign patient to the new bed if entry is current
  if (isActive && newBedId) {
    const { error: assignError } = await supabase
      .from('beds')
      .update({
        current_patient_id: admissionRecord.patient_id,
        status: 'occupied',
        updated_at: nowIso,
      })
      .eq('id', newBedId);

    if (assignError) {
      logger.error('Failed to assign patient to updated bed during room history edit', { id, assignError });
    }
  }

  logger.info('Room history entry updated', { id, userId: req.user?.id });

  res.json({
    success: true,
    message: 'Room history entry updated successfully',
    data: updatedEntry
  });
}));

// Delete room history entry (admin only)
router.delete('/:id', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('room_history')
    .delete()
    .eq('id', id);

  if (error) {
    logger.error('Failed to delete room history entry', { id, error });
    throw createError('Failed to delete room history entry', 500);
  }

  logger.info('Room history entry deleted', { id, userId: req.user?.id });

  res.json({
    success: true,
    message: 'Room history entry deleted successfully'
  });
}));

// Get room charges calculation for admission
router.get('/charges/:admissionId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { admissionId } = req.params;

  // Call the PostgreSQL function to calculate charges
  const { data, error } = await supabase
    .rpc('calculate_room_charges', { p_admission_id: admissionId });

  if (error) {
    logger.error('Failed to calculate room charges', { admissionId, error });
    throw createError('Failed to calculate room charges', 500);
  }

  res.json({
    success: true,
    data: data[0] || { total_days: 0, total_charges: 0, breakdown: [] }
  });
}));

export default router;
