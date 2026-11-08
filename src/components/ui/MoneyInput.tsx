import type { ClipboardEvent } from 'react';
import { formatBRL, moneyFromDigits, parseMoneyText } from '../../services/money';

interface MoneyInputProps {
	value: number;
	onValueChange: (value: number) => void;
	/** Quando informado, o valor numérico (ex.: 2150.50) é enviado no formulário por um campo oculto. */
	name?: string;
	id?: string;
	disabled?: boolean;
	autoFocus?: boolean;
	'aria-label'?: string;
	'aria-describedby'?: string;
}

// Campo monetário em reais: formata como "R$ 2.150,50" enquanto o valor é digitado (centavos entram pela direita).
export function MoneyInput({ value, onValueChange, name, id, disabled, autoFocus, ...aria }: MoneyInputProps) {
	function paste(event: ClipboardEvent<HTMLInputElement>) {
		const pasted = parseMoneyText(event.clipboardData.getData('text'));
		if (pasted === null) return;
		event.preventDefault();
		onValueChange(pasted);
	}

	return <span className="money-input">
		<input id={id} className="money-input-field" type="text" inputMode="numeric" autoComplete="off" disabled={disabled} autoFocus={autoFocus}
			value={formatBRL(value)} onChange={(event) => onValueChange(moneyFromDigits(event.target.value))}
			onFocus={(event) => event.currentTarget.select()} onPaste={paste} {...aria} />
		{name && <input type="hidden" name={name} value={value.toFixed(2)} />}
	</span>;
}
