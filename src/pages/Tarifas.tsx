import { useEffect, useState, type FormEvent } from 'react';
import { BackToPanel } from '../components/ui/BackToPanel';
import { saveReceptionRates, subscribeReceptionRates } from '../services/receptionStore';
import {
  EXTRA_LABELS, ROOM_TYPE_LABELS, SELECTABLE_ROOM_TYPES, WEEKDAYS,
  emptyReceptionRateSettings, type ExtraType, type ReceptionRateSettings, type RoomType, type WeekdayKey,
} from '../types/reception';
import './financeiro/financeiro.css';
import './tarifas.css';

const ROOM_TYPES: RoomType[] = [...SELECTABLE_ROOM_TYPES, 'triplo'];
const ADD_ON_FIELDS: { key: 'breakfast' | ExtraType; label: string; unit: string }[] = [
  { key: 'breakfast', label: 'Café da manhã', unit: 'por pessoa e por noite' },
  { key: 'cama_extra', label: 'Colchão / cama extra', unit: 'por noite' },
  { key: 'hospede_extra', label: 'Hóspede extra', unit: 'por noite' },
  { key: 'checkin_antecipado', label: EXTRA_LABELS.checkin_antecipado, unit: 'valor único' },
  { key: 'checkout_tardio', label: EXTRA_LABELS.checkout_tardio, unit: 'valor único' },
];
const WEEKEND_DAYS: WeekdayKey[] = ['friday', 'saturday', 'sunday'];
const WEEKDAY_DAYS: WeekdayKey[] = ['monday', 'tuesday', 'wednesday', 'thursday'];
const amountString = (value: number | undefined) => value === undefined ? '' : String(value).replace('.', ',');
const parseAmount = (value: string) => {
  if (!value.trim()) return undefined;
  const amount = Number(value.replace(',', '.'));
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : undefined;
};

type RateDayKey = WeekdayKey | 'holiday';
const RATE_DAY_KEYS: RateDayKey[] = [...WEEKDAYS.map(({ key }) => key), 'holiday'];
type DraftRates = Record<RoomType, Record<RateDayKey, string>>;
type DraftAddOns = Record<'breakfast' | ExtraType, string>;
type DraftPresets = Record<RoomType, { weekday: string; weekend: string }>;

function settingsToDraft(settings: ReceptionRateSettings): { rates: DraftRates; addOns: DraftAddOns; holidays: Record<string, string> } {
  const rates = Object.fromEntries(ROOM_TYPES.map((type) => [type, Object.fromEntries(RATE_DAY_KEYS.map((key) => [key, amountString(settings.roomRates[type]?.[key])]))])) as DraftRates;
  const addOns = Object.fromEntries(ADD_ON_FIELDS.map(({ key }) => [key, amountString(settings.addOnRates[key])])) as DraftAddOns;
  return { rates, addOns, holidays: { ...settings.holidays } };
}

function draftToSettings(rates: DraftRates, addOns: DraftAddOns, holidays: Record<string, string>): ReceptionRateSettings {
  const roomRates: ReceptionRateSettings['roomRates'] = {};
  ROOM_TYPES.forEach((type) => {
    const values = Object.fromEntries(RATE_DAY_KEYS.flatMap((key) => {
      const value = parseAmount(rates[type][key]);
      return value === undefined ? [] : [[key, value]];
    }));
    if (Object.keys(values).length) roomRates[type] = values;
  });
  const addOnRates: ReceptionRateSettings['addOnRates'] = {};
  ADD_ON_FIELDS.forEach(({ key }) => {
    const value = parseAmount(addOns[key]);
    if (value !== undefined) addOnRates[key] = value;
  });
  return { roomRates, addOnRates, holidays: Object.fromEntries(Object.entries(holidays).map(([date, label]) => [date, label.trim()])) };
}

export function Tarifas() {
  const [rates, setRates] = useState<DraftRates>(() => settingsToDraft(emptyReceptionRateSettings()).rates);
  const [addOns, setAddOns] = useState<DraftAddOns>(() => settingsToDraft(emptyReceptionRateSettings()).addOns);
  const [holidays, setHolidays] = useState<Record<string, string>>({});
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayLabel, setNewHolidayLabel] = useState('');
  const [presets, setPresets] = useState<DraftPresets>(() => Object.fromEntries(ROOM_TYPES.map((type) => [type, { weekday: '', weekend: '' }])) as DraftPresets);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => subscribeReceptionRates((settings) => {
    setLoaded(true);
    if (dirty) return;
    const draft = settingsToDraft(settings);
    setRates(draft.rates);
    setAddOns(draft.addOns);
    setHolidays(draft.holidays);
  }, (cause) => {
    setLoaded(true);
    setError(`Não foi possível carregar as tarifas: ${cause.message}`);
  }), [dirty]);

  function changeRate(type: RoomType, day: RateDayKey, value: string) {
    setDirty(true);
    setRates((current) => ({ ...current, [type]: { ...current[type], [day]: value } }));
  }

  function applyGroup(type: RoomType, days: WeekdayKey[], value: string) {
    setDirty(true);
    setRates((current) => ({ ...current, [type]: { ...current[type], ...Object.fromEntries(days.map((day) => [day, value])) } }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    for (const type of ROOM_TYPES) {
      for (const { key, label } of [...WEEKDAYS, { key: 'holiday' as const, label: 'feriado' }]) {
        if (rates[type][key].trim() && parseAmount(rates[type][key]) === undefined) {
          setError(`Informe um valor válido para ${ROOM_TYPE_LABELS[type]} na ${label.toLocaleLowerCase('pt-BR')}.`);
          return;
        }
      }
    }
    for (const { key, label } of ADD_ON_FIELDS) {
      if (addOns[key].trim() && parseAmount(addOns[key]) === undefined) {
        setError(`Informe um valor válido para ${label.toLocaleLowerCase('pt-BR')}.`);
        return;
      }
    }
    if (Object.values(holidays).some((label) => !label.trim())) {
      setError('Informe o nome de cada feriado cadastrado.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const settings = draftToSettings(rates, addOns, holidays);
      await saveReceptionRates(settings);
      const draft = settingsToDraft(settings);
      setRates(draft.rates);
      setAddOns(draft.addOns);
      setHolidays(draft.holidays);
      setDirty(false);
      setNotice('Tarifas e valores dos adicionais atualizados.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar as tarifas.');
    } finally {
      setSaving(false);
    }
  }

  return <main className="finance-page rates-page"><div className="finance-content">
    <BackToPanel />
    <h1>Tarifas dos quartos</h1>
    <p>Cadastre valores de referência por tipo de quarto, dia da semana e feriado. No cadastro do hóspede, o valor total das diárias será informado manualmente.</p>
    {error && <p role="alert" className="rates-alert">{error}</p>}
    {notice && <p role="status" className="rates-notice">{notice}</p>}
    <form onSubmit={(event) => void save(event)}>
      {!loaded && <p role="status">Carregando tarifas salvas…</p>}
      <section className="finance-panel rates-panel">
        <h2>Diárias por tipo de quarto</h2>
        <p className="rates-help">Use os atalhos para preencher segunda a quinta e sexta a domingo. Depois, edite qualquer dia ou a tarifa de feriado individualmente.</p>
        <div className="rates-room-list">{ROOM_TYPES.map((type) => <article className="rates-room-card" key={type}>
          <h3>{ROOM_TYPE_LABELS[type]}</h3>
          <div className="rates-presets">
            <label>Preço de segunda a quinta (R$)<input inputMode="decimal" placeholder="Ex.: 180,00" onChange={(event) => { setDirty(true); setPresets((current) => ({ ...current, [type]: { ...current[type], weekday: event.target.value } })); }} value={presets[type].weekday} /></label>
            <button type="button" onClick={() => applyGroup(type, WEEKDAY_DAYS, presets[type].weekday)}>Aplicar seg. a qui.</button>
            <label>Preço de sexta a domingo (R$)<input inputMode="decimal" placeholder="Ex.: 240,00" onChange={(event) => { setDirty(true); setPresets((current) => ({ ...current, [type]: { ...current[type], weekend: event.target.value } })); }} value={presets[type].weekend} /></label>
            <button type="button" onClick={() => applyGroup(type, WEEKEND_DAYS, presets[type].weekend)}>Aplicar sex. a dom.</button>
          </div>
          <div className="rates-week-grid">{WEEKDAYS.map(({ key, label }) => <label key={key}>{label}<span className="rates-money-input"><span>R$</span><input aria-label={`${label}, ${ROOM_TYPE_LABELS[type]}`} inputMode="decimal" placeholder="Sem tarifa" value={rates[type][key]} onChange={(event) => changeRate(type, key, event.target.value)} /></span></label>)}<label>Feriado<span className="rates-money-input"><span>R$</span><input aria-label={`Feriado, ${ROOM_TYPE_LABELS[type]}`} inputMode="decimal" placeholder="Sem tarifa" value={rates[type].holiday} onChange={(event) => changeRate(type, 'holiday', event.target.value)} /></span></label></div>
        </article>)}</div>
      </section>
      <section className="finance-panel rates-panel">
        <h2>Feriados</h2>
        <p className="rates-help">Cadastre as datas de feriado que devem usar a tarifa especial. O preço de feriado tem prioridade sobre o dia da semana e o fim de semana.</p>
        <div className="rates-holiday-form"><label>Data<input type="date" value={newHolidayDate} onChange={(event) => setNewHolidayDate(event.target.value)} /></label><label>Nome do feriado<input value={newHolidayLabel} onChange={(event) => setNewHolidayLabel(event.target.value)} maxLength={80} placeholder="Ex.: Independência" /></label><button type="button" onClick={() => {
          if (!newHolidayDate || !newHolidayLabel.trim()) { setError('Informe a data e o nome do feriado.'); return; }
          setDirty(true);
          setHolidays((current) => ({ ...current, [newHolidayDate]: newHolidayLabel.trim() }));
          setNewHolidayDate(''); setNewHolidayLabel(''); setError('');
        }}>Adicionar feriado</button></div>
        {Object.keys(holidays).length === 0 ? <p className="rates-empty">Nenhuma data de feriado cadastrada.</p> : <ul className="rates-holiday-list">{Object.entries(holidays).sort(([a], [b]) => a.localeCompare(b)).map(([date, label]) => <li key={date}><time dateTime={date}>{new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR')}</time><input aria-label={`Nome do feriado em ${date}`} value={label} onChange={(event) => { setDirty(true); setHolidays((current) => ({ ...current, [date]: event.target.value })); }} /><button type="button" onClick={() => { setDirty(true); setHolidays((current) => { const next = { ...current }; delete next[date]; return next; }); }}>Remover</button></li>)}</ul>}
      </section>
      <section className="finance-panel rates-panel">
        <h2>Valores padrão dos adicionais</h2>
        <p className="rates-help">A recepção pode alterar esses valores ao cadastrar o hóspede. Campos vazios não sugerem preço.</p>
        <div className="rates-addons">{ADD_ON_FIELDS.map(({ key, label, unit }) => <label key={key}>{label}<small>{unit}</small><span className="rates-money-input"><span>R$</span><input inputMode="decimal" placeholder="Sem valor padrão" value={addOns[key]} onChange={(event) => { setDirty(true); setAddOns((current) => ({ ...current, [key]: event.target.value })); }} /></span></label>)}</div>
      </section>
      <button className="rates-save" type="submit" disabled={!loaded || saving}>{saving ? 'Salvando…' : 'Salvar tarifas'}</button>
    </form>
  </div></main>;
}
