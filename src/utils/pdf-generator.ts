import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env.js';
import { logger } from './logger.js';

interface InvoiceData {
  invoice: any;
  billItems: any[];
  patientName: string;
  doctorName: string;
  admissionSummary?: {
    chief_complaint: string;
    diagnosis: string;
    treatment_provided: string;
    outcome: string;
    recommendations?: string;
  } | null;
}

interface PatientAuditData {
  patients: any[];
  dateFrom: string;
  dateTo: string;
  generatedBy: string;
}

interface AdmissionAuditData {
  admissions: any[];
  dateFrom: string;
  dateTo: string;
  generatedBy: string;
}

interface TableColumn {
  label: string;
  width: number;
  align?: 'left' | 'center' | 'right';
}

interface ColorScheme {
  primary: string;
  secondary: string;
  accent: string;
  text: string;
  lightBg: string;
  border: string;
}

const colors: ColorScheme = {
  primary: '#1a5f7a',
  secondary: '#2c8aa6',
  accent: '#e74c3c',
  text: '#2c3e50',
  lightBg: '#ecf0f1',
  border: '#bdc3c7',
};

const drawMedicationSection = (
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  leftX: number,
  contentWidth: number,
  startY: number,
): number => {
  const medications = data.billItems.filter(
    (item) =>
      item.item_type === 'medication' ||
      item.category === 'medication' ||
      (item.item_name && item.item_name.toLowerCase().includes('med'))
  );

  if (medications.length === 0) {
    return startY;
  }

  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(colors.primary).text('MEDICATION CHARGES', leftX, startY);
  startY += 15;

  const columns: TableColumn[] = [
    { label: 'Medication', width: Math.max(180, contentWidth * 0.35) },
    { label: 'Doses', width: 70, align: 'center' },
    { label: 'Per Dose', width: 80, align: 'right' },
    { label: 'Amount', width: 90, align: 'right' },
  ];

  const rows = medications.map((item) => {
    const qty = Number(item.quantity || item.doses || item.units || 1);
    const perDose = Number(item.unit_price || item.rate || 0);
    const amount = Number(item.total_price || item.amount || perDose * qty);

    return [
      item.item_name || item.item_description || 'Medication',
      qty.toString(),
      formatCurrency(perDose),
      formatCurrency(amount),
    ];
  });

  return drawTable(doc, columns, rows, leftX, startY, 'light');
};

export const generateInvoicePDF = async (data: InvoiceData): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ 
        margin: 35, 
        size: 'A4',
        bufferPages: true 
      });
      const buffers: Buffer[] = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      const pageWidth = doc.page.width;
      const leftX = doc.page.margins.left;
      const rightX = pageWidth - doc.page.margins.right;
      const contentWidth = rightX - leftX;

      let cursorY = doc.page.margins.top - 10;

      // Header
      cursorY = drawHeader(doc, data, leftX, contentWidth, cursorY);

      // Patient Info Section
      cursorY = drawPatientInfoSection(doc, data, leftX, contentWidth, cursorY);

      // Bill Details Section
      cursorY = drawBillDetailsSection(doc, data, leftX, contentWidth, cursorY);

      // Combined Item Table
      cursorY = drawBillingTable(doc, data, leftX, contentWidth, cursorY);

      // Medication Specific Table (only if meds exist)
      cursorY = drawMedicationSection(doc, data, leftX, contentWidth, cursorY);

      // Totals Section
      cursorY = drawTotalsSectionOptimized(doc, data, leftX, contentWidth, cursorY);

      // Footer
      drawFooter(doc, data, leftX, contentWidth, pageWidth);

      // Add admission summary page if provided
      if (data.admissionSummary) {
        drawAdmissionSummaryPage(doc, data, leftX, contentWidth, pageWidth);
      }

      doc.end();
    } catch (error) {
      logger.error('PDF generation failed', { error });
      reject(error);
    }
  });
};

const drawHeader = (
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  leftX: number,
  contentWidth: number,
  startY: number,
): number => {
  const logoPath = path.resolve(process.cwd(), 'public/logo.jpg');
  let logoEndX = leftX;
  const logoSize = 95;
  const logoPadding = 15;

  // Draw logo if exists
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, leftX, startY, { width: logoSize, height: logoSize });
    logoEndX = leftX + logoSize + logoPadding;
  }

  // Hospital Info
  const hospitalStartX = logoEndX;
  const hospitalWidth = contentWidth - (logoEndX - leftX);

  doc.font('Helvetica-Bold')
    .fontSize(20)
    .fillColor(colors.primary)
    .text(env.HOSPITAL_NAME || 'HOSPITAL NAME', hospitalStartX, startY);

  doc.font('Helvetica')
    .fontSize(9)
    .fillColor(colors.text)
    .text(env.HOSPITAL_ADDRESS || 'Address', hospitalStartX, startY + 25, {
      width: hospitalWidth,
    });

  doc.fontSize(8)
    .text(`Phone: ${env.HOSPITAL_PHONE || '+91-XXX-XXX-XXXX'} | Email: ${env.HOSPITAL_EMAIL || 'email@hospital.com'}`, 
      hospitalStartX, startY + 40, { width: hospitalWidth });

  doc.fontSize(8)
    .text(env.HOSPITAL_EMERGENCY_INFO || 'Emergency: 24/7', hospitalStartX, startY + 52, { width: hospitalWidth });

  const headerBottomY = startY + Math.max(logoSize, 75) + 5;

  // Decorative line
  doc.strokeColor(colors.primary).lineWidth(2);
  doc.moveTo(leftX, headerBottomY).lineTo(leftX + contentWidth, headerBottomY).stroke();

  // Bill title
  doc.font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(colors.accent)
    .text('PROVISIONAL BILL', leftX, headerBottomY + 10, {
      align: 'center',
      width: contentWidth,
    });

  return headerBottomY + 40;
};

const drawPatientInfoSection = (
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  leftX: number,
  contentWidth: number,
  startY: number,
): number => {
  const patientSource = data.invoice.admissions?.patients || data.invoice.patient || {};
  const patient = typeof patientSource === 'object' ? patientSource : { full_name: patientSource };
  const admission = data.invoice.admissions || {};
  const beds = admission.beds || {};
  const rooms = admission.rooms || {};

  const patientName =
    (data.patientName ||
      patient.full_name ||
      [patient.first_name, patient.last_name].filter(Boolean).join(' ') ||
      data.invoice.patient_name ||
      '--'
    ).trim() || '--';

  const patientUid = patient.patient_id || data.invoice.patient_uid || data.invoice.patientId || 'P000001';
  const admissionNumber = admission.admission_id || `A${String(admission.id || '').slice(-6)}` || data.invoice.invoice_number || '--';
  const bedDisplay = beds.bed_number
    ? `${beds.bed_number}${rooms.room_number ? ` (${rooms.room_number})` : ''}${rooms.room_type ? ` - ${rooms.room_type}` : ''}`
    : rooms.room_number 
      ? `Room ${rooms.room_number}${rooms.room_type ? ` - ${rooms.room_type}` : ''}`
      : '--';

  const consultingDoctor = data.doctorName || admission.staff?.name || 'Unknown Doctor';
  
  // Debug logging for missing data
  logger.info('PDF Debug - Patient Data', {
    patientName,
    patientUid,
    admissionNumber,
    bedDisplay,
    consultingDoctor,
    hasBeds: !!admission.beds,
    hasRooms: !!admission.rooms,
    bedNumber: beds.bed_number,
    roomNumber: rooms.room_number,
    roomType: rooms.room_type,
    doctorName: data.doctorName,
    staffName: admission.staff?.name,
    admissionId: admission.id,
    doctorId: admission.doctor_id,
  });
  
  const address = patient.address || data.invoice.patient_address || 'City - 411001';
  const admissionDate = admission.admission_date || data.invoice.admission_date || data.invoice.created_at;
  const dischargeDate = admission.discharge_date || data.invoice.discharge_date;

  // Background for patient info
  const sectionHeight = 95;
  doc.rect(leftX, startY, contentWidth, sectionHeight).fill(colors.lightBg);
  doc.strokeColor(colors.border).lineWidth(1).rect(leftX, startY, contentWidth, sectionHeight).stroke();

  const colWidth = contentWidth / 2;
  const leftColX = leftX + 10;
  const rightColX = leftX + colWidth + 10;
  let infoY = startY + 8;

  // Left Column
  drawInfoField(doc, leftColX, infoY, 'Patient Name', patientName, colWidth - 20);
  infoY += 15;
  drawInfoField(doc, leftColX, infoY, 'Patient UID', patientUid, colWidth - 20);
  infoY += 15;
  drawInfoField(doc, leftColX, infoY, 'Age / Gender', `${calculateAge(patient.date_of_birth)} / ${formatGender(patient.gender)}`, colWidth - 20);
  infoY += 15;
  drawInfoField(doc, leftColX, infoY, 'Address', address, colWidth - 20);

  // Right Column
  infoY = startY + 8;
  drawInfoField(doc, rightColX, infoY, 'Admission No', admissionNumber, colWidth - 20);
  infoY += 15;
  drawInfoField(doc, rightColX, infoY, 'Bill Date', formatDate(data.invoice.created_at), colWidth - 20);
  infoY += 15;
  drawInfoField(doc, rightColX, infoY, 'Bed No(s)', bedDisplay, colWidth - 20);
  infoY += 15;
  drawInfoField(doc, rightColX, infoY, 'Consulting Doctor', consultingDoctor, colWidth - 20);

  return startY + sectionHeight + 20;
};

const drawBillDetailsSection = (
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  leftX: number,
  contentWidth: number,
  startY: number,
): number => {
  const admission = data.invoice.admissions || {};
  const admissionDate = admission.admission_date || data.invoice.admission_date || data.invoice.created_at;
  const dischargeDate = admission.discharge_date || data.invoice.discharge_date;

  const colWidth = contentWidth / 2;

  // Left Column
  doc.font('Helvetica-Bold').fontSize(9).fillColor(colors.text).text('Admission Date:', leftX, startY);
  doc.font('Helvetica').fontSize(9).text(formatDate(admissionDate), leftX + 100, startY);

  // Right Column
  doc.font('Helvetica-Bold').fontSize(9).text('Discharge Date:', leftX + colWidth, startY);
  doc.font('Helvetica').fontSize(9).text(formatDate(dischargeDate), leftX + colWidth + 100, startY);

  return startY + 20;
};

const drawBillingTable = (
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  leftX: number,
  contentWidth: number,
  startY: number,
): number => {
  doc.font('Helvetica-Bold').fontSize(11).fillColor(colors.primary).text('BILL DETAILS', leftX, startY);
  startY += 15;

  const widthConfig = {
    dateOnly: 90,
    particulars: 0,
    rate: 70,
    qty: 35,
    amount: 70,
    gst: 70,
    total: 70,
  };

  const minWidths: Record<keyof typeof widthConfig, number> = {
    dateOnly: 70,
    particulars: 140,
    rate: 60,
    qty: 30,
    amount: 60,
    gst: 60,
    total: 60,
  };

  const staticSum =
    widthConfig.dateOnly +
    widthConfig.rate +
    widthConfig.qty +
    widthConfig.amount +
    widthConfig.gst +
    widthConfig.total;

  widthConfig.particulars = Math.max(minWidths.particulars, contentWidth - staticSum);

  let totalWidth = staticSum + widthConfig.particulars;
  const shrinkOrder: Array<keyof typeof widthConfig> = [
    'particulars',
    'rate',
    'amount',
    'gst',
    'total',
    'dateOnly',
  ];

  while (totalWidth > contentWidth) {
    let adjusted = false;
    for (const key of shrinkOrder) {
      if (totalWidth <= contentWidth) break;
      if (widthConfig[key] > minWidths[key]) {
        widthConfig[key] -= 1;
        totalWidth -= 1;
        adjusted = true;
      }
    }
    if (!adjusted) break;
  }

  const columns: TableColumn[] = [
    { label: 'Date', width: widthConfig.dateOnly },
    { label: 'Particulars', width: widthConfig.particulars },
    { label: 'Rate', width: widthConfig.rate, align: 'right' },
    { label: 'Qty', width: widthConfig.qty, align: 'center' },
    { label: 'Amount', width: widthConfig.amount, align: 'right' },
    { label: 'GST (18%)', width: widthConfig.gst, align: 'right' },
    { label: 'Total', width: widthConfig.total, align: 'right' },
  ];

  const items = data.billItems.length
    ? data.billItems
    : [{ item_name: 'Room Charges', amount: Number(data.invoice.total_amount || 0) }];

  const rows = items.map((item) => {
    const rate = Number(item.unit_price || item.rate || item.amount || 0);
    const qty = Number(item.quantity || item.units || 1);
    const amount = rate * qty || Number(item.amount || item.total_price || 0);
    const baseAmount = amount > 0 ? amount : rate * qty;
    const gst = baseAmount * 0.18;
    const total = baseAmount + gst;

    return [
      formatDate(item.created_at || data.invoice.created_at),
      item.item_name || item.description || item.particulars || 'Service Charge',
      formatCurrency(rate || baseAmount),
      qty.toString(),
      formatCurrency(baseAmount),
      formatCurrency(gst),
      formatCurrency(total),
    ];
  });

  return drawTable(doc, columns, rows, leftX, startY, 'standard', {
    headerHeight: 24,
    rowHeight: 18,
    headerFontSize: 9,
    rowFontSize: 9,
  });
};

const drawTotalsSectionOptimized = (
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  leftX: number,
  contentWidth: number,
  startY: number,
): number => {
  const summaryWidth = 280;
  const summaryX = leftX + contentWidth - summaryWidth;

  // Calculate totals from bill items to ensure accuracy
  const calculatedSubtotal = data.billItems.reduce((sum, item) => sum + Number(item.amount || item.total_price || 0), 0);
  const subtotal = Number(data.invoice.total_amount || calculatedSubtotal || 0);
  
  // Calculate GST as 18% of subtotal
  const calculatedGst = subtotal * 0.18;
  const gst = Number(data.invoice.gst_amount || calculatedGst);
  
  const discount = Number(data.invoice.discount_value || 0);
  const discountType = data.invoice.discount_type || 'fixed';
  
  // Calculate discount amount
  let discountAmount = discount;
  if (discountType === 'percentage') {
    discountAmount = subtotal * (discount / 100);
  }
  
  const calculatedPayable = subtotal + gst - discountAmount;
  const payable = Number(data.invoice.amount_payable || calculatedPayable);
  const amountPaid = Number(data.invoice.amount_paid || 0);
  const balance = Number(data.invoice.balance || payable - amountPaid);
  
  const discountDisplay = discountType === 'percentage' ? `${discount}%` : formatCurrency(discount);
  
  // Debug logging
  logger.info('PDF Totals Calculation', {
    calculatedSubtotal,
    subtotal,
    calculatedGst,
    gst,
    discount,
    discountType,
    discountAmount,
    calculatedPayable,
    payable,
    amountPaid,
    balance,
    billItemsCount: data.billItems.length
  });

  const rows: Array<[string, string, 'normal' | 'highlight' | 'total']> = [
    ['Subtotal', formatCurrency(subtotal), 'normal'],
    ['Discount', discountDisplay, 'normal'],
    ['GST (18%)', formatCurrency(gst), 'normal'],
    ['Amount Payable', formatCurrency(payable), 'highlight'],
    ['Amount Paid', formatCurrency(amountPaid), 'normal'],
    ['Balance Due', formatCurrency(balance), 'total'],
  ];

  // Background for totals
  doc.rect(summaryX - 10, startY, summaryWidth + 20, rows.length * 18 + 20)
    .fill(colors.lightBg);
  doc.strokeColor(colors.border).lineWidth(1)
    .rect(summaryX - 10, startY, summaryWidth + 20, rows.length * 18 + 20)
    .stroke();

  let currentY = startY + 10;

  rows.forEach(([label, value, type]) => {
    if (type === 'total') {
      doc.rect(summaryX - 10, currentY - 2, summaryWidth + 20, 18)
        .fill(colors.primary);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff');
    } else if (type === 'highlight') {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(colors.accent);
    } else {
      doc.font('Helvetica').fontSize(9).fillColor(colors.text);
    }

    doc.text(label, summaryX, currentY, { width: summaryWidth * 0.55, align: 'left' });
    doc.text(value, summaryX + summaryWidth * 0.55, currentY, { width: summaryWidth * 0.45, align: 'right' });
    currentY += 18;
  });

  return currentY + 20;
};

interface TableRenderOptions {
  headerHeight?: number;
  rowHeight?: number;
  headerFontSize?: number;
  rowFontSize?: number;
}

const drawTable = (
  doc: PDFKit.PDFDocument,
  columns: TableColumn[],
  rows: string[][],
  startX: number,
  startY: number,
  variant: 'light' | 'standard' = 'standard',
  options: TableRenderOptions = {},
): number => {
  const tableWidth = columns.reduce((sum, col) => sum + col.width, 0);
  const headerHeight = options.headerHeight ?? 20;
  const rowHeight = options.rowHeight ?? 16;
  const headerFontSize = options.headerFontSize ?? 8.5;
  const rowFontSize = options.rowFontSize ?? 8;

  // Draw header
  doc.rect(startX, startY, tableWidth, headerHeight)
    .fill(colors.primary);

  doc.strokeColor(colors.primary).lineWidth(1);
  doc.rect(startX, startY, tableWidth, headerHeight).stroke();

  doc.font('Helvetica-Bold').fontSize(headerFontSize).fillColor('#fff');
  let currentX = startX;
  columns.forEach((col) => {
    doc.text(col.label, currentX + 5, startY + 6, {
      width: col.width - 10,
      align: col.align || 'left',
    });
    currentX += col.width;
  });

  let currentY = startY + headerHeight;
  doc.font('Helvetica').fontSize(rowFontSize).fillColor(colors.text);

  // Draw rows
  rows.forEach((row, idx) => {
    const bgColor = variant === 'light' && idx % 2 === 0 ? colors.lightBg : '#fff';
    doc.rect(startX, currentY, tableWidth, rowHeight).fill(bgColor);
    doc.strokeColor(colors.border).lineWidth(0.5);
    doc.rect(startX, currentY, tableWidth, rowHeight).stroke();

    // Reset text style after background fill (PDFKit keeps fill color from .fill())
    doc.font('Helvetica').fontSize(rowFontSize).fillColor(colors.text);

    let x = startX;
    row.forEach((cell, index) => {
      const col = columns[index];
      const text = cell || '';
      const maxWidth = col.width - 10;

      const truncated = truncateText(doc, text, maxWidth, 'Helvetica', 8);
      doc.text(truncated, x + 5, currentY + 3, {
        width: maxWidth,
        align: col.align || 'left',
      });
      x += col.width;
    });

    currentY += rowHeight;
  });

  return currentY + 15;
};

const drawAdmissionSummaryPage = (
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  leftX: number,
  contentWidth: number,
  pageWidth: number,
): void => {
  if (!data.admissionSummary) return;

  doc.addPage();

  const logoPath = path.join(process.cwd(), 'public', 'logo.jpg');
  let logoY = 35;
  if (fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, leftX, logoY, { width: 50, height: 50 });
    } catch (err) {
      logger.warn('Failed to load logo for admission summary page', { error: err });
    }
  }

  doc.font('Helvetica-Bold').fontSize(18).fillColor(colors.primary);
  doc.text('ASHWINI GENERAL HOSPITAL', leftX + 60, logoY + 5, { width: contentWidth - 60 });
  
  doc.font('Helvetica').fontSize(9).fillColor(colors.text);
  doc.text('Comprehensive Healthcare Services', leftX + 60, logoY + 25, { width: contentWidth - 60 });

  doc.strokeColor(colors.border).lineWidth(2);
  doc.moveTo(leftX, logoY + 60).lineTo(pageWidth - 35, logoY + 60).stroke();

  let currentY = logoY + 80;

  doc.font('Helvetica-Bold').fontSize(16).fillColor(colors.primary);
  doc.text('TREATMENT SUMMARY', leftX, currentY, { width: contentWidth, align: 'center' });
  currentY += 30;

  doc.font('Helvetica').fontSize(9).fillColor(colors.text);
  doc.text(`Patient: ${data.patientName}`, leftX, currentY);
  currentY += 15;
  doc.text(`Consulting Doctor: ${data.doctorName}`, leftX, currentY);
  currentY += 15;
  doc.text(`Invoice: ${data.invoice.invoice_number || 'N/A'}`, leftX, currentY);
  currentY += 30;

  const sectionSpacing = 20;
  const labelColor = colors.primary;
  const textColor = colors.text;

  doc.font('Helvetica-Bold').fontSize(11).fillColor(labelColor);
  doc.text('Chief Complaint / Presenting Problem', leftX, currentY);
  currentY += 15;
  doc.font('Helvetica').fontSize(10).fillColor(textColor);
  doc.text(data.admissionSummary.chief_complaint, leftX, currentY, {
    width: contentWidth,
    align: 'left',
  });
  currentY = doc.y + sectionSpacing;

  doc.font('Helvetica-Bold').fontSize(11).fillColor(labelColor);
  doc.text('Diagnosis', leftX, currentY);
  currentY += 15;
  doc.font('Helvetica').fontSize(10).fillColor(textColor);
  doc.text(data.admissionSummary.diagnosis, leftX, currentY, {
    width: contentWidth,
    align: 'left',
  });
  currentY = doc.y + sectionSpacing;

  doc.font('Helvetica-Bold').fontSize(11).fillColor(labelColor);
  doc.text('Treatment Provided', leftX, currentY);
  currentY += 15;
  doc.font('Helvetica').fontSize(10).fillColor(textColor);
  doc.text(data.admissionSummary.treatment_provided, leftX, currentY, {
    width: contentWidth,
    align: 'left',
  });
  currentY = doc.y + sectionSpacing;

  doc.font('Helvetica-Bold').fontSize(11).fillColor(labelColor);
  doc.text('Outcome / Patient Status', leftX, currentY);
  currentY += 15;
  doc.font('Helvetica').fontSize(10).fillColor(textColor);
  doc.text(data.admissionSummary.outcome, leftX, currentY, {
    width: contentWidth,
    align: 'left',
  });
  currentY = doc.y + sectionSpacing;

  if (data.admissionSummary.recommendations) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(labelColor);
    doc.text('Recommendations / Follow-up Instructions', leftX, currentY);
    currentY += 15;
    doc.font('Helvetica').fontSize(10).fillColor(textColor);
    doc.text(data.admissionSummary.recommendations, leftX, currentY, {
      width: contentWidth,
      align: 'left',
    });
    currentY = doc.y + sectionSpacing;
  }

  // Add footer at bottom of current page without creating new page
  const bottomMargin = 60;
  const footerY = doc.page.height - bottomMargin;
  
  // Only add footer if we have space, otherwise it's fine to skip
  if (doc.y < footerY - 30) {
    doc.strokeColor(colors.border).lineWidth(1);
    doc.moveTo(leftX, footerY).lineTo(pageWidth - 35, footerY).stroke();

    doc.font('Helvetica').fontSize(7).fillColor('#999');
    doc.text(`Generated on: ${formatDateTime(new Date().toISOString())}`, leftX, footerY + 10, {
      width: contentWidth,
      align: 'center',
    });
  }
};

const drawFooter = (
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  leftX: number,
  contentWidth: number,
  pageWidth: number,
): void => {
  const footerHeight = 40;
  const bottomMargin = 60;
  // Try to keep footer on existing page; if content is too close to the bottom,
  // place the footer just below the current content but clamp within page bounds.
  let footerY = Math.max(doc.y + 20, doc.page.height - bottomMargin);
  const maxFooterTop = doc.page.height - (bottomMargin - 10);
  if (footerY > maxFooterTop) {
    footerY = maxFooterTop;
  }

  doc.strokeColor(colors.border).lineWidth(1);
  doc.moveTo(leftX, footerY).lineTo(pageWidth - 35, footerY).stroke();

  doc.font('Helvetica').fontSize(8).fillColor('#999');
  const footerText = [
    'This is a computer generated provisional bill and does not require a signature.',
    `Generated on: ${formatDateTime(new Date().toISOString())}`,
  ].join('\n');

  doc.text(footerText, leftX, footerY + 10, {
    width: contentWidth,
    align: 'center',
    lineGap: 4,
  });
};

const drawInfoField = (
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  label: string,
  value: string,
  maxWidth: number,
): void => {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(colors.primary).text(`${label}:`, x, y);
  const labelWidth = doc.widthOfString(`${label}:`);
  const maxValueWidth = maxWidth - labelWidth - 5;

  const truncated = truncateText(doc, value || '--', maxValueWidth, 'Helvetica', 8);
  doc.font('Helvetica').fontSize(8).fillColor(colors.text).text(truncated, x + labelWidth + 5, y);
};

const truncateText = (
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
  font: string,
  size: number,
): string => {
  doc.font(font).fontSize(size);
  const width = doc.widthOfString(text);
  if (width <= maxWidth) return text;
  
  // More aggressive truncation to ensure text fits
  let truncated = text;
  while (doc.widthOfString(truncated + '...') > maxWidth && truncated.length > 0) {
    truncated = truncated.substring(0, truncated.length - 1);
  }
  return truncated.length > 0 ? truncated + '...' : text.substring(0, 3) + '...';
};

const calculateAge = (dateOfBirth?: string) => {
  if (!dateOfBirth) return '--';
  const birthDate = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age.toString();
};

const formatDate = (value?: string) => {
  if (!value) return '--';
  return new Date(value).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
};

const formatDateTime = (value?: string) => {
  if (!value) return '--';
  const date = new Date(value);
  return date.toLocaleDateString('en-IN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }) + ' ' + date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
};

const formatCurrency = (value: number) => {
  return `Rs. ${value.toFixed(2)}`;
};

const formatGender = (gender?: string) => {
  if (!gender) return '--';
  return gender.charAt(0).toUpperCase() + gender.slice(1).toLowerCase();
};

export const generatePatientAuditPDF = async (data: PatientAuditData): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ 
        margin: 36, 
        size: 'A4',
        layout: 'landscape',
        bufferPages: true 
      });
      const buffers: Buffer[] = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      const pageWidth = doc.page.width;
      const leftX = doc.page.margins.left;
      const rightX = pageWidth - doc.page.margins.right;
      const contentWidth = rightX - leftX;

      let cursorY = doc.page.margins.top;

      cursorY = drawAuditHeader(doc, 'PATIENT AUDIT REPORT', data.dateFrom, data.dateTo, data.generatedBy, leftX, contentWidth, cursorY);

      cursorY = drawPatientAuditTable(doc, data.patients, leftX, contentWidth, cursorY);

      drawAuditFooter(doc, data.patients.length, leftX, contentWidth, pageWidth);

      doc.end();
    } catch (error) {
      logger.error('Patient audit PDF generation failed', { error });
      reject(error);
    }
  });
};

export const generateAdmissionAuditPDF = async (data: AdmissionAuditData): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ 
        margin: 36, 
        size: 'A4',
        bufferPages: true,
        layout: 'landscape'
      });
      const buffers: Buffer[] = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      const pageWidth = doc.page.width;
      const leftX = doc.page.margins.left;
      const rightX = pageWidth - doc.page.margins.right;
      const contentWidth = rightX - leftX;

      let cursorY = doc.page.margins.top;

      cursorY = drawAuditHeader(doc, 'ADMISSION AUDIT REPORT', data.dateFrom, data.dateTo, data.generatedBy, leftX, contentWidth, cursorY);

      cursorY = drawAdmissionAuditTable(doc, data.admissions, leftX, contentWidth, cursorY);

      drawAuditFooter(doc, data.admissions.length, leftX, contentWidth, pageWidth);

      doc.end();
    } catch (error) {
      logger.error('Admission audit PDF generation failed', { error });
      reject(error);
    }
  });
};

const drawAuditHeader = (
  doc: PDFKit.PDFDocument,
  title: string,
  dateFrom: string,
  dateTo: string,
  generatedBy: string,
  leftX: number,
  contentWidth: number,
  startY: number,
): number => {
  const logoPath = path.resolve(process.cwd(), 'public/logo.jpg');
  let logoEndX = leftX;
  const logoSize = 95;
  const logoPadding = 15;

  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, leftX, startY, { width: logoSize, height: logoSize });
    logoEndX = leftX + logoSize + logoPadding;
  }

  const hospitalStartX = logoEndX;
  const hospitalWidth = contentWidth - (logoEndX - leftX);

  doc.font('Helvetica-Bold')
    .fontSize(20)
    .fillColor(colors.primary)
    .text(env.HOSPITAL_NAME || 'HOSPITAL NAME', hospitalStartX, startY);

  doc.font('Helvetica')
    .fontSize(9)
    .fillColor(colors.text)
    .text(env.HOSPITAL_ADDRESS || 'Address', hospitalStartX, startY + 25, {
      width: hospitalWidth,
    });

  doc.fontSize(8)
    .text(`Phone: ${env.HOSPITAL_PHONE || '+91-XXX-XXX-XXXX'} | Email: ${env.HOSPITAL_EMAIL || 'email@hospital.com'}`, 
      hospitalStartX, startY + 40, { width: hospitalWidth });

  doc.fontSize(8)
    .text(env.HOSPITAL_EMERGENCY_INFO || 'Emergency: 24/7', hospitalStartX, startY + 52, { width: hospitalWidth });

  const headerBottomY = startY + Math.max(logoSize, 75) + 5;

  doc.strokeColor(colors.primary).lineWidth(2);
  doc.moveTo(leftX, headerBottomY).lineTo(leftX + contentWidth, headerBottomY).stroke();

  doc.font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(colors.accent)
    .text(title, leftX, headerBottomY + 10, {
      align: 'center',
      width: contentWidth,
    });

  doc.font('Helvetica')
    .fontSize(10)
    .fillColor(colors.text)
    .text(`Period: ${formatDate(dateFrom)} to ${formatDate(dateTo)}`, leftX, headerBottomY + 35, {
      align: 'center',
      width: contentWidth,
    });

  doc.fontSize(9)
    .fillColor(colors.text)
    .text(`Generated by: ${generatedBy}`, leftX, headerBottomY + 50, {
      align: 'center',
      width: contentWidth,
    });

  const titleBottomSpacing = 90;
  return headerBottomY + titleBottomSpacing;
};

const drawPatientAuditTable = (
  doc: PDFKit.PDFDocument,
  patients: any[],
  leftX: number,
  contentWidth: number,
  startY: number,
): number => {
  doc.font('Helvetica-Bold').fontSize(11).fillColor(colors.primary).text('PATIENT RECORDS', leftX, startY);
  startY += 20;

  const patientIdWidth = Math.floor(contentWidth * 0.1);
  const nameWidth = Math.floor(contentWidth * 0.25);
  const ageGenderWidth = Math.floor(contentWidth * 0.1);
  const phoneWidth = Math.floor(contentWidth * 0.17);
  const bloodGroupWidth = Math.floor(contentWidth * 0.1);
  const createdDateWidth = Math.floor(contentWidth * 0.1);
  const createdByWidth =
    contentWidth -
    (patientIdWidth + nameWidth + ageGenderWidth + phoneWidth + bloodGroupWidth + createdDateWidth);

  const columns: TableColumn[] = [
    { label: 'Patient ID', width: patientIdWidth },
    { label: 'Name', width: nameWidth },
    { label: 'Age & Gender', width: ageGenderWidth, align: 'center' },
    { label: 'Phone', width: phoneWidth },
    { label: 'Blood Group', width: bloodGroupWidth, align: 'center' },
    { label: 'Created On', width: createdDateWidth },
    { label: 'Created By', width: createdByWidth },
  ];

  const rows = patients.map((patient) => {
    const age = calculateAge(patient.date_of_birth);
    const gender = formatGender(patient.gender);
    const createdBy = patient.staff?.name || patient.created_by_name || '--';
    
    return [
      patient.patient_id || '--',
      `${patient.first_name || ''} ${patient.last_name || ''}`.trim() || '--',
      `${age}/${gender}`,
      patient.phone || '--',
      patient.blood_group || '--',
      formatDate(patient.created_at),
      createdBy,
    ];
  });

  return drawTable(doc, columns, rows, leftX, startY, 'standard', {
    headerHeight: 24,
    rowHeight: 18,
    headerFontSize: 9,
    rowFontSize: 9,
  });
};

const drawAdmissionAuditTable = (
  doc: PDFKit.PDFDocument,
  admissions: any[],
  leftX: number,
  contentWidth: number,
  startY: number,
): number => {
  doc.font('Helvetica-Bold').fontSize(11).fillColor(colors.primary).text('ADMISSION RECORDS', leftX, startY);
  startY += 20;

  const admissionIdWidth = Math.floor(contentWidth * 0.12);
  const patientNameWidth = Math.floor(contentWidth * 0.22);
  const patientIdWidth = Math.floor(contentWidth * 0.12);
  const roomWidth = Math.floor(contentWidth * 0.1);
  const admissionDateWidth = Math.floor(contentWidth * 0.14);
  const dischargeDateWidth = Math.floor(contentWidth * 0.14);
  const statusWidth = Math.floor(contentWidth * 0.08);
  const doctorWidth =
    contentWidth -
    (admissionIdWidth +
      patientNameWidth +
      patientIdWidth +
      roomWidth +
      admissionDateWidth +
      dischargeDateWidth +
      statusWidth);

  const columns: TableColumn[] = [
    { label: 'Admission ID', width: admissionIdWidth },
    { label: 'Patient Name', width: patientNameWidth },
    { label: 'Patient ID', width: patientIdWidth },
    { label: 'Room', width: roomWidth, align: 'center' },
    { label: 'Admission Date', width: admissionDateWidth },
    { label: 'Discharge Date', width: dischargeDateWidth },
    { label: 'Status', width: statusWidth, align: 'center' },
    { label: 'Doctor', width: doctorWidth },
  ];

  const rows = admissions.map((admission) => {
    const patient = admission.patients || {};
    const patientName = `${patient.first_name || ''} ${patient.last_name || ''}`.trim() || '--';
    const room = admission.rooms?.room_number || '--';
    const doctor = admission.doctor_staff?.name || '--';
    
    return [
      admission.admission_id || `A${String(admission.id || '').slice(-6)}`,
      patientName,
      patient.patient_id || '--',
      room,
      formatDate(admission.admission_date),
      formatDate(admission.discharge_date),
      (admission.status || 'active').toUpperCase(),
      doctor,
    ];
  });

  return drawTable(doc, columns, rows, leftX, startY, 'standard');
};

const drawAuditFooter = (
  doc: PDFKit.PDFDocument,
  recordCount: number,
  leftX: number,
  contentWidth: number,
  pageWidth: number,
): void => {
  const blockHeight = 55;
  const bottomMargin = doc.page.margins.bottom;
  const usableHeight = doc.page.height - bottomMargin - doc.y;

  if (usableHeight < blockHeight) {
    doc.addPage();
  }

  const footerTop = doc.page.height - bottomMargin - blockHeight;
  const footerLineRight = pageWidth - doc.page.margins.right;

  doc.strokeColor(colors.border).lineWidth(1);
  doc.moveTo(leftX, footerTop).lineTo(footerLineRight, footerTop).stroke();

  const summaryY = footerTop + 12;
  const noticeY = summaryY + 15;
  const timestampY = noticeY + 14;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(colors.text);
  doc.text(`Total Records: ${recordCount}`, leftX, summaryY, {
    width: contentWidth,
    align: 'center',
  });

  doc.font('Helvetica').fontSize(8).fillColor('#999');
  doc.text('This is a computer generated audit report.', leftX, noticeY, {
    width: contentWidth,
    align: 'center',
  });

  doc.fontSize(7).text(`Generated on: ${formatDateTime(new Date().toISOString())}`, leftX, timestampY, {
    width: contentWidth,
    align: 'center',
  });
};