import fs from 'fs';
import path from 'path';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedLogoDataUri: string | null = null;

const resolvePath = (filePath: string) => {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
};

export const getHospitalLogoDataUri = () => {
  if (cachedLogoDataUri !== null) {
    return cachedLogoDataUri;
  }

  const candidates: string[] = [];

  if (env.HOSPITAL_LOGO_PATH) {
    candidates.push(resolvePath(env.HOSPITAL_LOGO_PATH));
  }

  candidates.push(
    path.resolve(process.cwd(), 'public/logo.jpg'),
    path.resolve(__dirname, '../public/logo.jpg'),
    path.resolve(process.cwd(), '../hospital-management-frontend/public/logo.jpg'),
    path.resolve(__dirname, '../../hospital-management-frontend/public/logo.jpg'),
    path.resolve(__dirname, '../../../hospital-management-frontend/public/logo.jpg'),
  );

  const mimeType = env.HOSPITAL_LOGO_MIME || 'image/jpeg';

  for (const logoPath of candidates) {
    try {
      if (!fs.existsSync(logoPath)) continue;
      const buffer = fs.readFileSync(logoPath);
      cachedLogoDataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
      logger.info('Loaded hospital logo for invoices', { logoPath });
      return cachedLogoDataUri;
    } catch (error) {
      logger.warn('Failed to load hospital logo candidate', { logoPath, error });
    }
  }

  logger.warn('No hospital logo found; PDF invoices will omit logo');
  cachedLogoDataUri = '';
  return cachedLogoDataUri;
};
