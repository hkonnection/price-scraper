import { collectionPolicy, formatPublicationDate, publicationAge } from '../publication';
import type { Retailer } from './DealsPageClient';

interface PublicationSummaryProps {
  retailers: Retailer[];
  retailerDates: Record<string, string | null>;
  retailerPaused: Record<string, boolean>;
  evaluatedAt: string;
  hasLegacyRows: boolean;
}

/**
 * Show per-store publication age without claiming attempt success or full coverage.
 * @param props - Visible stores and server-selected publication metadata.
 * @returns Publication labels and links to existing Actions history.
 */
export default function PublicationSummary({ retailers, retailerDates, retailerPaused, evaluatedAt, hasLegacyRows }: PublicationSummaryProps) {
  return (
    <section aria-label="Publication dates" className="last-updated" style={{ textAlign: 'left' }}>
      {retailers.map(retailer => {
        const policy = collectionPolicy(retailer.slug);
        const age = publicationAge(retailerDates[retailer.slug], evaluatedAt, policy.maxAgeDays);
        const paused = policy.paused || retailerPaused[retailer.slug];
        return (
          <p key={retailer.slug}>
            <strong>{retailer.name}</strong>: Last published: {formatPublicationDate(retailerDates[retailer.slug])}.
            {' '}{age.stale ? 'Stale: ' : ''}{age.label}.
            {policy.maxAgeDays !== null && ` Age limit: ${policy.maxAgeDays} days.`}
            {paused && ' Collection paused. Saved results are retained.'}
            {policy.maxAgeDays === null && ' No scheduled age limit.'}
            {policy.historyUrl && <> <a href={policy.historyUrl} target="_blank" rel="noopener noreferrer">Actions run history</a>.</>}
          </p>
        );
      })}
      <p>Stale means older than the maximum scheduled collection gap: 4 days for twice-weekly sources, 7 days for weekly sources. This is an age rule, not a report of the latest attempt.</p>
      <p>Saved prices and availability may have changed. Last published does not prove full product or variant coverage. Fetch failures before the writer are only visible in Actions run history.</p>
      {hasLegacyRows && <p>Legacy rows have no verified publication date. Their observation dates are shown separately.</p>}
    </section>
  );
}
