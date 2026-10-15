const AppError = require('../../utils/AppError');

const normalizeName = (name) =>
  String(name || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();

const fields = [
  {
    parameter: 'xrawi', inclusion: 'rawi', field: 'rawi',
    catalog: require('../../data/rawi.json'),
  },
  {
    parameter: 'xm', inclusion: 'm', field: 'mohdith',
    id: 'mohdithId', catalog: require('../../data/mohdith.json'),
  },
  {
    parameter: 'xs', inclusion: 's', field: 'book',
    id: 'bookId', catalog: require('../../data/book.json'),
  },
].map((field) => ({
  ...field,
  names: new Map(field.catalog.map((option) => [
    String(option.key), normalizeName(option.value),
  ])),
}));

const parseExclusions = (queryParams) => {
  const query = { ...queryParams };
  const exclusions = [];
  for (const { parameter, inclusion, field, id, names } of fields) {
    const raw = query[parameter];
    delete query[parameter];
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.some((value) =>
      typeof value !== 'string' || !/^\d+$/.test(value) ||
      value === '0' || !names.has(value))) {
      throw new AppError(`Invalid ${parameter} catalog IDs`, 400);
    }
    const included = query[inclusion];
    if (included !== undefined &&
        (Array.isArray(included) ? included : [included])
          .some((value) => String(value) !== '0')) {
      throw new AppError(`Cannot include and exclude the same ${inclusion} filter`, 400);
    }
    const ids = new Set(values);
    const labels = new Set(values.map((value) => names.get(value)));
    exclusions.push((hadith) => id && hadith[id] != null
      ? ids.has(String(hadith[id]))
      : labels.has(normalizeName(hadith[field])));
  }
  return {
    query,
    active: exclusions.length > 0,
    keep: (hadith) => !exclusions.some((exclude) => exclude(hadith)),
  };
};

module.exports = { parseExclusions };
