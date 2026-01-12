import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { S3Client, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import bcrypt from 'bcryptjs';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireAdmin, requirePortalStaff } from '../middlewares/auth.js';
import { sendStaffWelcomeEmail } from '../utils/mailer.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY
  }
});

const deletePhotoFromStorage = async (key?: string | null): Promise<void> => {
  if (!key) return;
  try {
    await r2.send(new DeleteObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key
    }));
  } catch (error) {
    logger.warn('Failed to delete staff photo from storage', { key, error });
  }
};

type StaffPhotoFields = { profile_photo_key?: string | null; profile_photo_url?: string | null };
type StaffNameFields = { first_name?: string | null; last_name?: string | null };

const attachProfilePhotoUrl = async <T extends StaffPhotoFields>(staff: T): Promise<T> => {
  if (!staff.profile_photo_key) {
    return { ...staff, profile_photo_url: null };
  }

  try {
    const signedUrl = await getSignedUrl(
      r2,
      new GetObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: staff.profile_photo_key,
      }),
      { expiresIn: 900 }
    );
    return { ...staff, profile_photo_url: signedUrl };
  } catch (error) {
    logger.warn('Failed to generate staff photo signed URL', { key: staff.profile_photo_key, error });
    return { ...staff, profile_photo_url: null };
  }
};

const buildFullName = (first?: string | null, last?: string | null): string => {
  return [first, last]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ');
};

const formatStaffRecord = async <T extends StaffPhotoFields & StaffNameFields>(staff: T) => {
  const staffWithUrl = await attachProfilePhotoUrl(staff);
  return {
    ...staffWithUrl,
    name: buildFullName(staffWithUrl.first_name, staffWithUrl.last_name)
  };
};

const findAuthUserByEmail = async (email?: string | null) => {
  if (!email) {
    return null;
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const { data, error } = await supabase.auth.admin.listUsers();

    if (error) {
      logger.error('Failed to list auth users', { error });
      throw createError('Unable to verify existing portal accounts', 500);
    }

    const existingUser = data.users.find(
      (user) => user.email?.toLowerCase().trim() === normalizedEmail
    );

    return existingUser ? { id: existingUser.id, email: existingUser.email } : null;
  } catch (error) {
    logger.error('Failed to lookup auth user by email', { email: normalizedEmail, error });
    throw createError('Unable to verify existing portal accounts', 500);
  }
};

const PORTAL_ROLES = ['admin', 'doctor', 'nurse', 'billing', 'reception'];
const STAFF_SELECT = `
  id,
  user_id,
  first_name,
  last_name,
  email,
  role,
  employment_role,
  employment_status,
  department,
  phone,
  start_date,
  end_date,
  notes,
  profile_photo_key,
  profile_photo_url,
  requires_password_reset,
  password_hash,
  is_active,
  created_at,
  updated_at
`;

const generateTemporaryPassword = (): string => {
  const base = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  // ensure mix of upper/lower/number/symbol
  return `Ag${base.substring(0, 8)}!1`;
};

// Get staff directory (supports filters)
router.get('/', authenticateToken, requirePortalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const status = (req.query.status as string) ?? 'active';
  const roleFilter = req.query.role as string | undefined;
  const portalOnly = req.query.portalOnly === 'true';

  let query = supabase
    .from('staff')
    .select(STAFF_SELECT)
    .order('created_at', { ascending: false });

  if (roleFilter) {
    query = query.eq('role', roleFilter);
  }

  if (status !== 'all') {
    query = query.eq('employment_status', status);
  }

  if (portalOnly) {
    query = query.in('role', PORTAL_ROLES);
    if (status === 'active') {
      query = query.eq('is_active', true);
    }
  }

  const { data, error } = await query;

  if (error) {
    throw createError('Failed to fetch staff', 500);
  }

  const staffWithSignedUrls = await Promise.all((data ?? []).map((member) => formatStaffRecord(member)));

  res.json({
    success: true,
    data: { staff: staffWithSignedUrls }
  });
}));

// Create staff record (with optional portal login)
router.post('/', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    first_name,
    last_name,
    name,
    email,
    role,
    department,
    phone,
    employment_role,
    employment_status = 'active',
    start_date,
    end_date,
    notes,
    profile_photo_key,
    profile_photo_url
  } = req.body;

  const resolvedFirstName = (first_name ?? (typeof name === 'string' ? name.split(' ')[0] : '')).trim();
  const resolvedLastName = (last_name ?? (typeof name === 'string' ? name.split(' ').slice(1).join(' ') : '')).trim();

  if (!resolvedFirstName || !resolvedLastName) {
    throw createError('First name and last name are required', 400);
  }

  if (!role) {
    throw createError('Role is required', 400);
  }

  if (!['active', 'terminated', 'ex_employee'].includes(employment_status)) {
    throw createError('Invalid employment status', 400);
  }

  if (role !== 'record_only' && !PORTAL_ROLES.includes(role)) {
    throw createError('Invalid role specified', 400);
  }

  const shouldCreatePortalAccount = PORTAL_ROLES.includes(role);

  if (shouldCreatePortalAccount && !email) {
    throw createError('Email is required for portal-access roles', 400);
  }

  let userId: string | null = null;
  let temporaryPassword: string | null = null;
  let passwordHash: string | null = null;
  let linkedExistingPortalUser = false;

  if (shouldCreatePortalAccount) {
    temporaryPassword = generateTemporaryPassword();
    passwordHash = await bcrypt.hash(temporaryPassword, 10);

    const existingAuthUser = await findAuthUserByEmail(email);
    if (existingAuthUser) {
      userId = existingAuthUser.id;
      linkedExistingPortalUser = true;
      await supabase.auth.admin.updateUserById(existingAuthUser.id, {
        password: temporaryPassword,
      });
    } else {
      const { data: authUser, error: createUserError } = await supabase.auth.admin.createUser({
        email,
        password: temporaryPassword,
        email_confirm: true
      });

      if (createUserError || !authUser?.user) {
        throw createError(createUserError?.message || 'Failed to create portal user', 500);
      }

      userId = authUser.user.id;
    }
  }

  const isActive = employment_status === 'active';
  const normalizedPhone = typeof phone === 'string' ? phone.trim() : null;

  const { data, error } = await supabase
    .from('staff')
    .insert({
      user_id: userId,
      first_name: resolvedFirstName,
      last_name: resolvedLastName,
      email,
      role,
      department,
      phone: normalizedPhone,
      employment_role,
      employment_status,
      start_date: start_date || null,
      end_date: end_date || null,
      notes,
      profile_photo_key: profile_photo_key || null,
      profile_photo_url: profile_photo_url || null,
      is_active: isActive,
      requires_password_reset: shouldCreatePortalAccount,
      password_hash: passwordHash
    })
    .select(STAFF_SELECT)
    .single();

  if (error) {
    throw createError(error.message || 'Failed to create staff record', 500);
  }

  if (shouldCreatePortalAccount && temporaryPassword) {
    try {
      await sendStaffWelcomeEmail({
        name: buildFullName(resolvedFirstName, resolvedLastName),
        email,
        tempPassword: temporaryPassword,
        role,
        portalUrl: process.env.PORTAL_URL
      });
    } catch {
      // rollback user + staff record to avoid inconsistent state
      if (userId) {
        try {
          await supabase.auth.admin.deleteUser(userId);
        } catch {
          // ignore rollback failures
        }
      }
      try {
        await supabase.from('staff').delete().eq('id', data.id);
      } catch {
        // ignore rollback failures
      }
      throw createError('Failed to send welcome email. Staff creation aborted.', 500);
    }
  }

  const staffWithSignedUrl = await formatStaffRecord(data);

  res.status(201).json({
    success: true,
    data: { staff: staffWithSignedUrl }
  });
}));

// Get single staff member
router.get('/:id', authenticateToken, requirePortalStaff, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('staff')
    .select(STAFF_SELECT)
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    throw createError('Staff member not found', 404);
  }

  const staffWithSignedUrl = await formatStaffRecord(data);

  res.json({
    success: true,
    data: { staff: staffWithSignedUrl }
  });
}));

// Delete staff member and linked portal account
router.delete('/:id', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const staffId = req.params.id;

  const { data: existingStaff, error: fetchError } = await supabase
    .from('staff')
    .select(STAFF_SELECT)
    .eq('id', staffId)
    .single();

  if (fetchError || !existingStaff) {
    throw createError('Staff member not found', 404);
  }

  if (existingStaff.profile_photo_key) {
    await deletePhotoFromStorage(existingStaff.profile_photo_key);
  }

  if (existingStaff.user_id) {
    try {
      await supabase.auth.admin.deleteUser(existingStaff.user_id);
    } catch (error) {
      logger.error('Failed to delete linked auth user', { staffId, userId: existingStaff.user_id, error });
    }
  }

  const { error: deleteError } = await supabase
    .from('staff')
    .delete()
    .eq('id', staffId);

  if (deleteError) {
    throw createError(deleteError.message || 'Failed to delete staff member', 500);
  }

  res.json({
    success: true,
    message: 'Staff member deleted successfully'
  });
}));

// Resend temporary password & force reset
router.post('/:id/reset-password', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const staffId = req.params.id;

  const { data: existingStaff, error: fetchError } = await supabase
    .from('staff')
    .select(STAFF_SELECT)
    .eq('id', staffId)
    .single();

  if (fetchError || !existingStaff) {
    throw createError('Staff member not found', 404);
  }

  if (!existingStaff.email) {
    throw createError('Staff member does not have an email configured', 400);
  }

  if (!PORTAL_ROLES.includes(existingStaff.role)) {
    throw createError('Staff member does not have portal access', 400);
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(temporaryPassword, 10);

  let userId = existingStaff.user_id;

  if (userId) {
    const { error: updateUserError } = await supabase.auth.admin.updateUserById(userId, { password: temporaryPassword });
    if (updateUserError) {
      throw createError(updateUserError.message || 'Failed to update portal password', 500);
    }
  } else {
    const existingAuthUser = await findAuthUserByEmail(existingStaff.email);
    if (existingAuthUser) {
      userId = existingAuthUser.id;
      const { error: updateExistingUserError } = await supabase.auth.admin.updateUserById(userId, { password: temporaryPassword });
      if (updateExistingUserError) {
        throw createError(updateExistingUserError.message || 'Failed to update portal password', 500);
      }
    } else {
      const { data: authUser, error: createUserError } = await supabase.auth.admin.createUser({
        email: existingStaff.email,
        password: temporaryPassword,
        email_confirm: true
      });
      if (createUserError || !authUser?.user) {
        throw createError(createUserError?.message || 'Failed to create portal user', 500);
      }
      userId = authUser.user.id;
    }
  }

  const { error: staffUpdateError } = await supabase
    .from('staff')
    .update({
      user_id: userId,
      password_hash: passwordHash,
      requires_password_reset: true,
      updated_at: new Date().toISOString()
    })
    .eq('id', staffId);

  if (staffUpdateError) {
    throw createError(staffUpdateError.message || 'Failed to update staff password metadata', 500);
  }

  await sendStaffWelcomeEmail({
    name: buildFullName(existingStaff.first_name, existingStaff.last_name),
    email: existingStaff.email,
    tempPassword: temporaryPassword,
    role: existingStaff.role,
    portalUrl: process.env.PORTAL_URL
  });

  res.json({
    success: true,
    message: 'Temporary password sent successfully'
  });
}));

// Update staff profile
router.put('/:id', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    first_name,
    last_name,
    name,
    email,
    role,
    department,
    phone,
    employment_role,
    employment_status,
    start_date,
    end_date,
    notes,
    profile_photo_key,
    profile_photo_url
  } = req.body;

  const { data: existingStaff, error: fetchError } = await supabase
    .from('staff')
    .select(STAFF_SELECT)
    .eq('id', req.params.id)
    .single();

  if (fetchError || !existingStaff) {
    throw createError('Staff member not found', 404);
  }

  if (role && role !== 'record_only' && !PORTAL_ROLES.includes(role)) {
    throw createError('Invalid role specified', 400);
  }

  if (role && PORTAL_ROLES.includes(role) && !email) {
    throw createError('Email is required for portal-access roles', 400);
  }

  let userId = existingStaff.user_id;
  let passwordHash = existingStaff.password_hash;

  const desiredRole = role ?? existingStaff.role;
  const requiresPortalAccount = PORTAL_ROLES.includes(desiredRole);

  let temporaryPassword: string | null = null;
  let portalAccountCreated = false;

  if (requiresPortalAccount && !userId) {
    const existingAuthUser = await findAuthUserByEmail(email ?? existingStaff.email);
    temporaryPassword = generateTemporaryPassword();
    passwordHash = await bcrypt.hash(temporaryPassword, 10);
    if (existingAuthUser) {
      userId = existingAuthUser.id;
      await supabase.auth.admin.updateUserById(existingAuthUser.id, { password: temporaryPassword });
    } else {
      const { data: authUser, error: createUserError } = await supabase.auth.admin.createUser({
        email,
        password: temporaryPassword,
        email_confirm: true
      });
      if (createUserError || !authUser?.user) {
        throw createError(createUserError?.message || 'Failed to provision portal account', 500);
      }
      userId = authUser.user.id;
      portalAccountCreated = true;
    }
    await sendStaffWelcomeEmail({
      name: buildFullName(first_name ?? existingStaff.first_name, last_name ?? existingStaff.last_name),
      email,
      tempPassword: temporaryPassword,
      role: desiredRole,
      portalUrl: process.env.PORTAL_URL
    });
  } else if (email && userId && email !== existingStaff.email) {
    const { error: updateUserError } = await supabase.auth.admin.updateUserById(userId, { email });
    if (updateUserError) {
      throw createError(updateUserError.message, 500);
    }
  }

  const normalizedPhone = typeof phone === 'string' ? phone.trim() : existingStaff.phone;
  const resolvedFirstName = (first_name ?? (typeof name === 'string' ? name.split(' ')[0] : existingStaff.first_name)).trim();
  const resolvedLastName = (last_name ?? (typeof name === 'string' ? name.split(' ').slice(1).join(' ') : existingStaff.last_name)).trim();

  if (!resolvedFirstName || !resolvedLastName) {
    throw createError('First name and last name are required', 400);
  }

  const updates: Record<string, unknown> = {
    user_id: userId,
    first_name: resolvedFirstName,
    last_name: resolvedLastName,
    email: email ?? existingStaff.email,
    role: role ?? existingStaff.role,
    department: department ?? existingStaff.department,
    phone: normalizedPhone,
    employment_role: employment_role ?? existingStaff.employment_role,
    employment_status: employment_status ?? existingStaff.employment_status,
    start_date: start_date ?? existingStaff.start_date,
    end_date: end_date ?? existingStaff.end_date,
    notes: notes ?? existingStaff.notes,
    requires_password_reset: requiresPortalAccount
      ? (portalAccountCreated ? true : existingStaff.requires_password_reset)
      : existingStaff.requires_password_reset,
    password_hash: passwordHash,
    updated_at: new Date().toISOString()
  };

  let shouldDeleteOldPhoto = false;
  const newPhotoKey = profile_photo_key ?? (profile_photo_key === null ? null : existingStaff.profile_photo_key);
  const newPhotoUrl = profile_photo_url ?? (profile_photo_key === null ? null : existingStaff.profile_photo_url);

  if (profile_photo_key !== undefined) {
    updates.profile_photo_key = newPhotoKey;
    updates.profile_photo_url = newPhotoUrl;
    if (existingStaff.profile_photo_key && existingStaff.profile_photo_key !== newPhotoKey) {
      shouldDeleteOldPhoto = true;
    }
    if (profile_photo_key === null) {
      shouldDeleteOldPhoto = true;
    }
  }

  const { data, error } = await supabase
    .from('staff')
    .update(updates)
    .eq('id', req.params.id)
    .select(STAFF_SELECT)
    .single();

  if (error || !data) {
    throw createError('Failed to update staff profile', 500);
  }

  if (shouldDeleteOldPhoto) {
    await deletePhotoFromStorage(existingStaff.profile_photo_key);
  }

  const staffWithSignedUrl = await formatStaffRecord(data);

  res.json({
    success: true,
    data: { staff: staffWithSignedUrl }
  });
}));

// Update employment status
router.patch('/:id/status', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { employment_status, notes, end_date } = req.body;

  if (!employment_status || !['active', 'terminated', 'ex_employee'].includes(employment_status)) {
    throw createError('Valid employment_status is required', 400);
  }

  const isActive = employment_status === 'active';
  const resolvedEndDate = isActive ? null : (end_date || new Date().toISOString().split('T')[0]);

  const { data, error } = await supabase
    .from('staff')
    .update({
      employment_status,
      is_active: isActive,
      end_date: resolvedEndDate,
      notes,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select(STAFF_SELECT)
    .single();

  if (error || !data) {
    throw createError('Failed to update staff status', 500);
  }

  const staffWithSignedUrl = await formatStaffRecord(data);

  res.json({
    success: true,
    data: { staff: staffWithSignedUrl }
  });
}));

export default router;
