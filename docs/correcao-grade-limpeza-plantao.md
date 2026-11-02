# Grade futura, limpeza e caixa noturno

## Grade do funcionário

A consulta de hoje e dos dias futuros usa as hospedagens e o índice de reservas carregados pelo adaptador PocketBase. A mudança de data aplica o período de entrada e saída a esses registros; todos os quartos cadastrados continuam na grade, mesmo sem ocupantes. Não chama a função Netlify de checkout para consultar o futuro.

Datas anteriores ainda usam o serviço de histórico, que inclui reservas encerradas. Se esse serviço falhar, a tela informa que o histórico está indisponível e não fica indefinidamente em “Carregando”. Falhas dos alertas de pendências são apresentadas separadamente e não bloqueiam a grade. A liberação de quarto continua dependendo do serviço de checkout para validar débitos com segurança.

## Botão de liberação

O comando de liberação nas opções do quarto ganhou um estilo próprio, com fundo verde, borda, ícone, espaçamento, estados de foco e botão desabilitado durante o envio. Antes, ele usava uma classe cujo tamanho e borda só eram definidos dentro de outro contêiner, aparecendo como texto simples.

## Seleção da limpeza

Os cartões mostram o número e um indicador de seleção; não mostram hóspede, “sem hóspede”, “limpo” ou “sujo”. Quartos com tarefa em andamento mostram “Em limpeza” e não podem ser selecionados novamente. A conclusão libera a seleção para uma próxima tarefa. Bloqueios de manutenção e dispensa de limpeza continuam respeitados. Há transições de seleção e movimento discreto no indicador de limpeza, com suporte à preferência por movimento reduzido.

## Caixa das 19h às 7h

O dia operacional vai das **07:00 até 06:59:59 do dia seguinte**, no fuso de São Paulo. Os movimentos continuam separados pelo funcionário.

Exemplo: o caixa do funcionário que entra às **19:00 de 24/10** inclui os movimentos até **06:59:59 de 25/10** e aparece na data **24/10**. Às 07:00 começa o dia operacional 25/10. O seletor indica “Dia de início do plantão”. A data de cada movimento e a data padrão da consulta usam a mesma regra, independentemente de alterações posteriores na escala ou passagens de turno.

As consultas ao backend usam exatamente esse intervalo, inclusive para vendas antigas recebidas durante o turno. Não há alteração das datas originais dos registros nem dos lançamentos contábeis por calendário: esta é a atribuição ao caixa do plantão.

Republicar o frontend atualizado. Esta correção não exige índices ou regras novos no banco. Nenhum registro real foi alterado durante a implementação.
