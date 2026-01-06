import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PATIENT_FIELDS = 'id, patient_id, first_name, last_name, gender, email';
const ROOM_FIELDS = 'id, room_number, room_type, ward, floor, is_available';
const STAFF_FIELDS = 'id, first_name, last_name, role, email';

type RelatedMaps = {
  patients: Map<string, any>;
  rooms: Map<string, any>;
  staff: Map<string, any>;
};

const toAdmissionDocument = (record: any, maps: RelatedMaps) => {
  const patient = maps.patients.get(record.patient_id);
  const doctorId = record.doctor_id ?? record.admitted_by ?? null;
  const doctor = doctorId ? maps.staff.get(doctorId) : null;
  const room = record.room_id ? maps.rooms.get(record.room_id) : null;

  const doctorName = doctor
    ? `${doctor.first_name ?? ''} ${doctor.last_name ?? ''}`.trim()
    : '';

  const patientName = patient
    ? `${patient.first_name ?? ''} ${patient.last_name ?? ''}`.trim()
    : '';

  return {
    id: record.id,
    admissionId: record.admission_code ?? `A-${record.id?.slice(-6) ?? ''}`,
    patientIdRef: record.patient_id,
    patientLegacyId: patient?.patient_id ?? '',
    patientName,
    patientGender: patient?.gender ?? '',
    doctorIdRef: record.doctor_id ?? null,
    doctorName,
    roomIdRef: record.room_id ?? null,
    roomLabel: room
      ? `${room.room_number}${room.room_type ? ` - ${room.room_type}` : ''}`
      : '',
    date: record.admission_date,
    status: record.status,
    reason: record.reason ?? '',
    duration: record.duration ?? '',
    include_in_audit: record.include_in_audit ?? false,
    disease_details: record.disease_details ?? '',
    treatment_given: record.treatment_given ?? '',
    after_effects: record.after_effects ?? '',
    dischargeDate: record.discharge_date,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
};

router.get('/', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(50, parseInt(req.query.limit as string, 10) || 20);
  const statusFilter = (req.query.status as string) || '';
  const patientIdFilter = (req.query.patientId as string) || '';
  const search = (req.query.search as string) || '';
  const offset = (page - 1) * limit;

  let query = supabase
    .from('admissions')
    .select('*', { count: 'exact' })
    .order('admission_date', { ascending: false })
    .range(offset, offset + limit - 1);

  if (statusFilter) {
    query = query.eq('status', statusFilter);
  }

  if (patientIdFilter) {
    query = query.eq('patient_id', patientIdFilter);
  }

  if (search) {
    query = query.or(
      `patients.first_name.ilike.%${search}%,patients.last_name.ilike.%${search}%,patients.patient_id.ilike.%${search}%`
    );
  }

  const { data, error, count } = await query;

  if (error) {
    throw createError('Failed to fetch admissions', 500);
  }

  const admissionsData = data ?? [];
  const patientIds = Array.from(new Set(admissionsData.map((a) => a.patient_id).filter(Boolean)));
  const doctorIds = Array.from(new Set(admissionsData.map((a) => a.doctor_id ?? a.admitted_by).filter(Boolean)));
  const roomIds = Array.from(new Set(admissionsData.map((a) => a.room_id).filter(Boolean)));

  const [patientsResponse, doctorsResponse, roomsResponse] = await Promise.all([
    patientIds.length
      ? supabase.from('patients').select(PATIENT_FIELDS).in('id', patientIds)
      : Promise.resolve({ data: [], error: null }),
    doctorIds.length
      ? supabase.from('staff').select(STAFF_FIELDS).in('id', doctorIds)
      : Promise.resolve({ data: [], error: null }),
    roomIds.length
      ? supabase.from('rooms').select(ROOM_FIELDS).in('id', roomIds)
      : Promise.resolve({ data: [], error: null })
  ]);

  if (patientsResponse.error || doctorsResponse.error || roomsResponse.error) {
    throw createError('Failed to resolve admission relationships', 500);
  }

  const maps: RelatedMaps = {
    patients: new Map((patientsResponse.data ?? []).map((p) => [p.id, p])),
    rooms: new Map((roomsResponse.data ?? []).map((r) => [r.id, r])),
    staff: new Map((doctorsResponse.data ?? []).map((s) => [s.id, s])),
  };

  res.json({
    success: true,
    data: {
      admissions: admissionsData.map((record) => toAdmissionDocument(record, maps)),
      pagination: {
        page,
        limit,
        total: count ?? 0,
        pages: Math.ceil((count ?? 0) / limit),
      },
    },
  });
}));

router.post('/', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    patient_id,
    doctor_id,
    room_id,
    bed_id,
    admission_date,
    status = 'active',
    reason,
    duration,
    include_in_audit = false,
    disease_details,
    treatment_given,
    after_effects,
  } = req.body;

  if (!patient_id) {
    throw createError('patient_id is required', 400);
  }

  if (!['active', 'pending', 'completed', 'cancelled'].includes(status.toLowerCase())) {
    throw createError('Invalid status provided', 400);
  }
  const normalizedStatus = status.toLowerCase();

  if (room_id) {
    const { data: roomActive } = await supabase
      .from('admissions')
      .select('id')
      .eq('room_id', room_id)
      .eq('status', 'active')
      .maybeSingle();

    if (roomActive) {
      throw createError('Room already has an active admission', 400);
    }
  }

  const admissionPayload = {
    patient_id,
    doctor_id: doctor_id ?? req.user?.staff_id ?? null,
    room_id: room_id ?? null,
    bed_id: bed_id ?? null,
    admission_date: admission_date ? new Date(admission_date).toISOString() : new Date().toISOString(),
    status: normalizedStatus,
    reason: reason ?? null,
    duration: duration ?? null,
    include_in_audit: include_in_audit ?? false,
    disease_details: disease_details ?? null,
    treatment_given: treatment_given ?? null,
    after_effects: after_effects ?? null,
  };

  const { data, error } = await supabase
    .from('admissions')
    .insert(admissionPayload)
    .select('*')
    .single();

  if (error || !data) {
    throw createError('Failed to create admission', 500);
  }

  if (room_id) {
    const { error: roomUpdateError } = await supabase
      .from('rooms')
      .update({ 
        is_available: false,
        current_patient_id: patient_id,
        status: 'occupied'
      })
      .eq('id', room_id);

    if (roomUpdateError) {
      throw createError('Failed to update room availability', 500);
    }

    logger.info('Room assigned to patient', {
      roomId: room_id,
      patientId: patient_id,
      admissionId: data.id
    });
  }

  res.status(201).json({
    success: true,
    data: { admission: toAdmissionDocument(data, {
      patients: new Map(),
      rooms: new Map(),
      staff: new Map(),
    }) },
  });
}));

router.put('/:id', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { status, discharge_date, reason, duration, room_id, include_in_audit, disease_details, treatment_given, after_effects } = req.body;
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (status) {
    const normalizedStatus = status.toLowerCase();
    if (!['active', 'pending', 'completed', 'cancelled', 'discharged'].includes(normalizedStatus)) {
      throw createError('Invalid status provided', 400);
    }
    updates.status = normalizedStatus;
  }

  if (reason !== undefined) {
    updates.reason = reason;
  }

  if (duration !== undefined) {
    updates.duration = duration;
  }

  if (discharge_date) {
    updates.discharge_date = new Date(discharge_date).toISOString();
  } else if (status && ['completed', 'cancelled', 'discharged'].includes(status.toLowerCase())) {
    updates.discharge_date = new Date().toISOString();
  }

  if (room_id !== undefined) {
    updates.room_id = room_id;
  }

  if (include_in_audit !== undefined) {
    updates.include_in_audit = include_in_audit;
  }

  if (disease_details !== undefined) {
    updates.disease_details = disease_details;
  }

  if (treatment_given !== undefined) {
    updates.treatment_given = treatment_given;
  }

  if (after_effects !== undefined) {
    updates.after_effects = after_effects;
  }

  const { data, error } = await supabase
    .from('admissions')
    .update(updates)
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error || !data) {
    throw createError('Failed to update admission', 500);
  }

  // Handle room status updates when admission is discharged/cancelled
  if (data.room_id && (updates.status === 'completed' || updates.status === 'cancelled' || updates.status === 'discharged')) {
    const { error: roomUpdateError } = await supabase
      .from('rooms')
      .update({ 
        is_available: true,
        current_patient_id: null,
        status: 'available'
      })
      .eq('id', data.room_id);

    if (roomUpdateError) {
      throw createError('Failed to update room availability', 500);
    }

    logger.info('Room released from patient', {
      roomId: data.room_id,
      patientId: data.patient_id,
      admissionId: data.id,
      status: updates.status
    });
  }

  // Handle room changes when room_id is updated
  if (room_id !== undefined && room_id !== data.room_id) {
    // Release old room
    if (data.room_id) {
      await supabase
        .from('rooms')
        .update({ 
          is_available: true,
          current_patient_id: null,
          status: 'available'
        })
        .eq('id', data.room_id);
    }

    // Assign new room
    if (room_id) {
      await supabase
        .from('rooms')
        .update({ 
          is_available: false,
          current_patient_id: data.patient_id,
          status: 'occupied'
        })
        .eq('id', room_id);
    }
  }

  const patientIds = [data.patient_id].filter(Boolean);
  const doctorIds = [data.doctor_id ?? data.admitted_by].filter(Boolean);
  const roomIds = [data.room_id].filter(Boolean);

  const [patientsResponse, doctorsResponse, roomsResponse] = await Promise.all([
    patientIds.length
      ? supabase.from('patients').select(PATIENT_FIELDS).in('id', patientIds)
      : Promise.resolve({ data: [], error: null }),
    doctorIds.length
      ? supabase.from('staff').select(STAFF_FIELDS).in('id', doctorIds)
      : Promise.resolve({ data: [], error: null }),
    roomIds.length
      ? supabase.from('rooms').select(ROOM_FIELDS).in('id', roomIds)
      : Promise.resolve({ data: [], error: null })
  ]);

  const maps: RelatedMaps = {
    patients: new Map((patientsResponse.data ?? []).map((p) => [p.id, p])),
    rooms: new Map((roomsResponse.data ?? []).map((r) => [r.id, r])),
    staff: new Map((doctorsResponse.data ?? []).map((s) => [s.id, s])),
  };

  res.json({
    success: true,
    data: { admission: toAdmissionDocument(data, maps) },
  });
}));

router.delete('/:id', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data: existing, error: fetchError } = await supabase
    .from('admissions')
    .select('room_id')
    .eq('id', req.params.id)
    .maybeSingle();

  if (fetchError) {
    throw createError('Unable to fetch admission', 500);
  }

  const { error } = await supabase.from('admissions').delete().eq('id', req.params.id);

  if (error) {
    throw createError('Failed to delete admission', 500);
  }

  if (existing?.room_id) {
    await supabase.from('rooms').update({ is_available: true }).eq('id', existing.room_id);
  }

  res.json({ success: true });
}));

export default router;
