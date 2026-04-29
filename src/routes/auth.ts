import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import {
  generateEmailOtp,
  hashOtp,
  sendTwoFactorEmailOtp,
  SUPPORTED_METHODS,
  TwoFactorMethod,
  verifyTotpCode,
} from '../services/two-factor-service.js';

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const respondTwoFactorRequired = (
  res: Response,
  method: TwoFactorMethod,
  message?: string,
  expiresAt?: string,
) => {
  return res.status(202).json({
    success: true,
    data: {
      requiresTwoFactor: true,
      method,
      message,
      expiresAt,
    },
  });
};

// Login endpoint with direct database authentication
router.post('/login', asyncHandler(async (req: any, res: Response) => {
  const { email, password } = req.body;
  const otp = typeof req.body?.otp === 'string' ? req.body.otp.trim() : undefined;

  if (!email || !password) {
    throw createError('Email and password are required', 400);
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Find staff by email (normalized fallback to original column for backwards compatibility)
  const staffColumns = `
    id,
    first_name,
    last_name,
    email,
    role,
    is_active,
    employment_status,
    department,
    phone,
    password_hash,
    requires_password_reset,
    two_factor_enabled,
    two_factor_method,
    two_factor_secret,
    two_factor_login_otp,
    two_factor_login_otp_expires_at
  `;

  let staffData = null;
  let staffError = null;

  const normalizedResult = await supabase
    .from('staff')
    .select(staffColumns)
    .eq('email_normalized', normalizedEmail)
    .maybeSingle();

  if (normalizedResult.error && normalizedResult.error.code !== '42703') {
    staffError = normalizedResult.error;
  } else if (normalizedResult.data) {
    staffData = normalizedResult.data;
  }

  if (!staffData) {
    const fallbackResult = await supabase
      .from('staff')
      .select(staffColumns)
      .ilike('email', normalizedEmail)
      .maybeSingle();

    staffData = fallbackResult.data;
    staffError = fallbackResult.error;
  }

  if (staffError || !staffData) {
    logger.warn('Login attempt with invalid email', { email });
    throw createError('Invalid credentials', 401);
  }

  if (!staffData.is_active || staffData.employment_status !== 'active') {
    logger.warn('Login attempt with inactive account', { email, staffId: staffData.id });
    throw createError('Account is inactive', 403);
  }

  if (!staffData.password_hash) {
    logger.error('Staff account missing password hash', { email, staffId: staffData.id });
    throw createError('Account not properly configured. Contact administrator.', 500);
  }

  // Verify password
  const isPasswordValid = await bcrypt.compare(password, staffData.password_hash);
  
  if (!isPasswordValid) {
    logger.warn('Login attempt with invalid password', { email, staffId: staffData.id });
    throw createError('Invalid credentials', 401);
  }

  const fullName = [staffData.first_name, staffData.last_name]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ') || staffData.email;

  if (staffData.two_factor_enabled) {
    let method: TwoFactorMethod = (staffData.two_factor_method as TwoFactorMethod) || 'totp';
    if (!SUPPORTED_METHODS.includes(method)) {
      logger.warn('Unsupported 2FA method on staff record, defaulting to TOTP', {
        staffId: staffData.id,
        method: staffData.two_factor_method,
      });
      method = 'totp';
    }

    if (method === 'email') {
      if (!otp) {
        const { code, hashed, expiresAt } = generateEmailOtp();

        await supabase
          .from('staff')
          .update({
            two_factor_login_otp: hashed,
            two_factor_login_otp_expires_at: expiresAt,
          })
          .eq('id', staffData.id);

        await sendTwoFactorEmailOtp(staffData.email, code, 'login');

        return respondTwoFactorRequired(
          res,
          method,
          'Verification code sent to your registered email address',
          expiresAt,
        );
      }

      if (!staffData.two_factor_login_otp || !staffData.two_factor_login_otp_expires_at) {
        throw createError('Request a new verification code to continue login', 400);
      }

      const expiresAt = new Date(staffData.two_factor_login_otp_expires_at).getTime();
      if (Date.now() > expiresAt) {
        await supabase
          .from('staff')
          .update({
            two_factor_login_otp: null,
            two_factor_login_otp_expires_at: null,
          })
          .eq('id', staffData.id);
        throw createError('Verification code expired. Request a new code.', 400);
      }

      if (hashOtp(otp) !== staffData.two_factor_login_otp) {
        throw createError('Invalid verification code', 400);
      }

      await supabase
        .from('staff')
        .update({
          two_factor_login_otp: null,
          two_factor_login_otp_expires_at: null,
        })
        .eq('id', staffData.id);
    } else {
      if (!otp) {
        return respondTwoFactorRequired(
          res,
          method,
          'Enter the 6-digit code from your authenticator app to continue',
        );
      }

      if (!staffData.two_factor_secret) {
        logger.error('Two-factor secret missing for staff', { staffId: staffData.id });
        throw createError('Two-factor authentication is not configured correctly. Contact administrator.', 500);
      }

      const verified = verifyTotpCode(staffData.two_factor_secret, otp);
      if (!verified) {
        throw createError('Invalid verification code', 400);
      }
    }
  }

  // Generate JWT access token (24h)
  const tokenPayload = {
    id: staffData.id,
    email: staffData.email,
    role: staffData.role,
    name: fullName
  };

  const token = jwt.sign(tokenPayload, env.JWT_SECRET, { 
    expiresIn: '24h',
    issuer: 'ashwini-hospital-backend'
  });

  // Generate refresh token (7 days)
  const refreshTokenPayload = {
    id: staffData.id,
    type: 'refresh'
  };
  const refreshToken = jwt.sign(refreshTokenPayload, env.JWT_SECRET, { 
    expiresIn: '7d',
    issuer: 'ashwini-hospital-backend'
  });

  // Store refresh token in database
  const refreshTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await supabase
    .from('staff')
    .update({
      refresh_token: refreshToken,
      refresh_token_expires_at: refreshTokenExpiresAt.toISOString()
    })
    .eq('id', staffData.id);

  // Log successful login
  logger.info('User logged in successfully', {
    email: staffData.email,
    role: staffData.role,
    staffId: staffData.id
  });

  return res.json({
    success: true,
    data: {
      user: {
        id: staffData.id,
        email: staffData.email,
        role: staffData.role,
        name: fullName,
        department: staffData.department,
        staff_id: staffData.id,
        requires_password_reset: staffData.requires_password_reset
      },
      token: token,
      refreshToken: refreshToken
    }
  });
}));

// Get current user profile
router.get('/profile', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  return res.json({
    success: true,
    data: {
      user: {
        id: req.user!.id,
        email: req.user!.email,
        role: req.user!.role,
        staff_id: req.user!.staff_id,
        requires_password_reset: req.user!.requires_password_reset
      }
    }
  });
}));

// Reset password for authenticated staff (first login)
router.post('/reset-password', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { new_password } = req.body as { new_password?: string };

  if (!new_password || typeof new_password !== 'string' || new_password.trim().length < 8) {
    throw createError('New password must be at least 8 characters long', 400);
  }

  const trimmedPassword = new_password.trim();
  const staffId = req.user!.staff_id ?? req.user!.id;

  const { data: staffRecord, error: staffError } = await supabase
    .from('staff')
    .select('id, user_id, email')
    .eq('id', staffId)
    .single();

  if (staffError || !staffRecord) {
    throw createError('Staff account not found', 404);
  }

  if (!staffRecord.user_id) {
    throw createError('Portal user not provisioned for this staff account', 400);
  }

  const userId = staffRecord.user_id;

  const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
    password: trimmedPassword
  });

  if (updateError) {
    throw createError(updateError.message || 'Failed to update password', 500);
  }

  const newPasswordHash = await bcrypt.hash(trimmedPassword, 10);

  const { error: staffUpdateError } = await supabase
    .from('staff')
    .update({
      requires_password_reset: false,
      password_hash: newPasswordHash,
      updated_at: new Date().toISOString()
    })
    .eq('id', staffId);

  if (staffUpdateError) {
    throw createError(staffUpdateError.message || 'Failed to update staff record', 500);
  }

  logger.info('User completed password reset', {
    userId,
    email: req.user!.email
  });

  return res.json({
    success: true,
    message: 'Password updated successfully'
  });
}));

// Refresh token endpoint
router.post('/refresh', asyncHandler(async (req: any, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    throw createError('Refresh token is required', 400);
  }

  try {
    // Verify refresh token
    const decoded = jwt.verify(refreshToken, env.JWT_SECRET, {
      issuer: 'ashwini-hospital-backend'
    }) as { id: string; type: string };

    if (decoded.type !== 'refresh') {
      throw createError('Invalid refresh token', 401);
    }

    // Get staff record with refresh token
    const { data: staffData, error: staffError } = await supabase
      .from('staff')
      .select('id, email, role, first_name, last_name, department, refresh_token, refresh_token_expires_at, is_active')
      .eq('id', decoded.id)
      .single();

    if (staffError || !staffData) {
      throw createError('Invalid refresh token', 401);
    }

    // Check if account is active
    if (!staffData.is_active) {
      throw createError('Account is inactive', 403);
    }

    // Check if refresh token matches and is not expired
    if (staffData.refresh_token !== refreshToken) {
      throw createError('Invalid refresh token', 401);
    }

    if (staffData.refresh_token_expires_at && new Date(staffData.refresh_token_expires_at) < new Date()) {
      // Clear expired refresh token
      await supabase
        .from('staff')
        .update({ refresh_token: null, refresh_token_expires_at: null })
        .eq('id', staffData.id);
      throw createError('Refresh token has expired', 401);
    }

    const fullName = [staffData.first_name, staffData.last_name]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join(' ') || staffData.email;

    // Generate new access token
    const tokenPayload = {
      id: staffData.id,
      email: staffData.email,
      role: staffData.role,
      name: fullName
    };

    const newToken = jwt.sign(tokenPayload, env.JWT_SECRET, {
      expiresIn: '24h',
      issuer: 'ashwini-hospital-backend'
    });

    // Generate new refresh token
    const newRefreshTokenPayload = {
      id: staffData.id,
      type: 'refresh'
    };
    const newRefreshToken = jwt.sign(newRefreshTokenPayload, env.JWT_SECRET, {
      expiresIn: '7d',
      issuer: 'ashwini-hospital-backend'
    });

    // Update refresh token in database
    const newRefreshTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await supabase
      .from('staff')
      .update({
        refresh_token: newRefreshToken,
        refresh_token_expires_at: newRefreshTokenExpiresAt.toISOString()
      })
      .eq('id', staffData.id);

    logger.info('Token refreshed successfully', {
      staffId: staffData.id,
      email: staffData.email
    });

    return res.json({
      success: true,
      data: {
        user: {
          id: staffData.id,
          email: staffData.email,
          role: staffData.role,
          name: fullName,
          department: staffData.department,
          staff_id: staffData.id
        },
        token: newToken,
        refreshToken: newRefreshToken
      }
    });
  } catch (error: any) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      throw createError('Invalid or expired refresh token', 401);
    }
    throw error;
  }
}));

// Logout endpoint
router.post('/logout', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  // Clear refresh token from database
  const staffId = req.user!.staff_id ?? req.user!.id;
  await supabase
    .from('staff')
    .update({
      refresh_token: null,
      refresh_token_expires_at: null
    })
    .eq('id', staffId);

  if (token) {
    await supabase.auth.admin.signOut(token);
  }

  logger.info('User logged out', {
    userId: req.user!.id,
    email: req.user!.email
  });

  return res.json({
    success: true,
    message: 'Logged out successfully'
  });
}));

// Verify token endpoint
router.get('/verify', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  return res.json({
    success: true,
    data: {
      user: req.user,
      valid: true
    }
  });
}));

export default router;
