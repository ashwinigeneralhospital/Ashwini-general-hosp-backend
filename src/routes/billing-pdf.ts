import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireBilling } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { generateInvoicePDF } from '../utils/pdf-generator.js';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const INVOICE_SELECT = `
  *,
  admissions (
    id,
    admission_id,
    admission_date,
    discharge_date,
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
    )
  )
`;

// Generate PDF invoice using PDFKit
router.get('/:invoiceId/pdf', authenticateToken, requireBilling, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { invoiceId } = req.params;

  logger.info('Generating PDF for invoice', { invoiceId });

  // Fetch invoice with relations
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select(INVOICE_SELECT)
    .eq('id', invoiceId)
    .single();

  if (invoiceError || !invoice) {
    logger.error('Invoice not found', { invoiceId, error: invoiceError });
    throw createError('Invoice not found', 404);
  }

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
  if (invoice.admissions?.doctor_id) {
    const { data: staff } = await supabase
      .from('staff')
      .select('first_name, last_name, specialization')
      .eq('id', invoice.admissions.doctor_id)
      .single();

    if (staff) {
      staffName = `${staff.first_name} ${staff.last_name}${staff.specialization ? ` (${staff.specialization})` : ''}`;
    }
  }

  try {
    // Generate PDF using PDFKit
    const pdfBuffer = await generateInvoicePDF({
      invoice,
      billItems: billItems || [],
      patientName: `${invoice.admissions?.patients?.first_name || ''} ${invoice.admissions?.patients?.last_name || ''}`.trim(),
      doctorName: staffName
    });

    logger.info('PDF generated successfully', { 
      invoiceId, 
      fileSize: pdfBuffer.length,
      invoiceNumber: invoice.invoice_number 
    });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);

    // Send PDF
    res.send(pdfBuffer);

  } catch (error) {
    logger.error('PDF generation failed', { invoiceId, error });
    throw createError('Failed to generate PDF', 500);
  }
}));

export default router;
