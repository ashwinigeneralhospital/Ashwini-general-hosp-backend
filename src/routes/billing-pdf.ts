import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireBilling } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { generateInvoicePDF } from '../utils/pdf-generator.js';
import { mergeInvoiceWithLabReports } from '../utils/pdf-merger.js';
import { getSignedDownloadUrl } from '../utils/r2.js';
import { env } from '../config/env.js';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const ADMISSION_SELECT = `
  *,
  patients (
    id,
    patient_id,
    first_name,
    last_name,
    date_of_birth,
    gender,
    phone,
    email,
    address
  ),
  beds:bed_id (
    id,
    bed_number
  ),
  rooms:room_id (
    id,
    room_number,
    room_type,
    floor
  ),
  staff:doctor_id (
    id,
    first_name,
    last_name,
    department,
    employment_role
  )
`;

// Generate PDF invoice using PDFKit
router.get('/:invoiceId/pdf', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { invoiceId } = req.params;
  const includeLabReports = req.query.includeLabReports === 'true';
  const includeSummary = req.query.includeSummary === 'true';

  logger.info('PDF Download Request Received', {
    invoiceId,
    includeLabReports,
    includeSummary,
    queryParams: req.query,
    rawIncludeLabReports: req.query.includeLabReports,
    rawIncludeSummary: req.query.includeSummary,
    fullUrl: req.url
  });

  // Fetch invoice record
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*')
    .match({ id: invoiceId })
    .maybeSingle();

  if (invoiceError || !invoice) {
    logger.error('Invoice lookup failed', { invoiceId, error: invoiceError });
    throw createError('Invoice not found', 404);
  }

  // Fetch admission details manually since Supabase relationship is missing
  let admissionRecord = null;
  if (invoice.admission_id) {
    const { data: admissionData, error: admissionError } = await supabase
      .from('admissions')
      .select(ADMISSION_SELECT)
      .match({ id: invoice.admission_id })
      .maybeSingle();

    if (admissionError) {
      logger.error('Failed to fetch admission data for invoice PDF', {
        invoiceId,
        admissionId: invoice.admission_id,
        error: admissionError,
      });
    }

    admissionRecord = admissionData;
  }

  const invoiceWithRelations = {
    ...invoice,
    admissions: admissionRecord,
  };

  // Fetch bill items
  const { data: billItems, error: billItemsError } = await supabase
    .from('bill_items')
    .select('*')
    .eq('invoice_id', invoiceId);

  if (billItemsError) {
    logger.error('Failed to fetch bill items', { invoiceId, error: billItemsError });
    throw createError('Failed to fetch bill items', 500);
  }

  // Fetch staff/doctor information
  let staffName = 'Unknown Doctor';
  if (invoiceWithRelations.admissions?.doctor_id) {
    const { data: staff } = await supabase
      .from('staff')
      .select('first_name, last_name, specialization')
      .eq('id', invoiceWithRelations.admissions.doctor_id)
      .single();

    if (staff) {
      staffName = `${staff.first_name} ${staff.last_name}${staff.specialization ? ` (${staff.specialization})` : ''}`;
    }
  }

  try {
    // Fetch admission summary if requested
    let admissionSummary = null;
    if (includeSummary && invoiceWithRelations.admission_id) {
      const { data: summary } = await supabase
        .from('admission_summaries')
        .select('chief_complaint, diagnosis, treatment_provided, outcome, recommendations')
        .eq('admission_id', invoiceWithRelations.admission_id)
        .maybeSingle();
      
      admissionSummary = summary;
      logger.info('Admission summary fetched for PDF', { 
        invoiceId, 
        admissionId: invoiceWithRelations.admission_id,
        hasSummary: !!summary 
      });
    }

    // Generate PDF using PDFKit
    let pdfBuffer = await generateInvoicePDF({
      invoice: invoiceWithRelations,
      billItems: billItems || [],
      patientName: invoiceWithRelations.admissions?.patients
        ? `${invoiceWithRelations.admissions.patients.first_name || ''} ${invoiceWithRelations.admissions.patients.last_name || ''}`.trim()
        : '',
      doctorName: staffName,
      admissionSummary
    });

    logger.info('PDF generated successfully', { 
      invoiceId, 
      fileSize: pdfBuffer.length,
      invoiceNumber: invoice.invoice_number 
    });

    // If includeLabReports is true, fetch and merge lab report PDFs
    if (includeLabReports) {
      logger.info('includeLabReports is true, checking for lab reports', { invoiceId });
      
      const labBillItems = (billItems || []).filter(item => item.item_type === 'lab' && item.reference_id);
      
      logger.info('Lab bill items found', { 
        invoiceId, 
        totalBillItems: billItems?.length || 0,
        labBillItemsCount: labBillItems.length,
        labBillItems: labBillItems.map(item => ({ id: item.id, reference_id: item.reference_id, item_name: item.item_name }))
      });
      
      if (labBillItems.length > 0) {
        const labReportIds = labBillItems.map(item => item.reference_id).filter(Boolean);
        
        logger.info('Lab report IDs to fetch', { invoiceId, labReportIds });
        
        // Fetch lab reports with PDF URLs
        const { data: labReports, error: labReportsError } = await supabase
          .from('lab_reports')
          .select('id, pdf_url, pdf_storage_path')
          .in('id', labReportIds);

        logger.info('Lab reports fetched from database', { 
          invoiceId, 
          labReportsCount: labReports?.length || 0,
          labReports: labReports?.map(r => ({ id: r.id, pdf_url: r.pdf_url, pdf_storage_path: r.pdf_storage_path })),
          error: labReportsError
        });

        if (labReports && labReports.length > 0) {
          const labPdfUrls: string[] = [];

          for (const report of labReports) {
            if (report.pdf_url) {
              labPdfUrls.push(report.pdf_url);
              continue;
            }

            if (report.pdf_storage_path) {
              try {
                if (env.R2_PUBLIC_URL) {
                  labPdfUrls.push(`${env.R2_PUBLIC_URL}/${report.pdf_storage_path}`);
                } else {
                  const signedUrl = await getSignedDownloadUrl(report.pdf_storage_path, 3600);
                  labPdfUrls.push(signedUrl);
                }
              } catch (error: any) {
                logger.warn('Failed to generate URL for lab report PDF', {
                  invoiceId,
                  reportId: report.id,
                  storagePath: report.pdf_storage_path,
                  error: error.message
                });
              }
            } else {
              logger.warn('Lab report has no PDF URL or storage path', {
                invoiceId,
                reportId: report.id
              });
            }
          }

          logger.info('Lab PDF URLs to merge', { 
            invoiceId, 
            labPdfUrlsCount: labPdfUrls.length,
            labPdfUrls 
          });

          if (labPdfUrls.length > 0) {
            logger.info('Starting PDF merge process', { 
              invoiceId, 
              labReportCount: labPdfUrls.length 
            });

            pdfBuffer = await mergeInvoiceWithLabReports(pdfBuffer, labPdfUrls);
            
            logger.info('Lab reports merged successfully', { 
              invoiceId, 
              mergedFileSize: pdfBuffer.length 
            });
          } else {
            logger.warn('No valid PDF URLs found in lab reports', { invoiceId });
          }
        } else {
          logger.warn('No lab reports found in database', { invoiceId, labReportIds });
        }
      } else {
        logger.warn('No lab bill items found in invoice', { invoiceId, totalBillItems: billItems?.length || 0 });
      }
    } else {
      logger.info('includeLabReports is false, skipping lab report merge', { invoiceId });
    }

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}${includeLabReports ? '-with-reports' : ''}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);

    // Send PDF
    res.send(pdfBuffer);

  } catch (error) {
    logger.error('PDF generation failed', { invoiceId, error });
    throw createError('Failed to generate PDF', 500);
  }
}));

export default router;
