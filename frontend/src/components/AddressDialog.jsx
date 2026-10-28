import { useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Selector } from '@astryxdesign/core/Selector';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Banner } from '@astryxdesign/core/Banner';
import { api } from '../api.js';

const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Lakshadweep',
];

const EMPTY = { label: 'Home', fullName: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '', isDefault: false };

// Mirrors the server's rules for instant feedback; the server re-validates.
function validate(f) {
  const e = {};
  if (f.fullName.trim().length < 2) e.fullName = 'Enter the recipient’s full name';
  if (!/^[6-9]\d{9}$/.test(f.phone.trim())) e.phone = 'Enter a 10-digit mobile number';
  if (f.line1.trim().length < 3) e.line1 = 'Enter house number and street';
  if (f.city.trim().length < 2) e.city = 'Enter the city';
  if (!f.state) e.state = 'Choose a state';
  if (!/^\d{6}$/.test(f.pincode.trim())) e.pincode = 'Enter a 6-digit PIN code';
  return e;
}

/** Add / edit a saved address. Calls onSaved(address) after the server accepts it. */
export default function AddressDialog({ isOpen, onOpenChange, initial, onSaved }) {
  const [f, setF] = useState(() => ({ ...EMPTY, ...initial }));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  // Editing a field clears its error right away instead of waiting for the next submit.
  const set = (k) => (v) => {
    setF((cur) => ({ ...cur, [k]: v }));
    setErrors((cur) => (cur[k] ? { ...cur, [k]: undefined } : cur));
  };
  const status = (k) => (errors[k] ? { type: 'error', message: errors[k] } : undefined);

  const save = async (ev) => {
    ev.preventDefault();
    const e = validate(f);
    setErrors(e);
    setFormError('');
    if (Object.keys(e).length) return;
    setBusy(true);
    const body = { ...f, fullName: f.fullName.trim(), phone: f.phone.trim(), line1: f.line1.trim(), line2: f.line2.trim(), city: f.city.trim(), pincode: f.pincode.trim() };
    delete body.id;
    try {
      const { data } = initial?.id
        ? await api(`/account/addresses/${initial.id}`, { method: 'PUT', body })
        : await api('/account/addresses', { method: 'POST', body });
      onSaved(data.address);
      onOpenChange(false);
    } catch (err) {
      if (err.details) setErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width={560}>
      <DialogHeader title={initial?.id ? 'Edit address' : 'Add a delivery address'} onOpenChange={onOpenChange} />
      <form onSubmit={save} noValidate>
        <FormLayout defaultOptionality="required">
          {formError && <Banner status="error" title={formError} />}
          <SegmentedControl label="Address type" value={f.label} onChange={set('label')} size="sm">
            {['Home', 'Work', 'Other'].map((l) => <SegmentedControlItem key={l} value={l} label={l} />)}
          </SegmentedControl>
          <FormLayout direction="horizontal">
            <TextInput label="Full name" value={f.fullName} onChange={set('fullName')} autoComplete="name" status={status('fullName')} />
            <TextInput label="Mobile number" value={f.phone} onChange={set('phone')} autoComplete="tel-national" placeholder="10-digit number" status={status('phone')} />
          </FormLayout>
          <TextInput label="Flat, house no., building, street" value={f.line1} onChange={set('line1')} autoComplete="address-line1" status={status('line1')} />
          <TextInput label="Area, landmark" isOptional value={f.line2} onChange={set('line2')} autoComplete="address-line2" />
          <FormLayout direction="horizontal">
            <TextInput label="City" value={f.city} onChange={set('city')} autoComplete="address-level2" status={status('city')} />
            <TextInput label="PIN code" value={f.pincode} onChange={set('pincode')} autoComplete="postal-code" status={status('pincode')} />
          </FormLayout>
          <Selector label="State" hasSearch value={f.state || undefined} onChange={set('state')} options={STATES} placeholder="Choose a state" status={status('state')} />
          <CheckboxInput label="Make this my default address" value={f.isDefault} onChange={set('isDefault')} />
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={() => onOpenChange(false)} />
            <Button label="Save address" variant="primary" type="submit" isLoading={busy} />
          </HStack>
        </FormLayout>
      </form>
    </Dialog>
  );
}
