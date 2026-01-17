import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Costco Deals - Western Canada',
  description: 'Track Costco deals and savings in BC, AB, SK, MB',
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
