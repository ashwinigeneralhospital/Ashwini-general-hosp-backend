import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { asyncHandler, createError } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/auth.js';
import { logger } from '../utils/logger.js';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { env } from '../config/env.js';

const router = Router();
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Initialize R2 client (S3-compatible)
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = env.R2_BUCKET_NAME;

const normalizeKey = (value?: string | null) => {
  if (!value) return null;
  if (!value.startsWith('http')) {
    return value.replace(/^\/+/, '');
  }
  try {
    const parsed = new URL(value);
    return parsed.pathname.replace(/^\/+/, '');
  } catch {
    return null;
  }
};

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

const ALLOWED_TYPES = ['aadhaar', 'pan', 'staff-photo', 'insurance-claim-doc'] as const;

// Upload file to R2
router.post('/upload', authenticateToken, upload.single('file'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const file = req.file;
  const { type } = req.body;
  
  if (!file || !type) {
    throw createError('File and type are required', 400);
  }

  // Validate type
  if (!ALLOWED_TYPES.includes(type)) {
    throw createError('Invalid file type. Must be aadhaar, pan, staff-photo, or insurance-claim-doc', 400);
  }

  // Generate unique key
  const key = `${type}/${Date.now()}-${randomUUID()}-${file.originalname}`;
  
  // Upload to R2
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));

  // Generate signed URL for access (valid for 1 hour)
  const signedUrl = await getSignedUrl(r2, new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  }), { expiresIn: 3600 });

  logger.info('File uploaded to R2', {
    key,
    type,
    uploadedBy: req.user!.staff_id,
  });

  res.json({
    success: true,
    data: {
      url: signedUrl,
      key,
      type,
    }
  });
}));

// Cleanup temporary uploads
router.post('/cleanup', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { urls } = req.body;
  
  if (!Array.isArray(urls) || urls.length === 0) {
    throw createError('URLs array is required', 400);
  }

  // Extract keys from URLs (implementation depends on your URL structure)
  const keys = urls.map(url => {
    // Assuming URL contains the key after the bucket name
    const match = url.match(/\/([^/]+)$/);
    return match ? match[1] : null;
  }).filter(Boolean);

  if (keys.length === 0) {
    res.json({ success: true, message: 'No valid keys to delete' });
    return;
  }

  // Delete objects from R2
  await Promise.all(keys.map(key => 
    r2.send(new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    }))
  ));

  logger.info('Files cleaned up from R2', {
    keys,
    deletedBy: req.user!.staff_id,
  });

  res.json({
    success: true,
    data: { deleted: keys.length }
  });
}));

router.delete('/object', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { key } = req.body as { key?: string };

  const normalizedKey = normalizeKey(key);

  if (!normalizedKey) {
    throw createError('File key is required', 400);
  }

  if (!['aadhaar/', 'pan/', 'staff-photo/'].some((prefix) => normalizedKey.startsWith(prefix))) {
    throw createError('Invalid file key', 400);
  }

  await r2.send(new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: normalizedKey,
  }));

  logger.info('File deleted from R2', {
    key: normalizedKey,
    deletedBy: req.user!.staff_id,
  });

  res.json({
    success: true,
    data: { key: normalizedKey },
  });
}));

export default router;
