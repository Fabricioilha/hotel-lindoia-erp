export function exportCsv(filename: string, rows: (string | number)[][], localizedNumbers = false) {
	const numericFormat = new Intl.NumberFormat('pt-BR', { useGrouping: false, maximumFractionDigits: 6 });
	const content = rows.map((row) => row.map((value) => `"${(typeof value === 'string' && /^[=+@\t\r-]/.test(value) ? `'${value}` : typeof value === 'number' && localizedNumbers ? numericFormat.format(value) : String(value)).replaceAll('"', '""')}"`).join(';')).join('\r\n');
	const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
