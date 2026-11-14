/** ECB reference rates are budget estimates, not transaction settlement prices. */
export class EcbExchangeRates {
  constructor({ fetchImpl = fetch, clock = () => new Date() } = {}) { this.fetchImpl = fetchImpl; this.clock = clock; this.cache = null; }
  async rates(fromCurrencies, to) {
    if (!/^[A-Z]{3}$/.test(to)) return [];
    if (!this.cache || this.clock().getTime() - this.cache.loadedAt > 3600_000) {
      const response = await this.fetchImpl("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", { redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("exchange_rates_unavailable");
      const xml = await response.text(); if (xml.length > 100_000) throw new Error("invalid_exchange_rates");
      const asOf = xml.match(/\btime=['"]([0-9-]{10})['"]/)?.[1];
      if (!asOf || this.clock().getTime() - Date.parse(asOf) > 7 * 86400_000 || Date.parse(asOf) > this.clock().getTime() + 86400_000) throw new Error("exchange_rates_stale");
      const values = { EUR: 1 };
      for (const match of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g)) if (Number(match[2]) > 0) values[match[1]] = Number(match[2]);
      this.cache = { values, asOf, loadedAt: this.clock().getTime() };
    }
    const { values, asOf } = this.cache;
    return [...new Set(fromCurrencies)].filter(from => values[from] && values[to]).map(from => ({ from, to, rate: values[to] / values[from], source: "ECB", asOf }));
  }
}
