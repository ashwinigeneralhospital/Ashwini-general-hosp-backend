import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from './logger.js';
import { env } from '../config/env.js';

const R2_ENDPOINT = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const BUCKET_NAME = env.R2_BUCKET_NAME;
// Use R2's public URL format: https://pub-<hash>.r2.dev
// Or custom domain if configured
const PUBLIC_BASE_URL = process.env.R2_PUBLIC_URL || `https://pub-4ebb3a85771243cab7a77deb68bf9e9e.r2.dev`;

const r2Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

export async function uploadToR2(
  buffer: Buffer,
  fileName: string,
  contentType: string
): Promise<{ url: string; path: string }> {
  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: buffer,
      ContentType: contentType,
    });

    await r2Client.send(command);

    const url = `${PUBLIC_BASE_URL}/${fileName}`;

    logger.info('File uploaded to R2', { fileName, contentType, url });

    return { url, path: fileName };
  } catch (error: any) {
    logger.error('Failed to upload to R2', { fileName, error: error.message });
    throw new Error(`R2 upload failed: ${error.message}`);
  }
}

export async function getSignedDownloadUrl(filePath: string, expiresIn: number = 3600): Promise<string> {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: filePath,
    });

    const url = await getSignedUrl(r2Client, command, { expiresIn });
    return url;
  } catch (error: any) {
    logger.error('Failed to generate signed URL', { filePath, error: error.message });
    throw new Error(`Failed to generate signed URL: ${error.message}`);
  }
}

export async function uploadLabReportPDF(
  patientId: string,
  admissionId: string,
  reportId: string,
  buffer: Buffer
): Promise<{ url: string; path: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `lab-reports/${patientId}/${admissionId}/${reportId}_${timestamp}.pdf`;
  return uploadToR2(buffer, fileName, 'application/pdf');
}
