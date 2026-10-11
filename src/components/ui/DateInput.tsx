import { useEffect, useRef, useState } from 'react';

const toBr = (iso: string) => /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';

function mask(raw: string) {
	const digits = raw.replace(/\D/g, '').slice(0, 8);
	return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/');
}

function toIso(text: string) {
	const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
	if (!match) return '';
	const [, day, month, year] = match;
	const date = new Date(Number(year), Number(month) - 1, Number(day));
	return date.getFullYear() === Number(year) && date.getMonth() === Number(month) - 1 && date.getDate() === Number(day) ? `${year}-${month}-${day}` : '';
}

interface DateInputProps {
	name: string;
	value?: string;
	defaultValue?: string;
	onValueChange?: (iso: string) => void;
	required?: boolean;
	min?: string;
	max?: string;
	autoFocus?: boolean;
}

// Campo de data dd/mm/aaaa; o valor enviado no formulário e emitido em onValueChange é ISO (aaaa-mm-dd).
export function DateInput({ name, value, defaultValue, onValueChange, required, min, max, autoFocus }: DateInputProps) {
	const [text, setText] = useState(toBr(value ?? defaultValue ?? ''));
	const [lastValue, setLastValue] = useState(value);
	const ref = useRef<HTMLInputElement>(null);
	const pickerRef = useRef<HTMLInputElement>(null);
	const iso = toIso(text);

	if (value !== lastValue) {
		setLastValue(value);
		if (value !== undefined && value !== iso) setText(toBr(value));
	}

	useEffect(() => {
		let message = '';
		if (text && !iso) message = 'Informe uma data válida no formato dd/mm/aaaa.';
		else if (iso && min && iso < min) message = `A data não pode ser anterior a ${toBr(min)}.`;
		else if (iso && max && iso > max) message = `A data não pode ser posterior a ${toBr(max)}.`;
		ref.current?.setCustomValidity(message);
	}, [text, iso, min, max]);

	return <span style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
		<input ref={ref} style={{ flex: 1, minWidth: 0 }} type="text" inputMode="numeric" placeholder="dd/mm/aaaa" maxLength={10} autoComplete="off" required={required} autoFocus={autoFocus} value={text} onChange={(event) => {
			const next = mask(event.target.value);
			setText(next);
			onValueChange?.(toIso(next));
		}} />
		<button type="button" aria-label="Abrir calendário" title="Abrir calendário" style={{ flex: '0 0 auto', padding: '6px 9px', border: '1px solid #cfd9db', borderRadius: 6, background: '#fff', cursor: 'pointer', lineHeight: 1 }} onClick={() => pickerRef.current?.showPicker()}>📅</button>
		<input ref={pickerRef} type="date" tabIndex={-1} aria-hidden="true" min={min} max={max} value={iso} style={{ position: 'absolute', right: 0, bottom: 0, width: 1, height: 1, padding: 0, border: 0, opacity: 0, pointerEvents: 'none' }} onChange={(event) => {
			if (!event.target.value) return;
			setText(toBr(event.target.value));
			onValueChange?.(event.target.value);
		}} />
		<input type="hidden" name={name} value={iso} />
	</span>;
}
