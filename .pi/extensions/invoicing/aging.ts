/**
 * AR aging report: pi-agnostic, unit-testable.
 * Buckets outstanding (non-paid) invoices by days outstanding.
 */

import type { Ledger } from '../bookkeeping/ledger.ts';
import { listInvoices } from './invoices.ts';

export interface AgingBucketTotals {
  count: number;
  totalMinor: number; // sum of remaining amounts in natural balance
}

export interface AgingByCustomer {
  customer: string;
  buckets: {
    '0-30': AgingBucketTotals;
    '31-60': AgingBucketTotals;
    '61-90': AgingBucketTotals;
    '90+': AgingBucketTotals;
  };
  totalMinor: number;
}

export interface ArAgingReport {
  asOf: string;
  byCustomer: AgingByCustomer[];
  grandTotals: {
    '0-30': AgingBucketTotals;
    '31-60': AgingBucketTotals;
    '61-90': AgingBucketTotals;
    '90+': AgingBucketTotals;
    total: AgingBucketTotals;
  };
}

/**
 * Generate an AR aging report.
 * Buckets outstanding invoices by days outstanding as of a given date.
 * Paid invoices are excluded.
 * Groups by customer with per-bucket and grand totals.
 */
export function arAging(
  ledger: Ledger,
  opts: { asOf?: string } = {}
): ArAgingReport {
  const asOf = opts.asOf || new Date().toISOString().split('T')[0];

  // Get all invoices with non-zero remaining amounts
  const invoices = listInvoices(ledger, { asOf });
  const outstanding = invoices.filter((inv) => inv.remaining > 0);

  // Group by customer
  const byCustomerMap = new Map<string, typeof outstanding>();
  for (const inv of outstanding) {
    if (!byCustomerMap.has(inv.customer)) {
      byCustomerMap.set(inv.customer, []);
    }
    byCustomerMap.get(inv.customer)!.push(inv);
  }

  // Initialize grand totals
  const grandTotals = {
    '0-30': { count: 0, totalMinor: 0 },
    '31-60': { count: 0, totalMinor: 0 },
    '61-90': { count: 0, totalMinor: 0 },
    '90+': { count: 0, totalMinor: 0 },
  };

  // Process each customer
  const byCustomer: AgingByCustomer[] = [];
  for (const [customer, invs] of byCustomerMap) {
    const buckets = {
      '0-30': { count: 0, totalMinor: 0 },
      '31-60': { count: 0, totalMinor: 0 },
      '61-90': { count: 0, totalMinor: 0 },
      '90+': { count: 0, totalMinor: 0 },
    };

    let customerTotal = 0;
    for (const inv of invs) {
      const daysOutstanding = daysBetween(inv.issueDate, asOf);
      const bucket = getBucket(daysOutstanding);

      buckets[bucket].count += 1;
      buckets[bucket].totalMinor += inv.remaining;
      customerTotal += inv.remaining;

      grandTotals[bucket].count += 1;
      grandTotals[bucket].totalMinor += inv.remaining;
    }

    byCustomer.push({
      customer,
      buckets,
      totalMinor: customerTotal,
    });
  }

  // Compute grand total
  const grandTotal = {
    count: grandTotals['0-30'].count +
           grandTotals['31-60'].count +
           grandTotals['61-90'].count +
           grandTotals['90+'].count,
    totalMinor: grandTotals['0-30'].totalMinor +
                grandTotals['31-60'].totalMinor +
                grandTotals['61-90'].totalMinor +
                grandTotals['90+'].totalMinor,
  };

  return {
    asOf,
    byCustomer,
    grandTotals: {
      ...grandTotals,
      total: grandTotal,
    },
  };
}

/**
 * Calculate the number of days between two dates (YYYY-MM-DD).
 * Returns a non-negative integer.
 */
function daysBetween(fromDate: string, toDate: string): number {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const diffMs = to.getTime() - from.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Get the aging bucket name for a given number of days outstanding.
 */
function getBucket(daysOutstanding: number): '0-30' | '31-60' | '61-90' | '90+' {
  if (daysOutstanding <= 30) {
    return '0-30';
  } else if (daysOutstanding <= 60) {
    return '31-60';
  } else if (daysOutstanding <= 90) {
    return '61-90';
  } else {
    return '90+';
  }
}
