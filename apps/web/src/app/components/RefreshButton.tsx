'use client';

import { useState } from 'react';

/**
 * Button to trigger the scraper workflow.
 * Shows loading state while triggering.
 */
export default function RefreshButton() {
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleRefresh = async () => {
    setIsLoading(true);
    setMessage(null);

    try {
      const response = await fetch('/api/trigger-scrape', { method: 'POST' });
      const data = await response.json() as { error?: string; message?: string };

      if (response.ok) {
        setMessage('Scraper triggered! Refresh in ~1 min.');
      } else {
        setMessage(data.error || 'Failed to trigger scraper');
      }
    } catch {
      setMessage('Network error');
    } finally {
      setIsLoading(false);
      // Clear message after 5 seconds
      setTimeout(() => setMessage(null), 5000);
    }
  };

  return (
    <div className="refresh-container">
      <button
        onClick={handleRefresh}
        disabled={isLoading}
        className="refresh-button"
      >
        {isLoading ? 'Triggering...' : 'Refresh Deals'}
      </button>
      {message && <span className="refresh-message">{message}</span>}
    </div>
  );
}
