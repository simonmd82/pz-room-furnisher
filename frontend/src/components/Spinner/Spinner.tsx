import s from './Spinner.module.css';

interface SpinnerProps {
  /** px, default 14 */
  size?: number;
  className?: string;
}

/** Small inline spinner. Color follows currentColor, so it inherits the surrounding text color. */
export function Spinner({ size = 14, className }: SpinnerProps) {
  return (
    <span
      className={`${s.spinner} ${className ?? ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
