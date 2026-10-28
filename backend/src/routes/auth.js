import { config } from '../config/env.js';
import { authenticate, botGuard, rateLimit } from '../plugins/guards.js';
import * as authService from '../services/authService.js';
import * as accountService from '../services/accountService.js';
import { addressBody, email, objectId } from '../schemas/common.js';

export default async function authRoutes(app) {
  const authLimiter = rateLimit({ bucket: 'auth-ip', max: config.rateLimit.authIpMax, windowSec: config.rateLimit.windowSec });

  app.post('/auth/register', {
    preHandler: [authLimiter, botGuard],
    schema: {
      body: {
        type: 'object',
        additionalProperties: false, // a "role" field is silently dropped → no self-promotion to admin
        required: ['name', 'email', 'password'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 60, pattern: '\\S\\s*\\S' }, // at least 2 non-space characters
          email,
          password: { type: 'string', minLength: 8, maxLength: 72 }, // bcrypt uses only 72 bytes
        },
      },
    },
    handler: async (req, reply) => {
      const { name, email: mail, password } = req.body;
      reply.code(201);
      return authService.register({ name: name.trim(), email: mail.trim().toLowerCase(), password });
    },
  });

  app.post('/auth/login', {
    preHandler: [authLimiter, botGuard],
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: { email, password: { type: 'string', minLength: 1, maxLength: 72 } },
      },
    },
    handler: async (req) => authService.login({ email: req.body.email.trim().toLowerCase(), password: req.body.password }),
  });

  app.get('/auth/me', { preHandler: authenticate }, async (req) => ({ user: await authService.getProfile(req.user.id) }));

  // ----- address book -----
  app.get('/account/addresses', { preHandler: authenticate }, async (req) => ({ addresses: await accountService.listAddresses(req.user.id) }));

  app.post('/account/addresses', { preHandler: authenticate, schema: { body: addressBody } }, async (req, reply) => {
    reply.code(201);
    return { address: await accountService.addAddress(req.user.id, req.body) };
  });

  app.put('/account/addresses/:id', {
    preHandler: authenticate,
    schema: { params: { type: 'object', properties: { id: objectId } }, body: addressBody },
    handler: async (req) => ({ address: await accountService.updateAddress(req.user.id, req.params.id, req.body) }),
  });

  app.delete('/account/addresses/:id', {
    preHandler: authenticate,
    schema: { params: { type: 'object', properties: { id: objectId } } },
    handler: async (req, reply) => {
      await accountService.deleteAddress(req.user.id, req.params.id);
      reply.code(204).send();
    },
  });
}
