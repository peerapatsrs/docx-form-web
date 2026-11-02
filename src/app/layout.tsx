import type { Metadata } from "next";
import { connection } from "next/server";
import { SiteJsonLd } from "@/components/SiteJsonLd";
import {
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_NAME,
  SITE_NAME_FULL,
  SITE_TITLE,
  absoluteUrl,
} from "@/lib/site-meta";
import "./globals.css";

/**
 * Resolve metadata at request time so canonical / Open Graph URLs follow the
 * configured deployed base URL (APP_BASE_URL / NEXT_PUBLIC_APP_URL / …)
 * instead of whatever placeholder was present during `next build`.
 */
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const base = absoluteUrl("/");
  return {
    metadataBase: new URL(base),
    title: {
      default: SITE_TITLE,
      template: `%s · ${SITE_NAME}`,
    },
    description: SITE_DESCRIPTION,
    applicationName: SITE_NAME_FULL,
    keywords: [...SITE_KEYWORDS],
    authors: [{ name: "Peerapat Surasing", url: "mailto:peerapat.srs@gmail.com" }],
    creator: "Peerapat Surasing",
    category: "productivity",
    alternates: {
      canonical: "/",
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
    icons: {
      icon: [
        { url: "/brand/logo-mark.svg", type: "image/svg+xml" },
        { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
        { url: "/favicon-48.png", type: "image/png", sizes: "48x48" },
        { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
      shortcut: ["/favicon-32.png"],
    },
    openGraph: {
      type: "website",
      locale: "th_TH",
      alternateLocale: ["en_US"],
      url: "/",
      siteName: SITE_NAME_FULL,
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      images: [
        {
          url: "/brand/logo-mark.png",
          width: 512,
          height: 512,
          alt: `${SITE_NAME} logo — กรอกแบบฟอร์ม Word จากเทมเพลต .docx`,
        },
      ],
    },
    twitter: {
      card: "summary",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      images: ["/brand/logo-mark.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* Hybrid shell: fonts + /public/style.css (cache-busted) shared with app.js UI */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&family=Sarabun:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/style.css?v=web24" />
      </head>
      <body>
        <SiteJsonLd />
        {children}
      </body>
    </html>
  );
}
