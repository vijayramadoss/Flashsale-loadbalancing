export default function StockBar({ remaining, total }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  const low = pct <= 20;
  return (
    <div className="stock">
      <div
        className="stock-track"
        role="progressbar"
        aria-label="Units remaining"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={remaining}
      >
        <div className={`stock-fill${low ? ' low' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="stock-label">
        {remaining > 0 ? (
          <>
            <strong>{remaining}</strong> of {total} left{low ? ' — almost gone!' : ''}
          </>
        ) : (
          <strong>All {total} units claimed</strong>
        )}
      </p>
    </div>
  );
}
