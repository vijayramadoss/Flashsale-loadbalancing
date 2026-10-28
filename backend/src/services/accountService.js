import { User } from '../models/User.js';
import { AppError, notFound } from '../lib/errors.js';

const MAX_ADDRESSES = 10;

const publicAddress = (a) => ({
  id: a._id.toString(),
  label: a.label,
  fullName: a.fullName,
  phone: a.phone,
  line1: a.line1,
  line2: a.line2,
  city: a.city,
  state: a.state,
  pincode: a.pincode,
  isDefault: a.isDefault,
});

async function loadUser(userId) {
  const user = await User.findById(userId);
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Account no longer exists');
  return user;
}

export async function listAddresses(userId) {
  const user = await loadUser(userId);
  return user.addresses.map(publicAddress);
}

export async function addAddress(userId, data) {
  const user = await loadUser(userId);
  if (user.addresses.length >= MAX_ADDRESSES) throw new AppError(409, 'TOO_MANY_ADDRESSES', `You can save up to ${MAX_ADDRESSES} addresses`);
  // The first address is always the default.
  const makeDefault = data.isDefault || user.addresses.length === 0;
  if (makeDefault) user.addresses.forEach((a) => (a.isDefault = false));
  user.addresses.push({ ...data, isDefault: makeDefault });
  await user.save();
  return publicAddress(user.addresses.at(-1));
}

export async function updateAddress(userId, addressId, data) {
  const user = await loadUser(userId);
  const addr = user.addresses.id(addressId);
  if (!addr) throw notFound('Address not found');
  if (data.isDefault) user.addresses.forEach((a) => (a.isDefault = false));
  Object.assign(addr, data);
  if (!user.addresses.some((a) => a.isDefault)) addr.isDefault = true;
  await user.save();
  return publicAddress(addr);
}

export async function deleteAddress(userId, addressId) {
  const user = await loadUser(userId);
  const addr = user.addresses.id(addressId);
  if (!addr) throw notFound('Address not found');
  const wasDefault = addr.isDefault;
  addr.deleteOne();
  if (wasDefault && user.addresses.length) user.addresses[0].isDefault = true;
  await user.save();
}

/** Returns a plain snapshot of one of the user's addresses (for an order). */
export async function addressSnapshot(userId, addressId) {
  const user = await loadUser(userId);
  const a = user.addresses.id(addressId);
  if (!a) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a delivery address', [{ field: 'addressId', message: 'Unknown address' }]);
  const { label, fullName, phone, line1, line2, city, state, pincode } = a;
  return { label, fullName, phone, line1, line2, city, state, pincode };
}
