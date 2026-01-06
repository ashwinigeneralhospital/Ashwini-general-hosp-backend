import { Router, Response } from 'express';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/auth.js';

const router = Router();

router.post('/', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  res.json({ success: true, data: { message: 'Upload endpoint placeholder' } });
}));

export default router;
