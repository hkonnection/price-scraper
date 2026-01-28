'use client';

import { useState } from 'react';

interface ImportModalProps {
  retailerSlug: string;
  retailerName: string;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Modal dialog for importing deal data via JSON paste.
 * Posts to /api/import-deals with the retailer slug and parsed JSON array.
 */
export default function ImportModal({ retailerSlug, retailerName, onClose, onSuccess }: ImportModalProps) {
  const [jsonText, setJsonText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successCount, setSuccessCount] = useState<number | null>(null);

  /**
   * Validates JSON input and submits to the import API.
   */
  const handleSubmit = async () => {
    setError(null);
    setSuccessCount(null);

    // Client-side validation
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      setError('Invalid JSON. Please check the format and try again.');
      return;
    }

    if (!Array.isArray(parsed)) {
      setError('JSON must be an array of deal objects.');
      return;
    }

    if (parsed.length === 0) {
      setError('JSON array is empty.');
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch('/api/import-deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retailer: retailerSlug, deals: parsed }),
      });

      const data = await response.json() as { error?: string; count?: number; message?: string };

      if (response.ok && data.count) {
        setSuccessCount(data.count);
        setTimeout(() => {
          onSuccess();
          onClose();
        }, 1500);
      } else {
        setError(data.error || 'Import failed');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="import-modal-header">
          <h2>Import Deals — {retailerName}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="import-modal-body">
          <p className="import-instructions">
            Paste the JSON array extracted from the retailer website below.
          </p>

          <textarea
            className="import-textarea"
            placeholder='[{"product_code": "...", "product_name": "...", "sale_price": 9.99, "regular_price": 19.99, ...}]'
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            disabled={isLoading}
            rows={12}
          />

          {error && <div className="import-error">{error}</div>}
          {successCount !== null && (
            <div className="import-success">Imported {successCount} deals!</div>
          )}
        </div>

        <div className="import-modal-footer">
          <button className="import-cancel-btn" onClick={onClose} disabled={isLoading}>
            Cancel
          </button>
          <button className="import-submit-btn" onClick={handleSubmit} disabled={isLoading || !jsonText.trim()}>
            {isLoading ? 'Importing...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
