import * as authService from '../services/authService.js';

export async function register(req, res) {
  res.status(201).json(await authService.register(req.body));
}

export async function login(req, res) {
  res.json(await authService.login(req.body));
}

export async function me(req, res) {
  res.json({ user: await authService.getProfile(req.user.id) });
}
