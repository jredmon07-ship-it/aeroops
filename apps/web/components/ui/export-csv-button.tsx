/**
 * export-csv-button.tsx — THE one "Export CSV" button for report sections.
 *
 * Client-side blob download: the RSC section builds a fully-stringified grid
 * (header row + data rows) from the data it already fetched and passes it here;
 * this component serializes it with the shared, RFC-4180 `serializeCsv` from
 * @aeroops/core (the SAME serializer the pilot-logbook export uses) and triggers
 * a browser download. NO server round-trip, NO card/bank data — CSV text only.
 *
 * Every cell is passed through `neutralizeCsvFormula` (spreadsheet-injection
 * guard) since report grids carry operator free-text (member names, memos).
 * Report money/date/count cells never begin with a formula character, so the
 * guard is a no-op on them and only ever hardens genuine free-text.
 *
 * Disabled when there is no data (header row only) — nothing to export.
 */
'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { serializeCsv, neutralizeCsvFormula } from '@aeroops/core';
import { Button } from '@/components/ui/button';

export interface ExportCsvButtonProps {
  /** Full grid: row 0 is the header, the rest are data rows. All cells stringified. */
  rows: string[][];
  /** e.g. "aeroops-utilization-2026-07.csv". */
  filename: string;
  label?: string;
  disabled?: boolean;
}

export function ExportCsvButton({
  rows,
  filename,
  label = 'Export CSV',
  disabled,
}: ExportCsvButtonProps) {
  const hasData = rows.length > 1; // header + at least one data row

  function handleClick() {
    const csv = serializeCsv(rows.map((row) => row.map((cell) => neutralizeCsvFormula(cell))));
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={handleClick}
      disabled={disabled || !hasData}
      title={hasData ? undefined : 'Nothing to export'}
    >
      <Download className="h-4 w-4 mr-1" aria-hidden="true" />
      {label}
    </Button>
  );
}
