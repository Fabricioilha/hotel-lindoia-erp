/** Hotel operational day: 07:00 through 06:59:59 of the following day. */
export function cashShiftDate(timestamp: string | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('Data inválida no movimento de caixa.');
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  const day = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
  if (Number(part('hour')) < 7) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
