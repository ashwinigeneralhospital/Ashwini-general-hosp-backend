import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireBilling } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

const normalizeStorageKey = (value?: string | null) => {
  if (!value) return null;

  const stripBucketPrefix = (key: string) => {
    let trimmed = key.replace(/^\/+/, '');
    const bucketPrefix = `${env.R2_BUCKET_NAME}/`;
    while (trimmed.startsWith(bucketPrefix)) {
      trimmed = trimmed.slice(bucketPrefix.length);
    }
    return trimmed;
  };

  const decodeValue = (raw: string) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };

  if (!value.startsWith('http')) {
    return stripBucketPrefix(decodeValue(value));
  }

  try {
    const parsed = new URL(value);
    return stripBucketPrefix(decodeValue(parsed.pathname));
  } catch {
    return null;
  }
};

const getSignedDocumentUrl = async (value?: string | null) => {
  const key = normalizeStorageKey(value);
  if (!key) return null;

  try {
    const command = new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
    });
    return await getSignedUrl(r2, command, { expiresIn: 3600 });
  } catch (error) {
    logger.error('Failed to sign document URL', { error, key });
    return null;
  }
};

const mapClaimsWithRelations = async (claimsList: any[]) => {
  const admissionIds = Array.from(new Set(claimsList.map((claim) => claim.admission_id).filter(Boolean)));
  const partnerIds = Array.from(new Set(claimsList.map((claim) => claim.tpa_partner_id).filter(Boolean)));

  let admissionsMap = new Map<string, any>();
  if (admissionIds.length) {
    const { data: admissionsData, error: admissionsError } = await supabase
      .from('admissions')
      .select(`
        id,
        admission_date,
        discharge_date,
        patients (
          id,
          patient_id,
          first_name,
          last_name
        )
      `)
      .in('id', admissionIds);

    if (admissionsError) {
      throw createError('Failed to fetch admissions for insurance claims', 500);
    }

    admissionsMap = new Map((admissionsData ?? []).map((admission) => [admission.id, admission]));
  }

  let partnersMap = new Map<string, any>();
  if (partnerIds.length) {
    const { data: partnersData, error: partnersError } = await supabase
      .from('tpa_partners')
      .select('id, name, contact_person, phone, email, is_active')
      .in('id', partnerIds);

    if (partnersError) {
      throw createError('Failed to fetch TPA partners for claims', 500);
    }

    partnersMap = new Map((partnersData ?? []).map((partner) => [partner.id, partner]));
  }

  return await Promise.all(claimsList.map(async (claim) => {
    const admission = claim.admission_id ? admissionsMap.get(claim.admission_id) : null;
    const patient = admission?.patients;
    const partner = claim.tpa_partner_id ? partnersMap.get(claim.tpa_partner_id) : null;

    return {
      id: claim.id,
      admissionId: claim.admission_id,
      tpaPartnerId: claim.tpa_partner_id,
      claimNumber: claim.claim_number,
      claimAmount: Number(claim.claim_amount ?? 0),
      approvedAmount: claim.approved_amount !== null ? Number(claim.approved_amount) : null,
      status: claim.status,
      documentsUrl: await getSignedDocumentUrl(claim.documents_url),
      documentsKey: normalizeStorageKey(claim.documents_url),
      createdAt: claim.created_at,
      updatedAt: claim.updated_at,
      notes: claim.notes,
      createdBy: claim.created_by,
      admission: admission
        ? {
            id: admission.id,
            admissionDate: admission.admission_date,
            dischargeDate: admission.discharge_date
          }
        : null,
      patient: patient
        ? {
            id: patient.id,
            patientId: patient.patient_id,
            firstName: patient.first_name,
            lastName: patient.last_name,
            fullName: `${patient.first_name ?? ''} ${patient.last_name ?? ''}`.trim()
          }
        : null,
      tpaPartner: partner
        ? {
            id: partner.id,
            name: partner.name,
            contactPerson: partner.contact_person,
            email: partner.email,
            phone: partner.phone,
            isActive: partner.is_active
          }
        : null
    };
  }));
};

const auditClaimAction = (action: string, payload: Record<string, any>) => {
  logger.info(`Insurance claim ${action}`, payload);
};

router.get('/claims', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data: claimsData, error: claimsError } = await supabase
    .from('insurance_claims')
    .select('*')
    .order('created_at', { ascending: false });

  if (claimsError) {
    logger.error('Failed to fetch insurance claims', { claimsError, userId: req.user?.id });
    throw createError('Failed to fetch insurance claims', 500);
  }

  const claims = await mapClaimsWithRelations(claimsData ?? []);

  res.json({
    success: true,
    data: { claims }
  });
}));

router.get('/claims/:id', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const { data: claim, error } = await supabase
    .from('insurance_claims')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !claim) {
    throw createError('Insurance claim not found', 404);
  }

  const [claimWithRelations] = await mapClaimsWithRelations([claim]);

  res.json({
    success: true,
    data: { claim: claimWithRelations }
  });
}));

router.get('/claims/admission/:admissionId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { admissionId } = req.params;

  const { data: claimsData, error } = await supabase
    .from('insurance_claims')
    .select('*')
    .eq('admission_id', admissionId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Failed to fetch insurance claims by admission', { error, admissionId, userId: req.user?.id });
    throw createError('Failed to fetch insurance claims for admission', 500);
  }

  const claims = await mapClaimsWithRelations(claimsData ?? []);

  res.json({
    success: true,
    data: { claims }
  });
}));

router.get('/tpa', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('tpa_partners')
    .select('*')
    .order('name', { ascending: true });

  if (error) {
    logger.error('Failed to fetch TPA partners', { error, userId: req.user?.id });
    throw createError('Failed to fetch TPA partners', 500);
  }

  const tpaPartners = (data ?? []).map((partner) => ({
    id: partner.id,
    name: partner.name,
    contactPerson: partner.contact_person,
    email: partner.email,
    phone: partner.phone,
    isActive: partner.is_active,
    createdAt: partner.created_at
  }));

  res.json({
    success: true,
    data: { tpaPartners }
  });
}));

router.post('/tpa', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { name, contact_person, phone, email, is_active = true } = req.body;

  if (!name) {
    throw createError('TPA partner name is required', 400);
  }

  const { data: partner, error } = await supabase
    .from('tpa_partners')
    .insert({
      name,
      contact_person: contact_person || null,
      phone: phone || null,
      email: email || null,
      is_active,
      created_at: new Date().toISOString()
    })
    .select('*')
    .single();

  if (error || !partner) {
    logger.error('Failed to create TPA partner', { error, userId: req.user?.id });
    throw createError('Failed to create TPA partner', 500);
  }

  logger.info('TPA partner created', {
    partnerId: partner.id,
    partnerName: partner.name,
    createdBy: req.user?.staff_id || req.user?.id
  });

  res.status(201).json({
    success: true,
    data: { tpaPartner: partner }
  });
}));

router.post('/claims', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    admission_id,
    tpa_partner_id,
    claim_amount,
    documents_url,
    notes,
    status = 'submitted'
  } = req.body;

  if (!admission_id || !claim_amount) {
    throw createError('admission_id and claim_amount are required', 400);
  }

  const allowedStatuses = ['submitted', 'approved', 'rejected', 'settled'];
  if (!allowedStatuses.includes(status)) {
    throw createError('Invalid claim status', 400);
  }

  const { data: lastClaim } = await supabase
    .from('insurance_claims')
    .select('claim_number')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  let nextClaimNumber = 'CLM-000001';
  if (lastClaim?.claim_number) {
    const lastNumber = parseInt(lastClaim.claim_number.replace('CLM-', ''), 10);
    nextClaimNumber = `CLM-${(lastNumber + 1).toString().padStart(6, '0')}`;
  }

  const { data: newClaim, error } = await supabase
    .from('insurance_claims')
    .insert({
      admission_id,
      tpa_partner_id: tpa_partner_id || null,
      claim_number: nextClaimNumber,
      claim_amount,
      documents_url: normalizeStorageKey(documents_url) || null,
      status,
      notes: notes || null,
      created_by: req.user?.staff_id || req.user?.id
    })
    .select('*')
    .single();

  if (error) {
    logger.error('Failed to create insurance claim', { error, userId: req.user?.id });
    throw createError('Failed to create insurance claim', 500);
  }

  auditClaimAction('created', {
    claimId: newClaim.id,
    claimNumber: newClaim.claim_number,
    createdBy: req.user?.staff_id || req.user?.id
  });

  const [claimWithRelations] = await mapClaimsWithRelations([newClaim]);

  res.status(201).json({
    success: true,
    data: { claim: claimWithRelations }
  });
}));

router.put('/claims/:id', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const {
    admission_id,
    tpa_partner_id,
    claim_amount,
    approved_amount,
    documents_url,
    notes,
    status
  } = req.body;

  const allowedStatuses = ['submitted', 'approved', 'rejected', 'settled'];
  if (status && !allowedStatuses.includes(status)) {
    throw createError('Invalid claim status', 400);
  }

  const updatePayload: Record<string, any> = {
    updated_at: new Date().toISOString()
  };

  if (admission_id !== undefined) updatePayload.admission_id = admission_id;
  if (tpa_partner_id !== undefined) updatePayload.tpa_partner_id = tpa_partner_id;
  if (claim_amount !== undefined) updatePayload.claim_amount = claim_amount;
  if (approved_amount !== undefined) updatePayload.approved_amount = approved_amount;
  if (documents_url !== undefined) updatePayload.documents_url = documents_url ? normalizeStorageKey(documents_url) : null;
  if (notes !== undefined) updatePayload.notes = notes;
  if (status !== undefined) updatePayload.status = status;

  const { data: updatedClaim, error } = await supabase
    .from('insurance_claims')
    .update(updatePayload)
    .eq('id', id)
    .select('*')
    .single();

  if (error || !updatedClaim) {
    throw createError('Insurance claim not found or update failed', 404);
  }

  auditClaimAction('updated', {
    claimId: id,
    updatedBy: req.user?.staff_id || req.user?.id
  });

  const [claimWithRelations] = await mapClaimsWithRelations([updatedClaim]);

  res.json({
    success: true,
    data: { claim: claimWithRelations }
  });
}));

router.patch('/claims/:id/status', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { status, approved_amount, notes } = req.body;

  const allowedStatuses = ['submitted', 'approved', 'rejected', 'settled'];
  if (!allowedStatuses.includes(status)) {
    throw createError('Invalid claim status', 400);
  }

  const { data: updatedClaim, error } = await supabase
    .from('insurance_claims')
    .update({
      status,
      approved_amount: approved_amount ?? null,
      notes: notes ?? null,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select('*')
    .single();

  if (error || !updatedClaim) {
    throw createError('Insurance claim not found or update failed', 404);
  }

  auditClaimAction('status-updated', {
    claimId: id,
    status,
    updatedBy: req.user?.staff_id || req.user?.id
  });

  const [claimWithRelations] = await mapClaimsWithRelations([updatedClaim]);

  res.json({
    success: true,
    data: { claim: claimWithRelations }
  });
}));

router.delete('/claims/:id', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const { data: deletedClaim, error } = await supabase
    .from('insurance_claims')
    .delete()
    .eq('id', id)
    .select('id, claim_number')
    .single();

  if (error || !deletedClaim) {
    throw createError('Insurance claim not found or deletion failed', 404);
  }

  auditClaimAction('deleted', {
    claimId: id,
    claimNumber: deletedClaim.claim_number,
    deletedBy: req.user?.staff_id || req.user?.id
  });

  res.json({
    success: true,
    data: { claim: deletedClaim }
  });
}));

export default router;
