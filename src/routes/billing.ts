import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireBilling } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { sendEmail } from '../utils/mailer.js';
import puppeteer from 'puppeteer';

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
    .select('id, patient_id, admission_id, name, price_per_unit, units_per_dose, total_doses, doses_administered, last_administered_at, status')
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

  const medications = (data ?? []).map((med) => {
    const pricePerUnit = Number(med.price_per_unit ?? 0);
    const unitsPerDose = Number(med.units_per_dose ?? 1);
    const dosesGiven = Number(med.doses_administered ?? 0);
    const plannedDoses = med.total_doses ?? null;
    const totalCost = pricePerUnit * unitsPerDose * dosesGiven;

    return {
      id: med.id,
      name: med.name,
      status: med.status,
      admissionId: med.admission_id,
      pricePerUnit,
      unitsPerDose,
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
    .eq('id', updatedInvoice.admission_id)
    .single();

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
  const { data: admissionData, error: admissionError } = await supabase
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
      )
    `)
    .eq('id', invoice.admission_id)
    .single();

  // Try to fetch staff data separately if admission exists
  let staffData = null;
  if (admissionData && admissionData.doctor_id) {
    const { data: staff, error: staffError } = await supabase
      .from('staff')
      .select('id, first_name, last_name, role, employment_role, department')
      .eq('id', admissionData.doctor_id)
      .single();
    
    if (!staffError && staff) {
      staffData = {
        ...staff,
        name: `${staff.first_name} ${staff.last_name}`
      };
      logger.info('Staff data fetched', {
        invoiceId: id,
        staffId: staff.id,
        staffName: staffData.name
      });
    } else {
      logger.warn('Staff data not found', {
        invoiceId: id,
        doctorId: admissionData.doctor_id,
        error: staffError?.message
      });
    }
  }

  if (admissionError) {
    logger.error('Failed to fetch admission data', {
      invoiceId: id,
      admissionId: invoice.admission_id,
      error: admissionError.message
    });
  }

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

  // Combine the data
  const invoiceWithRelations = {
    ...invoice,
    admissions: {
      ...admissionData,
      staff: staffData
    },
    billItems: billItems || []
  };

  res.json({
    success: true,
    data: invoiceWithRelations
  });
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
    custom_items = [],
    notes
  } = req.body;

  if (!admission_id) {
    throw createError('admission_id is required', 400);
  }

  // Start transaction
  const { data: admission, error: admissionError } = await supabase
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

  if (admissionError || !admission) {
    throw createError('Admission not found', 404);
  }

  let totalAmount = 0;
  const invoiceItems: any[] = [];

  // Add room charges if requested
  if (include_room_charges) {
    const { data: roomCharges } = await supabase
      .rpc('calculate_room_usage_billing', { p_admission_id: admission_id });

    if (roomCharges && roomCharges.length > 0) {
      const roomCharge = roomCharges[0];
      const roomTotal = Number(roomCharge.total_amount || 0);
      totalAmount += roomTotal;
      
      invoiceItems.push({
        item_type: 'room',
        item_name: `Room ${roomCharge.room_name} - ${roomCharge.bed_label}`,
        item_description: `Room charges from ${new Date(roomCharge.start_date).toLocaleDateString()} to ${new Date(roomCharge.end_date).toLocaleDateString()}`,
        quantity: Number(roomCharge.total_days || 0),
        unit_price: Number(roomCharge.daily_rate || 0),
        total_price: roomTotal,
        date_from: roomCharge.start_date,
        date_to: roomCharge.end_date,
        reference_id: admission.room_id
      });
    }
  }

  // Add medication charges if requested
  if (include_medication_charges) {
    const { data: medications, error: medError } = await supabase
      .from('patient_medications')
      .select('*')
      .eq('admission_id', admission_id);

    if (!medError && medications) {
      medications.forEach(med => {
        const pricePerUnit = Number(med.price_per_unit ?? 0);
        const unitsPerDose = Number(med.units_per_dose ?? 1);
        const dosesGiven = Number(med.doses_administered ?? 0);
        const medTotal = pricePerUnit * unitsPerDose * dosesGiven;
        
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
        }
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

  // Create invoice
  const { data: newInvoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      admission_id,
      invoice_number,
      total_amount: totalAmount,
      status: 'pending',
      generated_by: req.user!.staff_id
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

  logger.info('Comprehensive invoice created', {
    invoiceId: newInvoice.id,
    invoiceNumber: invoice_number,
    totalAmount,
    itemsCount: billItemsToInsert.length,
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
          font-size: 24px;
          color: #000;
        }
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
          font-size: 9px;
        }
        .detailed-breakup th,
        .detailed-breakup td {
          border: 1px solid #000;
          padding: 3px;
          text-align: left;
        }
        .detailed-breakup th {
          background-color: #f0f0f0;
          font-weight: bold;
        }
        .detailed-breakup .amount-col {
          text-align: right;
          width: 60px;
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
        <div class="hospital-logo">🏥</div>
        <div class="hospital-info">
          <h1>Ashwini General Hospital</h1>
          <p>Main Road, City - 411001</p>
          <p>Phone: 9876543210</p>
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
              <td>${new Date(item.created_at).toLocaleDateString('en-GB')} ${new Date(item.created_at).toLocaleTimeString()}</td>
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

// Send invoice via email
router.post('/:id/send-email', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { email, subject, message } = req.body;

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', id)
    .single();

  if (invoiceError || !invoice) {
    throw createError('Invoice not found', 404);
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
        gender,
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
        first_name,
        last_name,
        role,
        employment_role,
        department
      )
    `)
    .eq('id', invoice.admission_id)
    .single();

  if (!admissionData) {
    throw createError('Admission data not found', 404);
  }

  // Fetch bill items
  const { data: billItems } = await supabase
    .from('bill_items')
    .select('*')
    .eq('invoice_id', id)
    .order('created_at', { ascending: true });

  // Combine the data
  const invoiceWithRelations = {
    ...invoice,
    admissions: {
      ...admissionData,
      staff: admissionData.staff ? {
        ...admissionData.staff,
        name: `${admissionData.staff.first_name} ${admissionData.staff.last_name}`
      } : null
    }
  };

  const patientEmail = email || admissionData.patients?.email;
  if (!patientEmail) {
    throw createError('Patient email not found', 400);
  }

  const patientName = `${invoiceWithRelations.admissions?.patients?.first_name || ''} ${invoiceWithRelations.admissions?.patients?.last_name || ''}`.trim();
  
  // Create email content
  const emailSubject = subject || `Invoice ${invoice.invoice_number} - Ashwini General Hospital`;
  const emailMessage = message || `Dear ${patientName},\n\nPlease find your invoice ${invoice.invoice_number} details below.\n\nTotal Amount: ₹${Number(invoice.total_amount).toLocaleString()}\nStatus: ${invoice.status}\n\nThank you for choosing Ashwini General Hospital.\n\nBest regards,\nBilling Department`;

  try {
    // Generate PDF invoice
    const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
      const htmlContent = generateInvoiceHTML(invoiceWithRelations, billItems || []);
      
      puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      }).then(async (browser) => {
        try {
          const page = await browser.newPage();
          await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
          
          const pdfUint8Array = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: {
              top: '20px',
              right: '20px',
              bottom: '20px',
              left: '20px'
            }
          });
          
          await browser.close();
          resolve(Buffer.from(pdfUint8Array));
        } catch (error) {
          await browser.close();
          reject(error);
        }
      }).catch(reject);
    });

    // Send email with PDF attachment
    await sendEmail({
      to: patientEmail,
      subject: emailSubject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">Ashwini General Hospital</h2>
          <h3>Invoice ${invoice.invoice_number}</h3>
          <p><strong>Patient:</strong> ${patientName}</p>
          <p><strong>Invoice Date:</strong> ${new Date(invoice.created_at).toLocaleDateString()}</p>
          <p><strong>Total Amount:</strong> ₹${Number(invoice.total_amount).toLocaleString()}</p>
          <p><strong>Status:</strong> ${invoice.status}</p>
          
          <div style="margin: 30px 0; padding: 20px; background-color: #f8f9fa; border-left: 4px solid #2563eb; border-radius: 4px;">
            <p style="margin: 0; font-size: 16px; color: #333;">
              <strong>📎 Your invoice is attached to this email</strong>
            </p>
            <p style="margin: 10px 0 0; color: #666;">
              Please find the detailed invoice PDF attached above for your records. The PDF contains complete billing information including itemized charges, payment details, and hospital information.
            </p>
          </div>
          
          <p style="margin-top: 30px;">${emailMessage.replace(/\n/g, '<br>')}</p>
          
          <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; font-size: 12px; color: #6b7280;">
              This is an automated email from Ashwini General Hospital Billing System.
            </p>
            <p style="margin: 5px 0 0; font-size: 12px; color: #6b7280;">
              If you have any questions about your invoice, please contact our billing department.
            </p>
          </div>
        </div>
      `,
      attachments: [{
        filename: `Invoice_${invoice.invoice_number}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf'
      }]
    });

    logger.info('Invoice email sent', {
      invoiceId: id,
      invoiceNumber: invoice.invoice_number,
      recipientEmail: patientEmail,
      sentBy: req.user!.staff_id
    });

    res.json({
      success: true,
      message: 'Invoice email sent successfully',
      data: {
        recipientEmail: patientEmail,
        subject: emailSubject
      }
    });
  } catch (error) {
    logger.error('Failed to send invoice email', {
      invoiceId: id,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw createError('Failed to send email', 500);
  }
}));

// Generate invoice PDF using Puppeteer
router.get('/:id/pdf', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', id)
    .single();

  if (invoiceError || !invoice) {
    throw createError('Invoice not found', 404);
  }

  logger.info('Generating PDF for invoice', {
    invoiceId: id,
    admissionId: invoice.admission_id
  });

  // Fetch related admission and patient data manually
  const { data: admissionData, error: admissionError } = await supabase
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
      )
    `)
    .eq('id', invoice.admission_id)
    .single();

  // Try to fetch staff data separately if admission exists
  let staffData = null;
  if (admissionData && admissionData.doctor_id) {
    const { data: staff, error: staffError } = await supabase
      .from('staff')
      .select('id, first_name, last_name, role, employment_role, department')
      .eq('id', admissionData.doctor_id)
      .single();
    
    if (!staffError && staff) {
      staffData = {
        ...staff,
        name: `${staff.first_name} ${staff.last_name}`
      };
      logger.info('Staff data fetched', {
        invoiceId: id,
        staffId: staff.id,
        staffName: staffData.name
      });
    } else {
      logger.warn('Staff data not found', {
        invoiceId: id,
        doctorId: admissionData.doctor_id,
        error: staffError?.message
      });
    }
  }

  if (admissionError) {
    logger.error('Failed to fetch admission data for PDF', {
      invoiceId: id,
      admissionId: invoice.admission_id,
      error: admissionError.message
    });
  }

  logger.info('PDF admission data fetched', {
    invoiceId: id,
    admissionFound: !!admissionData,
    patientFound: !!admissionData?.patients,
    doctorId: admissionData?.doctor_id,
    staffFound: !!staffData,
    staffName: staffData?.name
  });

  const { data: billItems } = await supabase
    .from('bill_items')
    .select(BILL_ITEM_SELECT)
    .eq('invoice_id', id)
    .order('created_at', { ascending: true });

  // Combine the data
  const invoiceWithRelations = {
    ...invoice,
    admissions: {
      ...admissionData,
      staff: staffData
    }
  };

  const patientName = `${invoiceWithRelations.admissions?.patients?.first_name || ''} ${invoiceWithRelations.admissions?.patients?.last_name || ''}`.trim();
  
  // Calculate patient age from date of birth
const calculateAge = (dateOfBirth: string | null | undefined) => {
  if (!dateOfBirth) return '-- years';
  const birthDate = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return `${age} years`;
};

// Convert number to words for Indian currency
const numberToWords = (num: number): string => {
  if (num === 0) return 'Zero';
  
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  
  const convertLessThanOneThousand = (n: number): string => {
    if (n === 0) return '';
    if (n < 10) return ones[n];
    if (n < 20) return teens[n - 10];
    if (n < 100) {
      const ten = Math.floor(n / 10);
      const one = n % 10;
      return tens[ten] + (one ? ' ' + ones[one] : '');
    }
    const hundred = Math.floor(n / 100);
    const remainder = n % 100;
    return ones[hundred] + ' Hundred' + (remainder ? ' ' + convertLessThanOneThousand(remainder) : '');
  };
  
  if (num < 1000) return convertLessThanOneThousand(num);
  
  const lakh = Math.floor(num / 100000);
  const remainder = num % 100000;
  
  if (lakh > 0) {
    const lakhWords = convertLessThanOneThousand(lakh) + ' Lakh';
    if (remainder === 0) return lakhWords;
    return lakhWords + ' ' + convertLessThanOneThousand(remainder);
  }
  
  return convertLessThanOneThousand(remainder);
};

const convertAmountToWords = (amount: number): string => {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  
  let words = numberToWords(rupees) + ' Rupees';
  
  if (paise > 0) {
    words += ' and ' + numberToWords(paise) + ' Paise';
  }
  
  return words + ' Only';
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

// Generate HTML content for PDF
  const htmlContent = `
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
          font-size: 24px;
          color: #000;
        }
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
        .section-title {
          text-align: center;
          font-weight: bold;
          font-size: 14px;
          margin: 15px 0 10px 0;
          text-decoration: underline;
        }
        .provisional-bill {
          width: 100%;
          border-collapse: collapse;
          margin: 10px 0;
        }
        .provisional-bill th {
          border: 1px solid #000;
          padding: 5px;
          font-weight: bold;
          font-size: 11px;
          text-align: left;
          background-color: #f0f0f0;
        }
        .provisional-bill td {
          border: 1px solid #000;
          padding: 5px;
          font-size: 11px;
        }
        .amount-col {
          text-align: right;
          width: 80px;
        }
        .gst-section {
          margin: 15px 0;
          padding: 10px;
          border: 1px solid #ccc;
          border-radius: 5px;
        }
        .gst-option {
          display: flex;
          align-items: center;
          margin-bottom: 10px;
        }
        .gst-checkbox {
          width: 20px;
          height: 20px;
          margin-right: 10px;
        }
        .total-section {
          text-align: right;
          margin: 10px 0;
          font-size: 11px;
        }
        .total-section .total-line {
          margin: 2px 0;
        }
        .detailed-breakup {
          width: 100%;
          border-collapse: collapse;
          margin: 15px 0;
        }
        .detailed-breakup th {
          border: 1px solid #000;
          padding: 4px;
          font-weight: bold;
          font-size: 10px;
          text-align: center;
          background-color: #f0f0f0;
        }
        .detailed-breakup td {
          border: 1px solid #000;
          padding: 4px;
          font-size: 10px;
        }
        .category-header {
          font-weight: bold;
          background-color: #f8f8f8;
        }
        .subtotal-row {
          font-weight: bold;
          text-align: right;
        }
        .center { text-align: center; }
        .right { text-align: right; }
        .bold { font-weight: bold; }
        .clearfix::after {
          content: "";
          display: table;
          clear: both;
        }
        @media print {
          body { margin: 0; }
          .no-print { display: none; }
        }
      </style>
    </head>
    <body>
      <div class="header clearfix">
        <div class="hospital-logo">⚕</div>
        <div class="hospital-info">
          <h1>Ashwini General Hospital</h1>
          <p>Reg. No. AGH2024</p>
          <p>Main Road, City - 411001</p>
          <p>Ph: 9876543210, Timing: AVAILABLE 24 HOURS AND 7 DAYS</p>
        </div>
      </div>
      
      <table class="patient-info">
        <tr>
          <td class="label">Patient UID:</td>
          <td>${invoiceWithRelations.admissions?.patients?.patient_id || 'N/A'}</td>
          <td class="label" style="padding-left: 100px;">Date:</td>
          <td>${new Date(invoice.created_at).toLocaleDateString('en-GB')}</td>
        </tr>
        <tr>
          <td class="label">Name:</td>
          <td>${patientName || 'N/A'}</td>
          <td class="label" style="padding-left: 100px;">Admission No:</td>
          <td>${invoice.admission_id ? invoice.admission_id.slice(-6) : 'N/A'}</td>
        </tr>
        <tr>
          <td class="label">Age:</td>
          <td>${calculateAge(invoiceWithRelations.admissions?.patients?.date_of_birth)}</td>
          <td class="label" style="padding-left: 100px;">Admission Date:</td>
          <td>${invoiceWithRelations.admissions?.admission_date ? new Date(invoiceWithRelations.admissions.admission_date).toLocaleDateString('en-GB') : 'N/A'}</td>
        </tr>
        <tr>
          <td class="label">Address:</td>
          <td>City - 411001, Contact No: ${invoiceWithRelations.admissions?.patients?.phone || 'N/A'}</td>
          <td class="label" style="padding-left: 100px;">Discharge Date:</td>
          <td>${invoiceWithRelations.admissions?.discharge_date ? new Date(invoiceWithRelations.admissions.discharge_date).toLocaleDateString('en-GB') : 'N/A'}</td>
        </tr>
      </table>

      <table class="patient-info">
        <tr>
          <td class="label">Payer Details:</td>
          <td colspan="3"></td>
        </tr>
        <tr>
          <td class="label">Name:</td>
          <td>${patientName || 'N/A'}</td>
          <td class="label" style="padding-left: 100px;">Bed No(s):</td>
          <td>${invoiceWithRelations.admissions?.rooms?.room_number || 'N/A'} (${invoiceWithRelations.admissions?.rooms?.room_type?.toUpperCase() || 'N/A'})</td>
        </tr>
        <tr>
          <td class="label">Address:</td>
          <td>City - 411001</td>
          <td colspan="2"></td>
        </tr>
        <tr>
          <td class="label">Consulting Doctors:</td>
          <td colspan="3">${invoiceWithRelations.admissions?.staff?.name || 'Dr. Attending Physician'} (${invoiceWithRelations.admissions?.staff?.employment_role || 'General Physician'})</td>
        </tr>
      </table>

      <div class="billing-details">PROVISIONAL BILL</div>
      
      <table class="provisional-bill">
        <thead>
          <tr>
            <th>Primary Code</th>
            <th>Particulars</th>
            <th class="amount-col">Amount</th>
            <th class="amount-col">GST (18%)</th>
            <th class="amount-col">Total</th>
          </tr>
        </thead>
        <tbody>
          ${billItems && billItems.length > 0 ? billItems.map(item => {
            const itemAmount = Number(item.total_price || 0);
            const gstAmount = itemAmount * 0.18;
            const totalWithGst = itemAmount + gstAmount;
            return `
            <tr>
              <td>${item.item_type === 'room' ? '100000' : item.item_type === 'medication' ? '300000' : '500000'}</td>
              <td>${item.item_name || 'Service Charge'}${item.item_description ? ` - ${item.item_description}` : ''}</td>
              <td class="amount-col">${itemAmount.toFixed(2)}</td>
              <td class="amount-col">${gstAmount.toFixed(2)}</td>
              <td class="amount-col">${totalWithGst.toFixed(2)}</td>
            </tr>
          `;
          }).join('') : `
            <tr>
              <td>100000</td>
              <td>Room & Nursing Charges (6 days)</td>
              <td class="amount-col">${Number(invoice.total_amount || 0).toFixed(2)}</td>
              <td class="amount-col">${(Number(invoice.total_amount || 0) * 0.18).toFixed(2)}</td>
              <td class="amount-col">${(Number(invoice.total_amount || 0) * 1.18).toFixed(2)}</td>
            </tr>
          `}
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
            <th>Rate</th>
            <th>Units</th>
            <th>Amount</th>
            <th>GST</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${billItems && billItems.length > 0 ? 
            (() => {
              const roomItems = billItems.filter(item => item.item_type === 'room');
              const medicationItems = billItems.filter(item => item.item_type === 'medication');
              const serviceItems = billItems.filter(item => item.item_type === 'service');
              
              let html = '';
              
              if (roomItems.length > 0) {
                html += `<tr class="category-header"><td colspan="9"><strong>Room/Bed Charges</strong></td></tr>`;
                roomItems.forEach(item => {
                  const itemAmount = Number(item.total_price || 0);
                  const gstAmount = itemAmount * 0.18;
                  const totalWithGst = itemAmount + gstAmount;
                  html += `
                    <tr>
                      <td>100000</td>
                      <td>${item.created_at ? `${new Date(item.created_at).toLocaleDateString('en-GB')} ${new Date(item.created_at).toLocaleTimeString('en-GB', {hour12: true})}` : 'N/A'}</td>
                      <td>${item.item_name || 'Room Charge'}${item.item_description ? ` - ${item.item_description}` : ''}</td>
                      <td class="right">${Number(item.unit_price || 0).toFixed(2)}</td>
                      <td class="center">${item.quantity || 1}</td>
                      <td class="right">${itemAmount.toFixed(2)}</td>
                      <td class="right">${gstAmount.toFixed(2)}</td>
                      <td class="right">${totalWithGst.toFixed(2)}</td>
                    </tr>
                  `;
                });
                const roomSubtotal = roomItems.reduce((sum, item) => sum + Number(item.total_price || 0), 0);
                const roomGst = roomSubtotal * 0.18;
                html += `<tr class="subtotal-row"><td colspan="7">Subtotal:</td><td class="right">${roomSubtotal.toFixed(2)}</td><td class="right">${roomGst.toFixed(2)}</td><td class="right">${(roomSubtotal + roomGst).toFixed(2)}</td></tr>`;
              }
              
              if (medicationItems.length > 0) {
                html += `<tr class="category-header"><td colspan="9"><strong>Nursing Charges</strong></td></tr>`;
                medicationItems.forEach(item => {
                  const itemAmount = Number(item.total_price || 0);
                  const gstAmount = itemAmount * 0.18;
                  const totalWithGst = itemAmount + gstAmount;
                  html += `
                    <tr>
                      <td>102001</td>
                      <td>${item.created_at ? `${new Date(item.created_at).toLocaleDateString('en-GB')} ${new Date(item.created_at).toLocaleTimeString('en-GB', {hour12: true})}` : 'N/A'}</td>
                      <td>${item.item_name || 'Medication'}${item.item_description ? ` - ${item.item_description}` : ''}</td>
                      <td class="right">${Number(item.unit_price || 0).toFixed(2)}</td>
                      <td class="center">${item.quantity || 1}</td>
                      <td class="right">${itemAmount.toFixed(2)}</td>
                      <td class="right">${gstAmount.toFixed(2)}</td>
                      <td class="right">${totalWithGst.toFixed(2)}</td>
                    </tr>
                  `;
                });
                const medSubtotal = medicationItems.reduce((sum, item) => sum + Number(item.total_price || 0), 0);
                const medGst = medSubtotal * 0.18;
                html += `<tr class="subtotal-row"><td colspan="7">Subtotal:</td><td class="right">${medSubtotal.toFixed(2)}</td><td class="right">${medGst.toFixed(2)}</td><td class="right">${(medSubtotal + medGst).toFixed(2)}</td></tr>`;
              }
              
              if (serviceItems.length > 0) {
                html += `<tr class="category-header"><td colspan="9"><strong>Professional Fees</strong></td></tr>`;
                serviceItems.forEach(item => {
                  const itemAmount = Number(item.total_price || 0);
                  const gstAmount = itemAmount * 0.18;
                  const totalWithGst = itemAmount + gstAmount;
                  html += `
                    <tr>
                      <td>500000</td>
                      <td>${item.created_at ? `${new Date(item.created_at).toLocaleDateString('en-GB')} ${new Date(item.created_at).toLocaleTimeString('en-GB', {hour12: true})}` : 'N/A'}</td>
                      <td>${item.item_name || 'Service'}${item.item_description ? ` - ${item.item_description}` : ''}</td>
                      <td class="right">${Number(item.unit_price || 0).toFixed(2)}</td>
                      <td class="center">${item.quantity || 1}</td>
                      <td class="right">${itemAmount.toFixed(2)}</td>
                      <td class="right">${gstAmount.toFixed(2)}</td>
                      <td class="right">${totalWithGst.toFixed(2)}</td>
                    </tr>
                  `;
                });
                const serviceSubtotal = serviceItems.reduce((sum, item) => sum + Number(item.total_price || 0), 0);
                const serviceGst = serviceSubtotal * 0.18;
                html += `<tr class="subtotal-row"><td colspan="7">Subtotal:</td><td class="right">${serviceSubtotal.toFixed(2)}</td><td class="right">${serviceGst.toFixed(2)}</td><td class="right">${(serviceSubtotal + serviceGst).toFixed(2)}</td></tr>`;
              }
              
              return html;
            })()
            : `
            <tr class="category-header"><td colspan="9"><strong>Room/Bed Charges</strong></td></tr>
            <tr>
              <td>100000</td>
              <td>${new Date(invoice.created_at).toLocaleDateString('en-GB')} ${new Date(invoice.created_at).toLocaleTimeString('en-GB', {hour12: true})}</td>
              <td>Bed Charges - ${invoiceWithRelations.admissions?.rooms?.room_type?.toUpperCase() || 'GENERAL'} (6 days)</td>
              <td class="right">${Number(invoice.total_amount || 0).toFixed(2)}</td>
              <td class="center">6</td>
              <td class="right">${Number(invoice.total_amount || 0).toFixed(2)}</td>
              <td class="right">${(Number(invoice.total_amount || 0) * 0.18).toFixed(2)}</td>
              <td class="right">${(Number(invoice.total_amount || 0) * 1.18).toFixed(2)}</td>
            </tr>
            <tr class="subtotal-row"><td colspan="7">Subtotal:</td><td class="right">${Number(invoice.total_amount || 0).toFixed(2)}</td><td class="right">${(Number(invoice.total_amount || 0) * 0.18).toFixed(2)}</td><td class="right">${(Number(invoice.total_amount || 0) * 1.18).toFixed(2)}</td></tr>
          `}
        </tbody>
      </table>
      
      <div class="no-print" style="margin-top: 20px; text-align: center; font-size: 10px; color: #666;">
        <p>This is a computer-generated invoice. No signature required.</p>
        <p>Use browser's Print function to save as PDF if needed.</p>
      </div>
    </body>
    </html>
  `;

  try {
    logger.info('Attempting PDF generation with Puppeteer', { invoiceId: invoice.id });
    
    // Launch Puppeteer
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const page = await browser.newPage();
    
    // Set content and generate PDF
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px'
      }
    });
    
    await browser.close();
    
    // Verify PDF buffer is valid
    if (pdfBuffer.length === 0) {
      throw new Error('Generated PDF is empty');
    }
    
    // Debug: Log PDF buffer info
    const firstBytes = pdfBuffer.slice(0, 10);
    const firstBytesStr = Array.from(firstBytes).map(b => b.toString(16)).join(' ');
    const firstBytesText = pdfBuffer.slice(0, 4).toString('utf8');
    logger.info('PDF buffer info', {
      invoiceId: invoice.id,
      size: pdfBuffer.length,
      firstBytes: firstBytesStr,
      header: firstBytesText
    });
    
    // Set response headers for PDF download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length.toString());
    res.setHeader('Cache-Control', 'no-cache');
    
    // Send the PDF buffer as binary
    res.end(pdfBuffer, 'binary');
    
    logger.info('PDF generated successfully with Puppeteer', {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      fileSize: pdfBuffer.length
    });
    
  } catch (error) {
    logger.error('Puppeteer PDF generation failed, falling back to HTML', { 
      error: error instanceof Error ? error.message : 'Unknown error',
      invoiceId: invoice.id,
      stack: error instanceof Error ? error.stack : undefined
    });
    
    // Fallback to HTML with print-friendly styling
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.html"`);
    res.send(htmlContent);
  }
}));

// Update invoice payment status and details
router.patch('/:id/status', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { 
    status, 
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
    discount_reason
  } = req.body;

  // Validate status
  if (!['pending', 'partial', 'paid'].includes(status)) {
    throw createError('Invalid payment status', 400);
  }

  // First get the current invoice to calculate discount
  const { data: currentInvoice, error: fetchError } = await supabase
    .from('invoices')
    .select('total_amount')
    .eq('id', id)
    .single();

  if (fetchError || !currentInvoice) {
    throw createError('Invoice not found', 404);
  }

  // Calculate discounted total
  const baseAmount = currentInvoice.total_amount || 0;
  let discountedAmount = baseAmount;
  
  if (discount_type === 'percentage' && discount_value && discount_value > 0) {
    discountedAmount = baseAmount * (1 - (discount_value / 100));
  } else if (discount_type === 'fixed' && discount_value && discount_value > 0) {
    discountedAmount = Math.max(0, baseAmount - discount_value);
  }

  // Calculate GST amounts if not provided
  const calculatedGstRate = gst_rate || 18.00;
  const calculatedGstAmount = include_gst ? (discountedAmount * calculatedGstRate / 100) : 0;
  const calculatedTotalWithGst = include_gst ? (discountedAmount + calculatedGstAmount) : discountedAmount;

  const updateData: any = {
    status,
    paid_amount: paid_amount || 0,
    updated_at: new Date().toISOString()
  };

  // Add GST fields if provided
  if (include_gst !== undefined) updateData.include_gst = include_gst;
  if (gst_rate !== undefined) updateData.gst_rate = gst_rate;
  if (gst_amount !== undefined) updateData.gst_amount = gst_amount;
  if (total_with_gst !== undefined) updateData.total_with_gst = total_with_gst;

  // Add payment details if provided
  if (payment_method) updateData.payment_method = payment_method;
  if (payment_reference) updateData.payment_reference = payment_reference;
  if (payment_notes) updateData.payment_notes = payment_notes;
  
  // Add discount details if provided
  if (discount_type) updateData.discount_type = discount_type;
  if (discount_value !== undefined) updateData.discount_value = discount_value;
  if (discount_reason) updateData.discount_reason = discount_reason;
  updateData.discounted_total = discountedAmount;
  
  // Add last payment date for paid or partial payments
  if (status === 'paid' || status === 'partial') {
    updateData.last_payment_date = new Date().toISOString();
  }

  const { data: invoice, error: updateError } = await supabase
    .from('invoices')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (updateError || !invoice) {
    throw createError('Failed to update payment status', 500);
  }

  logger.info('Payment status updated', {
    invoiceId: id,
    status,
    paid_amount,
    include_gst,
    discount_type,
    discount_value,
    payment_method,
    updatedBy: req.user?.id
  });

  res.json(invoice);
}));

// Fix admission doctor assignment (temporary fix)
router.post('/fix-doctor/:admissionId', asyncHandler(async (req: any, res: Response) => {
  const admissionId = req.params.admissionId;

  // Check if admission exists and has no admitted_by
  const { data: admission, error: admissionError } = await supabase
    .from('admissions')
    .select('id, admitted_by')
    .eq('id', admissionId)
    .single();

  if (admissionError || !admission) {
    throw createError('Admission not found', 404);
  }

  if (admission.admitted_by) {
    return res.json({ message: 'Admission already has a doctor assigned', admission });
  }

  // Get first doctor from staff table
  const { data: doctor, error: doctorError } = await supabase
    .from('staff')
    .select('id, name, role, employment_role')
    .eq('role', 'doctor')
    .limit(1)
    .single();

  if (doctorError || !doctor) {
    // Create a default doctor if none exists
    const { data: newDoctor, error: insertError } = await supabase
      .from('staff')
      .insert({
        name: 'Dr. Default Doctor',
        email: 'doctor@ashwini.com',
        role: 'doctor',
        employment_role: 'General Physician',
        employment_status: 'active',
        department: 'General Medicine',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select('id, name, role, employment_role')
      .single();

    if (insertError || !newDoctor) {
      throw createError('Failed to create default doctor', 500);
    }

    // Update admission with new doctor
    const { data: updatedAdmission } = await supabase
      .from('admissions')
      .update({
        admitted_by: newDoctor.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', admissionId)
      .select()
      .single();

    logger.info('Created and assigned default doctor to admission', {
      admissionId,
      doctorId: newDoctor.id,
      doctorName: newDoctor.name
    });

    return res.json({
      message: 'Created and assigned default doctor',
      doctor: newDoctor,
      admission: updatedAdmission
    });
  }

  // Update admission with existing doctor
  const { data: updatedAdmission } = await supabase
    .from('admissions')
    .update({
      admitted_by: doctor.id,
      updated_at: new Date().toISOString()
    })
    .eq('id', admissionId)
    .select()
    .single();

  logger.info('Assigned doctor to admission', {
    admissionId,
    doctorId: doctor.id,
    doctorName: doctor.name
  });

  return res.json({
    message: 'Doctor assigned to admission',
    doctor: doctor,
    admission: updatedAdmission
  });
}));

// Debug endpoint to check admission data
router.get('/debug-admission/:admissionId', asyncHandler(async (req: any, res: Response) => {
  const admissionId = req.params.admissionId;

  const { data: admission, error: admissionError } = await supabase
    .from('admissions')
    .select('*')
    .eq('id', admissionId)
    .single();

  if (admissionError) {
    return res.json({ error: admissionError.message, admissionId });
  }

  res.json({ admission, admissionId });
}));

// Debug endpoint to check staff data
router.get('/debug-staff/:staffId', asyncHandler(async (req: any, res: Response) => {
  const staffId = req.params.staffId;

  const { data: staff, error: staffError } = await supabase
    .from('staff')
    .select('*')
    .eq('id', staffId)
    .single();

  if (staffError) {
    return res.json({ error: staffError.message, staffId });
  }

  res.json({ staff, staffId });
}));

export default router;
