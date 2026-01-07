import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireAdmin } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { sendEmail } from '../utils/mailer.js';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.get('/', authenticateToken, asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Failed to fetch email templates', { error });
    throw createError('Failed to fetch email templates', 500);
  }

  res.json({
    success: true,
    data: data ?? [],
  });
}));

router.post('/', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { name, subject, body, status = 'active' } = req.body;

  if (!name || !subject || !body) {
    throw createError('name, subject, and body are required', 400);
  }

  const { data, error } = await supabase
    .from('email_templates')
    .insert({ name, subject, body, status })
    .select('*')
    .single();

  if (error || !data) {
    logger.error('Failed to create email template', { error });
    throw createError('Failed to create email template', 500);
  }

  res.status(201).json({
    success: true,
    data,
  });
}));

router.put('/:id', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { name, subject, body, status } = req.body;

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name;
  if (subject !== undefined) updates.subject = subject;
  if (body !== undefined) updates.body = body;
  if (status !== undefined) updates.status = status;

  if (!Object.keys(updates).length) {
    throw createError('No fields provided to update', 400);
  }

  const { data, error } = await supabase
    .from('email_templates')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (error || !data) {
    logger.error('Failed to update email template', { error, id });
    throw createError('Failed to update email template', 500);
  }

  res.json({
    success: true,
    data,
  });
}));

router.delete('/:id', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('email_templates')
    .delete()
    .eq('id', id);

  if (error) {
    logger.error('Failed to delete email template', { error, id });
    throw createError('Failed to delete email template', 500);
  }

  res.json({ success: true });
}));

router.post('/:id/send', authenticateToken, requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { to, subjectOverride, bodyOverride } = req.body;

  if (!to) {
    throw createError('Recipient email (to) is required', 400);
  }

  const { data: template, error } = await supabase
    .from('email_templates')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !template) {
    throw createError('Email template not found', 404);
  }

  const subject = subjectOverride || template.subject;
  const body = bodyOverride || template.body;

  await sendEmail({
    to,
    subject,
    html: body,
  });

  logger.info('Email sent from template', { templateId: id, to });

  res.json({ success: true });
}));

export default router;
