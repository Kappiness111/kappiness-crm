import { Cinzel, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { BOOT_SCRIPT } from "./lib/theme";

// IBM Plex Sans for text and headings; IBM Plex Mono for figures, like a clinical record.
const sans = IBM_Plex_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const serif = IBM_Plex_Sans({ subsets: ["latin"], variable: "--font-serif", display: "swap", weight: ["500", "600", "700"] });
const mono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap", weight: ["400", "500", "600"] });
// Cinzel only for the dashboard greeting.
const regal = Cinzel({ subsets: ["latin"], variable: "--font-regal", display: "swap", weight: ["500", "600", "700"] });

export const metadata = {
  title: "Kappiness CRM",
  description:
    "Kappiness CRM for managing leads, follow ups, appointments, and counsellor relationships.",
  icons: {
    icon: "/kappiness_logo_sq.jpeg",
    shortcut: "/kappiness_logo_sq.jpeg",
    apple: "/kappiness_logo_sq.jpeg",
  },
};

export default function RootLayout({ children }) {
  return (
    // The inline script applies the saved theme and sidebar width before the first paint, so React must accept them.
    <html lang="en" data-theme="light" data-sidebar="collapsed" className={`${sans.variable} ${serif.variable} ${mono.variable} ${regal.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
