import { formatPublicationDate } from '../publication';
import type { Retailer } from './DealsPageClient';

interface PublicationSummaryProps {
  retailer: Retailer | undefined;
  retailerDates: Record<string, string | null>;
}

/**
 * Show the selected store's completed publication time beside its table.
 * @param props - Selected store and unchanged server-selected publication dates.
 * @returns One compact update line, or nothing for the all-store view.
 */
export default function PublicationSummary({ retailer, retailerDates }: PublicationSummaryProps) {
  if (!retailer) return null;
  return (
    <p className="last-updated">
      Last updated: {formatPublicationDate(retailerDates[retailer.slug])}
    </p>
  );
}
