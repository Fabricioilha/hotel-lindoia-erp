import type { FinanceData } from '../../src/types/finance';
import { withCardFees } from '../../src/services/cardFees';
export const financeStorageMode='Prévia local com dados fictícios';
export const emptyFinance=(): FinanceData =>({incomes:{},expenses:{},payroll:{},transfers:{},openingBalances:{cash:300,bank:1000,oyo:0},suppressed:{},auditLog:{},incomeCategories:['Diária','Consumo'],expenseCategories:['Energia elétrica','Adiantamento de salário']});
let current:FinanceData={...emptyFinance(),cardFeeSchedule:{v:{credit:3,debit:1.5,effectiveAt:'2026-01-01T00:00:00Z'}},incomes:{i:{id:'i',date:'2026-10-25',amount:500,category:'Diária',wallet:'bank',items:[{id:'i',description:'Hospedagem de demonstração',paymentMethod:'credit',amount:500}],note:'Quarto 101',createdAt:'2026-10-25T14:00:00Z',updatedAt:'2026-10-25T14:00:00Z'}},expenses:{e:{id:'e',dueDate:'2026-09-15',category:'Energia elétrica',plannedAmount:350,paidCash:0,paidBank:0,note:'Conta do mês anterior',createdAt:'2026-09-01T14:00:00Z',updatedAt:'2026-09-01T14:00:00Z'}}};
const callbacks=new Set<(data: FinanceData) => void>();
export function subscribeFinance(callback: (data: FinanceData) => void){callbacks.add(callback);queueMicrotask(()=>callback(withCardFees(current)));return()=>callbacks.delete(callback);}
export async function updateFinance(update: (data: FinanceData) => FinanceData){current=update(withCardFees(current));callbacks.forEach(cb=>cb(withCardFees(current)));}
export async function loadFinanceForMonth(){return withCardFees(current);}
export const useStaff=()=>({data:{configured:true,members:{e:{id:'e',name:'Equipe de demonstração',active:true,categoryId:'reception'}},categories:{reception:{id:'reception',name:'Recepção',duty:'reception'}}}});
export async function deleteFinancialExpense(){throw Error('Exclusão desativada na prévia');}
export async function deleteFinancialIncome(){throw Error('Exclusão desativada na prévia');}
