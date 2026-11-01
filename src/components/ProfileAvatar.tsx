"use client";

import { useState } from "react";

type ProfileAvatarProps = {
  /** Provider profile image URL (Google, Facebook, …) or null */
  image?: string | null;
  /** Used for letter fallback + alt text */
  name?: string | null;
  email?: string | null;
  className?: string;
  fallbackClassName?: string;
  size?: number;
};

function initialOf(name?: string | null, email?: string | null): string {
  const raw = String(name || email || "?").trim();
  return (raw[0] || "?").toUpperCase();
}

/**
 * Renders an OAuth provider avatar via same-origin proxy so Google/Facebook
 * CDNs are not blocked by referrer / hotlink rules in the browser.
 * Falls back to a letter mark if the remote image is missing or fails.
 */
export function ProfileAvatar({
  image,
  name,
  email,
  className = "auth-bar-avatar",
  fallbackClassName = "auth-bar-avatar auth-bar-avatar-fallback",
  size = 28,
}: ProfileAvatarProps) {
  const [failed, setFailed] = useState(false);
  const label = name || email || "บัญชี";
  const src = String(image || "").trim();
  const showImg = Boolean(src) && !failed;

  if (!showImg) {
    return (
      <span className={fallbackClassName} aria-hidden>
        {initialOf(name, email)}
      </span>
    );
  }

  // Proxy keeps provider CDN quirks (Referer, CORS) off the browser.
  const proxySrc = `/api/avatar?src=${encodeURIComponent(src)}`;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={proxySrc}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      decoding="async"
      onError={() => setFailed(true)}
      title={label}
    />
  );
}
