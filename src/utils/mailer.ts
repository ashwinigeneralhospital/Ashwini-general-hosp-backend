import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// Create transporter with enhanced configuration
const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS
  },
  // Add connection timeout and retry options
  connectionTimeout: 60000, // 60 seconds
  greetingTimeout: 30000,   // 30 seconds
  socketTimeout: 60000,     // 60 seconds
  pool: true,               // Use connection pooling
  maxConnections: 5,        // Maximum number of connections
  maxMessages: 100,         // Maximum messages per connection
  rateDelta: 1000,          // Rate limiting
  rateLimit: 5              // Max 5 messages per second
});

// Verify transporter configuration
const verifyTransporter = async () => {
  try {
    await transporter.verify();
    logger.info('SMTP transporter verified successfully');
  } catch (error) {
    logger.error('SMTP transporter verification failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER
    });
  }
};

// Verify on startup
verifyTransporter();

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
  }>;
}

export const sendEmail = async ({ to, subject, html, attachments }: SendEmailOptions): Promise<void> => {
  try {
    // Verify connection before sending
    await transporter.verify();
    
    const mailOptions: any = {
      from: `"${env.HOSPITAL_NAME}" <${env.SMTP_USER}>`,
      to,
      subject,
      html
    };

    // Add attachments if provided
    if (attachments && attachments.length > 0) {
      mailOptions.attachments = attachments.map(attachment => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType
      }));
    }

    logger.info('Sending email', {
      to,
      subject,
      from: env.SMTP_USER,
      hasAttachments: attachments && attachments.length > 0
    });

    const result = await transporter.sendMail(mailOptions);
    
    logger.info('Email sent successfully', {
      messageId: result.messageId,
      to,
      subject,
      hasAttachments: attachments && attachments.length > 0
    });
  } catch (error) {
    logger.error('Failed to send email', {
      to,
      subject,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    throw new Error(`Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

interface StaffWelcomeEmailParams {
  name: string;
  email: string;
  tempPassword: string;
  role: string;
  portalUrl?: string;
}

export const sendStaffWelcomeEmail = async ({
  name,
  email,
  tempPassword,
  role,
  portalUrl = env.PORTAL_URL
}: StaffWelcomeEmailParams): Promise<void> => {
  const html = `
    <table style="width:100%;font-family:Arial,sans-serif;background:#f4f6fb;padding:24px 0;">
      <tr>
        <td>
          <table style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e5e7eb;">
            <tr>
              <td style="text-align:center;padding-bottom:16px;">
                <div style="margin-bottom: 12px;">
                  <img src="http://localhost:3000/logo.jpg" alt="Ashwini General Hospital" style="width: 60px; height: 60px; object-fit: contain;" />
                </div>
                <h2 style="margin:0;font-size:20px;color:#1f2937;">${env.HOSPITAL_NAME}</h2>
                <p style="margin:4px 0 0;font-size:14px;color:#6b7280;">Staff Access Credentials</p>
              </td>
            </tr>
            <tr>
              <td style="font-size:14px;color:#374151;line-height:1.6;">
                <p>Hi ${name},</p>
                <p>Welcome onboard! Your staff portal access has been created with the <strong>${role}</strong> role.</p>
                <div style="margin:16px 0;padding:16px;border-radius:12px;background:#f0f9ff;border:1px solid #bae6fd;">
                  <p style="margin:0 0 8px;font-weight:600;color:#0369a1;">Temporary Login Details</p>
                  <p style="margin:0;font-family:'Courier New',monospace;color:#0f172a;">Email: ${email}<br/>Password: ${tempPassword}</p>
                </div>
                <p style="margin:0 0 12px;">Please log in and create a new password immediately. For security reasons this password expires after first use.</p>
                <p style="margin:0 0 24px;">
                  <a href="${portalUrl}" style="display:inline-block;padding:12px 24px;border-radius:9999px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;">
                    Open Staff Portal
                  </a>
                </p>
                <p style="margin:0;font-size:12px;color:#6b7280;">If you did not expect this email, please contact the IT desk at ${env.HOSPITAL_EMAIL}.</p>
              </td>
            </tr>
          </table>
          <p style="text-align:center;font-size:12px;color:#9ca3af;margin-top:16px;">
            © ${new Date().getFullYear()} ${env.HOSPITAL_NAME}. All rights reserved.
          </p>
        </td>
      </tr>
    </table>
  `;

  await sendEmail({
    to: email,
    subject: 'Your Staff Portal Access',
    html
  });
};
