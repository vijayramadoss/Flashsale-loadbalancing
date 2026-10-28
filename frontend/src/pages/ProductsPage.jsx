import { useEffect, useState } from 'react';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { StackItem } from '@astryxdesign/core/Stack';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Selector } from '@astryxdesign/core/Selector';
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Token } from '@astryxdesign/core/Token';
import { Pagination } from '@astryxdesign/core/Pagination';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Button } from '@astryxdesign/core/Button';
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { navigate, useLocation } from '../router.jsx';
import { useApi } from '../hooks/useApi.js';
import ProductCard from '../components/ProductCard.jsx';

const SORTS = [
  { value: 'popular', label: 'Most popular' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'rating', label: 'Customer rating' },
  { value: 'newest', label: 'Newest first' },
];

// Price bands in rupees → API filters in paise.
const PRICE_BANDS = [
  { value: 'any', label: 'Any price' },
  { value: '0-30000', label: 'Under ₹30,000' },
  { value: '30000-60000', label: '₹30,000 – ₹60,000' },
  { value: '60000-100000', label: '₹60,000 – ₹1,00,000' },
  { value: '100000-', label: 'Over ₹1,00,000' },
];

/** The URL is the source of truth for filters, so results are shareable and Back works. */
function toApiQuery(query) {
  const p = new URLSearchParams();
  for (const b of query.getAll('brand')) p.append('brand', b);
  if (query.get('q')) p.set('q', query.get('q'));
  p.set('sort', query.get('sort') || 'popular');
  p.set('page', query.get('page') || '1');
  p.set('limit', '12');
  if (query.get('inStock') === '1') p.set('inStock', 'true');
  const [min, max] = (query.get('price') || '').split('-');
  if (min) p.set('minPrice', String(Number(min) * 100));
  if (max) p.set('maxPrice', String(Number(max) * 100));
  return p.toString();
}

export default function ProductsPage() {
  const { query, search } = useLocation();
  const { data, error, loading } = useApi(`/products?${toApiQuery(query)}`, { auth: false });
  const brands = query.getAll('brand');
  const q = query.get('q') || '';
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => setShowFilters(false), [search]);

  const update = (changes) => {
    const next = new URLSearchParams(query);
    for (const [k, v] of Object.entries(changes)) {
      next.delete(k);
      if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
      else if (v !== undefined && v !== null && v !== '') next.set(k, v);
    }
    if (!('page' in changes)) next.delete('page');
    const s = next.toString();
    navigate(`/phones${s ? `?${s}` : ''}`, { keepScroll: 'page' in changes ? false : true });
  };

  const filters = (
    <VStack gap={5}>
      <CheckboxList label="Brand" value={brands} onChange={(v) => update({ brand: v })} density="compact">
        {(data?.facets.brands || []).map((b) => (
          <CheckboxListItem key={b.name} value={b.name} label={b.name} endContent={<Text type="supporting" size="sm">{b.count}</Text>} />
        ))}
      </CheckboxList>
      <RadioList label="Price" value={query.get('price') || 'any'} onChange={(v) => update({ price: v === 'any' ? '' : v })} size="sm">
        {PRICE_BANDS.map((b) => <RadioListItem key={b.value} value={b.value} label={b.label} />)}
      </RadioList>
      <CheckboxInput label="In stock only" value={query.get('inStock') === '1'} onChange={(c) => update({ inStock: c ? '1' : '' })} />
    </VStack>
  );

  return (
    <VStack gap={5}>
      <Breadcrumbs>
        <BreadcrumbItem href="/">Home</BreadcrumbItem>
        <BreadcrumbItem>Phones</BreadcrumbItem>
      </Breadcrumbs>
      <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
        <VStack gap={0.5}>
          <Heading level={1}>{q ? `Results for “${q}”` : brands.length === 1 ? `${brands[0]} phones` : 'All phones'}</Heading>
          <Text type="supporting">{data ? `${data.total} phone${data.total === 1 ? '' : 's'}` : 'Loading…'}</Text>
        </VStack>
        <HStack gap={2} vAlign="center">
          <span className="mobile-only">
            <Button label={showFilters ? 'Hide filters' : 'Filters'} variant="secondary" onClick={() => setShowFilters((s) => !s)} />
          </span>
          <Selector label="Sort by" isLabelHidden variant="secondary" value={query.get('sort') || 'popular'} onChange={(v) => update({ sort: v })} options={SORTS} width={210} />
        </HStack>
      </HStack>

      {(brands.length > 0 || q || query.get('price') || query.get('inStock')) && (
        <HStack gap={2} wrap="wrap">
          {q && <Token label={`“${q}”`} onRemove={() => update({ q: '' })} />}
          {brands.map((b) => <Token key={b} label={b} onRemove={() => update({ brand: brands.filter((x) => x !== b) })} />)}
          {query.get('price') && <Token label={PRICE_BANDS.find((p) => p.value === query.get('price'))?.label || 'Price'} onRemove={() => update({ price: '' })} />}
          {query.get('inStock') && <Token label="In stock" onRemove={() => update({ inStock: '' })} />}
          <Button label="Clear all" variant="ghost" size="sm" onClick={() => navigate('/phones')} />
        </HStack>
      )}

      <div className="catalog">
        <aside className={`filters${showFilters ? ' open' : ''}`} aria-label="Filters">{filters}</aside>
        <StackItem size="fill">
          {error && <Text className="hint-error">Couldn’t load phones — {error.message}</Text>}
          {data && data.items.length === 0 && (
            <EmptyState title="No phones match these filters" description="Try removing a filter or searching for something else." actions={<Button label="Clear filters" onClick={() => navigate('/phones')} />} />
          )}
          <Grid columns={{ minWidth: 220, max: 3 }} gap={4} className={loading && data ? 'is-refreshing' : undefined}>
            {data
              ? data.items.map((p) => <ProductCard key={p.slug} p={p} />)
              : Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={360} index={i} />)}
          </Grid>
          {data && data.pages > 1 && (
            <div className="pager">
              <Pagination page={data.page} onChange={(page) => update({ page: String(page) })} totalItems={data.total} pageSize={data.limit} />
            </div>
          )}
        </StackItem>
      </div>
    </VStack>
  );
}
