import { useEffect, useState, type FormEvent } from 'react';
import { BackToPanel } from '../components/ui/BackToPanel';
import { saveReceptionRates, subscribeReceptionRates } from '../services/receptionStore';
import { subscribeRoomCategories } from '../services/housekeepingStore';
import {
  EXTRA_LABELS, WEEKDAYS,
  emptyReceptionRateSettings, type ExtraType, type ReceptionRateSettings, type WeekdayKey,
} from '../types/reception';
import { roomCategoryGuestCounts, type RoomCategoryRecord } from '../types/housekeeping';
import './financeiro/financeiro.css';
import './tarifas.css';

const ADD_ON_FIELDS: { key: 'breakfast' | ExtraType; label: string; unit: string }[] = [
  { key: 'breakfast', label: 'Café da manhã', unit: 'por pessoa e por noite' },
  { key: 'cama_extra', label: 'Colchão / cama extra', unit: 'por noite' },
  { key: 'hospede_extra', label: 'Hóspede extra', unit: 'por noite' },
  { key: 'checkin_antecipado', label: EXTRA_LABELS.checkin_antecipado, unit: 'valor único' },
  { key: 'checkout_tardio', label: EXTRA_LABELS.checkout_tardio, unit: 'valor único' },
];
const WEEKEND_DAYS: WeekdayKey[] = ['friday', 'saturday'];
const SUNDAY_THROUGH_THURSDAY_DAYS: WeekdayKey[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday'];
const amountString = (value: number | undefined) => value === undefined ? '' : String(value).replace('.', ',');
const parseAmount = (value: string) => {
  if (!value.trim()) return undefined;
  const amount = Number(value.replace(',', '.'));
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : undefined;
};

type RateDayKey = WeekdayKey | 'holidayWeekday' | 'holidayWeekend';
const RATE_DAY_KEYS: RateDayKey[] = [...WEEKDAYS.map(({ key }) => key), 'holidayWeekday', 'holidayWeekend'];
type DraftRates = Record<string, Record<number, Record<RateDayKey, string>>>;
type DraftAddOns = Record<'breakfast' | ExtraType, string>;
type DraftPresets = Record<string, Record<number, { weekday: string; weekend: string }>>;

function settingsToDraft(settings: ReceptionRateSettings, categories: RoomCategoryRecord[]): { rates: DraftRates; addOns: DraftAddOns; holidays: Record<string, string> } {
  const rates = Object.fromEntries(categories.map((category) => {
    const guestCounts = roomCategoryGuestCounts(category);
    const maximumGuests = guestCounts.at(-1) ?? 1;
    return [category.id, Object.fromEntries(guestCounts.map((guestCount) => [
      guestCount,
      Object.fromEntries(RATE_DAY_KEYS.map((key) => {
        const configuredRates = settings.roomRatesByGuests?.[category.id]?.[guestCount];
        const configuredRate = configuredRates?.[key]
          ?? (key === 'holidayWeekday' || key === 'holidayWeekend' ? configuredRates?.holiday : undefined);
        const legacyRates = settings.roomRates[category.id];
        const legacyRate = guestCount === maximumGuests
          ? legacyRates?.[key] ?? (key === 'holidayWeekday' || key === 'holidayWeekend' ? legacyRates?.holiday : undefined)
          : undefined;
        return [key, amountString(configuredRate ?? legacyRate)];
      })),
    ]))];
  })) as DraftRates;
  const addOns = Object.fromEntries(ADD_ON_FIELDS.map(({ key }) => [key, amountString(settings.addOnRates[key])])) as DraftAddOns;
  return { rates, addOns, holidays: { ...settings.holidays } };
}

function draftToSettings(
  rates: DraftRates,
  addOns: DraftAddOns,
  holidays: Record<string, string>,
  previousSettings: ReceptionRateSettings,
  categories: RoomCategoryRecord[],
): ReceptionRateSettings {
  const roomRates = { ...previousSettings.roomRates };
  const roomRatesByGuests: NonNullable<ReceptionRateSettings['roomRatesByGuests']> = Object.fromEntries(
    Object.entries(previousSettings.roomRatesByGuests ?? {}).map(([categoryId, guestRates]) => [categoryId, { ...guestRates }]),
  );
  categories.forEach((category) => {
    const categoryRates = { ...(roomRatesByGuests[category.id] ?? {}) };
    roomCategoryGuestCounts(category).forEach((guestCount) => {
      const values = Object.fromEntries(RATE_DAY_KEYS.flatMap((key) => {
        const value = parseAmount(rates[category.id]?.[guestCount]?.[key] ?? '');
        return value === undefined ? [] : [[key, value]];
      }));
      if (Object.keys(values).length) categoryRates[guestCount] = values;
      else delete categoryRates[guestCount];
    });
    if (Object.keys(categoryRates).length) roomRatesByGuests[category.id] = categoryRates;
    else delete roomRatesByGuests[category.id];
    // Move managed categories away from the old single-price format.
    delete roomRates[category.id];
  });
  const addOnRates: ReceptionRateSettings['addOnRates'] = {};
  ADD_ON_FIELDS.forEach(({ key }) => {
    const value = parseAmount(addOns[key]);
    if (value !== undefined) addOnRates[key] = value;
  });
  return {
    roomRates,
    roomRatesByGuests,
    addOnRates,
    holidays: Object.fromEntries(Object.entries(holidays).map(([date, label]) => [date, label.trim()])),
  };
}

type SheetRateGroup = 'solteiro' | 'casal' | 'twin' | 'triplo';
type SheetRateProfile = Record<'weekday' | 'weekend' | 'holidayWeekday' | 'holidayWeekend', Partial<Record<number, number>>>;

const SHEET_RATE_PROFILES: Record<SheetRateGroup, SheetRateProfile> = {
  solteiro: {
    weekday: { 1: 140 }, weekend: { 1: 170 },
    holidayWeekday: { 1: 160 }, holidayWeekend: { 1: 240 },
  },
  casal: {
    weekday: { 1: 160, 2: 185 }, weekend: { 1: 190, 2: 230 },
    holidayWeekday: { 1: 180, 2: 220 }, holidayWeekend: { 1: 290, 2: 320 },
  },
  twin: {
    weekday: { 1: 150, 2: 190 }, weekend: { 1: 200, 2: 240 },
    holidayWeekday: { 1: 190, 2: 230 }, holidayWeekend: { 1: 300, 2: 330 },
  },
  triplo: {
    weekday: { 1: 200, 2: 220, 3: 250 }, weekend: { 1: 250, 2: 270, 3: 300 },
    holidayWeekday: { 1: 240, 2: 260, 3: 290 }, holidayWeekend: { 1: 340, 2: 380, 3: 410 },
  },
};

function sheetRateGroup(category: RoomCategoryRecord): SheetRateGroup | undefined {
  const normalize = (value: string) => value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const identity = normalize(category.id + ' ' + category.name + ' ' + category.bedComposition);
  if (/twin|222|duas camas de solteiro|2 camas de solteiro/.test(identity)) return 'twin';
  if (/solteir|individual/.test(identity)) return 'solteiro';
  if (/triplo|triple/.test(identity)) return 'triplo';
  if (/casal|queen|king|matrimonial/.test(identity)) return 'casal';
  return undefined;
}

function applyPrintedRates(current: DraftRates, categories: RoomCategoryRecord[]) {
  const rates: DraftRates = { ...current };
  const matched: string[] = [];
  const matchedGroups = new Set<SheetRateGroup>();
  categories.forEach((category) => {
    const group = sheetRateGroup(category);
    if (!group) return;
    matched.push(category.name);
    matchedGroups.add(group);
    const profile = SHEET_RATE_PROFILES[group];
    const guestRates: Record<number, Record<RateDayKey, string>> = {};
    roomCategoryGuestCounts(category).forEach((guestCount) => {
      const weekday = amountString(profile.weekday[guestCount]);
      const weekend = amountString(profile.weekend[guestCount]);
      const holidayWeekday = amountString(profile.holidayWeekday[guestCount]);
      const holidayWeekend = amountString(profile.holidayWeekend[guestCount]);
      guestRates[guestCount] = {
        sunday: weekday, monday: weekday, tuesday: weekday, wednesday: weekday, thursday: weekday,
        friday: weekend, saturday: weekend, holidayWeekday, holidayWeekend,
      };
    });
    rates[category.id] = guestRates;
  });
  const missingGroups = (['solteiro', 'casal', 'twin', 'triplo'] as SheetRateGroup[]).filter((group) => !matchedGroups.has(group));
  return { rates, matched, missingGroups };
}

export function Tarifas() {
  const [categories, setCategories] = useState<RoomCategoryRecord[]>([]);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [settings, setSettings] = useState<ReceptionRateSettings>(() => emptyReceptionRateSettings());
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [rates, setRates] = useState<DraftRates>({});
  const [addOns, setAddOns] = useState<DraftAddOns>(() => settingsToDraft(emptyReceptionRateSettings(), []).addOns);
  const [holidays, setHolidays] = useState<Record<string, string>>({});
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayLabel, setNewHolidayLabel] = useState('');
  const [presets, setPresets] = useState<DraftPresets>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const loaded = categoriesLoaded && settingsLoaded;

  useEffect(() => subscribeRoomCategories((next) => {
    setCategories(next);
    setCategoriesLoaded(true);
  }, (cause) => {
    setCategoriesLoaded(true);
    setError(`Não foi possível carregar as categorias dos quartos: ${cause.message}`);
  }), []);

  useEffect(() => subscribeReceptionRates((next) => {
    setSettings(next);
    setSettingsLoaded(true);
  }, (cause) => {
    setSettingsLoaded(true);
    setError(`Não foi possível carregar as tarifas: ${cause.message}`);
  }), []);

  useEffect(() => {
    if (!loaded || dirty) return;
    const draft = settingsToDraft(settings, categories);
    setRates(draft.rates);
    setAddOns(draft.addOns);
    setHolidays(draft.holidays);
  }, [loaded, dirty, settings, categories]);

  function fillPrintedRates() {
    const result = applyPrintedRates(rates, categories);
    if (result.matched.length === 0) {
      setError('Não encontrei categorias Solteiro, Casal, Twin/222 ou Triplo para preencher.');
      setNotice('');
      return;
    }
    setRates(result.rates);
    setDirty(true);
    setError('');
    const missing = result.missingGroups.length ? ' Categorias não encontradas: ' + result.missingGroups.join(', ') + '.' : '';
    setNotice('Tabela aplicada às categorias: ' + result.matched.join(', ') + '.' + missing + ' Confira os valores e clique em Salvar tarifas.');
  }

  function changeRate(categoryId: string, guestCount: number, day: RateDayKey, value: string) {
    setDirty(true);
    setRates((current) => ({
      ...current,
      [categoryId]: {
        ...current[categoryId],
        [guestCount]: { ...current[categoryId]?.[guestCount], [day]: value },
      },
    }));
  }

  function applyGroup(categoryId: string, guestCount: number, days: WeekdayKey[], value: string) {
    setDirty(true);
    setRates((current) => ({
      ...current,
      [categoryId]: {
        ...current[categoryId],
        [guestCount]: { ...current[categoryId]?.[guestCount], ...Object.fromEntries(days.map((day) => [day, value])) },
      },
    }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    for (const category of categories) {
      for (const guestCount of roomCategoryGuestCounts(category)) {
        for (const { key, label } of [...WEEKDAYS, { key: 'holidayWeekday' as const, label: 'feriado de domingo a quinta' }, { key: 'holidayWeekend' as const, label: 'feriado de sexta e sábado' }]) {
          const value = rates[category.id]?.[guestCount]?.[key] ?? '';
          if (value.trim() && parseAmount(value) === undefined) {
            setError(`Informe um valor válido para ${category.name}, com ${guestCount} ${guestCount === 1 ? 'hóspede' : 'hóspedes'}, na ${label.toLocaleLowerCase('pt-BR')}.`);
            return;
          }
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
      const nextSettings = draftToSettings(rates, addOns, holidays, settings, categories);
      await saveReceptionRates(nextSettings);
      setSettings(nextSettings);
      const draft = settingsToDraft(nextSettings, categories);
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
    <p>Cadastre valores de referência por categoria, quantidade de hóspedes, dia da semana e feriado. Os preços da tabela base são sem café da manhã; configure o café separadamente em Valores padrão dos adicionais. No cadastro do hóspede, o valor total das diárias será informado manualmente.</p>
    {error && <p role="alert" className="rates-alert">{error}</p>}
    {notice && <p role="status" className="rates-notice">{notice}</p>}
    <form onSubmit={(event) => void save(event)}>
      {!loaded && <p role="status">Carregando categorias e tarifas salvas…</p>}
      <section className="finance-panel rates-panel">
        <h2>Diárias por categoria de quarto</h2>
        <p className="rates-help">As categorias e configurações de camas vêm do cadastro de quartos da gerência. Cada categoria mostra uma opção de preço para cada quantidade de hóspedes comportada. Os atalhos seguem a tabela: domingo a quinta e sexta e sábado. As tarifas especiais de feriado são separadas por esses mesmos períodos.</p>
        <button type="button" onClick={fillPrintedRates} disabled={!loaded}>Preencher valores da folha</button>
        {loaded && categories.length === 0
          ? <p className="rates-empty">Nenhuma categoria cadastrada. Cadastre categorias em Gerenciar quartos para configurar as tarifas.</p>
          : <div className="rates-room-list">{categories.map((category) => {
            const guestCounts = roomCategoryGuestCounts(category);
            return <article className="rates-room-card" key={category.id}>
              <h3>{category.name}<small>{category.bedComposition} · {category.bedCount} {category.bedCount === 1 ? 'cama' : 'camas'}</small></h3>
              {guestCounts.map((guestCount) => {
                const preset = presets[category.id]?.[guestCount] ?? { weekday: '', weekend: '' };
                const guestLabel = `${guestCount} ${guestCount === 1 ? 'hóspede' : 'hóspedes'}`;
                const categoryLabel = `${category.name} · ${guestLabel}`;
                return <section className="rates-occupancy-card" key={guestCount} aria-label={`Tarifas para ${categoryLabel}`}>
                  <h4>{guestLabel}</h4>
                  <div className="rates-presets">
                    <label>Preço de domingo a quinta (R$)<input inputMode="decimal" placeholder="Ex.: 180,00" onChange={(event) => { setDirty(true); setPresets((current) => ({ ...current, [category.id]: { ...current[category.id], [guestCount]: { ...preset, weekday: event.target.value } } })); }} value={preset.weekday} /></label>
                    <button type="button" onClick={() => applyGroup(category.id, guestCount, SUNDAY_THROUGH_THURSDAY_DAYS, preset.weekday)}>Aplicar dom. a qui.</button>
                    <label>Preço de sexta e sábado (R$)<input inputMode="decimal" placeholder="Ex.: 240,00" onChange={(event) => { setDirty(true); setPresets((current) => ({ ...current, [category.id]: { ...current[category.id], [guestCount]: { ...preset, weekend: event.target.value } } })); }} value={preset.weekend} /></label>
                    <button type="button" onClick={() => applyGroup(category.id, guestCount, WEEKEND_DAYS, preset.weekend)}>Aplicar sex. e sáb.</button>
                  </div>
                  <div className="rates-week-grid">
                    {WEEKDAYS.map(({ key, label }) => <label key={key}>{label}<span className="rates-money-input"><span>R$</span><input aria-label={label + ', ' + categoryLabel} inputMode="decimal" placeholder="Sem tarifa" value={rates[category.id]?.[guestCount]?.[key] ?? ''} onChange={(event) => changeRate(category.id, guestCount, key, event.target.value)} /></span></label>)}
                    {([
                      ['holidayWeekday', 'Feriado · domingo a quinta'],
                      ['holidayWeekend', 'Feriado · sexta e sábado'],
                    ] as const).map(([key, label]) => <label key={key}>{label}<span className="rates-money-input"><span>R$</span><input aria-label={label + ', ' + categoryLabel} inputMode="decimal" placeholder="Sem tarifa" value={rates[category.id]?.[guestCount]?.[key] ?? ''} onChange={(event) => changeRate(category.id, guestCount, key, event.target.value)} /></span></label>)}
                  </div>
                </section>;
              })}
            </article>;
          })}</div>}
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
