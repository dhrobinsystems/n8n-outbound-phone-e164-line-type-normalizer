/**
 * Dependency-free phone parser that produces strict E.164 (+<country code><national number>, at most 15 digits).
 *
 * It recognises international input (+, 00, and 011 from North America), national input with
 * trunk prefixes, the "(0)" convention, extensions and multi-number fields. It validates
 * national-number lengths per country and North American Numbering Plan structure, and it
 * detects reserved fictional ranges (NANP 555-01XX, Ofcom drama numbers, ACMA fictional numbers).
 * It decides format validity only; line type comes from the carrier lookup.
 */

/** iso: [callingCode, trunkPrefix ('' when none), minNationalLength, maxNationalLength] */
const COUNTRY_TABLE = {
  US: ['1', '1', 10, 10], CA: ['1', '1', 10, 10], PR: ['1', '1', 10, 10],
  GB: ['44', '0', 9, 10], IE: ['353', '0', 7, 9], DE: ['49', '0', 6, 13], FR: ['33', '0', 9, 9],
  ES: ['34', '', 9, 9], IT: ['39', '', 6, 11], NL: ['31', '0', 9, 9], BE: ['32', '0', 8, 9],
  CH: ['41', '0', 9, 9], AT: ['43', '0', 4, 13], SE: ['46', '0', 7, 9], NO: ['47', '', 8, 8],
  DK: ['45', '', 8, 8], FI: ['358', '0', 5, 12], PL: ['48', '', 9, 9], PT: ['351', '', 9, 9],
  AU: ['61', '0', 9, 9], NZ: ['64', '0', 8, 10], IN: ['91', '0', 10, 10], SG: ['65', '', 8, 8],
  HK: ['852', '', 8, 8], JP: ['81', '0', 9, 10], CN: ['86', '0', 10, 11], BR: ['55', '0', 10, 11],
  MX: ['52', '', 10, 10], ZA: ['27', '0', 9, 9], AE: ['971', '0', 8, 9], BD: ['880', '0', 10, 10],
  PH: ['63', '0', 10, 10], IL: ['972', '0', 8, 9],
};

export const SUPPORTED_COUNTRIES = Object.freeze(Object.keys(COUNTRY_TABLE));
export const NANP_COUNTRIES = Object.freeze(['US', 'CA', 'PR']);

const CALLING_CODES = {};
for (const [iso, [code]] of Object.entries(COUNTRY_TABLE)) (CALLING_CODES[code] || (CALLING_CODES[code] = [])).push(iso);

const COUNTRY_ALIASES = {
  'united states': 'US', 'united states of america': 'US', usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', america: 'US',
  canada: 'CA', 'puerto rico': 'PR',
  'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  ireland: 'IE', germany: 'DE', deutschland: 'DE', france: 'FR', spain: 'ES', espana: 'ES', italy: 'IT', italia: 'IT',
  netherlands: 'NL', 'the netherlands': 'NL', holland: 'NL', belgium: 'BE', switzerland: 'CH', austria: 'AT', sweden: 'SE',
  norway: 'NO', denmark: 'DK', finland: 'FI', poland: 'PL', portugal: 'PT', australia: 'AU', 'new zealand': 'NZ',
  india: 'IN', singapore: 'SG', 'hong kong': 'HK', japan: 'JP', china: 'CN', brazil: 'BR', brasil: 'BR', mexico: 'MX',
  'south africa': 'ZA', 'united arab emirates': 'AE', uae: 'AE', bangladesh: 'BD', philippines: 'PH', israel: 'IL',
};

export function countryInfo(iso) {
  const row = COUNTRY_TABLE[iso];
  return row ? { iso, callingCode: row[0], trunkPrefix: row[1], minLength: row[2], maxLength: row[3], nanp: NANP_COUNTRIES.includes(iso) } : null;
}

/** Accepts ISO codes ("gb"), names ("United Kingdom") and common aliases. Returns an ISO code or null. */
export function resolveCountry(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper === 'UK') return 'GB';
  if (COUNTRY_TABLE[upper]) return upper;
  return COUNTRY_ALIASES[text.toLowerCase()] || null;
}

/** Reserved fictional ranges. Real systems should never dial or text these. */
export function isFictionalNumber(callingCode, national) {
  if (callingCode === '1') return /^\d{3}55501\d{2}$/.test(national);
  if (callingCode === '44') return /^(?:7700900\d{3}|2079460\d{3}|1632960\d{3}|1134960\d{3}|1214960\d{3}|1314960\d{3}|1414960\d{3}|1514960\d{3}|1614960\d{3}|1914960\d{3}|1174960\d{3})$/.test(national);
  if (callingCode === '61') return /^(?:491570(?:006|156|157|158|159|110|313|737|810)|25550\d{4}|37010\d{4}|75550\d{4}|87010\d{4})$/.test(national);
  return false;
}

function validateNanp(national) {
  if (!/^\d{10}$/.test(national)) return 'wrong_length';
  const area = national.slice(0, 3);
  const exchange = national.slice(3, 6);
  if (!/^[2-9]/.test(area)) return 'invalid_area_code';
  if (/^[2-9]11$/.test(area)) return 'invalid_area_code';
  if (!/^[2-9]/.test(exchange)) return 'invalid_exchange';
  if (/^[2-9]11$/.test(exchange)) return 'invalid_exchange';
  return null;
}

function validateNational(info, national) {
  if (info.nanp) return validateNanp(national);
  if (national.length < info.minLength) return 'too_short';
  if (national.length > info.maxLength) return 'too_long';
  if (/^0/.test(national) && info.trunkPrefix === '0') return 'unexpected_trunk_prefix';
  return null;
}

function matchCallingCode(digits) {
  for (const length of [1, 2, 3]) {
    const code = digits.slice(0, length);
    if (CALLING_CODES[code]) return code;
  }
  return null;
}

function pickIso(code, hint) {
  const candidates = CALLING_CODES[code] || [];
  if (hint && candidates.includes(hint)) return hint;
  return candidates[0] || null;
}

function parseResult(input, fields) {
  return { input, status: 'invalid', e164: null, countryIso: null, callingCode: null, nationalNumber: null, extension: null, issues: [], ...fields };
}

function finish(input, info, national, extension, issues) {
  const reason = validateNational(info, national);
  if (reason) return parseResult(input, { reason, countryIso: info.iso, callingCode: info.callingCode, extension, issues });
  const e164 = `+${info.callingCode}${national}`;
  if (e164.length - 1 > 15) return parseResult(input, { reason: 'too_long', extension, issues });
  const fictional = isFictionalNumber(info.callingCode, national);
  return parseResult(input, {
    status: fictional ? 'fictional' : 'valid',
    reason: fictional ? 'reserved_fictional_range' : null,
    e164,
    countryIso: info.iso,
    callingCode: info.callingCode,
    nationalNumber: national,
    extension,
    issues,
  });
}

function parseInternational(input, digits, hintIso, extension, issues) {
  const code = matchCallingCode(digits);
  if (!code) {
    if (digits.length >= 8 && digits.length <= 15) {
      return parseResult(input, { status: 'valid', e164: `+${digits}`, extension, issues: [...issues, 'unrecognised_country_code'], reason: null });
    }
    return parseResult(input, { reason: digits.length > 15 ? 'too_long' : 'too_short', extension, issues });
  }
  const info = countryInfo(pickIso(code, hintIso));
  let national = digits.slice(code.length);
  if (info.trunkPrefix === '0' && national.startsWith('0') && national.length - 1 >= info.minLength) {
    national = national.slice(1);
    issues.push('trunk_prefix_in_international_format');
  }
  return finish(input, info, national, extension, issues);
}

/**
 * normalizePhone("(555) 555-0100", { defaultCountry: "US" })
 *   → { status: "fictional", e164: "+15555550100", countryIso: "US", ... }
 * Status is one of valid, fictional, invalid, missing.
 */
export function normalizePhone(raw, { defaultCountry = 'US', countryHint = null } = {}) {
  const input = raw === undefined || raw === null ? '' : String(raw);
  let text = input.trim();
  if (!text) return parseResult(input, { status: 'missing', reason: 'empty' });
  const issues = [];
  text = text.replace(/^tel:/i, '').replace(/[  -​‐-―−]/g, (char) => (/[‐-―−]/.test(char) ? '-' : ' ')).replace(/^＋/, '+');

  let extension = null;
  const extensionMatch = text.match(/[,;]?\s*(?:ext\.?|extension|x|#)\s*(\d{1,6})\s*$/i);
  if (extensionMatch && /\d/.test(text.slice(0, extensionMatch.index))) {
    extension = extensionMatch[1];
    text = text.slice(0, extensionMatch.index).trim();
  }

  const segments = text.split(/\s*(?:[,;|]|\s\/\s|\bor\b|\band\b)\s*/i).filter((segment) => (segment.match(/\d/g) || []).length >= 7);
  if (segments.length > 1) {
    text = segments[0];
    issues.push('multiple_numbers_in_field');
  }

  if (/[a-z]/i.test(text)) return parseResult(input, { reason: 'contains_letters', extension, issues });
  if (!/^[\d\s\-.()+/]+$/.test(text)) return parseResult(input, { reason: 'invalid_characters', extension, issues });
  if (text.indexOf('+') > 0 || (text.match(/\+/g) || []).length > 1) return parseResult(input, { reason: 'misplaced_plus', extension, issues });

  const hintIso = resolveCountry(countryHint);
  const homeIso = hintIso || resolveCountry(defaultCountry) || 'US';
  const home = countryInfo(homeIso) || countryInfo('US');

  const international = text.startsWith('+');
  if (international) text = text.replace(/\(\s*0\s*\)/, ' ');
  let digits = text.replace(/\D/g, '');
  if (!digits) return parseResult(input, { reason: 'no_digits', extension, issues });

  if (international) return parseInternational(input, digits, hintIso, extension, issues);
  if (digits.startsWith('00')) return parseInternational(input, digits.slice(2), hintIso, extension, issues);
  if (home.nanp && digits.startsWith('011')) return parseInternational(input, digits.slice(3), hintIso, extension, issues);
  text = text.replace(/\(\s*0\s*\)/, '0');
  digits = text.replace(/\D/g, '');

  let national = digits;
  if (home.nanp) {
    if (national.length === 11 && national.startsWith('1')) national = national.slice(1);
  } else if (home.trunkPrefix && national.startsWith(home.trunkPrefix)) {
    national = national.slice(home.trunkPrefix.length);
  }
  const attempt = finish(input, home, national, extension, [...issues]);
  if (attempt.status !== 'invalid') return attempt;

  // Fallback: an international number typed without "+" or "00" (for example 447700900123).
  if (!home.nanp || digits.length > 11) {
    const code = matchCallingCode(digits);
    if (code && digits.length >= 8) {
      const fallback = parseInternational(input, digits, hintIso, extension, [...issues, 'missing_international_prefix']);
      if (fallback.status !== 'invalid') return fallback;
    }
  }
  return attempt;
}

/** For logs: keeps the country code and last four digits only. */
export function maskPhone(e164OrRaw) {
  if (!e164OrRaw) return null;
  const text = String(e164OrRaw);
  const digits = text.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  const code = text.startsWith('+') ? `+${matchCallingCode(digits) || digits.slice(0, 1)}` : '';
  const tail = digits.slice(-4);
  return `${code}${code ? ' ' : ''}${'*'.repeat(Math.max(2, digits.length - tail.length - (code ? code.length - 1 : 0)))}${tail}`;
}
