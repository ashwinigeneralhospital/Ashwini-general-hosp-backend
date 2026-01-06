import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireAdmin } from '../middlewares/auth.js';

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ROOM_SELECT = `
  *,
  beds (
    id,
    bed_number,
    bed_label,
    status,
    current_patient_id,
    rate_per_day,
    notes
  )
`;

const mapRoom = (room: any) => {
  const beds = room.beds || [];
  const occupiedBeds = beds.filter((bed: any) => bed.status === 'occupied').length;
  const totalBeds = beds.length;
  
  return {
    id: room.id,
    room_number: room.room_number,
    room_type: room.room_type,
    floor: room.floor,
    ward: room.ward ?? null,
    block: room.block ?? null,
    bed_label: room.bed_label ?? null,
    rate_per_day: room.rate_per_day,
    status: room.status ?? (room.is_available ? 'available' : 'occupied'),
    is_available: room.is_available,
    needs_cleaning: room.needs_cleaning ?? false,
    last_cleaned_at: room.last_cleaned_at ?? null,
    notes: room.notes ?? null,
    total_beds: totalBeds,
    occupied_beds: occupiedBeds,
    beds: beds.map((bed: any) => ({
      id: bed.id,
      bed_number: bed.bed_number,
      bed_label: bed.bed_label,
      status: bed.status,
      current_patient_id: bed.current_patient_id,
      rate_per_day: bed.rate_per_day,
      notes: bed.notes,
    })),
    current_patient: null, // Will be populated after migration
    latest_admission_id: null, // Will be populated after migration
  };
};

// Get all rooms with occupancy status
router.get('/', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('rooms')
    .select(ROOM_SELECT)
    .order('floor', { ascending: true })
    .order('room_number', { ascending: true });

  if (error) {
    throw createError('Failed to fetch rooms', 500);
  }

  res.json({
    success: true,
    data: { rooms: (data ?? []).map(mapRoom) }
  });
}));

// Get only available rooms for dropdown selection
router.get('/available', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('rooms')
    .select(ROOM_SELECT)
    .eq('status', 'available')
    .order('floor', { ascending: true })
    .order('room_number', { ascending: true });

  if (error) {
    throw createError('Failed to fetch available rooms', 500);
  }

  res.json({
    success: true,
    data: { rooms: (data ?? []).map(mapRoom) }
  });
}));

// Get single room by ID
router.get('/:id', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  
  const { data, error } = await supabase
    .from('rooms')
    .select(ROOM_SELECT)
    .eq('id', id)
    .single();

  if (error) {
    throw createError('Room not found', 404);
  }

  res.json({
    success: true,
    data: { room: mapRoom(data) }
  });
}));

// Create new room
router.post('/', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    room_number,
    room_type,
    floor,
    rate_per_day,
    ward,
    block,
    bed_label,
    status = 'available',
    notes,
  } = req.body;

  if (!room_number || !room_type || typeof floor !== 'number' || Number.isNaN(floor)) {
    throw createError('room_number, room_type, and floor are required', 400);
  }

  if (!['available', 'occupied', 'cleaning', 'maintenance'].includes(status)) {
    throw createError('Invalid room status', 400);
  }

  const { data, error } = await supabase
    .from('rooms')
    .insert({
      room_number,
      room_type,
      floor,
      rate_per_day: typeof rate_per_day === 'number' && !Number.isNaN(rate_per_day) ? rate_per_day : null,
      ward,
      block,
      bed_label,
      status,
      is_available: status === 'available',
      notes,
    })
    .select(ROOM_SELECT)
    .single();

  if (error || !data) {
    throw createError('Failed to create room', 500);
  }

  res.status(201).json({
    success: true,
    data: { room: mapRoom(data) },
  });
}));

// Update room
router.patch('/:id', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const {
    room_type,
    floor,
    rate_per_day,
    ward,
    block,
    bed_label,
    status,
    notes,
    current_patient_id,
    needs_cleaning,
    last_cleaned_at,
  } = req.body;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (room_type !== undefined) updates.room_type = room_type;
  if (floor !== undefined) updates.floor = floor;
  if (rate_per_day !== undefined) {
    if (rate_per_day === null || typeof rate_per_day === 'number' && !Number.isNaN(rate_per_day)) {
      updates.rate_per_day = rate_per_day;
    } else {
      throw createError('Invalid rate_per_day value', 400);
    }
  }
  if (ward !== undefined) updates.ward = ward;
  if (block !== undefined) updates.block = block;
  if (bed_label !== undefined) updates.bed_label = bed_label;
  if (notes !== undefined) updates.notes = notes;
  if (needs_cleaning !== undefined) updates.needs_cleaning = needs_cleaning;
  if (last_cleaned_at !== undefined) updates.last_cleaned_at = last_cleaned_at;

  if (status !== undefined) {
    if (!['available', 'occupied', 'cleaning', 'maintenance'].includes(status)) {
      throw createError('Invalid room status', 400);
    }
    updates.status = status;
    updates.is_available = status === 'available';
  }

  if (current_patient_id !== undefined) {
    if (current_patient_id === null) {
      updates.current_patient_id = null;
    } else {
      // Ensure patient exists
      const { data: patientExists, error: patientError } = await supabase
        .from('patients')
        .select('id')
        .eq('id', current_patient_id)
        .maybeSingle();

      if (patientError || !patientExists) {
        throw createError('Selected patient not found', 404);
      }
      updates.current_patient_id = current_patient_id;
    }
  }

  const { data, error } = await supabase
    .from('rooms')
    .update(updates)
    .eq('id', id)
    .select(ROOM_SELECT)
    .single();

  if (error || !data) {
    throw createError('Failed to update room', 500);
  }

  res.json({
    success: true,
    data: { room: mapRoom(data) },
  });
}));

// Delete room
router.delete('/:id', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const { data: activeAdmission } = await supabase
    .from('admissions')
    .select('id')
    .eq('room_id', id)
    .eq('status', 'active')
    .maybeSingle();

  if (activeAdmission) {
    throw createError('Cannot delete room with active admission', 400);
  }

  const { error } = await supabase.from('rooms').delete().eq('id', id);

  if (error) {
    throw createError('Failed to delete room', 500);
  }

  res.json({ success: true });
}));

export default router;
