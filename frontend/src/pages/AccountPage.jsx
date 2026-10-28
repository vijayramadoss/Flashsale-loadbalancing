import { useState } from 'react';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Grid } from '@astryxdesign/core/Grid';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { useToast } from '@astryxdesign/core/Toast';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, invalidateApiCache } from '../hooks/useApi.js';
import { navigate } from '../router.jsx';
import AddressDialog from '../components/AddressDialog.jsx';

export default function AccountPage() {
  const { user, logout } = useAuth();
  const addresses = useApi('/account/addresses');
  const toast = useToast();
  const [editing, setEditing] = useState(null); // null | {} (new) | address
  const [deleting, setDeleting] = useState(null);

  const refresh = () => {
    invalidateApiCache('/account/addresses');
    addresses.reload();
  };

  const remove = async () => {
    try {
      await api(`/account/addresses/${deleting.id}`, { method: 'DELETE' });
      toast({ body: 'Address removed.' });
      refresh();
    } catch (err) {
      toast({ body: err.message, type: 'error' });
    }
    setDeleting(null);
  };

  return (
    <VStack gap={6}>
      <Heading level={1}>My account</Heading>
      <Card>
        <HStack gap={4} hAlign="between" vAlign="center" wrap="wrap">
          <MetadataList orientation="horizontal">
            <MetadataListItem label="Name">{user.name}</MetadataListItem>
            <MetadataListItem label="Email">{user.email}</MetadataListItem>
          </MetadataList>
          <HStack gap={2}>
            <Button label="My orders" href="/orders" />
            <Button label="Sign out" variant="ghost" onClick={() => { logout(); navigate('/'); }} />
          </HStack>
        </HStack>
      </Card>

      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center">
          <Heading level={2}>Saved addresses</Heading>
          <Button label="Add address" variant="primary" onClick={() => setEditing({})} />
        </HStack>
        {!addresses.data && <Skeleton height={140} />}
        {addresses.data?.addresses.length === 0 && <Text type="supporting">No saved addresses yet — add one to check out faster.</Text>}
        <Grid columns={{ minWidth: 260, max: 3 }} gap={3}>
          {addresses.data?.addresses.map((a) => (
            <Card key={a.id}>
              <VStack gap={2}>
                <HStack gap={2} vAlign="center"><Text weight="semibold">{a.fullName}</Text><span className="tag">{a.label}</span>{a.isDefault && <span className="tag">Default</span>}</HStack>
                <Text size="sm">{a.line1}{a.line2 ? `, ${a.line2}` : ''}</Text>
                <Text size="sm">{a.city}, {a.state} {a.pincode}</Text>
                <Text type="supporting" size="sm">{a.phone}</Text>
                <HStack gap={1}>
                  <Button label="Edit" size="sm" variant="ghost" onClick={() => setEditing(a)} />
                  <Button label="Remove" size="sm" variant="ghost" onClick={() => setDeleting(a)} />
                </HStack>
              </VStack>
            </Card>
          ))}
        </Grid>
      </VStack>

      {editing && <AddressDialog isOpen onOpenChange={(o) => !o && setEditing(null)} initial={editing.id ? editing : undefined} onSaved={() => { toast({ body: 'Address saved.' }); refresh(); }} />}
      <AlertDialog
        isOpen={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Remove this address?"
        description={deleting ? `${deleting.fullName}, ${deleting.line1}, ${deleting.city}` : ''}
        actionLabel="Remove"
        onAction={remove}
      />
    </VStack>
  );
}
