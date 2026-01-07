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
      const leftX = 35;
      const rightX = pageWidth - 35;
      const contentWidth = rightX - leftX;

      let cursorY = 20;

      // Header
      cursorY = drawHeader(doc, data, leftX, contentWidth, cursorY);

      // Patient Info Section
      cursorY = drawPatientInfoSection(doc, data, leftX, contentWidth, cursorY);

      // Bill Details Section
      cursorY = drawBillDetailsSection(doc, data, leftX, contentWidth, cursorY);

      // Item Summary Table
      cursorY = drawSummaryTable(doc, data, leftX, contentWidth, cursorY);

      // Detailed Breakup
      cursorY = drawDetailedBreakup(doc, data, leftX, contentWidth, cursorY);

      // Totals Section
      cursorY = drawTotalsSectionOptimized(doc, data, leftX, contentWidth, cursorY);

      // Footer
      drawFooter(doc, data, leftX, contentWidth, pageWidth);

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

  // Draw logo if exists
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, leftX, startY, { width: 70, height: 70 });
    logoEndX = leftX + 80;
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

  // Decorative line
  doc.strokeColor(colors.primary).lineWidth(2);
  doc.moveTo(leftX, startY + 75).lineTo(leftX + contentWidth, startY + 75).stroke();

  // Bill title
  doc.font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(colors.accent)
    .text('PROVISIONAL BILL', leftX, startY + 85, {
      align: 'center',
      width: contentWidth,
    });

  return startY + 115;
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

const drawSummaryTable = (
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  leftX: number,
  contentWidth: number,
  startY: number,
): number => {
  doc.font('Helvetica-Bold').fontSize(11).fillColor(colors.primary).text('BILL SUMMARY', leftX, startY);
  startY += 15;

  const fixedWidths = {
    code: 60,
    amount: 80,
    gst: 80,
    total: 90,
  };

  const descriptionWidth =
    contentWidth - (fixedWidths.code + fixedWidths.amount + fixedWidths.gst + fixedWidths.total);

  const columns: TableColumn[] = [
    { label: 'Code', width: fixedWidths.code, align: 'center' },
    { label: 'Description', width: Math.max(160, descriptionWidth), align: 'left' },
    { label: 'Amount', width: fixedWidths.amount, align: 'right' },
    { label: 'GST (18%)', width: fixedWidths.gst, align: 'right' },
    { label: 'Total', width: fixedWidths.total, align: 'right' },
  ];

  const rows = (data.billItems.length
    ? data.billItems
    : [{ item_name: 'Room Charges', amount: Number(data.invoice.total_amount || 0) }]
  ).map((item) => {
    const amount = Number(item.amount || item.total_price || 0);
    const gst = amount * 0.18;
    return [
      item.item_code || item.primary_code || '100000',
      item.item_name || item.description || item.particulars || 'Service Charge',
      formatCurrency(amount),
      formatCurrency(gst),
      formatCurrency(amount + gst),
    ];
  });

  return drawTable(doc, columns, rows, leftX, startY, 'light');
};

const drawDetailedBreakup = (
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  leftX: number,
  contentWidth: number,
  startY: number,
): number => {
  doc.font('Helvetica-Bold').fontSize(11).fillColor(colors.primary).text('DETAILED BREAKUP', leftX, startY);
  startY += 15;

  const widthConfig = {
    code: 55,
    dateOnly: 90,
    particulars: 0,
    rate: 70,
    qty: 35,
    amount: 70,
    gst: 70,
    total: 70,
  };

  const minWidths: Record<keyof typeof widthConfig, number> = {
    code: 45,
    dateOnly: 70,
    particulars: 120,
    rate: 55,
    qty: 30,
    amount: 60,
    gst: 60,
    total: 60,
  };

  const staticSum =
    widthConfig.code +
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
    'code',
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
    { label: 'Code', width: widthConfig.code },
    { label: 'Date', width: widthConfig.dateOnly },
    { label: 'Particulars', width: widthConfig.particulars },
    { label: 'Rate', width: widthConfig.rate, align: 'right' },
    { label: 'Qty', width: widthConfig.qty, align: 'center' },
    { label: 'Amount', width: widthConfig.amount, align: 'right' },
    { label: 'GST', width: widthConfig.gst, align: 'right' },
    { label: 'Total', width: widthConfig.total, align: 'right' },
  ];

  const rows = (data.billItems.length
    ? data.billItems
    : [{ item_name: 'Room Charges', amount: Number(data.invoice.total_amount || 0) }]
  ).map((item) => {
    const rate = Number(item.unit_price || item.rate || item.amount || 0);
    const qty = Number(item.quantity || item.units || 1);
    const amount = rate * qty;
    const gst = amount * 0.18;
    const total = amount + gst;

    return [
      item.item_code || '100000',
      formatDate(item.created_at || data.invoice.created_at),
      item.item_name || item.description || 'Service Charge',
      formatCurrency(rate),
      qty.toString(),
      formatCurrency(amount),
      formatCurrency(gst),
      formatCurrency(total),
    ];
  });

  return drawTable(doc, columns, rows, leftX, startY, 'standard');
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

const drawTable = (
  doc: PDFKit.PDFDocument,
  columns: TableColumn[],
  rows: string[][],
  startX: number,
  startY: number,
  variant: 'light' | 'standard' = 'standard',
): number => {
  const tableWidth = columns.reduce((sum, col) => sum + col.width, 0);
  const headerHeight = 20;
  const rowHeight = 16;

  // Draw header
  doc.rect(startX, startY, tableWidth, headerHeight)
    .fill(colors.primary);

  doc.strokeColor(colors.primary).lineWidth(1);
  doc.rect(startX, startY, tableWidth, headerHeight).stroke();

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#fff');
  let currentX = startX;
  columns.forEach((col) => {
    doc.text(col.label, currentX + 5, startY + 6, {
      width: col.width - 10,
      align: col.align || 'left',
    });
    currentX += col.width;
  });

  let currentY = startY + headerHeight;
  doc.font('Helvetica').fontSize(8).fillColor(colors.text);

  // Draw rows
  rows.forEach((row, idx) => {
    const bgColor = variant === 'light' && idx % 2 === 0 ? colors.lightBg : '#fff';
    doc.rect(startX, currentY, tableWidth, rowHeight).fill(bgColor);
    doc.strokeColor(colors.border).lineWidth(0.5);
    doc.rect(startX, currentY, tableWidth, rowHeight).stroke();

    // Reset text style after background fill (PDFKit keeps fill color from .fill())
    doc.font('Helvetica').fontSize(8).fillColor(colors.text);

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

const drawFooter = (
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  leftX: number,
  contentWidth: number,
  pageWidth: number,
): void => {
  const currentY = doc.y;
  const footerY = doc.page.height - 60;
  
  // Only draw footer if there's enough space, otherwise it will create a new page
  if (currentY < footerY - 30) {
    doc.strokeColor(colors.border).lineWidth(1);
    doc.moveTo(leftX, footerY).lineTo(pageWidth - 35, footerY).stroke();

    doc.font('Helvetica').fontSize(8).fillColor('#999');
    doc.text('This is a computer generated provisional bill and does not require a signature.', leftX, footerY + 10, {
      width: contentWidth,
      align: 'center',
    });

    doc.fontSize(7).text(`Generated on: ${formatDateTime(new Date().toISOString())}`, leftX, footerY + 22, {
      width: contentWidth,
      align: 'center',
    });
  }
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