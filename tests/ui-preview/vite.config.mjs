import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
export default defineConfig({root,plugins:[{name:'offline-fixtures',enforce:'pre',resolveId(id){if(/(?:^|\/)services\/(financeStore|staffStore|financeDeletion)$/.test(id))return root+'fixtures.ts';}},react()],server:{host:'127.0.0.1',port:5182,strictPort:true,fs:{allow:[fileURLToPath(new URL('../..',import.meta.url))]}}});