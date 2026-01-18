import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Price Scraper - Western Canada',
  description: 'Track deals and savings from Costco, Superstore, Save-On-Foods and more in BC, AB, SK, MB',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
