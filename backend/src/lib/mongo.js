import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectMongo(uri = config.mongoUri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(uri, {
    // Fail fast instead of buffering queries forever when Mongo is down.
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 20,
  });
  logger.info('mongo connected', { db: mongoose.connection.name });
  return mongoose.connection;
}

export async function disconnectMongo() {
  await mongoose.disconnect();
}
