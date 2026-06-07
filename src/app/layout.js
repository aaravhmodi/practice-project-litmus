import "./globals.css";

export const metadata = {
  title: "Workshop",
  description: "Collaborative prompt editor shell",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
