import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middlewares/auth.js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { sendEmail } from '../utils/mailer.js';
import crypto from 'crypto';

const router = Router();
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const EMAIL_OTP_EXPIRY_MINUTES = 10;

type TwoFactorMethod = 'totp' | 'email';
const SUPPORTED_METHODS: TwoFactorMethod[] = ['totp', 'email'];

const hashOtp = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

const generateBackupCodes = () =>
  Array.from({ length: 10 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());

const generateEmailOtp = () => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  return {
    code,
    hashed: hashOtp(code),
    expiresAt: new Date(Date.now() + EMAIL_OTP_EXPIRY_MINUTES * 60 * 1000).toISOString(),
  };
};

const sendTwoFactorEmailOtp = async (
  to: string,
  code: string,
  purpose: 'enable' | 'disable',
): Promise<void> => {
  const subject =
    purpose === 'disable'
      ? 'Two-Factor Authentication Disable Request'
      : 'Two-Factor Authentication Verification Code';

  const html = `
    <p>Dear Staff Member,</p>
    <p>Your ${purpose === 'disable' ? 'disable' : 'verification'} code for two-factor authentication is:</p>
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

// Generate 2FA secret / initiate method setup
router.post('/setup', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  const { method = 'totp' }: { method?: TwoFactorMethod } = req.body ?? {};

  if (!SUPPORTED_METHODS.includes(method)) {
    throw createError('Invalid 2FA method selected', 400);
  }

  // Check if 2FA is already enabled
  const { data: staffMember, error: staffError } = await supabase
    .from('staff')
    .select('id, email, two_factor_enabled, two_factor_method')
    .eq('id', userId)
    .single();

  if (staffError || !staffMember) {
    logger.error('Failed to fetch user for 2FA setup', { userId, error: staffError?.message });
    throw createError('Failed to fetch user', 500);
  }

  if (staffMember.two_factor_enabled) {
    throw createError('2FA is already enabled. Disable it first to set up again.', 400);
  }

  if (method === 'email') {
    const { code, hashed, expiresAt } = generateEmailOtp();

    const { error: updateError } = await supabase
      .from('staff')
      .update({
        two_factor_method: 'email',
        two_factor_email_otp: hashed,
        two_factor_email_otp_expires_at: expiresAt,
        two_factor_secret: null,
        two_factor_backup_codes: null,
      })
      .eq('id', userId);

    if (updateError) {
      logger.error('Failed to store email OTP for 2FA', { userId, error: updateError.message });
      throw createError('Failed to setup 2FA', 500);
    }

    await sendTwoFactorEmailOtp(staffMember.email, code, 'enable');

    logger.info('Email-based 2FA setup initiated', { userId });

    return res.json({
      success: true,
      data: {
        method: 'email',
        expiresAt,
      },
    });
  }

  // TOTP path - Generate secret
  const secret = speakeasy.generateSecret({
    name: `Ashwini Hospital (${staffMember.email})`,
    issuer: 'Ashwini General Hospital',
  });

  // Generate QR code
  const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url!);

  // Store secret temporarily (not enabled yet)
  const { error: updateError } = await supabase
    .from('staff')
    .update({
      two_factor_secret: secret.base32,
      two_factor_method: 'totp',
      two_factor_email_otp: null,
      two_factor_email_otp_expires_at: null,
    })
    .eq('id', userId);

  if (updateError) {
    logger.error('Failed to store 2FA secret', { userId, error: updateError.message });
    throw createError('Failed to setup 2FA', 500);
  }

  logger.info('2FA setup initiated', { userId });

  return res.json({
    success: true,
    data: {
      secret: secret.base32,
      qrCode: qrCodeUrl,
      method: 'totp',
    },
  });
}));

// Verify OTP and enable 2FA
router.post('/enable', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  const { otp } = req.body;

  if (!otp) {
    throw createError('OTP is required', 400);
  }

  // Fetch user's 2FA context
  const { data: staffMember, error: staffError } = await supabase
    .from('staff')
    .select(
      'email, two_factor_secret, two_factor_enabled, two_factor_method, two_factor_email_otp, two_factor_email_otp_expires_at',
    )
    .eq('id', userId)
    .single();

  if (staffError || !staffMember) {
    logger.error('Failed to fetch user for 2FA enable', { userId, error: staffError?.message });
    throw createError('User not found', 404);
  }

  if (staffMember.two_factor_enabled) {
    throw createError('2FA is already enabled', 400);
  }

  const method: TwoFactorMethod = (staffMember.two_factor_method as TwoFactorMethod) || 'totp';

  if (method === 'email') {
    if (!staffMember.two_factor_email_otp || !staffMember.two_factor_email_otp_expires_at) {
      throw createError('Request an email verification code before enabling 2FA', 400);
    }

    const hashedInput = hashOtp(otp);
    const expiresAt = new Date(staffMember.two_factor_email_otp_expires_at).getTime();
    if (Date.now() > expiresAt) {
      throw createError('OTP has expired. Request a new code.', 400);
    }

    if (hashedInput !== staffMember.two_factor_email_otp) {
      logger.warn('Invalid email OTP during 2FA enable', { userId });
      throw createError('Invalid OTP', 400);
    }

    const { error: updateError } = await supabase
      .from('staff')
      .update({
        two_factor_enabled: true,
        two_factor_verified_at: new Date().toISOString(),
        two_factor_method: 'email',
        two_factor_secret: null,
        two_factor_backup_codes: null,
        two_factor_email_otp: null,
        two_factor_email_otp_expires_at: null,
      })
      .eq('id', userId);

    if (updateError) {
      logger.error('Failed to enable email-based 2FA', { userId, error: updateError.message });
      throw createError('Failed to enable 2FA', 500);
    }

    logger.info('Email-based 2FA enabled successfully', { userId });

    return res.json({
      success: true,
      message: 'Email-based 2FA enabled successfully',
    });
  }

  if (!staffMember.two_factor_secret) {
    throw createError('2FA setup not initiated. Call /setup first.', 400);
  }

  // Verify TOTP
  const verified = speakeasy.totp.verify({
    secret: staffMember.two_factor_secret,
    encoding: 'base32',
    token: otp,
    window: 2,
  });

  if (!verified) {
    logger.warn('Invalid OTP during TOTP 2FA enable', { userId });
    throw createError('Invalid OTP', 400);
  }

  // Generate backup codes
  const backupCodes = generateBackupCodes();

  // Enable 2FA
  const { error: updateError } = await supabase
    .from('staff')
    .update({
      two_factor_enabled: true,
      two_factor_verified_at: new Date().toISOString(),
      two_factor_backup_codes: backupCodes,
      two_factor_method: 'totp',
      two_factor_email_otp: null,
      two_factor_email_otp_expires_at: null,
    })
    .eq('id', userId);

  if (updateError) {
    logger.error('Failed to enable TOTP 2FA', { userId, error: updateError.message });
    throw createError('Failed to enable 2FA', 500);
  }

  logger.info('TOTP 2FA enabled successfully', { userId });

  return res.json({
    success: true,
    message: '2FA enabled successfully',
    data: {
      backupCodes,
    },
  });
}));

// Send / resend email OTP
router.post('/email/send-code', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  const { purpose = 'enable' }: { purpose?: 'enable' | 'disable' } = req.body ?? {};

  if (!['enable', 'disable'].includes(purpose)) {
    throw createError('Invalid purpose for email OTP', 400);
  }

  const { data: staffMember, error: staffError } = await supabase
    .from('staff')
    .select('email, two_factor_enabled, two_factor_method')
    .eq('id', userId)
    .single();

  if (staffError || !staffMember) {
    throw createError('User not found', 404);
  }

  if (purpose === 'enable' && staffMember.two_factor_enabled) {
    throw createError('2FA is already enabled', 400);
  }

  if (purpose === 'disable' && !staffMember.two_factor_enabled) {
    throw createError('2FA is not enabled', 400);
  }

  const { code, hashed, expiresAt } = generateEmailOtp();

  const { error: updateError } = await supabase
    .from('staff')
    .update({
      two_factor_method: 'email',
      two_factor_email_otp: hashed,
      two_factor_email_otp_expires_at: expiresAt,
    })
    .eq('id', userId);

  if (updateError) {
    logger.error('Failed to store email OTP code', { userId, error: updateError.message });
    throw createError('Failed to send OTP', 500);
  }

  await sendTwoFactorEmailOtp(staffMember.email, code, purpose);

  logger.info('Email OTP sent', { userId, purpose });

  return res.json({
    success: true,
    message: 'Verification code sent to your email',
    data: { expiresAt },
  });
}));

// Disable 2FA (requires OTP verification)
router.post('/disable', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  const { otp } = req.body;

  if (!otp) {
    throw createError('OTP is required to disable 2FA', 400);
  }

  // Fetch user's 2FA settings
  const { data: staffMember, error: staffError } = await supabase
    .from('staff')
    .select(
      'email, two_factor_secret, two_factor_enabled, two_factor_backup_codes, two_factor_method, two_factor_email_otp, two_factor_email_otp_expires_at',
    )
    .eq('id', userId)
    .single();

  if (staffError || !staffMember) {
    logger.error('Failed to fetch user for 2FA disable', { userId, error: staffError?.message });
    throw createError('User not found', 404);
  }

  if (!staffMember.two_factor_enabled) {
    throw createError('2FA is not enabled', 400);
  }

  const method: TwoFactorMethod = (staffMember.two_factor_method as TwoFactorMethod) || 'totp';

  let verified = false;

  if (method === 'email') {
    if (!staffMember.two_factor_email_otp || !staffMember.two_factor_email_otp_expires_at) {
      throw createError('Request a disable verification code from email first', 400);
    }

    if (Date.now() > new Date(staffMember.two_factor_email_otp_expires_at).getTime()) {
      throw createError('OTP has expired. Request a new code.', 400);
    }

    if (hashOtp(otp) !== staffMember.two_factor_email_otp) {
      throw createError('Invalid OTP', 400);
    }

    verified = true;
  } else {
    // TOTP or backup codes
    if (staffMember.two_factor_secret) {
      verified = speakeasy.totp.verify({
        secret: staffMember.two_factor_secret,
        encoding: 'base32',
        token: otp,
        window: 2,
      });
    }

    if (!verified && staffMember.two_factor_backup_codes) {
      const normalized = otp.toUpperCase();
      verified = staffMember.two_factor_backup_codes.includes(normalized);

      if (verified) {
        const remainingCodes = staffMember.two_factor_backup_codes.filter((code: string) => code !== normalized);
        await supabase
          .from('staff')
          .update({ two_factor_backup_codes: remainingCodes })
          .eq('id', userId);
      }
    }
  }

  if (!verified) {
    logger.warn('Invalid OTP during 2FA disable', { userId, method });
    throw createError('Invalid OTP or backup code', 400);
  }

  const { error: updateError } = await supabase
    .from('staff')
    .update({
      two_factor_enabled: false,
      two_factor_secret: null,
      two_factor_backup_codes: null,
      two_factor_verified_at: null,
      two_factor_email_otp: null,
      two_factor_email_otp_expires_at: null,
    })
    .eq('id', userId);

  if (updateError) {
    logger.error('Failed to disable 2FA', { userId, error: updateError.message });
    throw createError('Failed to disable 2FA', 500);
  }

  logger.info('2FA disabled successfully', { userId });

  return res.json({
    success: true,
    message: '2FA disabled successfully',
  });
}));

// Admin: Toggle 2FA for any user (no OTP required)
router.post('/admin/toggle/:targetUserId', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { targetUserId } = req.params;
  const { enable, method = 'totp' }: { enable: boolean; method?: TwoFactorMethod } = req.body;

  if (typeof enable !== 'boolean') {
    throw createError('enable field must be a boolean', 400);
  }

  if (method && !SUPPORTED_METHODS.includes(method)) {
    throw createError('Invalid 2FA method', 400);
  }

  // Fetch target user
  const { data: targetUser, error: userError } = await supabase
    .from('staff')
    .select('id, email, two_factor_enabled')
    .eq('id', targetUserId)
    .single();

  if (userError || !targetUser) {
    logger.error('Failed to fetch target user for admin 2FA toggle', { targetUserId, error: userError?.message });
    throw createError('User not found', 404);
  }

  if (enable) {
    if (method === 'email') {
      const { error: updateError } = await supabase
        .from('staff')
        .update({
          two_factor_enabled: true,
          two_factor_method: 'email',
          two_factor_secret: null,
          two_factor_backup_codes: null,
          two_factor_verified_at: new Date().toISOString(),
          two_factor_email_otp: null,
          two_factor_email_otp_expires_at: null,
        })
        .eq('id', targetUserId);

      if (updateError) {
        logger.error('Admin failed to enable email 2FA', { targetUserId, adminId: req.user!.id, error: updateError.message });
        throw createError('Failed to enable 2FA', 500);
      }

      logger.info('Admin enabled email 2FA for user', { targetUserId, adminId: req.user!.id });

      return res.json({
        success: true,
        message: 'Email-based 2FA enabled for user',
      });
    }

    // Enable 2FA for user (admin override)
    const secret = speakeasy.generateSecret({
      name: `Ashwini Hospital (${targetUser.email})`,
      issuer: 'Ashwini General Hospital',
    });

    const backupCodes = Array.from({ length: 10 }, () =>
      crypto.randomBytes(4).toString('hex').toUpperCase()
    );

    const { error: updateError } = await supabase
      .from('staff')
      .update({
        two_factor_enabled: true,
        two_factor_secret: secret.base32,
        two_factor_verified_at: new Date().toISOString(),
        two_factor_backup_codes: backupCodes,
        two_factor_method: 'totp',
        two_factor_email_otp: null,
        two_factor_email_otp_expires_at: null,
      })
      .eq('id', targetUserId);

    if (updateError) {
      logger.error('Admin failed to enable 2FA', { targetUserId, adminId: req.user!.id, error: updateError.message });
      throw createError('Failed to enable 2FA', 500);
    }

    logger.info('Admin enabled 2FA for user', { targetUserId, adminId: req.user!.id });

    return res.json({
      success: true,
      message: '2FA enabled for user',
      data: {
        secret: secret.base32,
        backupCodes,
      },
    });
  } else {
    // Disable 2FA for user (admin override)
    const { error: updateError } = await supabase
      .from('staff')
      .update({
        two_factor_enabled: false,
        two_factor_secret: null,
        two_factor_backup_codes: null,
        two_factor_verified_at: null,
        two_factor_email_otp: null,
        two_factor_email_otp_expires_at: null,
      })
      .eq('id', targetUserId);

    if (updateError) {
      logger.error('Admin failed to disable 2FA', { targetUserId, adminId: req.user!.id, error: updateError.message });
      throw createError('Failed to disable 2FA', 500);
    }

    logger.info('Admin disabled 2FA for user', { targetUserId, adminId: req.user!.id });

    return res.json({
      success: true,
      message: '2FA disabled for user',
    });
  }
}));

// Get 2FA status
router.get('/status', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;

  const { data: staffMember, error: staffError } = await supabase
    .from('staff')
    .select('two_factor_enabled, two_factor_verified_at, two_factor_method')
    .eq('id', userId)
    .single();

  if (staffError || !staffMember) {
    logger.error('Failed to fetch 2FA status', { userId, error: staffError?.message });
    throw createError('User not found', 404);
  }

  return res.json({
    success: true,
    data: {
      enabled: staffMember.two_factor_enabled || false,
      verifiedAt: staffMember.two_factor_verified_at,
      method: (staffMember.two_factor_method as TwoFactorMethod) || 'totp',
    },
  });
}));

export default router;
