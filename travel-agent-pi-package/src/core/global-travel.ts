/** Region, money and wall-clock rules shared by every host and provider. */
export interface DestinationContext {
  countryCode: string;
  timeZone: string;
  localCurrency?: string;
  languageCode?: string;
}
export interface Money { amount: number; currency: string }
export interface ExchangeRate { from: string; to: string; rate: number; source: string; asOf: string }

export function countryCode(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}
export function destinationContext(brief: Record<string, unknown> = {}): Partial<DestinationContext> {
  const nested = brief.destinationContext && typeof brief.destinationContext === "object" ? brief.destinationContext as Record<string, unknown> : {};
  const code = countryCode(nested.countryCode ?? brief.countryCode);
  const zone = nested.timeZone ?? brief.timeZone;
  const currency = String(nested.localCurrency ?? "").toUpperCase();
  return { ...(code ? { countryCode: code } : {}), ...(validTimeZone(zone) ? { timeZone: zone } : {}),
    ...(/^[A-Z]{3}$/.test(currency) ? { localCurrency: currency } : {}) };
}

function localParts(instant: number, zone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instant).map(p => [p.type, p.value]));
}
function wallValue(instant: number, zone: string): number {
  const p = localParts(instant, zone);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}
export function zonedIso(value: string | number, timeZone: string): string {
  if (!validTimeZone(timeZone)) throw new Error("time_zone_required");
  const instant = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error("invalid_date_time");
  const p = localParts(instant, timeZone);
  const offset = Math.round((wallValue(instant, timeZone) - Math.floor(instant / 1000) * 1000) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const minutes = Math.abs(offset);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Reject nonexistent/ambiguous DST wall times; an explicit UTC offset resolves ambiguity. */
export function localDateTime(value: unknown, date: string | null, timeZone: string): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:?\d\d)$/.test(raw)) {
    const instant = Date.parse(raw.replace(" ", "T"));
    return Number.isFinite(instant) ? zonedIso(instant, timeZone) : null;
  }
  const wall = /^\d{1,2}:\d\d$/.test(raw) && date ? `${date}T${raw.padStart(5, "0")}:00` : raw.replace(" ", "T");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(wall) || !validTimeZone(timeZone)) return null;
  const wanted = Date.parse(`${wall.length === 16 ? `${wall}:00` : wall}Z`);
  if (!Number.isFinite(wanted)) return null;
  const offsets = new Set([-36, -12, 0, 12, 36].map(h => {
    const probe = wanted + h * 3600_000;
    return wallValue(probe, timeZone) - probe;
  }));
  const matches = [...offsets].map(offset => wanted - offset).filter(t => wallValue(t, timeZone) === wanted);
  if (matches.length !== 1) return null;
  return zonedIso(matches[0]!, timeZone);
}

export function convertMoney(money: Money, to: string, rates: ExchangeRate[] = []): (Money & { conversion?: ExchangeRate }) | null {
  if (!Number.isFinite(money.amount) || money.amount < 0 || !/^[A-Z]{3}$/.test(money.currency) || !/^[A-Z]{3}$/.test(to)) return null;
  if (money.currency === to) return { ...money };
  const rate = rates.find(r => r.from === money.currency && r.to === to && r.rate > 0 && Number.isFinite(r.rate) && r.source && Number.isFinite(Date.parse(r.asOf)));
  return rate ? { amount: Math.round(money.amount * rate.rate * 100) / 100, currency: to, conversion: rate } : null;
}

export function providerCoversRegion(provider: { regions?: string[]; legacyCountryCode?: string }, country: string | null): boolean {
  if (!provider.regions) return true; // Existing explicit local providers keep their legacy contract.
  if (!country) return provider.legacyCountryCode === "CN";
  return provider.regions.includes(country) || (provider.regions.includes("international") && country !== "CN") || provider.regions.includes("global");
}
