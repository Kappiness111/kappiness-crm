import "./globals.css";
import { BOOT_SCRIPT } from "./lib/theme";

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
    <html lang="en" data-theme="light" data-sidebar="collapsed" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
