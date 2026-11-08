const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

// Teto de 10 dígitos (R$ 99.999.999,99) evita valores absurdos por teclas presas.
const MAX_DIGITS = 10;
const MAX_AMOUNT = Number('9'.repeat(MAX_DIGITS)) / 100;

export const formatBRL = (value: number): string => currency.format(Number.isFinite(value) ? value : 0);

// Máscara por centavos: cada dígito digitado entra pela direita ("215050" vira 2.150,50).
export function moneyFromDigits(text: string): number {
  const digits = text.replace(/\D/g, '').slice(0, MAX_DIGITS);
  return digits ? Number(digits) / 100 : 0;
}

// Lê valores colados em formatos brasileiros ("1.234,56") e internacionais ("1234.56").
export function parseMoneyText(text: string): number | null {
  const cleaned = text.replace(/[^\d.,]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? cleaned.replaceAll('.', '').replace(',', '.') : cleaned.replaceAll(',', '');
  } else if (lastComma >= 0) {
    normalized = cleaned.replaceAll('.', '').replace(',', '.');
  } else if (lastDot >= 0) {
    const parts = cleaned.split('.');
    normalized = parts.length === 2 && parts[1].length <= 2 ? cleaned : parts.join('');
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value * 100) / 100, MAX_AMOUNT) : null;
}
