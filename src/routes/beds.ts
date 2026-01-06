import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireAdmin, requireMedicalStaff } from '../middlewares/auth.js';

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BED_SELECT = `
  id,
  room_id,
  bed_number,
  bed_label,
  status,
  current_patient_id,
  rate_per_day,
  notes,
  created_at,
  updated_at,
  room:rooms!beds_room_id_fkey (
    id,
    room_number,
    room_type,
    floor,
    ward,
    block,
    bed_number,
    total_beds,
    occupied_beds,
    status,
    rate_per_day
  ),
  current_patient:patients!beds_current_patient_id_fkey (
    id,
    patient_id,
    first_name,
    last_name,
    phone,
    email
  )
`;

const mapBed = (bed: any) => {
  console.log('Mapping bed:', bed);
  const result = {
    id: bed.id,
    roomId: bed.room_id,
    roomNumber: bed.room?.room_number,
    roomType: bed.room?.room_type,
    roomFloor: bed.room?.floor,
    roomWard: bed.room?.ward,
    roomBlock: bed.room?.block,
    roomTotalBeds: bed.room?.total_beds,
    roomOccupiedBeds: bed.room?.occupied_beds,
    roomStatus: bed.room?.status,
    bedNumber: bed.bed_number,
    bedLabel: bed.bed_label,
    status: bed.status,
    current_patient_id: bed.current_patient_id,
    rate_per_day: bed.rate_per_day,
    notes: bed.notes,
    currentPatientId: bed.current_patient?.id,
    currentPatientName: bed.current_patient
      ? `${bed.current_patient.first_name} ${bed.current_patient.last_name}`.trim()
      : null,
    currentPatientIdRef: bed.current_patient?.patient_id,
    currentPatientContact: bed.current_patient
      ? [bed.current_patient.phone, bed.current_patient.email].filter(Boolean).join(" • ")
      : null,
    createdAt: bed.created_at,
    updatedAt: bed.updated_at,
  };
  console.log('Mapped bed result:', result);
  return result;
};

// Get all beds with room and patient information
router.get('/', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('beds')
    .select(BED_SELECT)
    .order('room_number', { ascending: true })
    .order('bed_number', { ascending: true });

  if (error) {
    throw createError('Failed to fetch beds', 500);
  }

  res.json({
    success: true,
    data: { beds: (data ?? []).map(mapBed) }
  });
}));

// Get beds by room ID
router.get('/room/:roomId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { roomId } = req.params;

  const { data, error } = await supabase
    .from('beds')
    .select(BED_SELECT)
    .eq('room_id', roomId)
    .order('bed_number', { ascending: true });

  console.log('Beds query result for room:', roomId, { data, error });

  if (error) {
    throw createError('Failed to fetch room beds', 500);
  }

  res.json({
    success: true,
    data: { beds: (data ?? []).map(mapBed) }
  });
}));

// Get available beds (not occupied)
router.get('/available', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('beds')
    .select(BED_SELECT)
    .eq('status', 'available')
    .order('room_number', { ascending: true })
    .order('bed_number', { ascending: true });

  if (error) {
    throw createError('Failed to fetch available beds', 500);
  }

  res.json({
    success: true,
    data: { beds: (data ?? []).map(mapBed) }
  });
}));

// Create new bed
router.post('/', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    room_id,
    bed_number,
    bed_label,
    rate_per_day,
    status = 'available',
    notes,
  } = req.body;

  if (!room_id || !bed_number) {
    throw createError('room_id and bed_number are required', 400);
  }

  // Check if bed number already exists in the room
  const { data: existingBed } = await supabase
    .from('beds')
    .select('id')
    .eq('room_id', room_id)
    .eq('bed_number', bed_number)
    .maybeSingle();

  if (existingBed) {
    throw createError('Bed number already exists in this room', 409);
  }

  // Check if room exists and has capacity
  const { data: room } = await supabase
    .from('rooms')
    .select('id, total_beds, occupied_beds, rate_per_day')
    .eq('id', room_id)
    .maybeSingle();

  if (!room) {
    throw createError('Room not found', 404);
  }

  if (room.occupied_beds >= room.total_beds) {
    throw createError('Room is at full capacity', 409);
  }

  const { data, error } = await supabase
    .from('beds')
    .insert({
      room_id,
      bed_number,
      bed_label: bed_label || `Bed ${bed_number}`,
      rate_per_day: rate_per_day || room.rate_per_day,
      status,
      notes: notes || null,
    })
    .select(BED_SELECT)
    .single();

  if (error || !data) {
    throw createError('Failed to create bed', 500);
  }

  res.status(201).json({
    success: true,
    data: { bed: mapBed(data) }
  });
}));

// Update bed
router.patch('/:id', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const {
    bed_label,
    rate_per_day,
    status,
    notes,
    current_patient_id,
  } = req.body;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (bed_label !== undefined) updates.bed_label = bed_label;
  if (rate_per_day !== undefined) updates.rate_per_day = rate_per_day;
  if (notes !== undefined) updates.notes = notes;
  if (status !== undefined) {
    if (!['available', 'occupied', 'maintenance', 'cleaning'].includes(status)) {
      throw createError('Invalid bed status', 400);
    }
    updates.status = status;
  }

  if (current_patient_id !== undefined) {
    if (current_patient_id === null) {
      // Clear patient assignment
      updates.current_patient_id = null;
    } else {
      // Verify patient exists
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
    .from('beds')
    .update(updates)
    .eq('id', id)
    .select(BED_SELECT)
    .single();

  if (error || !data) {
    throw createError('Failed to update bed', 500);
  }

  res.json({
    success: true,
    data: { bed: mapBed(data) }
  });
}));

// Delete bed
router.delete('/:id', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  // Check if bed has active patient assignment
  const { data: bed } = await supabase
    .from('beds')
    .select('current_patient_id')
    .eq('id', id)
    .maybeSingle();

  if (bed?.current_patient_id) {
    throw createError('Cannot delete bed with active patient assignment', 400);
  }

  const { error } = await supabase
    .from('beds')
    .delete()
    .eq('id', id);

  if (error) {
    throw createError('Failed to delete bed', 500);
  }

  res.json({
    success: true,
    data: { message: 'Bed deleted successfully' }
  });
}));

// Assign patient to bed
router.post('/:id/assign-patient', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { patient_id } = req.body;

  if (!patient_id) {
    throw createError('patient_id is required', 400);
  }

  // Verify patient exists
  const { data: patient } = await supabase
    .from('patients')
    .select('id, patient_id, first_name, last_name')
    .eq('id', patient_id)
    .maybeSingle();

  if (!patient) {
    throw createError('Patient not found', 404);
  }

  // Check if bed is available
  const { data: bed } = await supabase
    .from('beds')
    .select('id, status, current_patient_id')
    .eq('id', id)
    .maybeSingle();

  if (!bed) {
    throw createError('Bed not found', 404);
  }

  if (bed.status !== 'available' || bed.current_patient_id) {
    throw createError('Bed is not available for assignment', 409);
  }

  const { data: updatedBed, error } = await supabase
    .from('beds')
    .update({
      current_patient_id: patient_id,
      status: 'occupied',
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select(BED_SELECT)
    .single();

  if (error || !updatedBed) {
    throw createError('Failed to assign patient to bed', 500);
  }

  res.json({
    success: true,
    data: { bed: mapBed(updatedBed) }
  });
}));

// Release patient from bed
router.post('/:id/release-patient', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const { data: bed } = await supabase
    .from('beds')
    .select('id, current_patient_id')
    .eq('id', id)
    .maybeSingle();

  if (!bed) {
    throw createError('Bed not found', 404);
  }

  if (!bed.current_patient_id) {
    throw createError('No patient assigned to this bed', 400);
  }

  const { data: updatedBed, error } = await supabase
    .from('beds')
    .update({
      current_patient_id: null,
      status: 'cleaning',
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select(BED_SELECT)
    .single();

  if (error || !updatedBed) {
    throw createError('Failed to release patient from bed', 500);
  }

  res.json({
    success: true,
    data: { bed: mapBed(updatedBed) }
  });
}));

export default router;
