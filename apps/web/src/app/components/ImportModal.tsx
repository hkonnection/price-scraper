'use client';

import { useState, useRef, useCallback } from 'react';

interface ImportModalProps {
  retailerSlug: string;
  retailerName: string;
  onClose: () => void;
  onSuccess: () => void;
}

interface ParsedDeal {
  product_name: string;
  sale_price: number;
  regular_price: number;
  [key: string]: unknown;
}

/**
 * Modal dialog for importing deal data via file upload or JSON paste.
 * Posts to /api/import-deals with the retailer slug and parsed JSON array.
 */
export default function ImportModal({ retailerSlug, retailerName, onClose, onSuccess }: ImportModalProps) {
  const [activeTab, setActiveTab] = useState<'upload' | 'paste'>('upload');
  const [jsonText, setJsonText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [parsedDeals, setParsedDeals] = useState<ParsedDeal[] | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successCount, setSuccessCount] = useState<number | null>(null);
  const [pulledDate, setPulledDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Parses JSON string and validates it's an array of deals.
   * Returns parsed array or null if invalid.
   */
  const parseAndValidate = useCallback((jsonString: string): ParsedDeal[] | null => {
    try {
      const parsed = JSON.parse(jsonString);
      if (!Array.isArray(parsed)) {
        setError('JSON must be an array of deal objects.');
        return null;
      }
      if (parsed.length === 0) {
        setError('JSON array is empty.');
        return null;
      }
      const sample = parsed[0];
      if (!sample.product_name || sample.sale_price === undefined || sample.regular_price === undefined) {
        setError('Deals must have product_name, sale_price, and regular_price fields.');
        return null;
      }
      return parsed as ParsedDeal[];
    } catch {
      setError('Invalid JSON. Please check the format and try again.');
      return null;
    }
  }, []);

  /**
   * Handles file selection from input or drop.
   */
  const handleFile = useCallback((selectedFile: File) => {
    setError(null);
    setParsedDeals(null);

    if (!selectedFile.name.endsWith('.json')) {
      setError('Please select a JSON file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      const deals = parseAndValidate(content);
      if (deals) {
        setFile(selectedFile);
        setParsedDeals(deals);
        setError(null);
      }
    };
    reader.onerror = () => {
      setError('Failed to read file. Please try again.');
    };
    reader.readAsText(selectedFile);
  }, [parseAndValidate]);

  /**
   * Handles drag events for the drop zone.
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      handleFile(droppedFile);
    }
  }, [handleFile]);

  /**
   * Clears the selected file and parsed data.
   */
  const clearFile = useCallback(() => {
    setFile(null);
    setParsedDeals(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  /**
   * Validates JSON input from textarea and submits to the import API.
   */
  const handleSubmit = async () => {
    setError(null);
    setSuccessCount(null);

    let dealsToSubmit: ParsedDeal[] | null = null;

    if (activeTab === 'upload') {
      if (!parsedDeals) {
        setError('Please select a valid JSON file first.');
        return;
      }
      dealsToSubmit = parsedDeals;
    } else {
      dealsToSubmit = parseAndValidate(jsonText);
      if (!dealsToSubmit) return;
    }

    setIsLoading(true);

    try {
      const response = await fetch('/api/import-deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retailer: retailerSlug, deals: dealsToSubmit, pulledDate }),
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

  /**
   * Formats a number with commas for display.
   */
  const formatNumber = (n: number) => n.toLocaleString();

  /**
   * Formats price for display.
   */
  const formatPrice = (price: number) => `$${price.toFixed(2)}`;

  const canSubmit = activeTab === 'upload'
    ? parsedDeals !== null && parsedDeals.length > 0
    : jsonText.trim().length > 0;

  const submitButtonText = isLoading
    ? 'Importing...'
    : parsedDeals && activeTab === 'upload'
      ? `Import ${formatNumber(parsedDeals.length)}`
      : 'Submit';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="import-modal-header">
          <h2>Import Deals — {retailerName}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="import-modal-body">
          {/* Tabs */}
          <div className="import-tabs">
            <button
              className={`import-tab ${activeTab === 'upload' ? 'active' : ''}`}
              onClick={() => setActiveTab('upload')}
              disabled={isLoading}
            >
              Upload File
            </button>
            <button
              className={`import-tab ${activeTab === 'paste' ? 'active' : ''}`}
              onClick={() => setActiveTab('paste')}
              disabled={isLoading}
            >
              Paste JSON
            </button>
          </div>

          {/* Upload Tab */}
          {activeTab === 'upload' && (
            <>
              {!file ? (
                <div
                  className={`drop-zone ${isDragging ? 'dragging' : ''}`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                    style={{ display: 'none' }}
                  />
                  <div className="drop-zone-icon">📁</div>
                  <div className="drop-zone-text">
                    Drop JSON file here<br />
                    <span>or click to browse</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="file-info">
                    <div className="file-info-content">
                      <span className="file-info-icon">✓</span>
                      <div className="file-info-details">
                        <div className="file-info-name">{file.name}</div>
                        <div className="file-info-count">
                          {parsedDeals ? `${formatNumber(parsedDeals.length)} products ready to import` : 'Processing...'}
                        </div>
                      </div>
                    </div>
                    <button className="file-info-clear" onClick={clearFile} disabled={isLoading}>×</button>
                  </div>

                  {parsedDeals && parsedDeals.length > 0 && (
                    <div className="import-preview">
                      <div className="import-preview-title">Preview:</div>
                      <div className="import-preview-list">
                        {parsedDeals.slice(0, 3).map((deal, i) => (
                          <div key={i} className="import-preview-item">
                            • {deal.product_name} — {formatPrice(deal.sale_price)} (was {formatPrice(deal.regular_price)})
                          </div>
                        ))}
                        {parsedDeals.length > 3 && (
                          <div className="import-preview-more">
                            ... and {formatNumber(parsedDeals.length - 3)} more
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Date picker for when data was pulled */}
                  <div className="import-date-field">
                    <label htmlFor="pulled-date">Data pulled on (optional):</label>
                    <input
                      type="date"
                      id="pulled-date"
                      value={pulledDate}
                      onChange={(e) => setPulledDate(e.target.value)}
                      disabled={isLoading}
                    />
                  </div>
                </>
              )}
            </>
          )}

          {/* Paste Tab */}
          {activeTab === 'paste' && (
            <>
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

              {/* Date picker for when data was pulled */}
              <div className="import-date-field">
                <label htmlFor="pulled-date-paste">Data pulled on (optional):</label>
                <input
                  type="date"
                  id="pulled-date-paste"
                  value={pulledDate}
                  onChange={(e) => setPulledDate(e.target.value)}
                  disabled={isLoading}
                />
              </div>
            </>
          )}

          {error && <div className="import-error">{error}</div>}
          {successCount !== null && (
            <div className="import-success">Imported {formatNumber(successCount)} deals!</div>
          )}
        </div>

        <div className="import-modal-footer">
          <button className="import-cancel-btn" onClick={onClose} disabled={isLoading}>
            Cancel
          </button>
          <button
            className="import-submit-btn"
            onClick={handleSubmit}
            disabled={isLoading || !canSubmit}
          >
            {submitButtonText}
          </button>
        </div>
      </div>
    </div>
  );
}
