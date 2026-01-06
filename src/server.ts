import app from './app.js';
import { logger } from './utils/logger.js';
import { startCronJobs } from './cron/index.js';

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  logger.info(`🏥 Ashwini Hospital ERP Backend running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Start cron jobs for automated billing
  startCronJobs();
  logger.info('📅 Cron jobs started');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

export default server;
