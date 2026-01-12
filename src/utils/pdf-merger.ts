import { PDFDocument } from 'pdf-lib';
import { logger } from './logger.js';

/**
 * Merge multiple PDF buffers into a single PDF
 */
export async function mergePDFs(pdfBuffers: Buffer[]): Promise<Buffer> {
  try {
    const mergedPdf = await PDFDocument.create();

    for (const pdfBuffer of pdfBuffers) {
      const pdf = await PDFDocument.load(pdfBuffer);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => {
        mergedPdf.addPage(page);
      });
    }

    const mergedPdfBytes = await mergedPdf.save();
    return Buffer.from(mergedPdfBytes);
  } catch (error: any) {
    logger.error('Failed to merge PDFs', { error: error.message });
    throw new Error(`PDF merge failed: ${error.message}`);
  }
}

/**
 * Download PDF from URL and return as Buffer
 */
export async function downloadPDF(url: string): Promise<Buffer> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error: any) {
    logger.error('Failed to download PDF', { url, error: error.message });
    throw new Error(`PDF download failed: ${error.message}`);
  }
}

/**
 * Merge invoice PDF with lab report PDFs
 */
export async function mergeInvoiceWithLabReports(
  invoicePdfBuffer: Buffer,
  labReportUrls: string[]
): Promise<Buffer> {
  try {
    logger.info('Starting mergeInvoiceWithLabReports', { 
      invoicePdfBufferSize: invoicePdfBuffer.length,
      labReportUrlsCount: labReportUrls.length,
      labReportUrls 
    });

    const pdfBuffers: Buffer[] = [invoicePdfBuffer];

    // Download all lab report PDFs
    for (let i = 0; i < labReportUrls.length; i++) {
      const url = labReportUrls[i];
      try {
        logger.info(`Attempting to download lab report PDF ${i + 1}/${labReportUrls.length}`, { url });
        const labPdfBuffer = await downloadPDF(url);
        logger.info(`Lab report PDF ${i + 1} downloaded successfully`, { 
          url, 
          bufferSize: labPdfBuffer.length 
        });
        pdfBuffers.push(labPdfBuffer);
      } catch (error: any) {
        logger.error(`Failed to download lab report PDF ${i + 1}`, { 
          url, 
          error: error.message,
          stack: error.stack 
        });
        // Continue with other PDFs even if one fails
      }
    }

    logger.info('All lab report PDFs processed', { 
      totalBuffers: pdfBuffers.length,
      invoiceBuffer: 1,
      labReportBuffers: pdfBuffers.length - 1 
    });

    // Merge all PDFs
    logger.info('Starting PDF merge operation');
    const mergedPdf = await mergePDFs(pdfBuffers);
    logger.info('Successfully merged invoice with lab reports', {
      totalPdfs: pdfBuffers.length,
      labReportsIncluded: pdfBuffers.length - 1,
      finalMergedSize: mergedPdf.length
    });

    return mergedPdf;
  } catch (error: any) {
    logger.error('Failed to merge invoice with lab reports', { 
      error: error.message,
      stack: error.stack 
    });
    throw new Error(`Invoice merge failed: ${error.message}`);
  }
}
