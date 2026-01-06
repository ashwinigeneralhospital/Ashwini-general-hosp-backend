import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import { createError } from './errorHandler.js';
import { env } from '../config/env.js';

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    name?: string;
    staff_id?: string;
    requires_password_reset?: boolean;
  };
}

export const authenticateToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      throw createError('Access token required', 401);
    }

    // Verify JWT token
    const decoded = jwt.verify(token, env.JWT_SECRET) as any;
    
    if (!decoded || !decoded.id) {
      throw createError('Invalid or expired token', 401);
    }

    // Get staff details from database
    const { data: staffData, error: staffError } = await supabase
      .from('staff')
      .select('id, first_name, last_name, email, role, is_active, employment_status, requires_password_reset, department')
      .eq('id', decoded.id)
      .single();

    if (staffError || !staffData) {
      throw createError('Staff account not found', 403);
    }

    const portalRoles = ['admin', 'doctor', 'nurse', 'billing', 'reception'];

    if (!portalRoles.includes(staffData.role) || !staffData.is_active || staffData.employment_status !== 'active') {
      throw createError('Staff account inactive or lacks portal access', 403);
    }

    const fullName = [staffData.first_name, staffData.last_name]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join(' ') || staffData.email;

    req.user = {
      id: staffData.id,
      email: staffData.email,
      role: staffData.role,
      name: fullName,
      staff_id: staffData.id,
      requires_password_reset: staffData.requires_password_reset
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      next(createError('Invalid or expired token', 401));
    } else {
      next(error);
    }
  }
};

export const requireRole = (allowedRoles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(createError('Authentication required', 401));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(createError('Insufficient permissions', 403));
    }

    if (req.user.requires_password_reset) {
      return next(createError('Password reset required', 403));
    }

    next();
  };
};

export const requireAdmin = requireRole(['admin']);
export const requireDoctor = requireRole(['admin', 'doctor']);
export const requireNurse = requireRole(['admin', 'doctor', 'nurse']);
export const requireBilling = requireRole(['admin', 'billing']);
export const requireReception = requireRole(['admin', 'reception', 'billing']);
export const requireMedicalStaff = requireRole(['admin', 'doctor', 'nurse']);
export const requirePortalStaff = requireRole(['admin', 'doctor', 'nurse', 'billing', 'reception']);
