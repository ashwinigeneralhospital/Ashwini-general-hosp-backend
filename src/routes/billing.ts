import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireBilling } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { sendEmail } from '../utils/mailer.js';
import { getHospitalLogoDataUri } from '../utils/logo.js';
import { env } from '../config/env.js';
import { mergeInvoiceWithLabReports } from '../utils/pdf-merger.js';
import { getSignedDownloadUrl } from '../utils/r2.js';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const INVOICE_SELECT = `
  *,
  admissions (
    id,
    admission_date,
    discharge_date,
    room_id,
    bed_id,
    patients (
      id,
      patient_id,
      first_name,
      last_name,
      phone,
      email
    ),
    rooms (
      id,
      room_number,
      room_type,
      rate_per_day
    )
  )
`;

const BILL_ITEM_SELECT = `
  *
`;

const ADMISSION_BASE_FIELDS = `
  id,
  patient_id,
  room_id,
  bed_id,
  doctor_id,
  admission_date,
  discharge_date,
  status,
  reason
`;

const fetchAdmissionWithRelations = async (admissionId: string) => {
  const { data: admission, error } = await supabase
    .from('admissions')
    .select(ADMISSION_BASE_FIELDS)
    .eq('id', admissionId)
    .single();

  if (error || !admission) {
    logger.error('Admission lookup failed', { admissionId, error });
    throw createError('Admission not found', 404);
  }

  const [
    patientResult,
    roomResult,
    bedResult,
    staffResult,
  ] = await Promise.all([
    admission.patient_id
      ? supabase
          .from('patients')
          .select('id, patient_id, first_name, last_name, date_of_birth, phone, email, gender')
          .eq('id', admission.patient_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    admission.room_id
      ? supabase
          .from('rooms')
          .select('id, room_number, room_type, floor')
          .eq('id', admission.room_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    admission.bed_id
      ? supabase
          .from('beds')
          .select('id, bed_number, bed_label')
          .eq('id', admission.bed_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    admission.doctor_id
      ? supabase
          .from('staff')
          .select('id, first_name, last_name, role, employment_role, department')
          .eq('id', admission.doctor_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const logRelationError = (relation: string, relationError: any) => {
    if (relationError) {
      logger.warn(`Failed to fetch ${relation} for admission`, {
        admissionId,
        error: relationError.message,
      });
    }
  };

  logRelationError('patient', patientResult.error);
  logRelationError('room', roomResult.error);
  logRelationError('bed', bedResult.error);
  logRelationError('staff', staffResult.error);

  const staffData = staffResult.data
    ? {
        ...staffResult.data,
        name: [staffResult.data.first_name, staffResult.data.last_name].filter(Boolean).join(' ').trim(),
      }
    : null;

  return {
    ...admission,
    patients: patientResult.data,
    rooms: roomResult.data,
    beds: bedResult.data,
    staff: staffData,
  };
};

const ensureMedicationBillItems = async (
  invoiceId: string,
  admissionId: string,
  currentItems: any[],
) => {
  const medicationRefs = new Set(
    currentItems
      .filter(
        (item) =>
          item?.item_type === 'medication' ||
          item?.item_name?.toLowerCase?.().includes('med'),
      )
      .map((item) => item.reference_id)
      .filter(Boolean),
  );

  const { data: medications, error: medicationsError } = await supabase
    .from('patient_medications')
    .select('*')
    .eq('admission_id', admissionId);

  if (medicationsError) {
    logger.warn('Failed to load medications for invoice sync', {
      invoiceId,
      admissionId,
      error: medicationsError.message,
    });
    return currentItems;
  }

  const newMedicationItems = (medications ?? [])
    .filter((med) => !medicationRefs.has(med.id))
    .map((med) => {
      const pricePerUnit = Number(med.price_per_unit ?? 0);
      const unitsPerDose = Number(med.units_per_dose ?? 1);
      const dosesGiven = Number(med.doses_administered ?? 0);
      const medTotal = pricePerUnit * unitsPerDose * dosesGiven;

      if (medTotal <= 0) {
        return null;
      }

      return {
        invoice_id: invoiceId,
        item_type: 'medication',
        item_name: med.name || 'Medication Charge',
        item_description: `Medication administered - ${dosesGiven} dose${dosesGiven === 1 ? '' : 's'}`,
        quantity: dosesGiven,
        unit_price: pricePerUnit * unitsPerDose,
        total_price: medTotal,
        reference_id: med.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    })
    .filter(Boolean) as any[];

  if (!newMedicationItems.length) {
    return currentItems;
  }

  const { data: insertedItems, error: insertError } = await supabase
    .from('bill_items')
    .insert(newMedicationItems)
    .select('*');

  if (insertError) {
    logger.error('Failed to persist medication bill items', {
      invoiceId,
      admissionId,
      error: insertError.message,
    });
    // Fall back to returning optimistic items (without DB IDs)
    return [...currentItems, ...newMedicationItems];
  }

  logger.info('Medication bill items synced', {
    invoiceId,
    admissionId,
    insertedCount: insertedItems?.length ?? 0,
  });

  // Recalculate invoice total after adding medication items
  const allItems = [...currentItems, ...(insertedItems ?? [])];
  const newTotal = allItems.reduce((sum, item) => sum + Number(item.total_price || 0), 0);

  const { error: updateError } = await supabase
    .from('invoices')
    .update({ total_amount: newTotal, updated_at: new Date().toISOString() })
    .eq('id', invoiceId);

  if (updateError) {
    logger.error('Failed to update invoice total after medication sync', {
      invoiceId,
      error: updateError.message,
    });
  } else {
    logger.info('Invoice total updated after medication sync', {
      invoiceId,
      newTotal,
    });
  }

  return allItems;
};

const ensureLabReportBillItems = async (
  invoiceId: string,
  admissionId: string,
  currentItems: any[],
) => {
  const labReportRefs = new Set(
    currentItems
      .filter((item) => item?.item_type === 'lab')
      .map((item) => item.reference_id)
      .filter(Boolean),
  );

  const { data: labReports, error: labReportsError } = await supabase
    .from('lab_reports')
    .select('*')
    .eq('admission_id', admissionId)
    .eq('billing_status', 'billed');

  if (labReportsError) {
    logger.warn('Failed to load lab reports for invoice sync', {
      invoiceId,
      admissionId,
      error: labReportsError.message,
    });
    return currentItems;
  }

  const newLabReportItems = (labReports ?? [])
    .filter((report) => !labReportRefs.has(report.id))
    .map((report) => {
      const price = Number(report.price ?? 0);

      if (price <= 0) {
        return null;
      }

      return {
        invoice_id: invoiceId,
        item_type: 'lab',
        item_name: report.report_title || report.type || 'Lab Report',
        item_description: report.report_description || `Lab test: ${report.type}`,
        quantity: 1,
        unit_price: price,
        total_price: price,
        reference_id: report.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    })
    .filter(Boolean) as any[];

  if (!newLabReportItems.length) {
    return currentItems;
  }

  const { data: insertedItems, error: insertError } = await supabase
    .from('bill_items')
    .insert(newLabReportItems)
    .select('*');

  if (insertError) {
    logger.error('Failed to persist lab report bill items', {
      invoiceId,
      admissionId,
      error: insertError.message,
    });
    return [...currentItems, ...newLabReportItems];
  }

  logger.info('Lab report bill items synced', {
    invoiceId,
    admissionId,
    insertedCount: insertedItems?.length ?? 0,
  });

  const allItems = [...currentItems, ...(insertedItems ?? [])];
  const newTotal = allItems.reduce((sum, item) => sum + Number(item.total_price || 0), 0);

  const { error: updateError } = await supabase
    .from('invoices')
    .update({ total_amount: newTotal, updated_at: new Date().toISOString() })
    .eq('id', invoiceId);

  if (updateError) {
    logger.error('Failed to update invoice total after lab report sync', {
      invoiceId,
      error: updateError.message,
    });
  } else {
    logger.info('Invoice total updated after lab report sync', {
      invoiceId,
      newTotal,
    });
  }

  return allItems;
};

// Get all invoices
router.get('/', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(50, parseInt(req.query.limit as string, 10) || 20);
  const statusFilter = (req.query.status as string) || '';
  const search = (req.query.search as string) || '';
  const offset = (page - 1) * limit;

  let query = supabase
    .from('invoices')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (statusFilter) {
    query = query.eq('status', statusFilter);
  }

  if (search) {
    query = query.ilike('invoice_number', `%${search}%`);
  }

  const { data: invoices, error, count } = await query;

  if (error) {
    logger.error('Failed to fetch invoices', { error, userId: req.user!.id });
    throw createError('Failed to fetch invoices', 500);
  }

  const invoiceList = invoices ?? [];
  const admissionIds = Array.from(new Set(invoiceList.map((invoice) => invoice.admission_id).filter(Boolean)));

  let admissionMap = new Map<string, any>();

  if (admissionIds.length > 0) {
    const { data: admissionsData, error: admissionsError } = await supabase
      .from('admissions')
      .select('id, admission_date, discharge_date, patient_id, room_id, bed_id, doctor_id')
      .in('id', admissionIds);

    if (admissionsError) {
      logger.error('Failed to fetch admissions for invoices', { error: admissionsError });
      throw createError('Failed to fetch invoices', 500);
    }

    const admissionsList = admissionsData ?? [];
    const patientIds = Array.from(new Set(admissionsList.map((adm) => adm.patient_id).filter(Boolean)));
    const roomIds = Array.from(new Set(admissionsList.map((adm) => adm.room_id).filter(Boolean)));

    const [patientsResponse, roomsResponse] = await Promise.all([
      patientIds.length
        ? supabase.from('patients').select('id, patient_id, first_name, last_name, phone, email').in('id', patientIds)
        : Promise.resolve({ data: [], error: null }),
      roomIds.length
        ? supabase.from('rooms').select('id, room_number, room_type').in('id', roomIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (patientsResponse.error || roomsResponse.error) {
      logger.error('Failed to fetch patient/room data for invoices', {
        patientError: patientsResponse.error,
        roomError: roomsResponse.error,
      });
      throw createError('Failed to fetch invoices', 500);
    }

    const patientMap = new Map((patientsResponse.data ?? []).map((patient) => [patient.id, patient]));
    const roomMap = new Map((roomsResponse.data ?? []).map((room) => [room.id, room]));

    admissionMap = new Map(
      admissionsList.map((admission) => [
        admission.id,
        {
          ...admission,
          patients: admission.patient_id ? patientMap.get(admission.patient_id) ?? null : null,
          rooms: admission.room_id ? roomMap.get(admission.room_id) ?? null : null,
        },
      ]),
    );
  }

  const invoicesWithRelations = invoiceList.map((invoice) => ({
    ...invoice,
    admissions: invoice.admission_id ? admissionMap.get(invoice.admission_id) ?? null : null,
  }));

  res.json({
    success: true,
    data: {
      invoices: invoicesWithRelations,
      pagination: {
        page,
        limit,
        total: count ?? 0,
        pages: Math.ceil((count ?? 0) / limit),
      },
    },
  });
}));

// Get invoices by patient ID with optional admission filter
router.get('/patient/:patientId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { patientId } = req.params;
  const admissionId = (req.query.admissionId as string) || null;

  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Failed to fetch patient invoices', {
      patientId,
      admissionId,
      error: error.message,
      details: error.details,
      hint: error.hint,
    });
    throw createError('Failed to fetch patient invoices', 500);
  }

  const admissionIds = Array.from(
    new Set((invoices ?? []).map((invoice) => invoice.admission_id).filter(Boolean))
  );

  const { data: admissionsData, error: admissionsError } = admissionIds.length
    ? await supabase
        .from('admissions')
        .select('id, admission_date, discharge_date, patient_id')
        .in('id', admissionIds)
    : { data: [], error: null };

  if (admissionsError) {
    logger.error('Failed to fetch admissions for invoices', {
      patientId,
      admissionId,
      error: admissionsError.message,
      details: admissionsError.details,
      hint: admissionsError.hint,
    });
    throw createError('Failed to fetch patient invoices', 500);
  }

  const patientIds = Array.from(
    new Set((admissionsData ?? []).map((admission) => admission.patient_id).filter(Boolean))
  );

  const { data: patientsData, error: patientsError } = patientIds.length
    ? await supabase
        .from('patients')
        .select('id, patient_id, first_name, last_name')
        .in('id', patientIds)
    : { data: [], error: null };

  if (patientsError) {
    logger.error('Failed to fetch patients for invoices', {
      patientId,
      admissionId,
      error: patientsError.message,
      details: patientsError.details,
      hint: patientsError.hint,
    });
    throw createError('Failed to fetch patient invoices', 500);
  }

  const admissionMap = new Map((admissionsData ?? []).map((admission) => [admission.id, admission]));
  const patientMap = new Map((patientsData ?? []).map((patient) => [patient.id, patient]));

  const invoicesWithRelations = (invoices ?? []).map((invoice) => {
    const admission = invoice.admission_id ? admissionMap.get(invoice.admission_id) : null;
    const patient = admission ? patientMap.get(admission.patient_id) : null;

    return {
      ...invoice,
      admissions: admission
        ? {
            ...admission,
            patients: patient
              ? {
                  id: patient.id,
                  patient_id: patient.patient_id,
                  first_name: patient.first_name,
                  last_name: patient.last_name,
                }
              : null,
          }
        : null,
    };
  });

  const filteredInvoices = invoicesWithRelations.filter((invoice) => {
    const admissionPatient = invoice.admissions?.patients;
    if (!admissionPatient) return false;
    return admissionPatient.id === patientId || admissionPatient.patient_id === patientId;
  });

  const finalInvoices =
    admissionId !== null
      ? filteredInvoices.filter((invoice) => invoice.admission_id === admissionId)
      : filteredInvoices;

  res.json({
    success: true,
    data: { invoices: finalInvoices },
  });
}));

// Get invoices by admission ID
router.get('/admission/:admissionId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { admissionId } = req.params;

  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('admission_id', admissionId)
    .order('created_at', { ascending: false });

  if (error) {
    throw createError('Failed to fetch admission invoices', 500);
  }

  // Fetch related data for each invoice
  const invoicesWithRelations = await Promise.all(
    invoices.map(async (invoice) => {
      const { data: admissionData } = await supabase
        .from('admissions')
        .select(`
          *,
          patients (
            id,
            patient_id,
            first_name,
            last_name,
            phone,
            email
          ),
          rooms (
            id,
            room_number,
            room_type,
            rate_per_day
          )
        `)
        .eq('id', invoice.admission_id)
        .single();

      return {
        ...invoice,
        admissions: admissionData
      };
    })
  );

  res.json({
    success: true,
    data: { invoices: invoicesWithRelations }
  });
}));

// Aggregate medication charges for a patient (optional admission filter)
router.get('/patient/:patientId/charges', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { patientId } = req.params;
  const admissionId = req.query.admissionId as string | undefined;

  let query = supabase
    .from('patient_medications')
    .select(`
      id,
      patient_id,
      admission_id,
      name,
      price_per_unit,
      units_per_dose,
      total_doses,
      doses_administered,
      last_administered_at,
      status,
      medication_catalog_id
    `)
    .eq('patient_id', patientId);

  if (admissionId) {
    query = query.eq('admission_id', admissionId);
  }

  const { data, error } = await query;

  if (error) {
    logger.error('Failed to fetch medication charges', {
      patientId,
      admissionId,
      error: error.message,
      details: error.details,
      hint: error.hint,
    });
    throw createError('Failed to fetch medication charges', 500);
  }

  const medicationsRaw = data ?? [];

  let catalogLookup: Record<string, { price_per_unit?: number | null; default_units_per_dose?: number | null }> = {};
  const catalogIds = Array.from(
    new Set(
      medicationsRaw
        .map((med) => med.medication_catalog_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
  );

  if (catalogIds.length > 0) {
    const { data: catalogData, error: catalogError } = await supabase
      .from('medication_catalog')
      .select('id, price_per_unit, default_units_per_dose')
      .in('id', catalogIds);

    if (catalogError) {
      logger.error('Failed to load medication catalog fallback data', {
        catalogIds,
        error: catalogError.message,
        details: catalogError.details,
        hint: catalogError.hint,
      });
      throw createError('Failed to fetch medication charges', 500);
    }

    catalogLookup = Object.fromEntries(
      (catalogData ?? []).map((catalog) => [
        catalog.id,
        {
          price_per_unit: catalog.price_per_unit,
          default_units_per_dose: catalog.default_units_per_dose,
        },
      ])
    );
  }

  const toNumber = (value: unknown, fallback: number): number => {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const medications = medicationsRaw.map((med) => {
    const catalog = med.medication_catalog_id ? catalogLookup[med.medication_catalog_id] : undefined;
    const catalogPrice = toNumber(catalog?.price_per_unit, 0);
    const catalogUnits = toNumber(catalog?.default_units_per_dose, 1);

    const directPrice = toNumber(med.price_per_unit, -1);
    const pricePerUnit = directPrice > 0 ? directPrice : catalogPrice;

    const directUnits = toNumber(med.units_per_dose, -1);
    const unitsPerDose = directUnits > 0 ? directUnits : catalogUnits || 1;

    const dosesGiven = Number(med.doses_administered ?? 0);
    const plannedDoses = med.total_doses ?? null;
    const totalCost = pricePerUnit * unitsPerDose * dosesGiven;

    return {
      id: med.id,
      name: med.name,
      status: med.status,
      admissionId: med.admission_id,
      pricePerUnit: pricePerUnit > 0 ? pricePerUnit : 0,
      unitsPerDose: unitsPerDose > 0 ? unitsPerDose : 1,
      dosesAdministered: dosesGiven,
      totalDoses: plannedDoses,
      remainingDoses: plannedDoses !== null ? Math.max(plannedDoses - dosesGiven, 0) : null,
      lastAdministeredAt: med.last_administered_at,
      totalCost,
    };
  });

  const medicationCost = medications.reduce((sum, med) => sum + med.totalCost, 0);

  res.json({
    success: true,
    data: {
      patientId,
      admissionId: admissionId ?? null,
      medicationCost,
      medications,
    },
  });
}));

// Create new invoice
router.post('/', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    admission_id,
    total_amount,
    status = 'pending'
  } = req.body;

  if (!admission_id || !total_amount) {
    throw createError('admission_id and total_amount are required', 400);
  }

  // Generate invoice number
  const { data: lastInvoice } = await supabase
    .from('invoices')
    .select('invoice_number')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  let nextId = 1;
  if (lastInvoice?.invoice_number) {
    const lastNum = parseInt(lastInvoice.invoice_number.replace('INV-', ''));
    nextId = lastNum + 1;
  }

  const invoice_number = `INV-${nextId.toString().padStart(6, '0')}`;

  const { data: newInvoice, error } = await supabase
    .from('invoices')
    .insert({
      admission_id,
      invoice_number,
      total_amount,
      status,
      generated_by: req.user!.staff_id
    })
    .select('*')
    .single();

  if (error) {
    logger.error('Failed to create invoice', { error, userId: req.user!.id });
    throw createError('Failed to create invoice', 500);
  }

  const admissionData = await fetchAdmissionWithRelations(admission_id);

  // Combine the data
  const invoiceWithRelations = {
    ...newInvoice,
    admissions: admissionData
  };

  logger.info('Invoice created', {
    invoiceId: invoiceWithRelations.id,
    invoiceNumber: invoice_number,
    createdBy: req.user!.staff_id
  });

  res.status(201).json({
    success: true,
    data: { invoice: invoiceWithRelations }
  });
}));

// Update invoice
router.put('/:id', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    total_amount,
    paid_amount,
    status
  } = req.body;

  const { data: updatedInvoice, error } = await supabase
    .from('invoices')
    .update({
      total_amount,
      paid_amount,
      status,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error || !updatedInvoice) {
    throw createError('Invoice not found or update failed', 404);
  }

  const admissionData = await fetchAdmissionWithRelations(updatedInvoice.admission_id);

  // Combine the data
  const invoiceWithRelations = {
    ...updatedInvoice,
    admissions: admissionData
  };

  logger.info('Invoice updated', {
    invoiceId: invoiceWithRelations.id,
    updatedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { invoice: invoiceWithRelations }
  });
}));

// Delete invoice
router.delete('/:id', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('invoices')
    .delete()
    .eq('id', req.params.id)
    .select('id, invoice_number')
    .single();

  if (error || !data) {
    throw createError('Invoice not found or deletion failed', 404);
  }

  logger.info('Invoice deleted', {
    invoiceId: data.id,
    invoiceNumber: data.invoice_number,
    deletedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { invoice: data }
  });
}));

// Get invoice with bill items
router.get('/:id/details', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', id)
    .single();

  if (invoiceError || !invoice) {
    throw createError('Invoice not found', 404);
  }

  logger.info('Fetching admission data for invoice', {
    invoiceId: id,
    admissionId: invoice.admission_id
  });

  // Fetch related admission and patient data manually
  try {
    const admissionData = await fetchAdmissionWithRelations(invoice.admission_id);
    logger.info('Admission data fetched', {
      invoiceId: id,
      admissionFound: !!admissionData,
      patientFound: !!admissionData?.patients,
      doctorId: admissionData?.doctor_id,
      admissionData: admissionData ? {
        id: admissionData.id,
        doctor_id: admissionData.doctor_id,
        hasDoctorId: !!admissionData.doctor_id
      } : null
    });

    const { data: billItems, error: itemsError } = await supabase
      .from('bill_items')
      .select(BILL_ITEM_SELECT)
      .eq('invoice_id', id)
      .order('created_at', { ascending: true });

    if (itemsError) {
      throw createError('Failed to fetch bill items', 500);
    }

    let finalBillItems = await ensureMedicationBillItems(
      invoice.id,
      invoice.admission_id,
      billItems ? [...billItems] : []
    );

    // Also ensure lab report bill items are included
    finalBillItems = await ensureLabReportBillItems(
      invoice.id,
      invoice.admission_id,
      finalBillItems
    );

    let medicationDetails: any[] = [];
    const medicationReferenceIds = finalBillItems
      .filter((item) => item.item_type === 'medication' && item.reference_id)
      .map((item) => item.reference_id as string);

    if (medicationReferenceIds.length) {
      const { data: medicationRecords, error: medicationFetchError } = await supabase
        .from('patient_medications')
        .select(
          `
            id,
            name,
            route,
            frequency,
            dose_unit,
            units_per_dose,
            doses_administered,
            price_per_unit,
            administered_at,
            notes
          `,
        )
        .in('id', medicationReferenceIds);

      if (medicationFetchError) {
        logger.warn('Failed to fetch medication details for invoice', {
          invoiceId: id,
          admissionId: invoice.admission_id,
          error: medicationFetchError.message,
        });
      } else {
        medicationDetails = medicationRecords ?? [];
      }
    }

    const invoiceWithRelations = {
      ...invoice,
      admissions: admissionData,
      billItems: finalBillItems,
      medicationDetails,
    };

    res.json({
      success: true,
      data: invoiceWithRelations,
    });
  } catch (fetchError: any) {
    logger.error('Failed to fetch admission data for invoice details', {
      invoiceId: id,
      admissionId: invoice.admission_id,
      error: fetchError?.message,
    });
    throw createError('Failed to fetch admission data', 500);
  }
}));

// Generate PDF invoice using PDFKit
router.get("/:id/pdf", authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  logger.info("Generating PDF for invoice", { invoiceId: id });

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", id)
    .single();

  if (invoiceError || !invoice) {
    logger.error("Invoice not found", { invoiceId: id, error: invoiceError });
    throw createError("Invoice not found", 404);
  }

  let admissionData = null;
  try {
    admissionData = await fetchAdmissionWithRelations(invoice.admission_id);
  } catch (admissionError: any) {
    logger.error("Admission data not found", { invoiceId: id, error: admissionError?.message });
    throw createError("Admission data not found for invoice", 404);
  }

  // Debug logging for admission data
  logger.info('Admission Data Debug', {
    invoiceId: id,
    admissionId: invoice.admission_id,
    admissionData,
    hasBeds: !!admissionData?.beds,
    hasRooms: !!admissionData?.rooms,
    bedId: admissionData?.bed_id,
    roomId: admissionData?.room_id,
    doctorId: admissionData?.doctor_id,
    bedsData: admissionData?.beds,
    roomsData: admissionData?.rooms
  });

  let staffName = "Unknown Doctor";
  if (admissionData?.doctor_id) {
    logger.info('Fetching staff data', { doctorId: admissionData.doctor_id });
    const { data: staff, error: staffError } = await supabase
      .from("staff")
      .select("first_name, last_name")
      .eq("id", admissionData.doctor_id)
      .single();

    if (staffError) {
      logger.error("Staff fetch error", { doctorId: admissionData.doctor_id, error: staffError });
    } else if (staff) {
      staffName = `${staff.first_name} ${staff.last_name}`;
      logger.info('Staff data found', { staffName, staff });
    } else {
      logger.warn('Staff not found', { doctorId: admissionData.doctor_id });
    }
  } else {
    logger.warn('No doctor_id in admission data', { admissionData });
  }

  // Calculate room charges based on admission duration and room type
  const calculateRoomCharges = (admission: any) => {
    const admissionDate = new Date(admission.admission_date);
    const dischargeDate = admission.discharge_date ? new Date(admission.discharge_date) : new Date();
    const totalDays = Math.ceil((dischargeDate.getTime() - admissionDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // Default room rates (can be fetched from database room rates)
    const roomRates = {
      'icu': 5000,
      'private': 3000,
      'general': 1500,
      'semi-private': 2000
    };
    
    // Get current room rate
    const roomType = (admission.rooms?.room_type as string)?.toLowerCase() || 'general';
    const currentRoomRate = admission.rooms?.rate_per_day || roomRates[roomType as keyof typeof roomRates] || roomRates.general;
    
    // For now, calculate based on current room type for entire stay
    // TODO: Implement room history tracking for multiple room types
    const totalRoomCharges = totalDays * currentRoomRate;
    
    logger.info('Room charges calculated', {
      admissionId: admission.id,
      totalDays,
      roomType: admission.rooms?.room_type,
      ratePerDay: currentRoomRate,
      totalCharges: totalRoomCharges,
      admissionDate: admission.admission_date,
      dischargeDate: admission.discharge_date
    });
    
    return {
      totalDays,
      roomType: admission.rooms?.room_type || 'general',
      ratePerDay: currentRoomRate,
      totalCharges: totalRoomCharges,
      breakdown: [{
        roomType: admission.rooms?.room_type || 'general',
        days: totalDays,
        ratePerDay: currentRoomRate,
        charges: totalRoomCharges
      }]
    };
  };

  const roomCharges = calculateRoomCharges(admissionData);

  const invoiceWithRelations = {
    ...invoice,
    admissions: admissionData
      ? {
          ...admissionData,
          staff: admissionData.doctor_id
            ? { id: admissionData.doctor_id, name: staffName }
            : null,
        }
      : null,
  };

  const { data: billItems, error: billItemsError } = await supabase
    .from("bill_items")
    .select("*")
    .eq("invoice_id", id);

  // Add room charges to bill items if not already present
  let finalBillItems = billItems || [];
  const hasRoomCharges = finalBillItems.some(item => 
    item.item_name?.toLowerCase().includes('room') || 
    item.description?.toLowerCase().includes('room')
  );

  if (!hasRoomCharges && roomCharges.totalCharges > 0) {
    const roomChargeItem = {
      id: `room-charge-${admissionData.id}`,
      invoice_id: id,
      item_name: `Room Charges - ${roomCharges.roomType.charAt(0).toUpperCase() + roomCharges.roomType.slice(1)} Room`,
      description: `${roomCharges.totalDays} days @ ${roomCharges.ratePerDay}/day`,
      quantity: roomCharges.totalDays,
      unit_price: roomCharges.ratePerDay,
      amount: roomCharges.totalCharges,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    finalBillItems.push(roomChargeItem);
    logger.info('Room charges added to bill items', { roomChargeItem });
  }

  if (billItemsError) {
    logger.error("Failed to fetch bill items", { invoiceId: id, error: billItemsError });
    throw createError("Failed to fetch bill items", 500);
  }

  try {
    const { generateInvoicePDF } = await import("../utils/pdf-generator.js");
    const pdfBuffer = await generateInvoicePDF({
      invoice: invoiceWithRelations,
      billItems: finalBillItems,
      patientName: `${invoiceWithRelations.admissions?.patients?.first_name || ""} ${invoiceWithRelations.admissions?.patients?.last_name || ""}`.trim(),
      doctorName: staffName,
    });

    logger.info("PDF generated successfully", {
      invoiceId: id,
      fileSize: pdfBuffer.length,
      invoiceNumber: invoice.invoice_number,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);

    res.send(pdfBuffer);
  } catch (error) {
    logger.error("PDF generation failed", { invoiceId: id, error });
    throw createError("Failed to generate PDF", 500);
  }
}));

// Get room usage charges for admission
router.get('/admission/:admissionId/room-charges', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { admissionId } = req.params;

  const { data, error } = await supabase
    .rpc('calculate_room_usage_billing', { p_admission_id: admissionId });

  if (error) {
    logger.error('Failed to calculate room charges', {
      admissionId,
      error: error.message
    });
    throw createError('Failed to calculate room charges', 500);
  }

  res.json({
    success: true,
    data: {
      admissionId,
      roomCharges: data ?? []
    }
  });
}));

// Get hospital services
router.get('/services', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const category = req.query.category as string;
  const active = req.query.active !== 'false';

  let query = supabase
    .from('hospital_services')
    .select('*')
    .eq('is_active', active)
    .order('service_name');

  if (category) {
    query = query.eq('service_category', category);
  }

  const { data, error } = await query;

  if (error) {
    throw createError('Failed to fetch hospital services', 500);
  }

  res.json({
    success: true,
    data: { services: data ?? [] }
  });
}));

// Create comprehensive invoice with bill items
router.post('/comprehensive', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    admission_id,
    bill_items = [],
    include_room_charges = true,
    include_medication_charges = true,
    include_lab_reports = false,
    custom_items = [],
    notes,
    medication_item_ids = [],
    lab_report_ids = []
  } = req.body;

  if (!admission_id) {
    throw createError('admission_id is required', 400);
  }

  const fetchAdmission = (column: 'id' | 'admission_code', value: string) =>
    supabase
      .from('admissions')
      .select('*')
      .eq(column, value)
      .maybeSingle();

  let admissionResult = await fetchAdmission('id', admission_id);
  if ((admissionResult.error && admissionResult.error.code !== 'PGRST116') || !admissionResult.data) {
    logger.warn('Admission lookup by ID failed, attempting fallback to admission_code', {
      admission_id,
      error: admissionResult.error?.message,
    });
    admissionResult = await fetchAdmission('admission_code', admission_id);
  }

  if (admissionResult.error || !admissionResult.data) {
    logger.error('Admission lookup failed for invoice generation', {
      admission_id,
      error: admissionResult.error?.message,
    });
    throw createError('Admission not found', 404);
  }

  const admission = admissionResult.data;

  let totalAmount = 0;
  const invoiceItems: any[] = [];

  // Add room charges if requested (using bed-specific pricing from room_history)
  if (include_room_charges) {
    const { data: roomChargesResult, error: roomChargesError } = await supabase
      .rpc('calculate_room_charges', { p_admission_id: admission_id });

    if (roomChargesError) {
      logger.warn('Failed to calculate room charges from room_history', { 
        admission_id, 
        error: roomChargesError.message 
      });
    } else if (roomChargesResult && roomChargesResult.length > 0) {
      const chargesSummary = roomChargesResult[0];
      const totalCharges = Number(chargesSummary.total_charges || 0);
      const breakdown = chargesSummary.breakdown || [];

      if (totalCharges > 0 && Array.isArray(breakdown) && breakdown.length > 0) {
        totalAmount += totalCharges;

        // Add individual breakdown items as separate line items
        breakdown.forEach((entry: any) => {
          const entryCharges = Number(entry.charges || 0);
          const entryDays = Number(entry.days || 0);
          const entryRate = Number(entry.rate_per_day || 0);

          if (entryCharges > 0) {
            invoiceItems.push({
              item_type: 'room',
              item_name: `Room/Bed - ${entry.room_type || 'N/A'}`,
              item_description: `Charges from ${new Date(entry.start_date).toLocaleDateString()} to ${entry.end_date ? new Date(entry.end_date).toLocaleDateString() : 'Present'}`,
              quantity: entryDays,
              unit_price: entryRate,
              total_price: entryCharges,
              date_from: entry.start_date,
              date_to: entry.end_date,
              reference_id: admission.room_id
            });
          }
        });
      }
    }
  }

  // Add medication charges if requested
  if (include_medication_charges) {
    let medicationQuery = supabase
      .from('patient_medications')
      .select('*')
      .eq('admission_id', admission_id);

    if (Array.isArray(medication_item_ids) && medication_item_ids.length > 0) {
      medicationQuery = medicationQuery.in('id', medication_item_ids);
    }

    const { data: medications, error: medError } = await medicationQuery;

    logger.info('Fetching medications for invoice', {
      admission_id,
      medication_item_ids,
      medicationsFound: medications?.length ?? 0,
      error: medError?.message
    });

    if (!medError && medications) {
      // Fetch catalog prices for medications that don't have direct prices
      const catalogIds = medications
        .filter(med => med.medication_catalog_id)
        .map(med => med.medication_catalog_id);
      
      let catalogLookup: Record<string, { price_per_unit?: number; default_units_per_dose?: number }> = {};
      
      if (catalogIds.length > 0) {
        const { data: catalogData } = await supabase
          .from('medication_catalog')
          .select('id, price_per_unit, default_units_per_dose')
          .in('id', catalogIds);
        
        if (catalogData) {
          catalogLookup = Object.fromEntries(
            catalogData.map(cat => [cat.id, {
              price_per_unit: cat.price_per_unit,
              default_units_per_dose: cat.default_units_per_dose
            }])
          );
        }
      }

      medications.forEach(med => {
        // Use catalog fallback if direct price is not set
        const catalog = med.medication_catalog_id ? catalogLookup[med.medication_catalog_id] : undefined;
        const directPrice = Number(med.price_per_unit ?? 0);
        const pricePerUnit = directPrice > 0 ? directPrice : Number(catalog?.price_per_unit ?? 0);
        
        const directUnits = Number(med.units_per_dose ?? 0);
        const unitsPerDose = directUnits > 0 ? directUnits : Number(catalog?.default_units_per_dose ?? 1);
        
        const dosesGiven = Number(med.doses_administered ?? 0);
        const medTotal = pricePerUnit * unitsPerDose * dosesGiven;
        
        logger.info('Processing medication for invoice', {
          medicationId: med.id,
          name: med.name,
          directPrice,
          catalogPrice: catalog?.price_per_unit,
          pricePerUnit,
          unitsPerDose,
          dosesGiven,
          medTotal
        });
        
        if (medTotal > 0) {
          totalAmount += medTotal;
          invoiceItems.push({
            item_type: 'medication',
            item_name: med.name,
            item_description: `Medication administered - ${dosesGiven} doses`,
            quantity: dosesGiven,
            unit_price: pricePerUnit * unitsPerDose,
            total_price: medTotal,
            reference_id: med.id
          });
        } else {
          logger.warn('Medication skipped due to zero total', {
            medicationId: med.id,
            name: med.name,
            pricePerUnit,
            unitsPerDose,
            dosesGiven,
            hasCatalogId: !!med.medication_catalog_id,
            catalogPrice: catalog?.price_per_unit
          });
        }
      });
    } else if (medError) {
      logger.error('Failed to fetch medications for invoice', {
        admission_id,
        error: medError.message
      });
    }
  }

  // Add lab report charges if requested
  if (include_lab_reports) {
    let labQuery = supabase
      .from('lab_reports')
      .select('id, report_title, test_type, price, billing_status')
      .eq('admission_id', admission_id)
      .eq('billing_status', 'pending');

    if (Array.isArray(lab_report_ids) && lab_report_ids.length > 0) {
      labQuery = labQuery.in('id', lab_report_ids);
    }

    const { data: labReports, error: labError } = await labQuery;

    logger.info('Fetching lab reports for invoice', {
      admission_id,
      lab_report_ids,
      labReportsFound: labReports?.length ?? 0,
      error: labError?.message
    });

    if (!labError && labReports) {
      labReports.forEach(report => {
        const reportPrice = Number(report.price ?? 0);
        
        logger.info('Processing lab report for invoice', {
          reportId: report.id,
          title: report.report_title,
          price: reportPrice
        });
        
        if (reportPrice > 0) {
          totalAmount += reportPrice;
          invoiceItems.push({
            item_type: 'lab',
            item_name: report.report_title || report.test_type || 'Lab Report',
            item_description: `Lab Test: ${report.test_type}`,
            quantity: 1,
            unit_price: reportPrice,
            total_price: reportPrice,
            reference_id: report.id
          });
        } else {
          logger.warn('Lab report skipped due to zero price', {
            reportId: report.id,
            title: report.report_title,
            price: reportPrice
          });
        }
      });
    } else if (labError) {
      logger.error('Failed to fetch lab reports for invoice', {
        admission_id,
        error: labError.message
      });
    }
  }

  // Add custom items
  custom_items.forEach((item: any) => {
    const itemTotal = Number(item.quantity || 1) * Number(item.unit_price || 0);
    totalAmount += itemTotal;
    invoiceItems.push({
      item_type: item.item_type || 'other',
      item_name: item.item_name,
      item_description: item.item_description,
      quantity: Number(item.quantity || 1),
      unit_price: Number(item.unit_price || 0),
      total_price: itemTotal,
      reference_id: item.reference_id
    });
  });

  if (totalAmount === 0) {
    throw createError('No billable items found', 400);
  }

  // Generate invoice number
  const { data: lastInvoice } = await supabase
    .from('invoices')
    .select('invoice_number')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  let nextId = 1;
  if (lastInvoice?.invoice_number) {
    const lastNum = parseInt(lastInvoice.invoice_number.replace('INV-', ''));
    nextId = lastNum + 1;
  }

  const invoice_number = `INV-${nextId.toString().padStart(6, '0')}`;

  // Separate items by type for JSONB storage
  const medicationItems = invoiceItems.filter(item => item.item_type === 'medication');
  const labItems = invoiceItems.filter(item => item.item_type === 'lab');
  const customItems = invoiceItems.filter(item => 
    item.item_type !== 'medication' && 
    item.item_type !== 'lab' && 
    item.item_type !== 'room'
  );

  // Create invoice
  const { data: newInvoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      admission_id,
      invoice_number,
      total_amount: totalAmount,
      status: 'pending',
      generated_by: req.user!.staff_id,
      medication_items: medicationItems,
      lab_items: labItems,
      custom_items: customItems
    })
    .select('*')
    .single();

  if (invoiceError) {
    logger.error('Failed to create invoice', { error: invoiceError, userId: req.user!.id });
    throw createError('Failed to create invoice', 500);
  }

  // Fetch related admission and patient data manually
  const { data: admissionData } = await supabase
    .from('admissions')
    .select(`
      *,
      patients (
        id,
        patient_id,
        first_name,
        last_name,
        date_of_birth,
        phone,
        email
      ),
      rooms (
        id,
        room_number,
        room_type,
        rate_per_day
      ),
      staff (
        id,
        name,
        role,
        employment_role,
        department
      )
    `)
    .eq('id', admission_id)
    .single();

  // Combine the data
  const invoiceWithRelations = {
    ...newInvoice,
    admissions: admissionData
  };

  // Create bill items
  const billItemsToInsert = invoiceItems.map(item => ({
    ...item,
    invoice_id: newInvoice.id
  }));

  const { error: itemsError } = await supabase
    .from('bill_items')
    .insert(billItemsToInsert);

  if (itemsError) {
    logger.error('Failed to create bill items', { error: itemsError });
    // Try to cleanup the invoice
    await supabase.from('invoices').delete().eq('id', newInvoice.id);
    throw createError('Failed to create bill items', 500);
  }

  // Mark lab reports as billed
  const labReportIdsInInvoice = invoiceItems
    .filter(item => item.item_type === 'lab' && item.reference_id)
    .map(item => item.reference_id);

  if (labReportIdsInInvoice.length > 0) {
    await supabase
      .from('lab_reports')
      .update({ billing_status: 'billed' })
      .in('id', labReportIdsInInvoice);
  }

  logger.info('Comprehensive invoice created', {
    invoiceId: newInvoice.id,
    invoiceNumber: invoice_number,
    totalAmount,
    itemsCount: billItemsToInsert.length,
    medicationItemsCount: medicationItems.length,
    labItemsCount: labItems.length,
    roomItemsCount: invoiceItems.filter(i => i.item_type === 'room').length,
    customItemsCount: customItems.length,
    createdBy: req.user!.staff_id
  });

  res.status(201).json({
    success: true,
    data: {
      invoice: invoiceWithRelations,
      billItems: billItemsToInsert,
      totalAmount
    }
  });
}));

// Add bill item to existing invoice
router.post('/:id/items', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const {
    item_type,
    item_name,
    item_description,
    quantity = 1,
    unit_price,
    reference_id
  } = req.body;

  if (!item_type || !item_name || !unit_price) {
    throw createError('item_type, item_name, and unit_price are required', 400);
  }

  const total_price = Number(quantity) * Number(unit_price);

  const { data: billItem, error } = await supabase
    .from('bill_items')
    .insert({
      invoice_id: id,
      item_type,
      item_name,
      item_description,
      quantity: Number(quantity),
      unit_price: Number(unit_price),
      total_price,
      reference_id
    })
    .select(BILL_ITEM_SELECT)
    .single();

  if (error) {
    throw createError('Failed to add bill item', 500);
  }

  // Update invoice total
  const { data: allItems } = await supabase
    .from('bill_items')
    .select('total_price')
    .eq('invoice_id', id);

  const newTotal = (allItems ?? []).reduce((sum, item) => sum + Number(item.total_price), 0);

  await supabase
    .from('invoices')
    .update({ 
      total_amount: newTotal,
      updated_at: new Date().toISOString()
    })
    .eq('id', id);

  res.status(201).json({
    success: true,
    data: { billItem }
  });
}));

// Update invoice payment status & financial details
router.patch('/:id/status', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    status,
    amount_paid,
    paid_amount,
    include_gst,
    gst_rate,
    gst_amount,
    total_with_gst,
    payment_method,
    payment_reference,
    payment_notes,
    discount_type,
    discount_value,
    discount_reason,
    last_payment_date,
  } = req.body;

  const { id } = req.params;
  const paidAmountValue = paid_amount ?? amount_paid;

  if (!status) {
    throw createError('status is required', 400);
  }

  const updateData: Record<string, any> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (paidAmountValue !== undefined) {
    updateData.paid_amount = Number(paidAmountValue);
    updateData.last_payment_date = last_payment_date ?? new Date().toISOString();
  }

  if (include_gst !== undefined) updateData.include_gst = Boolean(include_gst);
  if (gst_rate !== undefined) updateData.gst_rate = Number(gst_rate);
  if (gst_amount !== undefined) updateData.gst_amount = Number(gst_amount);
  if (total_with_gst !== undefined) updateData.total_with_gst = Number(total_with_gst);

  if (payment_method !== undefined) updateData.payment_method = payment_method || null;
  if (payment_reference !== undefined) updateData.payment_reference = payment_reference || null;
  if (payment_notes !== undefined) updateData.payment_notes = payment_notes || null;

  if (discount_type !== undefined) {
    updateData.discount_type = discount_type === 'none' ? null : discount_type;
  }
  if (discount_value !== undefined) updateData.discount_value = discount_value !== null ? Number(discount_value) : null;
  if (discount_reason !== undefined) updateData.discount_reason = discount_reason || null;

  const { data: updatedInvoice, error } = await supabase
    .from('invoices')
    .update(updateData)
    .eq('id', id)
    .select('*')
    .single();

  if (error || !updatedInvoice) {
    throw createError('Invoice not found or update failed', 404);
  }

  logger.info('Invoice payment status updated', {
    invoiceId: id,
    status,
    paid_amount: paidAmountValue,
    include_gst: updateData.include_gst,
    discount_type: updateData.discount_type,
    discount_value: updateData.discount_value,
    payment_method: updateData.payment_method,
    updatedBy: req.user?.id,
  });

  res.json({
    success: true,
    message: 'Payment status updated successfully',
    data: updatedInvoice,
  });
}));

// Update bill item
router.put('/items/:itemId', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { itemId } = req.params;
  const {
    item_name,
    item_description,
    quantity,
    unit_price
  } = req.body;

  const updateData: any = {};
  if (item_name !== undefined) updateData.item_name = item_name;
  if (item_description !== undefined) updateData.item_description = item_description;
  if (quantity !== undefined) updateData.quantity = Number(quantity);
  if (unit_price !== undefined) updateData.unit_price = Number(unit_price);

  if (quantity !== undefined || unit_price !== undefined) {
    const { data: currentItem } = await supabase
      .from('bill_items')
      .select('quantity, unit_price')
      .eq('id', itemId)
      .single();

    const newQuantity = quantity !== undefined ? Number(quantity) : Number(currentItem?.quantity || 1);
    const newUnitPrice = unit_price !== undefined ? Number(unit_price) : Number(currentItem?.unit_price || 0);
    updateData.total_price = newQuantity * newUnitPrice;
  }

  updateData.updated_at = new Date().toISOString();

  const { data: billItem, error } = await supabase
    .from('bill_items')
    .update(updateData)
    .eq('id', itemId)
    .select(`${BILL_ITEM_SELECT}, invoice_id`)
    .single();

  if (error || !billItem) {
    throw createError('Bill item not found or update failed', 404);
  }

  // Update invoice total
  const { data: allItems } = await supabase
    .from('bill_items')
    .select('total_price')
    .eq('invoice_id', billItem.invoice_id);

  const newTotal = (allItems ?? []).reduce((sum, item) => sum + Number(item.total_price), 0);

  await supabase
    .from('invoices')
    .update({ 
      total_amount: newTotal,
      updated_at: new Date().toISOString()
    })
    .eq('id', billItem.invoice_id);

  res.json({
    success: true,
    data: { billItem }
  });
}));

// Delete bill item
router.delete('/items/:itemId', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { itemId } = req.params;

  const { data: billItem, error } = await supabase
    .from('bill_items')
    .delete()
    .eq('id', itemId)
    .select('invoice_id, total_price')
    .single();

  if (error || !billItem) {
    throw createError('Bill item not found or deletion failed', 404);
  }

  // Update invoice total
  const { data: allItems } = await supabase
    .from('bill_items')
    .select('total_price')
    .eq('invoice_id', billItem.invoice_id);

  const newTotal = (allItems ?? []).reduce((sum, item) => sum + Number(item.total_price), 0);

  await supabase
    .from('invoices')
    .update({ 
      total_amount: newTotal,
    })
    .eq('id', billItem.invoice_id);

  res.json({
    success: true,
    data: { billItem }
  });
}));

// Generate HTML content for PDF
const generateInvoiceHTML = (invoice: any, billItems: any[]) => {
  const logoDataUri = getHospitalLogoDataUri();
  // Calculate age correctly
  const calculatePatientAge = (dateOfBirth: string) => {
    if (!dateOfBirth) return '-- years';
    
    const birthDate = new Date(dateOfBirth);
    const today = new Date();
    
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    // Adjust age if birthday hasn't occurred yet this year
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    
    return `${age} years`;
  };

  // Format gender for display
  const formatGender = (gender: string) => {
    if (!gender) return '--';
    return gender.charAt(0).toUpperCase() + gender.slice(1).toLowerCase();
  };

  // Calculate discount amounts for PDF
  const calculateDiscountAmountForPDF = () => {
    const baseAmount = Number(invoice.total_amount || 0);
    const discountType = invoice.discount_type || 'none';
    const discountValue = Number(invoice.discount_value || 0);
    
    if (discountType === 'percentage' && discountValue > 0) {
      return baseAmount * (discountValue / 100);
    } else if (discountType === 'fixed' && discountValue > 0) {
      return Math.min(discountValue, baseAmount);
    }
    return 0;
  };

  const calculateDiscountedTotalForPDF = () => {
    const baseAmount = Number(invoice.total_amount || 0);
    return baseAmount - calculateDiscountAmountForPDF();
  };

  const calculateGSTAmountForPDF = () => {
    if (!invoice.include_gst) return 0;
    const discountedTotal = calculateDiscountedTotalForPDF();
    return discountedTotal * 0.18;
  };

  const calculateTotalWithGSTForPDF = () => {
    const discountedTotal = calculateDiscountedTotalForPDF();
    return invoice.include_gst ? discountedTotal + calculateGSTAmountForPDF() : discountedTotal;
  };

  const discountAmount = calculateDiscountAmountForPDF();
  const discountedTotal = calculateDiscountedTotalForPDF();
  const gstAmount = calculateGSTAmountForPDF();
  const totalWithGST = calculateTotalWithGSTForPDF();

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Invoice ${invoice.invoice_number}</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          margin: 20px; 
          color: #000; 
          font-size: 12px;
          line-height: 1.2;
        }
        .header { 
          text-align: left; 
          margin-bottom: 20px; 
          border-bottom: 2px solid #000;
          padding-bottom: 10px;
        }
        .hospital-logo {
          float: left;
          margin-right: 15px;
          width: 60px;
          height: 60px;
        }
        .hospital-logo img {
          width: 60px !important;
          height: 60px !important;
          object-fit: contain;
          display: block;
          max-width: none !important;        }
        .hospital-info h1 { 
          margin: 0; 
          font-size: 18px; 
          font-weight: bold;
        }
        .hospital-info p { 
          margin: 2px 0; 
          font-size: 10px;
        }
        .patient-info { 
          width: 100%; 
          margin: 15px 0;
          border-collapse: collapse;
        }
        .patient-info td {
          padding: 2px 5px;
          font-size: 11px;
          vertical-align: top;
        }
        .patient-info .label {
          font-weight: bold;
          width: 80px;
        }
        .billing-table {
          width: 100%;
          border-collapse: collapse;
          margin: 20px 0;
          font-size: 10px;
        }
        .billing-table th,
        .billing-table td {
          border: 1px solid #000;
          padding: 5px;
          text-align: left;
        }
        .billing-table th {
          background-color: #f0f0f0;
          font-weight: bold;
        }
        .billing-table .amount-col {
          text-align: right;
          width: 80px;
        }
        .total-section {
          margin-top: 20px;
          text-align: right;
        }
        .total-line {
          margin: 5px 0;
          font-size: 11px;
        }
        .section-title {
          font-weight: bold;
          margin: 20px 0 10px 0;
          font-size: 12px;
          border-bottom: 1px solid #000;
          padding-bottom: 5px;
        }
        .detailed-breakup {
          width: 100%;
          border-collapse: collapse;
          margin: 10px 0;
          font-size: 9.5px;
          table-layout: fixed;
        }
        .detailed-breakup th,
        .detailed-breakup td {
          border: 1px solid #000;
          padding: 4px;
          text-align: left;
          vertical-align: top;
          word-break: break-word;
        }
        .detailed-breakup th {
          background-color: #f0f0f0;
          font-weight: bold;
        }
        .detailed-breakup th:nth-child(1) {
          width: 60px;
        }
        .detailed-breakup th:nth-child(2) {
          width: 120px;
        }
        .detailed-breakup .amount-col {
          text-align: right;
          width: 80px;
          white-space: nowrap;
        }
        .billing-details {
          text-align: center;
          font-weight: bold;
          font-size: 14px;
          margin: 20px 0;
          padding: 10px;
          border: 2px solid #000;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="hospital-logo">
          <img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAoACgDASIAAhEBAxEB/8QAGwAAAQUBAQAAAAAAAAAAAAAABQACAwQGAQf/xAAsEAACAQMDAwMEAQUAAAAAAAABAgMABBEFEiExQVEGImFxgZGhsRMUMsHR8P/EABgBAAMBAQAAAAAAAAAAAAAAAAABAgME/8QAHxEAAgICAgMBAAAAAAAAAAAAAAECEQMhEjFBUWFx/9oADAMBAAIRAxEAPwD3+iiigAooooAKKKKACiiigAooooAKKKKACiiigD//2Q==" alt="Ashwini General Hospital Logo" style="width: 60px; height: 60px; object-fit: contain; display: block;" />
        </div>
        <div class="hospital-info">
          <h1>${env.HOSPITAL_NAME}</h1>
          <p>${env.HOSPITAL_LEAD_PHYSICIAN}</p>
          <p>${env.HOSPITAL_ADDRESS}</p>
          <p>Phone: ${env.HOSPITAL_PHONE} | Email: ${env.HOSPITAL_EMAIL}</p>
          <p>${env.HOSPITAL_EMERGENCY_INFO}</p>
        </div>
      </div>

      <table class="patient-info">
        <tr>
          <td class="label">Patient:</td>
          <td>${invoice.admissions?.patients?.first_name || ''} ${invoice.admissions?.patients?.last_name || ''}</td>
          <td class="label">Age:</td>
          <td>${calculatePatientAge(invoice.admissions?.patients?.date_of_birth || '')}</td>
        </tr>
        <tr>
          <td class="label">Patient ID:</td>
          <td>${invoice.admissions?.patients?.patient_id || ''}</td>
          <td class="label">Gender:</td>
          <td>${formatGender(invoice.admissions?.patients?.gender || '')}</td>
        </tr>
        <tr>
          <td class="label">Invoice No:</td>
          <td>${invoice.invoice_number}</td>
          <td class="label">Date:</td>
          <td>${new Date(invoice.created_at).toLocaleDateString('en-GB')}</td>
        </tr>
        <tr>
          <td class="label">Admission:</td>
          <td>${new Date(invoice.admissions?.admission_date || '').toLocaleDateString('en-GB')}</td>
          <td class="label">Discharge:</td>
          <td>${invoice.admissions?.discharge_date ? new Date(invoice.admissions.discharge_date).toLocaleDateString('en-GB') : '--'}</td>
        </tr>
        <tr>
          <td class="label">Room:</td>
          <td>${invoice.admissions?.rooms?.room_number || ''} (${invoice.admissions?.rooms?.room_type || ''})</td>
          <td class="label">Doctor:</td>
          <td>${invoice.admissions?.staff?.name || 'Dr. Attending Physician'} (${invoice.admissions?.staff?.employment_role || 'General Physician'})</td>
        </tr>
      </table>

      <table class="billing-table">
        <thead>
          <tr>
            <th>Particulars</th>
            <th class="amount-col">Rate</th>
            <th class="amount-col">Qty</th>
            <th class="amount-col">Amount</th>
            <th class="amount-col">GST</th>
            <th class="amount-col">Total</th>
          </tr>
        </thead>
        <tbody>
          ${billItems.map(item => `
            <tr>
              <td>${item.item_name}</td>
              <td class="amount-col">${Number(item.unit_price).toFixed(2)}</td>
              <td class="amount-col">${item.quantity}</td>
              <td class="amount-col">${Number(item.total_price).toFixed(2)}</td>
              <td class="amount-col">${(Number(item.total_price) * 0.18).toFixed(2)}</td>
              <td class="amount-col">${(Number(item.total_price) * 1.18).toFixed(2)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div class="total-section">
        <div class="total-line"><strong>Subtotal: ${Number(invoice.total_amount || 0).toFixed(2)}</strong></div>
        ${discountAmount > 0 ? `<div class="total-line"><strong>Discount (${invoice.discount_type === 'percentage' ? invoice.discount_value + '%' : 'Fixed'}): -${discountAmount.toFixed(2)}</strong></div>` : ''}
        <div class="total-line"><strong>Discounted Total: ${discountedTotal.toFixed(2)}</strong></div>
        ${invoice.include_gst ? `<div class="total-line"><strong>GST (18%): ${gstAmount.toFixed(2)}</strong></div>` : ''}
        <div class="total-line"><strong>Total Bill Amount: ${totalWithGST.toFixed(2)}</strong></div>
        <div class="total-line">Amount Payable: ${totalWithGST.toFixed(2)}</div>
        <div class="total-line">Amount Paid: ${Number(invoice.paid_amount || 0).toFixed(2)}</div>
        <div class="total-line"><strong>Balance: ${(totalWithGST - Number(invoice.paid_amount || 0)).toFixed(2)}</strong></div>
        <div class="total-line"><strong>Payment Status: ${invoice.status.toUpperCase()}</strong></div>
      </div>

      <div class="section-title">DETAILED BREAKUP</div>
      
      <table class="detailed-breakup">
        <thead>
          <tr>
            <th>Code</th>
            <th>Date & Time</th>
            <th>Particulars</th>
            <th class="amount-col">Rate</th>
            <th class="amount-col">Qty</th>
            <th class="amount-col">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${billItems.map(item => `
            <tr>
              <td>${item.medical_code || 'N/A'}</td>
              <td>${new Date(item.created_at).toLocaleDateString('en-GB')}</td>
              <td>${item.item_name}</td>
              <td class="amount-col">${Number(item.unit_price).toFixed(2)}</td>
              <td class="amount-col">${item.quantity}</td>
              <td class="amount-col">${Number(item.total_price).toFixed(2)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div class="billing-details">PROVISIONAL BILL</div>
    </body>
    </html>
  `;
};

// Send invoice via email with PDF attachment
router.post('/:id/send-email', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const {
    email,
    subject,
    message,
    includeLabReports: includeLabReportsRaw,
    includeSummary: includeSummaryRaw,
  } = req.body;

  const includeLabReports = includeLabReportsRaw === true || includeLabReportsRaw === 'true';
  const includeSummary = includeSummaryRaw === true || includeSummaryRaw === 'true';

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', id)
    .single();

  if (invoiceError || !invoice) {
    throw createError('Invoice not found', 404);
  }

  let admissionData = null;
  try {
    admissionData = await fetchAdmissionWithRelations(invoice.admission_id);
  } catch (admissionError: any) {
    logger.error('Admission lookup failed for invoice email', { invoiceId: id, error: admissionError?.message });
    throw createError('Admission data not found', 404);
  }

  const { data: billItems, error: billItemsError } = await supabase
    .from('bill_items')
    .select('*')
    .eq('invoice_id', id)
    .order('created_at', { ascending: true });

  if (billItemsError) {
    logger.error('Bill items fetch failed for invoice email', { invoiceId: id, error: billItemsError });
    throw createError('Failed to load invoice items', 500);
  }

  const invoiceWithRelations = {
    ...invoice,
    admissions: admissionData,
  };

  const patientEmail = email || admissionData?.patients?.email;
  if (!patientEmail) {
    throw createError('Patient email not found', 400);
  }

  const patientName = `${admissionData?.patients?.first_name || ''} ${admissionData?.patients?.last_name || ''}`.trim() || 'Patient';
  const doctorName = admissionData?.staff?.name || 'Attending Doctor';
  const emailSubject = subject || `Invoice ${invoice.invoice_number} - ${env.HOSPITAL_NAME}`;
  const outstandingBase = Math.max(Number(invoice.total_amount || 0) - Number(invoice.paid_amount || 0), 0);
  const outstandingAmount = invoice.status === 'paid' ? 0 : outstandingBase;
  const textMessage =
    message ||
    `Dear ${patientName},

Please find your invoice ${invoice.invoice_number} attached for your records.

Total Amount: ₹${Number(invoice.total_amount || 0).toLocaleString('en-IN')}
Status: ${invoice.status}
Outstanding: ₹${outstandingAmount.toLocaleString('en-IN')}

If you have already settled this invoice, please ignore this message.

Regards,
${env.HOSPITAL_NAME}
${env.HOSPITAL_PHONE} | ${env.HOSPITAL_EMAIL}`;

  try {
    const { generateInvoicePDF } = await import('../utils/pdf-generator.js');
    let admissionSummary = null;
    if (includeSummary && invoice.admission_id) {
      const { data: summary } = await supabase
        .from('admission_summaries')
        .select('chief_complaint, diagnosis, treatment_provided, outcome, recommendations')
        .eq('admission_id', invoice.admission_id)
        .maybeSingle();
      admissionSummary = summary;
    }

    let pdfBuffer = await generateInvoicePDF({
      invoice: invoiceWithRelations,
      billItems: billItems || [],
      patientName,
      doctorName,
      admissionSummary,
    });

    if (includeLabReports) {
      const labBillItems = (billItems || []).filter((item) => item.item_type === 'lab' && item.reference_id);
      if (labBillItems.length > 0) {
        const labReportIds = labBillItems.map((item) => item.reference_id).filter(Boolean);
        const { data: labReports } = await supabase
          .from('lab_reports')
          .select('id, pdf_url, pdf_storage_path')
          .in('id', labReportIds);

        if (labReports && labReports.length > 0) {
          const labPdfUrls: string[] = [];
          for (const report of labReports) {
            if (report.pdf_url) {
              labPdfUrls.push(report.pdf_url);
            } else if (report.pdf_storage_path) {
              if (env.R2_PUBLIC_URL) {
                labPdfUrls.push(`${env.R2_PUBLIC_URL}/${report.pdf_storage_path}`);
              } else {
                const signedUrl = await getSignedDownloadUrl(report.pdf_storage_path, 3600);
                labPdfUrls.push(signedUrl);
              }
            }
          }
          if (labPdfUrls.length) {
            pdfBuffer = await mergeInvoiceWithLabReports(pdfBuffer, labPdfUrls);
          }
        }
      }
    }

    await sendEmail({
      to: patientEmail,
      subject: emailSubject,
      html: buildInvoiceEmailHtml({
        patientName,
        message: textMessage,
        invoiceNumber: invoice.invoice_number,
        status: invoice.status,
        totalAmount: Number(invoice.total_amount || 0),
        outstandingAmount,
        invoiceId: invoice.id,
      }),
      attachments: [
        {
          filename: `invoice-${invoice.invoice_number}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    logger.info('Invoice email sent', {
      invoiceId: id,
      invoiceNumber: invoice.invoice_number,
      recipient: patientEmail,
      sentBy: req.user?.staff_id,
    });

    res.json({
      success: true,
      data: {
        invoice_id: id,
        recipient: patientEmail,
      },
    });
  } catch (error) {
    logger.error('Failed to send invoice email', {
      invoiceId: id,
      error: error instanceof Error ? error.message : error,
    });
    throw createError('Failed to send invoice email', 500);
  }
}));

const escapeHtml = (value = ''): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatCurrencyINR = (amount: number): string =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(amount || 0);

const buildInvoiceEmailHtml = ({
  patientName,
  message,
  invoiceNumber,
  status,
  totalAmount,
  outstandingAmount,
  invoiceId,
}: {
  patientName: string;
  message: string;
  invoiceNumber: string;
  status: string;
  totalAmount: number;
  outstandingAmount: number;
  invoiceId: string;
}): string => {
  const formattedMessage = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p style="margin: 0 0 12px;">${escapeHtml(line)}</p>`)
    .join('');

  const invoiceUrl = `${env.PORTAL_URL}/admin/billing/${invoiceId}`;

  return `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #2c3e50; line-height: 1.6;">
      <p style="margin: 0 0 12px;">Dear ${escapeHtml(patientName)},</p>
      ${formattedMessage}
      <div style="margin: 24px 0; padding: 16px; border: 1px solid #dfe6e9; border-radius: 10px; background: #f8fbfc;">
        <h3 style="margin: 0 0 12px; color: #1a5f7a;">Invoice Summary</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tbody>
            <tr>
              <td style="padding: 6px 0; color: #7f8c8d;">Invoice #</td>
              <td style="padding: 6px 0; font-weight: 600;">${escapeHtml(invoiceNumber)}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #7f8c8d;">Status</td>
              <td style="padding: 6px 0; font-weight: 600; text-transform: capitalize;">${escapeHtml(status)}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #7f8c8d;">Total Amount</td>
              <td style="padding: 6px 0; font-weight: 600;">${formatCurrencyINR(totalAmount)}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #7f8c8d;">Outstanding</td>
              <td style="padding: 6px 0; font-weight: 600;">${formatCurrencyINR(Math.max(outstandingAmount, 0))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p style="margin: 0 0 16px;">You can also view or download this invoice online:</p>
      <p style="margin: 0 0 24px;">
        <a href="${invoiceUrl}" style="display: inline-block; padding: 10px 18px; background: #1a5f7a; color: #ffffff; text-decoration: none; border-radius: 6px;">View Invoice</a>
      </p>
      <p style="margin: 0 0 12px;">Regards,<br/>${escapeHtml(env.HOSPITAL_NAME)}<br/>${escapeHtml(env.HOSPITAL_PHONE)} | ${escapeHtml(env.HOSPITAL_EMAIL)}</p>
    </div>
  `;
};

export default router;
