export function initialCase(search = '') {
  const query = new URLSearchParams(search);
  const year = Number(query.get('year') ?? 2018);
  const pre = Number(String(query.get('pre') ?? query.get('lead') ?? 5).replace(/^pre/, ''));
  return {
    predYear: Number.isInteger(year) && year >= 2000 && year <= 2019 ? year : 2018,
    leadTime: `pre${Number.isInteger(pre) && pre >= 1 && pre <= 20 ? pre : 5}`,
    predRegion: 'eastasia',
  };
}

export function initialComparisonRegion(search = '') {
  return new URLSearchParams(search).get('region') === 'eastasia' ? 'eastasia' : 'focus';
}
