import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, requireReception, AuthenticatedRequest } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env';

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

const buildR2ObjectUrl = (key?: string | null) => {
  if (!key) return null;
  const sanitized = key.replace(/^\/+/, '');
  return `https://${env.R2_BUCKET_NAME}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${sanitized}`;
};

const extractKeyFromUrl = (value?: string | null) => {
  if (!value) return null;
  if (!value.startsWith('http')) {
    return value.replace(/^\/+/, '');
  }
  try {
    const parsed = new URL(value);
    let key = parsed.pathname.replace(/^\/+/, '');
    if (!key) return null;
    return decodeURIComponent(key);
  } catch {
    return null;
  }
};

const deleteDocumentFromStorage = async (url?: string | null) => {
  const key = extractKeyFromUrl(url);
  if (!key) return;
  try {
    await r2.send(
      new DeleteObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: key,
      })
    );
  } catch (error) {
    logger.warn('Failed to delete patient document from storage', { url, error });
  }
};

const generateSignedDocumentUrl = async (storedValue?: string | null) => {
  const key = extractKeyFromUrl(storedValue);
  if (!key) return null;
  try {
    return await getSignedUrl(
      r2,
      new GetObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: key,
      }),
      { expiresIn: 60 * 60 * 24 * 7 }
    );
  } catch (error) {
    logger.warn('Failed to refresh patient document URL', { storedValue, error });
    return buildR2ObjectUrl(key);
  }
};

const attachDocumentUrls = async <T extends { aadhaar_url?: string | null; pan_url?: string | null }>(patient: T): Promise<T> => {
  const [aadhaarSigned, panSigned] = await Promise.all([
    generateSignedDocumentUrl(patient.aadhaar_url),
    generateSignedDocumentUrl(patient.pan_url),
  ]);

  return {
    ...patient,
    aadhaar_url: aadhaarSigned ?? buildR2ObjectUrl(extractKeyFromUrl(patient.aadhaar_url)),
    pan_url: panSigned ?? buildR2ObjectUrl(extractKeyFromUrl(patient.pan_url)),
  };
};

// Get all patients (with pagination)
router.get('/', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const search = req.query.search as string;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('patients')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,patient_id.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data, error, count } = await query;

  if (error) {
    throw createError('Failed to fetch patients', 500);
  }

  const patientsWithDocuments = await Promise.all((data ?? []).map(attachDocumentUrls));

  res.json({
    success: true,
    data: {
      patients: patientsWithDocuments,
      pagination: {
        page,
        limit,
        total: count,
        pages: Math.ceil((count || 0) / limit)
      }
    }
  });
}));

const PATIENT_WITH_RELATIONS = `
  *,
  admissions (
    id,
    admission_date,
    discharge_date,
    room_id,
    status,
    rooms (
      id,
      room_number,
      room_type,
      is_available
    )
  )
`;

// Get patient by ID or patient code
router.get('/:id', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const identifier = req.params.id;

  const fetchPatient = async (column: 'id' | 'patient_id') => {
    const { data, error } = await supabase
      .from('patients')
      .select(PATIENT_WITH_RELATIONS)
      .eq(column, identifier)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      throw createError('Failed to fetch patient', 500);
    }
    return data;
  };

  let patient = await fetchPatient('id');
  if (!patient) {
    patient = await fetchPatient('patient_id');
  }

  if (!patient) {
    throw createError('Patient not found', 404);
  }

  const patientWithDocuments = await attachDocumentUrls(patient);

  res.json({
    success: true,
    data: { patient: patientWithDocuments }
  });
}));

// Create new patient
router.post('/', authenticateToken, requireReception, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    first_name,
    last_name,
    date_of_birth,
    gender,
    phone,
    email,
    address,
    emergency_contact,
    emergency_phone,
    blood_group,
    allergies,
    medical_history,
    aadhaar_number,
    pan_number,
    aadhaar_url,
    pan_url,
    include_in_audit = true
  } = req.body;

  if (!first_name || !last_name || !date_of_birth || !gender || !phone) {
    throw createError('First name, last name, date of birth, gender, and phone are required', 400);
  }

  // Generate patient ID
  const { data: lastPatient } = await supabase
    .from('patients')
    .select('patient_id')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  let nextId = 1;
  if (lastPatient?.patient_id) {
    const lastNum = parseInt(lastPatient.patient_id.replace('P', ''));
    nextId = lastNum + 1;
  }

  const patient_id = `P${nextId.toString().padStart(6, '0')}`;

  const aadhaarKey = extractKeyFromUrl(aadhaar_number ? aadhaar_url : null) ?? extractKeyFromUrl(aadhaar_url);
  const panKey = extractKeyFromUrl(pan_number ? pan_url : null) ?? extractKeyFromUrl(pan_url);

  const { data, error } = await supabase
    .from('patients')
    .insert({
      patient_id,
      first_name,
      last_name,
      date_of_birth,
      gender,
      phone,
      email,
      address,
      emergency_contact,
      emergency_phone,
      blood_group,
      allergies,
      medical_history,
      aadhaar_number,
      pan_number,
      aadhaar_url: aadhaarKey,
      pan_url: panKey,
      include_in_audit,
      created_by: req.user!.staff_id
    })
    .select()
    .single();

  if (error) {
    logger.error('Failed to create patient', { error, userId: req.user!.id });
    throw createError('Failed to create patient', 500);
  }

  logger.info('Patient created', {
    patientId: data.id,
    patientNumber: patient_id,
    createdBy: req.user!.staff_id
  });

  const patientWithDocuments = await attachDocumentUrls(data);

  res.status(201).json({
    success: true,
    data: { patient: patientWithDocuments }
  });
}));

// Delete patient
router.delete('/:id', authenticateToken, requireReception, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('patients')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .single();

  if (error || !data) {
    throw createError('Patient not found or deletion failed', 404);
  }

  logger.info('Patient deleted', {
    patientId: data.id,
    deletedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { patient: data }
  });
}));

// Update patient
router.put('/:id', authenticateToken, requireReception, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    first_name,
    last_name,
    date_of_birth,
    gender,
    phone,
    email,
    address,
    emergency_contact,
    emergency_phone,
    blood_group,
    allergies,
    medical_history,
    aadhaar_number,
    pan_number,
    aadhaar_url,
    pan_url,
    include_in_audit
  } = req.body;

  const { data: existingPatient, error: fetchError } = await supabase
    .from('patients')
    .select('*, aadhaar_url, pan_url')
    .eq('id', req.params.id)
    .single();

  if (fetchError || !existingPatient) {
    throw createError('Patient not found', 404);
  }

  const { data, error } = await supabase
    .from('patients')
    .update({
      first_name,
      last_name,
      date_of_birth,
      gender,
      phone,
      email,
      address,
      emergency_contact,
      emergency_phone,
      blood_group,
      allergies,
      medical_history,
      aadhaar_number,
      pan_number,
      aadhaar_url,
      pan_url,
      include_in_audit,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) {
    throw createError('Patient not found or update failed', 404);
  }

  if (aadhaar_url !== undefined && aadhaar_url !== existingPatient.aadhaar_url) {
    await deleteDocumentFromStorage(existingPatient.aadhaar_url);
  }
  if (pan_url !== undefined && pan_url !== existingPatient.pan_url) {
    await deleteDocumentFromStorage(existingPatient.pan_url);
  }

  const patientWithDocuments = await attachDocumentUrls(data);

  logger.info('Patient updated', {
    patientId: data.id,
    updatedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { patient: patientWithDocuments }
  });
}));

// Toggle audit inclusion
router.patch('/:id/audit-inclusion', authenticateToken, requireReception, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { include_in_audit } = req.body;

  if (typeof include_in_audit !== 'boolean') {
    throw createError('include_in_audit must be a boolean', 400);
  }

  const updatePatient = async (column: 'id' | 'patient_id', value: string) => {
    return supabase
      .from('patients')
      .update({
        include_in_audit,
        updated_at: new Date().toISOString()
      })
      .eq(column, value)
      .select('id, patient_id, first_name, last_name, include_in_audit')
      .single();
  };

  let { data, error } = await updatePatient('id', req.params.id);

  if ((error || !data) && req.params.id.startsWith('P')) {
    ({ data, error } = await updatePatient('patient_id', req.params.id));
  }

  if (error || !data) {
    throw createError('Patient not found', 404);
  }

  logger.info('Patient audit inclusion updated', {
    patientId: data.id,
    patientNumber: data.patient_id,
    patientName: `${data.first_name ?? ''} ${data.last_name ?? ''}`.trim(),
    includeInAudit: include_in_audit,
    updatedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { patient: data }
  });
}));

export default router;
