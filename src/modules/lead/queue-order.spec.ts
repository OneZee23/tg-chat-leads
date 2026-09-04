import { leadQueueScoreSql } from '@modules/lead/queue-order';

describe('leadQueueScoreSql', () => {
  it('без алиаса — голая колонка, для сырого SQL', () => {
    expect(leadQueueScoreSql()).toContain('ad_messages_count <= 5');
    expect(leadQueueScoreSql()).not.toContain('"');
  });

  it('с алиасом — квалифицированная колонка, для QueryBuilder', () => {
    expect(leadQueueScoreSql('lead')).toContain('"lead"."ad_messages_count"');
  });

  it('обе формы описывают ОДИН порядок — иначе предпросмотр соврёт', () => {
    // yarn send показывает выборку через QueryBuilder, а отправляет через
    // сырой SQL. Разъедутся формулы — предпросмотр покажет не тех людей,
    // которым уйдёт письмо.
    const plain = leadQueueScoreSql();
    const aliased = leadQueueScoreSql('lead').replace(
      /"lead"\."ad_messages_count"/g,
      'ad_messages_count',
    );
    expect(aliased).toBe(plain);
  });

  it('порог и знаки те, что измерены: +2 до пяти объявлений, -1 от тридцати', () => {
    const sql = leadQueueScoreSql();
    expect(sql).toContain('<= 5 THEN 2');
    expect(sql).toContain('>= 30 THEN -1');
  });
});
