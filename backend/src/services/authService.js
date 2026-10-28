import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { User } from '../models/User.js';
import { AppError, conflict } from '../lib/errors.js';

// A real bcrypt hash of a random string, used to spend the same time on
// "unknown email" as on "wrong password" so attackers can't enumerate accounts by timing.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', config.bcryptRounds);

export function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, name: user.name },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn, algorithm: 'HS256' },
  );
}

export function verifyToken(token) {
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  return { id: payload.sub, role: payload.role, name: payload.name };
}

export async function register({ name, email, password }) {
  const exists = await User.exists({ email });
  if (exists) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  // Role is never taken from the request: self-registration is always a customer.
  const user = await User.create({ name, email, passwordHash, role: 'customer' });
  return { token: signToken(user), user: user.toPublic() };
}

export async function login({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash');
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  return { token: signToken(user), user: user.toPublic() };
}

export async function getProfile(userId) {
  const user = await User.findById(userId);
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Account no longer exists');
  return user.toPublic();
}
