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

  // First, close any existing room history entries
  await supabase
    .from('room_history')
    .update({ end_date: new Date().toISOString() })
    .eq('admission_id', admissionId)
    .is('end_date', null);

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
        room_type,
        rate_per_day
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
      updated_at: new Date().toISOString()
    })
    .eq('id', admissionId);

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

  const { data: updatedEntry, error } = await supabase
    .from('room_history')
    .update({
      room_id: roomId,
      bed_id: bedId,
      room_type: roomType,
      rate_per_day: ratePerDay,
      start_date: startDate,
      end_date: endDate,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select(`
      *,
      rooms (
        id,
        room_number,
        room_type,
        rate_per_day
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
