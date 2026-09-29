

export type CardBrand =
  | "visa"
  | "mastercard"
  | "american-express"
  | "discover"
  | "jcb"
  | "diners-club"
  | "unionpay"
  | "unknown";

export interface CardValidationResult {
  valid: boolean;
  brand: CardBrand;
  luhnValid: boolean;
  formatValid: boolean;
  expiryValid?: boolean;
  cvvValid?: boolean;
  error?: string;
}


export function validateLuhn(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, "");
  if (digits.length < 2) return false;

  let sum = 0;
  let shouldDouble = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}


export function detectCardBrand(cardNumber: string): CardBrand {
  const clean = cardNumber.replace(/\D/g, "");
  if (!clean) return "unknown";

  // Visa: 4...
  if (/^4/.test(clean)) return "visa";

  // Mastercard: 51-55 or 2221-2720
  if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)/.test(clean)) {
    return "mastercard";
  }

  // American Express: 34 or 37
  if (/^3[47]/.test(clean)) return "american-express";

  // Diners Club: 300-305, 36, 38
  if (/^3(0[0-5]|[68])/.test(clean)) return "diners-club";

  // JCB: 3528-3589
  if (/^35(2[89]|[3-8]\d)/.test(clean)) return "jcb";

  // Discover: 6011, 622126-622925, 644-649, 65
  if (/^(6011|65|64[4-9]|622(12[6-9]|1[3-9]\d|[2-8]\d{2}|9[01]\d|92[0-5]))/.test(clean)) {
    return "discover";
  }

  // UnionPay: 62
  if (/^62/.test(clean)) return "unionpay";

  return "unknown";
}


export function validateCardExpiry(month: number, year: number): boolean {
  if (!month || month < 1 || month > 12) return false;
  const fullYear = year < 100 ? 2000 + year : year;
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  if (fullYear < curYear || fullYear > curYear + 30) return false;
  if (fullYear === curYear && month < curMonth) return false;
  return true;
}


export function validateCardCvv(cvv: string, brand?: CardBrand): boolean {
  const digits = cvv.trim();
  if (brand === "american-express") {
    return /^\d{4}$/.test(digits);
  }
  return /^\d{3,4}$/.test(digits);
}


export function validatePaymentCard(input: {
  number: string;
  expirationMonth?: number;
  expirationYear?: number;
  securityCode?: string;
}): CardValidationResult {
  const cleanNumber = input.number.replace(/\D/g, "");
  const brand = detectCardBrand(cleanNumber);
  const luhn = validateLuhn(cleanNumber);

  let formatValid = cleanNumber.length >= 12 && cleanNumber.length <= 19;
  if (brand === "american-express" && cleanNumber.length !== 15) formatValid = false;
  if ((brand === "visa" || brand === "mastercard") && cleanNumber.length !== 16 && cleanNumber.length !== 13 && cleanNumber.length !== 19) {
    formatValid = false;
  }

  let expiryValid: boolean | undefined;
  if (input.expirationMonth !== undefined && input.expirationYear !== undefined) {
    expiryValid = validateCardExpiry(input.expirationMonth, input.expirationYear);
  }

  let cvvValid: boolean | undefined;
  if (input.securityCode !== undefined) {
    cvvValid = validateCardCvv(input.securityCode, brand);
  }

  const valid = luhn && formatValid && (expiryValid === undefined || expiryValid) && (cvvValid === undefined || cvvValid);

  let error: string | undefined;
  if (!formatValid) error = "invalid_card_length";
  else if (!luhn) error = "invalid_card_luhn";
  else if (expiryValid === false) error = "expired_or_invalid_date";
  else if (cvvValid === false) error = "invalid_security_code";

  return {
    valid,
    brand,
    luhnValid: luhn,
    formatValid,
    expiryValid,
    cvvValid,
    error,
  };
}
