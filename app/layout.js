
import "./globals.css";

export const metadata = {
  title: "Kappiness CRM | Lead Management",
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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
