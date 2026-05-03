import dotenv from 'dotenv';
import { generateInvoicePDF } from './src/utils/pdf-generator.js';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config();

// Create test invoice data
const testData = {
  invoice: {
    invoice_number: 'INV-2024-001',
    created_at: new Date().toISOString(),
    total_amount: 15000,
    gst_amount: 2700,
    discount_value: 0,
    amount_payable: 17700,
    paid_amount: 10000,
    balance: 7700,
    admissions: {
      admission_id: 'ADM-2024-001',
      admission_date: new Date().toISOString(),
      discharge_date: null,
      patients: {
        first_name: 'John',
        last_name: 'Doe',
        patient_id: 'P001',
        date_of_birth: '1990-01-01',
        gender: 'male',
        address: 'ARJUN CO-OP SOCIETY,BAJI PRABHU DESHPANDE MARG,VADAVALI SECTION,AMBERNATH EAST - 421501',
      },
      beds: {
        bed_number: 'B101',
      },
      rooms: {
        room_number: '101',
        room_type: 'Private',
      },
      staff: {
        name: 'Dr. Smith',
      },
    },
  },
  billItems: [
    {
      item_name: 'Room Charges',
      quantity: 5,
      unit_price: 2000,
      amount: 10000,
      created_at: new Date().toISOString(),
    },
    {
      item_name: 'Consultation Fee',
      quantity: 1,
      unit_price: 500,
      amount: 500,
      created_at: new Date().toISOString(),
    },
    {
      item_name: 'Lab Tests',
      quantity: 3,
      unit_price: 1500,
      amount: 4500,
      created_at: new Date().toISOString(),
    },
  ],
  patientName: 'John Doe',
  doctorName: 'Dr. Smith',
  admissionSummary: {
    chief_complaint: 'Patient presented with severe abdominal pain and fever',
    diagnosis: 'Acute appendicitis',
    treatment_provided: 'Appendectomy performed under general anesthesia. Post-operative care provided.',
    outcome: 'Patient stable and recovering well',
    recommendations: 'Follow-up appointment in 7 days. Complete prescribed antibiotics course.',
  },
};

async function testPDFGeneration() {
  try {
    console.log('Starting PDF generation test...');
    console.log('Hospital Name:', process.env.HOSPITAL_NAME);
    console.log('Footer Address:', process.env.HOSPITAL_FOOTER_ADDRESS);
    
    const pdfBuffer = await generateInvoicePDF(testData);
    
    // Save PDF to file
    const outputPath = path.join(process.cwd(), 'test-invoice.pdf');
    fs.writeFileSync(outputPath, pdfBuffer);
    
    console.log('PDF generated successfully!');
    console.log('Output file:', outputPath);
    console.log('File size:', (pdfBuffer.length / 1024).toFixed(2), 'KB');
  } catch (error) {
    console.error('PDF generation failed:', error);
    process.exit(1);
  }
}

testPDFGeneration();
