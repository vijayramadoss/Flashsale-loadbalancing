// Illustrated back view of a phone in the variant's real colour. Used instead
// of product photos (no copyrighted images, zero image requests, any colour).
// `design` approximates each model's camera layout.

function Lens({ cx, cy, r = 13 }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r + 3} fill="#00000026" />
      <circle cx={cx} cy={cy} r={r} fill="#16171a" />
      <circle cx={cx} cy={cy} r={r * 0.55} fill="#2b3140" />
      <circle cx={cx - r * 0.3} cy={cy - r * 0.3} r={r * 0.18} fill="#ffffff55" />
    </g>
  );
}

function Cameras({ design }) {
  switch (design) {
    case 'vertical':
      return (
        <g>
          <Lens cx={52} cy={52} />
          <Lens cx={52} cy={88} />
          <Lens cx={52} cy={124} r={11} />
          <circle cx={80} cy={52} r={4} fill="#f5e7b8" />
        </g>
      );
    case 'bar':
      return (
        <g>
          <rect x={18} y={56} width={164} height={44} rx={22} fill="#00000030" />
          <Lens cx={60} cy={78} r={12} />
          <Lens cx={92} cy={78} r={12} />
          <Lens cx={124} cy={78} r={12} />
          <circle cx={154} cy={78} r={4} fill="#f5e7b8" />
        </g>
      );
    case 'circle':
      return (
        <g>
          <circle cx={72} cy={78} r={50} fill="#00000026" />
          <Lens cx={72} cy={52} r={12} />
          <Lens cx={50} cy={92} r={12} />
          <Lens cx={94} cy={92} r={12} />
          <circle cx={132} cy={46} r={4} fill="#f5e7b8" />
        </g>
      );
    case 'pill':
      return (
        <g>
          <rect x={30} y={30} width={44} height={110} rx={22} fill="#00000026" />
          <Lens cx={52} cy={54} r={12} />
          <Lens cx={52} cy={86} r={12} />
          <Lens cx={52} cy={117} r={8} />
          <circle cx={88} cy={44} r={4} fill="#f5e7b8" />
        </g>
      );
    default: // square module
      return (
        <g>
          <rect x={22} y={22} width={96} height={96} rx={26} fill="#00000026" />
          <Lens cx={50} cy={50} />
          <Lens cx={50} cy={92} />
          <Lens cx={90} cy={71} />
          <circle cx={92} cy={38} r={4} fill="#f5e7b8" />
        </g>
      );
  }
}

export default function PhoneArt({ colorHex = '#d9d9d9', design = 'square', label, size = 'md' }) {
  const id = `g${colorHex.slice(1)}`;
  return (
    <svg
      className={`phone-art phone-art-${size}`}
      viewBox="0 0 200 320"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.28" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.12" />
        </linearGradient>
      </defs>
      <rect x={8} y={8} width={184} height={304} rx={34} fill={colorHex} />
      <rect x={8} y={8} width={184} height={304} rx={34} fill={`url(#${id})`} />
      <rect x={8.5} y={8.5} width={183} height={303} rx={33.5} fill="none" stroke="#00000033" />
      <Cameras design={design} />
    </svg>
  );
}
