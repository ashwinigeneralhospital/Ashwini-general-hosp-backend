import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireMedicalStaff } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { uploadLabReportPDF } from '../utils/r2.js';

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Configure multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

const LAB_REPORT_SELECT = `
  *,
  patients (
    id,
    patient_id,
    first_name,
    last_name
  ),
  admissions (
    id,
    admission_date,
    status
  ),
  staff:staff!lab_reports_ordered_by_fkey (
    id,
    first_name,
    last_name,
    role
  )
`;

// Get lab reports by patient ID with optional admission filter
router.get('/patient/:patientId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { patientId } = req.params;
  const admissionId = req.query.admissionId as string;

  let query = supabase
    .from('lab_reports')
    .select(LAB_REPORT_SELECT)
    .eq('patient_id', patientId)
    .order('test_date', { ascending: false });

  if (admissionId) {
    query = query.eq('admission_id', admissionId);
  }

  const { data, error } = await query;

  if (error) {
    throw createError('Failed to fetch lab reports', 500);
  }

  res.json({
    success: true,
    data: { labReports: data ?? [] }
  });
}));

// Get lab reports by admission ID
router.get('/admission/:admissionId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { admissionId } = req.params;

  const { data, error } = await supabase
    .from('lab_reports')
    .select(LAB_REPORT_SELECT)
    .eq('admission_id', admissionId)
    .order('test_date', { ascending: false });

  if (error) {
    throw createError('Failed to fetch admission lab reports', 500);
  }

  res.json({
    success: true,
    data: { labReports: data ?? [] }
  });
}));

// Create new lab report with optional PDF upload
router.post('/', authenticateToken, requireMedicalStaff, upload.single('pdf'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    patient_id,
    admission_id,
    test_type,
    test_date,
    result_summary,
    result_details,
    normal_range,
    status,
    notes,
    report_title,
    report_description,
    price
  } = req.body;

  if (!patient_id || !test_type || !test_date) {
    throw createError('patient_id, test_type, and test_date are required', 400);
  }

  // First create the lab report to get an ID
  const { data: labReport, error: insertError } = await supabase
    .from('lab_reports')
    .insert({
      patient_id,
      admission_id: admission_id || null,
      test_type,
      test_date: new Date(test_date).toISOString(),
      result_summary: result_summary || null,
      result_details: result_details || null,
      normal_range: normal_range || null,
      status: status || 'pending',
      notes: notes || null,
      report_title: report_title || null,
      report_description: report_description || null,
      price: price ? parseFloat(price) : 0,
      ordered_by: req.user!.staff_id,
      uploaded_by: req.user!.staff_id,
      billing_status: 'pending'
    })
    .select('id, patient_id, admission_id')
    .single();

  if (insertError || !labReport) {
    logger.error('Failed to create lab report', { error: insertError, userId: req.user!.id });
    throw createError('Failed to create lab report', 500);
  }

  // If PDF file is uploaded, upload to R2 and update the record
  if (req.file) {
    try {
      const { url, path } = await uploadLabReportPDF(
        labReport.patient_id,
        labReport.admission_id || 'no-admission',
        labReport.id,
        req.file.buffer
      );

      const { error: updateError } = await supabase
        .from('lab_reports')
        .update({
          pdf_url: url,
          pdf_storage_path: path,
          updated_at: new Date().toISOString()
        })
        .eq('id', labReport.id);

      if (updateError) {
        logger.error('Failed to update lab report with PDF info', { error: updateError, labReportId: labReport.id });
      }
    } catch (uploadError: any) {
      logger.error('Failed to upload PDF to R2', { error: uploadError.message, labReportId: labReport.id });
      // Continue without failing the entire request
    }
  }

  // Fetch the complete record with relations
  const { data, error } = await supabase
    .from('lab_reports')
    .select(LAB_REPORT_SELECT)
    .eq('id', labReport.id)
    .single();

  if (error || !data) {
    throw createError('Failed to fetch created lab report', 500);
  }

  logger.info('Lab report created', {
    labReportId: data.id,
    patientId: patient_id,
    hasPDF: !!req.file,
    createdBy: req.user!.staff_id
  });

  res.status(201).json({
    success: true,
    data: { labReport: data }
  });
}));

// Update lab report with optional PDF upload
router.put('/:id', authenticateToken, requireMedicalStaff, upload.single('pdf'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    test_type,
    test_date,
    result_summary,
    result_details,
    normal_range,
    status,
    notes,
    report_title,
    report_description,
    price
  } = req.body;

  const updateData: any = {
    test_type,
    test_date: test_date ? new Date(test_date).toISOString() : undefined,
    result_summary,
    result_details,
    normal_range,
    status,
    notes,
    report_title,
    report_description,
    price: price ? parseFloat(price) : undefined,
    updated_at: new Date().toISOString()
  };

  // If PDF file is uploaded, upload to R2 first
  if (req.file) {
    const { data: existingReport } = await supabase
      .from('lab_reports')
      .select('patient_id, admission_id')
      .eq('id', req.params.id)
      .single();

    if (existingReport) {
      try {
        const { url, path } = await uploadLabReportPDF(
          existingReport.patient_id,
          existingReport.admission_id || 'no-admission',
          req.params.id,
          req.file.buffer
        );

        updateData.pdf_url = url;
        updateData.pdf_storage_path = path;
      } catch (uploadError: any) {
        logger.error('Failed to upload PDF to R2', { error: uploadError.message, labReportId: req.params.id });
      }
    }
  }

  const { data, error } = await supabase
    .from('lab_reports')
    .update(updateData)
    .eq('id', req.params.id)
    .select(LAB_REPORT_SELECT)
    .single();

  if (error || !data) {
    throw createError('Lab report not found or update failed', 404);
  }

  logger.info('Lab report updated', {
    labReportId: data.id,
    hasPDF: !!req.file,
    updatedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { labReport: data }
  });
}));

// Get signed URL for lab report PDF
router.get('/:id/pdf-url', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const { data: labReport, error } = await supabase
    .from('lab_reports')
    .select('id, pdf_storage_path, pdf_url')
    .eq('id', id)
    .single();

  if (error || !labReport) {
    throw createError('Lab report not found', 404);
  }

  if (!labReport.pdf_storage_path) {
    throw createError('Lab report has no PDF attached', 404);
  }

  try {
    const { getSignedDownloadUrl } = await import('../utils/r2.js');
    const signedUrl = await getSignedDownloadUrl(labReport.pdf_storage_path, 3600); // 1 hour expiry

    logger.info('Generated signed URL for lab report PDF', {
      labReportId: id,
      requestedBy: req.user!.staff_id
    });

    res.json({
      success: true,
      data: { 
        signedUrl,
        expiresIn: 3600
      }
    });
  } catch (error: any) {
    logger.error('Failed to generate signed URL', {
      labReportId: id,
      error: error.message
    });
    throw createError('Failed to generate PDF access URL', 500);
  }
}));

// Delete lab report
router.delete('/:id', authenticateToken, requireMedicalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('lab_reports')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .single();

  if (error || !data) {
    throw createError('Lab report not found or deletion failed', 404);
  }

  logger.info('Lab report deleted', {
    labReportId: data.id,
    deletedBy: req.user!.staff_id
  });

  res.json({
    success: true,
    data: { labReport: data }
  });
}));

export default router;
