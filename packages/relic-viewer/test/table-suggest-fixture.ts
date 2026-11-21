/** CSV fixture for structured suggestion path tests. */
export const TABLE_SUGGEST_CRLF = '\ufeffname,note\r\nAda,"a ""quote"""\r\n';

export const TABLE_SUGGEST_PATH_CRLF =
  '\ufeff\ufeffname,note\r\nZoe,"repeat tail"\r\nAda,"repeat tail"\r\n' +
  Array.from(
    { length: 70 },
    (_, index) => `User ${index},item ${index}\r\n`
  ).join('');
