import crypto from 'crypto';
import speakeasy from 'speakeasy';
import { sendEmail } from '../utils/mailer.js';
import { env } from '../config/env.js';

export type TwoFactorMethod = 'totp' | 'email';
export type EmailOtpPurpose = 'enable' | 'disable' | 'login';

export const EMAIL_OTP_EXPIRY_MINUTES = Number(process.env.TWO_FACTOR_EMAIL_OTP_EXPIRY || 10);

export const SUPPORTED_METHODS: TwoFactorMethod[] = ['totp', 'email'];

export const hashOtp = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

export const generateBackupCodes = () =>
  Array.from({ length: 10 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());

export const generateEmailOtp = () => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  return {
    code,
    hashed: hashOtp(code),
    expiresAt: new Date(Date.now() + EMAIL_OTP_EXPIRY_MINUTES * 60 * 1000).toISOString(),
  };
};

export const sendTwoFactorEmailOtp = async (
  to: string,
  code: string,
  purpose: EmailOtpPurpose,
): Promise<void> => {
  const subjectMap: Record<EmailOtpPurpose, string> = {
    enable: 'Two-Factor Authentication Verification Code',
    disable: 'Two-Factor Authentication Disable Request',
    login: 'Two-Factor Authentication Login Code',
  };

  const descriptionMap: Record<EmailOtpPurpose, string> = {
    enable: 'verification',
    disable: 'disable',
    login: 'login',
  };

  const subject = subjectMap[purpose] ?? subjectMap.enable;
  const action = descriptionMap[purpose] ?? 'verification';

  const html = `
    <p>Dear Staff Member,</p>
    <p>Your ${action} code for two-factor authentication is:</p>
    <p style="font-size: 24px; font-weight: bold; letter-spacing: 8px;">${code}</p>
    <p>This code will expire in ${EMAIL_OTP_EXPIRY_MINUTES} minutes. If you did not request this, please contact the administrator immediately.</p>
    <p>Regards,<br/>${env.HOSPITAL_NAME}</p>
  `;

  await sendEmail({
    to,
    subject,
    html,
  });
};

export const verifyTotpCode = (secret: string, token: string) => {
  if (!secret) return false;

  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 2,
  });
};
