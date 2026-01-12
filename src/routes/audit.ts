import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { generatePatientAuditPDF, generateAdmissionAuditPDF } from '../utils/pdf-generator.js';

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

router.post('/patient-audit', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { dateFrom, dateTo } = req.body;

  if (!dateFrom || !dateTo) {
    throw createError('dateFrom and dateTo are required', 400);
  }

  const startDate = new Date(dateFrom);
  const endDate = new Date(dateTo);
  endDate.setHours(23, 59, 59, 999);

  if (startDate >= endDate) {
    throw createError('dateFrom must be before dateTo', 400);
  }

  const { data: patients, error: patientsError } = await supabase
    .from('patients')
    .select('*')
    .eq('include_in_audit', true)
    .gte('created_at', startDate.toISOString())
    .lte('created_at', endDate.toISOString())
    .order('created_at', { ascending: true });

  if (patientsError) {
    logger.error('Failed to fetch patients for audit', { error: patientsError });
    throw createError('Failed to fetch patients for audit', 500);
  }

  if (!patients || patients.length === 0) {
    throw createError('No patients found for the specified date range with include_in_audit=true', 404);
  }

  const createdByIds = Array.from(new Set(patients.map((p) => p.created_by).filter(Boolean)));

  const { data: staffMembers, error: staffError } = createdByIds.length
    ? await supabase
        .from('staff')
        .select('id, first_name, last_name')
        .in('id', createdByIds)
    : { data: [], error: null };

  if (staffError) {
    logger.error('Failed to resolve staff for patient audit', { error: staffError });
    throw createError('Failed to resolve staff details for audit', 500);
  }

  const staffMap = new Map(
    (staffMembers ?? []).map((member) => {
      const fullName =
        `${member.first_name ?? ''} ${member.last_name ?? ''}`.trim() || 'Unknown Staff';
      return [member.id, { id: member.id, name: fullName }];
    })
  );

  const patientsWithStaff = patients.map((patient) => ({
    ...patient,
    staff: patient.created_by ? staffMap.get(patient.created_by) ?? null : null,
  }));

  const generatedBy = req.user?.email || 'Admin';

  const pdfBuffer = await generatePatientAuditPDF({
    patients: patientsWithStaff,
    dateFrom,
    dateTo,
    generatedBy,
  });

  const fileName = `Patient_Audit_${dateFrom}_to_${dateTo}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', pdfBuffer.length);

  logger.info('Patient audit PDF generated', {
    dateFrom,
    dateTo,
    patientCount: patientsWithStaff.length,
    generatedBy: req.user?.staff_id,
  });

  res.send(pdfBuffer);
}));

router.post('/admission-audit', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { dateFrom, dateTo } = req.body;

  if (!dateFrom || !dateTo) {
    throw createError('dateFrom and dateTo are required', 400);
  }

  const startDate = new Date(dateFrom);
  const endDate = new Date(dateTo);
  endDate.setHours(23, 59, 59, 999);

  if (startDate >= endDate) {
    throw createError('dateFrom must be before dateTo', 400);
  }

  const { data: admissions, error: admissionsError } = await supabase
    .from('admissions')
    .select(`
      id,
      admission_date,
      discharge_date,
      status,
      doctor_id,
      include_in_audit,
      created_at,
      patients!inner(
        id,
        patient_id,
        first_name,
        last_name,
        include_in_audit
      ),
      rooms(room_number, room_type)
    `)
    .eq('include_in_audit', true)
    .eq('patients.include_in_audit', true)
    .gte('created_at', startDate.toISOString())
    .lte('created_at', endDate.toISOString())
    .order('created_at', { ascending: true });

  if (admissionsError) {
    logger.error('Failed to fetch admissions for audit', { error: admissionsError });
    throw createError('Failed to fetch admissions for audit', 500);
  }

  if (!admissions || admissions.length === 0) {
    throw createError('No admissions found for the specified date range with include_in_audit=true', 404);
  }

  const staffIds = Array.from(new Set(admissions.map((admission) => admission.doctor_id).filter(Boolean)));

  const { data: staffMembers, error: staffError } = staffIds.length
    ? await supabase
        .from('staff')
        .select('id, first_name, last_name')
        .in('id', staffIds)
    : { data: [], error: null };

  if (staffError) {
    logger.error('Failed to resolve staff for audit admissions', { error: staffError });
    throw createError('Failed to resolve staff details for audit', 500);
  }

  const staffMap = new Map(
    (staffMembers ?? []).map((member) => {
      const fullName =
        `${member.first_name ?? ''} ${member.last_name ?? ''}`.trim() || 'Unknown Staff';
      return [member.id, { id: member.id, name: fullName }];
    })
  );

  const admissionsWithStaff = admissions.map((admission) => ({
    ...admission,
    doctor_staff: admission.doctor_id ? staffMap.get(admission.doctor_id) ?? null : null,
  }));

  const generatedBy = req.user?.email || 'Admin';

  const pdfBuffer = await generateAdmissionAuditPDF({
    admissions: admissionsWithStaff,
    dateFrom,
    dateTo,
    generatedBy,
  });

  const fileName = `Admission_Audit_${dateFrom}_to_${dateTo}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', pdfBuffer.length);

  logger.info('Admission audit PDF generated', {
    dateFrom,
    dateTo,
    admissionCount: admissions.length,
    generatedBy: req.user?.staff_id,
  });

  res.send(pdfBuffer);
}));

router.patch('/patients/:id/audit-status', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { include_in_audit } = req.body;

  if (typeof include_in_audit !== 'boolean') {
    throw createError('include_in_audit must be a boolean', 400);
  }

  const { data, error } = await supabase
    .from('patients')
    .update({ include_in_audit, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    logger.error('Failed to update patient audit status', { error, patientId: id });
    throw createError('Failed to update patient audit status', 500);
  }

  logger.info('Patient audit status updated', {
    patientId: id,
    include_in_audit,
    updatedBy: req.user?.staff_id,
  });

  res.json({
    success: true,
    data: { patient: data },
  });
}));

router.patch('/admissions/:id/audit-status', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { include_in_audit } = req.body;

  if (typeof include_in_audit !== 'boolean') {
    throw createError('include_in_audit must be a boolean', 400);
  }

  const { data, error } = await supabase
    .from('admissions')
    .update({ include_in_audit, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    logger.error('Failed to update admission audit status', { error, admissionId: id });
    throw createError('Failed to update admission audit status', 500);
  }

  logger.info('Admission audit status updated', {
    admissionId: id,
    include_in_audit,
    updatedBy: req.user?.staff_id,
  });

  res.json({
    success: true,
    data: { admission: data },
  });
}));

export default router;
