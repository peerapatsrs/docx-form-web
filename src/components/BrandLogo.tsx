import Image from "next/image";

/** Display mark: SVG (tiny). Raster `/brand/logo-mark.png` kept for OG / icons. */
export const BRAND_LOGO_SRC = "/brand/logo-mark.svg";
export const BRAND_LOGO_RASTER_SRC = "/brand/logo-mark.png";
export const BRAND_NAME = "docx-form";

type BrandLogoProps = {
  size?: number;
  className?: string;
  /** Decorative mark next to wordmark (default). */
  decorative?: boolean;
};

export function BrandLogo({
  size = 28,
  className = "brand-logo",
  decorative = true,
}: BrandLogoProps) {
  return (
    <Image
      className={className}
      src={BRAND_LOGO_SRC}
      alt={decorative ? "" : BRAND_NAME}
      width={size}
      height={size}
      priority
      unoptimized
      aria-hidden={decorative || undefined}
    />
  );
}

type BrandLockupProps = {
  versionId?: string;
  versionLabel?: string;
  href?: string;
  className?: string;
  markSize?: number;
};

/** Mark + wordmark (+ optional version) used in the home topbar. */
export function BrandLockup({
  versionId,
  versionLabel = "v…",
  href = "/",
  className = "brand",
  markSize = 28,
}: BrandLockupProps) {
  const inner = (
    <>
      <BrandLogo size={markSize} className="brand-logo" />
      <div className="brand-copy">
        <span className="brand-text">{BRAND_NAME}</span>
        {versionId ? (
          <span className="brand-ver" id={versionId}>
            {versionLabel}
          </span>
        ) : null}
      </div>
    </>
  );

  if (href) {
    return (
      <a className={className} href={href} aria-label={BRAND_NAME}>
        {inner}
      </a>
    );
  }

  return <div className={className}>{inner}</div>;
}
