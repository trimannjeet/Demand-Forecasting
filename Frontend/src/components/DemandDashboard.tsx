import { useMemo, useState } from 'react';
import type { CustomForecastResponse } from '../types/api';
import { parseWeeklyDate, weekStart } from '../lib/dates';

type Row = Record<string, string>;
type Grain = 'week' | 'month' | 'year';
type Bucket = { key: string; label: string; start: number; actual: number; forecast: number; hasActual: boolean; hasForecast: boolean };

const formatNumber = (value: number | null, digits = 0) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });

function periodFor(date: string, grain: Grain): { key: string; label: string; start: number } {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (grain === 'year') return { key: String(year), label: String(year), start: Date.UTC(year, 0, 1) };
  if (grain === 'month') {
    const label = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(year, month - 1, 1)));
    return { key: `${year}-${String(month).padStart(2, '0')}`, label, start: Date.UTC(year, month - 1, 1) };
  }
  const label = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' })
    .format(new Date(timestamp));
  return { key: date, label, start: timestamp };
}

export default function DemandDashboard({
  rows,
  dateColumn,
  demandColumn,
  groupColumn,
  dateFormat,
  response,
  onGenerate,
  canGenerate,
  loading,
}: {
  rows: Row[];
  dateColumn: string;
  demandColumn: string;
  groupColumn: string;
  dateFormat: 'day-first' | 'month-first';
  response: CustomForecastResponse | null;
  onGenerate: () => void;
  canGenerate: boolean;
  loading: boolean;
}) {
  const [grain, setGrain] = useState<Grain>('month');
  const [selectedGroup, setSelectedGroup] = useState('__all__');

  const observations = useMemo(() => {
    const weeklyTotals = new Map<string, { date: string; demand: number; group: string }>();
    rows.forEach(row => {
      const parsedDate = parseWeeklyDate(row[dateColumn] ?? '', dateFormat);
      const demand = Number((row[demandColumn] ?? '').trim());
      const group = groupColumn ? (row[groupColumn] ?? '').trim() : 'All stores';
      if (!parsedDate || !Number.isFinite(demand) || demand < 0 || !group) return;
      const date = weekStart(parsedDate);
      const key = `${group}\0${date}`;
      const point = weeklyTotals.get(key) ?? { date, demand: 0, group };
      point.demand += demand;
      weeklyTotals.set(key, point);
    });
    return [...weeklyTotals.values()];
  }, [rows, dateColumn, demandColumn, groupColumn, dateFormat]);

  const groups = useMemo(() => [...new Set(observations.map(point => point.group))].sort(), [observations]);
  const activeGroup = selectedGroup !== '__all__' && groups.includes(selectedGroup)
    ? selectedGroup
    : '__all__';
  const actualPoints = activeGroup === '__all__'
    ? observations
    : observations.filter(point => point.group === activeGroup);
  const forecastPoints = useMemo(
    () => (response?.forecasts ?? [])
      .filter(point => activeGroup === '__all__' || point.group_value === activeGroup)
      .map(point => ({ date: point.forecast_date, demand: point.predicted_demand })),
    [response, activeGroup],
  );
  const groupForecasts = useMemo(() => {
    if (!response || activeGroup !== '__all__' || response.groups_count < 2) return [];
    const totals = new Map<string, number>();
    response.forecasts.forEach(point => {
      totals.set(point.group_value, (totals.get(point.group_value) ?? 0) + point.predicted_demand);
    });
    const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
    return [...totals.entries()]
      .map(([group, demand]) => ({
        group,
        demand,
        share: total > 0 ? (demand / total) * 100 : 0,
      }))
      .sort((left, right) => right.demand - left.demand)
      .slice(0, 8);
  }, [response, activeGroup]);

  const buckets = useMemo(() => {
    const byPeriod = new Map<string, Bucket>();
    const add = (date: string, value: number, kind: 'actual' | 'forecast') => {
      const period = periodFor(date, grain);
      const bucket = byPeriod.get(period.key) ?? {
        ...period,
        actual: 0,
        forecast: 0,
        hasActual: false,
        hasForecast: false,
      };
      bucket[kind] += value;
      if (kind === 'actual') bucket.hasActual = true;
      else bucket.hasForecast = true;
      byPeriod.set(period.key, bucket);
    };
    actualPoints.forEach(point => add(point.date, point.demand, 'actual'));
    forecastPoints.forEach(point => add(point.date, point.demand, 'forecast'));
    return [...byPeriod.values()].sort((left, right) => left.start - right.start);
  }, [actualPoints, forecastPoints, grain]);

  const comparisons = useMemo(() => {
    if (!response || !actualPoints.length || !forecastPoints.length) return null;
    const observedWeeks = [...new Set(actualPoints.map(point => point.date))].sort();
    const comparisonDates = new Set(observedWeeks.slice(-response.horizon_weeks));
    const previous = actualPoints
      .filter(point => comparisonDates.has(point.date))
      .reduce((total, point) => total + point.demand, 0);
    const expected = forecastPoints.reduce((total, point) => total + point.demand, 0);
    const change = previous === 0 ? null : ((expected - previous) / previous) * 100;
    return { previous, expected, change, weeks: Math.min(response.horizon_weeks, comparisonDates.size) };
  }, [response, actualPoints, forecastPoints]);
  const backtest = useMemo(() => {
    if (!response) return null;
    const scopedMetrics = response.metrics.filter(metric =>
      activeGroup === '__all__' || metric.group_value === activeGroup,
    );
    const validMetrics = scopedMetrics.flatMap(metric =>
      metric.wape_percent != null && Number.isFinite(metric.wape_percent)
        ? [{ ...metric, wape_percent: metric.wape_percent }]
        : [],
    );
    const available = validMetrics.map(metric => metric.wape_percent);
    const sortedErrors = [...available].sort((left, right) => left - right);
    return {
      typicalDifference: sortedErrors.length
        ? (sortedErrors[Math.floor((sortedErrors.length - 1) / 2)]
          + sortedErrors[Math.floor(sortedErrors.length / 2)]) / 2
        : null,
      validationWindows: validMetrics.length
        ? Math.min(...validMetrics.map(metric => metric.validation_windows))
        : 0,
      checkedGroups: available.length,
      totalGroups: scopedMetrics.length,
    };
  }, [response, activeGroup]);

  const actualTotal = actualPoints.reduce((total, point) => total + point.demand, 0);
  const historyWeeks = new Set(actualPoints.map(point => point.date)).size;
  const salesPulse = useMemo(() => {
    const weeklyTotals = new Map<string, number>();
    actualPoints.forEach(point => weeklyTotals.set(
      point.date,
      (weeklyTotals.get(point.date) ?? 0) + point.demand,
    ));
    const weekly = [...weeklyTotals.entries()]
      .map(([date, demand]) => ({ date, demand }))
      .sort((left, right) => left.date.localeCompare(right.date));
    const recent = weekly.slice(-13);
    const previous = weekly.slice(-26, -13);
    const recentTotal = recent.reduce((total, point) => total + point.demand, 0);
    const previousTotal = previous.reduce((total, point) => total + point.demand, 0);
    const peakWeek = weekly.reduce<(typeof weekly)[number] | null>(
      (peak, point) => peak == null || point.demand > peak.demand ? point : peak,
      null,
    );
    return {
      average: historyWeeks ? actualTotal / historyWeeks : null,
      recentChange: recent.length === 13 && previous.length === 13 && previousTotal > 0
        ? ((recentTotal - previousTotal) / previousTotal) * 100
        : null,
      peakWeek,
    };
  }, [actualPoints, actualTotal, historyWeeks]);
  const seasonality = useMemo(() => {
    const months = Array.from({ length: 12 }, (_, index) => ({
      month: index,
      label: new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' })
        .format(new Date(Date.UTC(2020, index, 1))),
      total: 0,
      weeks: 0,
    }));
    const weeks = new Map<string, number>();
    actualPoints.forEach(point => weeks.set(point.date, (weeks.get(point.date) ?? 0) + point.demand));
    weeks.forEach((demand, date) => {
      const month = Number(date.slice(5, 7)) - 1;
      const bucket = months[month];
      if (!bucket || month < 0 || month > 11) return;
      bucket.total += demand;
      bucket.weeks += 1;
    });
    return months.map(bucket => ({
      ...bucket,
      average: bucket.weeks ? bucket.total / bucket.weeks : null,
    }));
  }, [actualPoints]);
  const seasonalityMax = Math.max(1, ...seasonality.map(month => month.average ?? 0));
  const forecastByWeek = useMemo(() => {
    const totals = new Map<string, number>();
    forecastPoints.forEach(point => totals.set(point.date, (totals.get(point.date) ?? 0) + point.demand));
    return [...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, demand]) => ({
        date,
        demand,
        label: new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })
          .format(new Date(`${date}T00:00:00Z`)),
      }));
  }, [forecastPoints]);
  const forecastWeekMax = Math.max(1, ...forecastByWeek.map(point => point.demand));
  const forecastMix = useMemo(() => {
    if (!response || activeGroup !== '__all__' || response.groups_count < 2) return [];
    const totals = new Map<string, number>();
    response.forecasts.forEach(point => {
      totals.set(point.group_value, (totals.get(point.group_value) ?? 0) + point.predicted_demand);
    });
    const ranked = [...totals.entries()].sort((left, right) => right[1] - left[1]);
    const topGroups = ranked.slice(0, 5);
    const otherDemand = ranked.slice(5).reduce((total, [, demand]) => total + demand, 0);
    const entries = topGroups.map(([group, demand]) => ({ label: group, demand }));
    if (otherDemand > 0) entries.push({ label: 'Other stores', demand: otherDemand });
    const total = entries.reduce((sum, entry) => sum + entry.demand, 0);
    const colors = ['#8d9eff', '#4bc9a1', '#f1b65c', '#e987a4', '#59b8dc', '#77849b'];
    let end = 0;
    const stops = entries.map((entry, index) => {
      const start = end;
      end += total > 0 ? (entry.demand / total) * 100 : 0;
      return `${colors[index % colors.length]} ${start}% ${end}%`;
    });
    return entries.map((entry, index) => ({
      ...entry,
      share: total > 0 ? (entry.demand / total) * 100 : 0,
      color: colors[index % colors.length],
      gradient: stops.join(', '),
    }));
  }, [response, activeGroup]);
  const latestDate = actualPoints.reduce<string | null>(
    (latest, point) => latest == null || point.date > latest ? point.date : latest,
    null,
  );
  const latestValue = latestDate == null
    ? null
    : actualPoints.filter(point => point.date === latestDate).reduce((total, point) => total + point.demand, 0);
  const chartWidth = 1000;
  const chartHeight = 320;
  const left = 74;
  const right = 24;
  const top = 22;
  const bottom = 48;
  const values = buckets.flatMap(bucket => [bucket.hasActual ? bucket.actual : null, bucket.hasForecast ? bucket.forecast : null])
    .filter((value): value is number => value != null);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const span = max - min || 1;
  const x = (index: number) => left + (buckets.length <= 1
    ? (chartWidth - left - right) / 2
    : index * (chartWidth - left - right) / (buckets.length - 1));
  const y = (value: number) => chartHeight - bottom - ((value - min) / span) * (chartHeight - top - bottom);
  const actualLine = buckets.map((bucket, index) => bucket.hasActual ? `${x(index)},${y(bucket.actual)}` : null).filter(Boolean).join(' ');
  const lastActualIndex = buckets.map(bucket => bucket.hasActual).lastIndexOf(true);
  const forecastLine = [
    ...(lastActualIndex >= 0 ? [`${x(lastActualIndex)},${y(buckets[lastActualIndex].actual)}`] : []),
    ...buckets.map((bucket, index) => bucket.hasForecast ? `${x(index)},${y(bucket.forecast)}` : null).filter((point): point is string => point !== null),
  ].join(' ');
  const axisIndices = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])];
  const projectedTotal = forecastPoints.reduce((total, point) => total + point.demand, 0);
  const comparedTotal = (comparisons?.previous ?? 0) + projectedTotal;
  const previousShare = comparedTotal > 0 ? ((comparisons?.previous ?? 0) / comparedTotal) * 100 : 50;
  const comparisonMax = Math.max(comparisons?.previous ?? 0, projectedTotal, 1);
  const previousBarWidth = ((comparisons?.previous ?? 0) / comparisonMax) * 100;
  const forecastBarWidth = (projectedTotal / comparisonMax) * 100;

  return <section className="demand-dashboard" id="insights" aria-label="Demand analytics dashboard">
    <div className="dashboard-heading">
      <div>
        <div className="section-kicker">DEMAND OVER TIME</div>
        <h2>{activeGroup === '__all__' ? 'Your demand picture' : activeGroup}</h2>
        <p>See how demand has changed and what may come next.</p>
      </div>
      <div className="dashboard-controls">
        {response && groups.length > 1 && <label className="dashboard-filter">Choose store or group
          <select value={activeGroup} onChange={event => setSelectedGroup(event.target.value)}>
            <option value="__all__">All groups combined</option>
            {groups.map(group => <option key={group} value={group}>{group}</option>)}
          </select>
        </label>}
        {response && <div className="grain-switch" role="group" aria-label="Chart time scale">
          {(['week', 'month', 'year'] as const).map(value =>
            <button key={value} className={grain === value ? 'selected' : ''} onClick={() => setGrain(value)}>
              {value === 'week' ? 'Weekly' : value === 'month' ? 'Monthly' : 'Yearly'}
            </button>,
          )}
        </div>}
        <button className="button button-primary dashboard-generate" onClick={onGenerate} disabled={!canGenerate}>
          {loading ? 'Forecasting…' : response ? 'Update forecast' : 'Generate forecast'}
        </button>
      </div>
    </div>

    {response ? <>
    <div className="comparison-cards">
      <article className="comparison-card">
        <span className="comparison-eyebrow">{response ? `Previous ${comparisons?.weeks ?? response.horizon_weeks} weeks` : 'Past demand'}</span>
        <strong>{formatNumber(comparisons?.previous ?? actualTotal)}</strong>
        <span>{comparisons ? 'What was sold before the forecast' : `Across ${historyWeeks.toLocaleString()} weeks of history`}</span>
      </article>
      <article className="comparison-card forecast-card">
        <span className="comparison-eyebrow">{response ? `Next ${response.horizon_weeks} weeks · expected` : 'Coming next'}</span>
        <strong>{response ? formatNumber(projectedTotal) : 'Ready when you are'}</strong>
        <span>{response ? 'Expected demand for the selected period' : 'Create a forecast to see expected demand'}</span>
      </article>
      <article className={`comparison-card ${comparisons?.change != null ? comparisons.change >= 0 ? 'change-up' : 'change-down' : ''}`}>
        <span className="comparison-eyebrow">Compared with before</span>
        <strong>{comparisons?.change == null ? '—' : `${comparisons.change >= 0 ? '+' : ''}${comparisons.change.toFixed(1)}%`}</strong>
        <span>{comparisons ? `Compared with the previous ${comparisons.weeks} weeks` : 'Available after creating a forecast'}</span>
      </article>
      <article className="comparison-card">
        <span className="comparison-eyebrow">Most recent week</span>
        <strong>{formatNumber(latestValue)}</strong>
        <span>{latestDate ?? 'No dated sales yet'}</span>
      </article>
    </div>

    <section className="sales-pulse" aria-label="Recent sales insights">
      <div className="sales-pulse-heading">
        <div>
          <h3>Sales at a glance</h3>
          <p>Quick signals from {activeGroup === '__all__' ? 'all selected data' : activeGroup}</p>
        </div>
        <span>Based on {historyWeeks.toLocaleString()} observed weeks</span>
      </div>
      <div className="sales-pulse-grid">
        <article className="sales-pulse-card">
          <span>Average each week</span>
          <strong>{formatNumber(salesPulse.average)}</strong>
          <small>Across the available sales history</small>
        </article>
        <article className={`sales-pulse-card ${salesPulse.recentChange == null ? '' : salesPulse.recentChange >= 0 ? 'pulse-up' : 'pulse-down'}`}>
          <span>Recent sales movement</span>
          <strong>{salesPulse.recentChange == null ? 'More history needed' : `${salesPulse.recentChange >= 0 ? '+' : ''}${salesPulse.recentChange.toFixed(1)}%`}</strong>
          <small>{salesPulse.recentChange == null
            ? 'Needs 26 observed weeks to compare fairly'
            : 'Last 13 weeks compared with the 13 before'}</small>
        </article>
        <article className="sales-pulse-card">
          <span>Highest sales week</span>
          <strong>{formatNumber(salesPulse.peakWeek?.demand ?? null)}</strong>
          <small>{salesPulse.peakWeek?.date ?? 'No weekly sales available'}</small>
        </article>
      </div>
    </section>

    {response && <div className="forecast-check-panel" aria-live="polite">
      <span className="forecast-check-mark" aria-hidden="true">%</span>
      <div>
        <strong>How close past forecasts were</strong>
        {backtest?.typicalDifference == null
          ? <p>There isn’t enough history to replay this forecast period yet. The forecast is still available; more past sales will unlock this check.</p>
          : <p>
            Tested across {backtest.validationWindows} past forecast window{backtest.validationWindows === 1 ? '' : 's'}, a typical {backtest.totalGroups > 1 ? 'store' : 'forecast'} was off by about <b>{backtest.typicalDifference.toFixed(1)}%</b> of actual sales
            {backtest.totalGroups > 1 ? ` (median across ${backtest.checkedGroups} stores)` : ''}.
            {backtest.checkedGroups < backtest.totalGroups ? ` ${backtest.totalGroups - backtest.checkedGroups} other stores need more history for this check.` : ''}
          </p>}
      </div>
    </div>}

    <div className="panel timeline-panel">
      <div className="timeline-heading">
        <div>
          <h3>Actual demand & forecast</h3>
          <p>{grain === 'week' ? 'Weekly sales' : grain === 'month' ? 'Total sales by calendar month' : 'Total sales by calendar year'}</p>
        </div>
        <div className="timeline-legend"><span><i className="actual-key"/> Past sales</span><span><i className="forecast-key"/> Expected sales</span></div>
      </div>
      {buckets.length > 0 ? <div className="timeline-chart">
        <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={`${grain} actual demand and forecast chart`}>
          {[0, 1, 2, 3].map(tick => {
            const value = max - (span * tick) / 3;
            const lineY = y(value);
            return <g key={tick}>
              <line x1={left} x2={chartWidth - right} y1={lineY} y2={lineY} className="chart-grid-line"/>
              <text x={left - 12} y={lineY + 4} textAnchor="end" className="chart-tick">{formatNumber(value)}</text>
            </g>;
          })}
          {actualLine && <polyline points={actualLine} className="actual-series"/>}
          {forecastLine && <polyline points={forecastLine} className="forecast-series"/>}
          {buckets.map((bucket, index) => bucket.hasActual && <circle key={`a-${bucket.key}`} cx={x(index)} cy={y(bucket.actual)} r="3.5" className="actual-point"><title>{`${bucket.label} actual: ${formatNumber(bucket.actual)}`}</title></circle>)}
          {buckets.map((bucket, index) => bucket.hasForecast && <circle key={`f-${bucket.key}`} cx={x(index)} cy={y(bucket.forecast)} r="4" className="forecast-point"><title>{`${bucket.label} forecast: ${formatNumber(bucket.forecast)}`}</title></circle>)}
          {axisIndices.map(index => <text key={index} x={x(index)} y={chartHeight - 14} textAnchor={index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'} className="chart-tick">{buckets[index]?.label}</text>)}
        </svg>
      </div> : <div className="dashboard-empty">Choose a valid date and demand column to display your history.</div>}
      <div className="timeline-footnote">
        {response
          ? `Expected sales cover the next ${response.horizon_weeks} weeks. Monthly and yearly totals include only forecast weeks that fall within each period.`
            : 'Monthly and yearly totals are added from your weekly sales.'}
      </div>
    </div>

    <div className="dashboard-visual-grid">
      <section className="panel visual-panel seasonality-panel">
        <div className="timeline-heading">
          <div>
            <h3>Seasonal demand pattern</h3>
            <p>Average weekly sales in each calendar month</p>
          </div>
          <span className="visual-unit">By month</span>
        </div>
        <div className="seasonality-chart" role="img" aria-label="Average weekly demand by calendar month">
          {seasonality.map(month => {
            const height = month.average == null ? 0 : (month.average / seasonalityMax) * 100;
            return <div className={`seasonality-column ${month.average == null ? 'no-observations' : ''}`} key={month.month} title={`${month.label}: ${month.average == null ? 'no sales weeks observed' : `${formatNumber(month.average)} average per observed week`}`}>
              <span className="seasonality-value">{month.average == null ? '—' : formatNumber(month.average)}</span>
              <div className="seasonality-track"><i style={{ height: `${height}%` }} /></div>
              <span className="seasonality-label">{month.label}</span>
            </div>;
          })}
        </div>
        <p className="timeline-footnote">Only observed weeks are included; months without data are left blank rather than treated as zero sales.</p>
      </section>

      {response && <section className="panel visual-panel forecast-week-panel">
        <div className="timeline-heading">
          <div>
            <h3>Week-by-week outlook</h3>
            <p>Expected demand for each upcoming week</p>
          </div>
          <span className="visual-unit">{forecastByWeek.length} weeks</span>
        </div>
        <div className="forecast-week-chart" role="img" aria-label={`Weekly forecast: ${forecastByWeek.map(point => `${point.label}, ${formatNumber(point.demand)}`).join('; ')}`}>
        {forecastByWeek.map(point => {
          return <div className="forecast-week-column" key={point.date} title={`${point.label}: ${formatNumber(point.demand)} expected`}>
            <span className="forecast-week-value">{formatNumber(point.demand)}</span>
            <div className="forecast-week-track"><i style={{ height: `${(point.demand / forecastWeekMax) * 100}%` }} /></div>
              <span className="forecast-week-label">{point.label}</span>
            </div>;
          })}
        </div>
        <p className="timeline-footnote">The forecast uses the selected store filter and forecast horizon.</p>
      </section>}

      {forecastMix.length > 1 && <section className="panel visual-panel store-mix-panel">
        <div className="timeline-heading">
          <div>
            <h3>Forecast mix by store</h3>
            <p>Share of expected sales over the forecast period</p>
          </div>
          <span className="visual-unit">{response?.groups_count} stores</span>
        </div>
        <div className="store-mix-content">
          <div className="store-mix-donut" role="img" aria-label={`Forecast contribution mix: ${forecastMix.map(item => `${item.label} ${item.share.toFixed(1)} percent`).join(', ')}`} style={{ background: `conic-gradient(${forecastMix[0].gradient})` }}>
            <div><span>Forecast total</span><strong>{formatNumber(projectedTotal)}</strong></div>
          </div>
          <div className="store-mix-legend">
            {forecastMix.map(item => <div key={item.label} title={`${item.label}: ${formatNumber(item.demand)}`}>
              <i style={{ background: item.color }} />
              <span>{item.label}</span>
              <strong>{item.share.toFixed(1)}%</strong>
            </div>)}
          </div>
        </div>
        <p className="timeline-footnote">Stores outside the top five are combined into “Other stores.”</p>
      </section>}
    </div>

    {response && <div className="dashboard-bottom-grid">
      <div className="panel period-panel">
        <div className="timeline-heading"><div><h3>{grain === 'week' ? 'Weekly' : grain === 'month' ? 'Monthly' : 'Yearly'} breakdown</h3><p>Past sales and expected sales by calendar period</p></div></div>
        <div className="period-table-wrap"><table className="period-table"><thead><tr><th>Period</th><th>Past sales</th><th>Expected sales</th></tr></thead><tbody>
          {buckets.slice(-12).map(bucket => <tr key={bucket.key}><td>{bucket.label}</td><td>{bucket.hasActual ? formatNumber(bucket.actual) : '—'}</td><td>{bucket.hasForecast ? formatNumber(bucket.forecast) : '—'}</td></tr>)}
        </tbody></table></div>
        <p className="timeline-footnote">Year totals include only the weeks shown. We do not fill in weeks that were not forecast.</p>
      </div>
      <div className="panel comparison-visual-panel">
        <div className="timeline-heading"><div><h3>Before and after</h3><p>{comparisons ? `Sales across ${comparisons.weeks} past weeks and the next ${response?.horizon_weeks} weeks` : 'Create a forecast to compare periods'}</p></div></div>
        {comparisons && <div className="donut-comparison">
          <div
            className="comparison-donut"
            role="img"
            aria-label={`Past sales ${formatNumber(comparisons.previous)}; expected sales ${formatNumber(projectedTotal)}`}
            style={{ background: `conic-gradient(#41c9a0 0 ${previousShare}%, #91a7ff ${previousShare}% 100%)` }}
          ><div><span>Two periods</span><strong>{formatNumber(comparedTotal)}</strong></div></div>
          <div className="donut-legend">
            <div><i className="actual-key"/><span>Past sales<strong>{formatNumber(comparisons.previous)}</strong></span></div>
            <div><i className="forecast-key"/><span>Expected sales<strong>{formatNumber(projectedTotal)}</strong></span></div>
            <div className="comparison-bars" aria-label="Side-by-side sales comparison">
              <span>Past</span><div><i className="past-bar" style={{ width: `${previousBarWidth}%` }}/></div>
              <span>Next</span><div><i className="next-bar" style={{ width: `${forecastBarWidth}%` }}/></div>
            </div>
            <p>The same number of weeks is compared on each side, so the change is easier to understand.</p>
          </div>
        </div>}
      </div>
    </div>}
    {groupForecasts.length > 1 && <div className="panel group-forecast-panel">
      <div className="timeline-heading">
        <div>
          <h3>Expected sales by store</h3>
          <p>Which stores contribute most to the upcoming {response?.horizon_weeks} weeks</p>
        </div>
        <span className="group-count-badge">{response?.groups_count} stores</span>
      </div>
      <div className="group-ranking">
        {groupForecasts.map((item, index) => <div className="group-ranking-row" key={item.group}>
          <span className="group-ranking-index">{String(index + 1).padStart(2, '0')}</span>
          <span className="group-ranking-name" title={item.group}>{item.group}</span>
          <span className="group-ranking-track" aria-hidden="true">
            <i style={{ width: `${item.share}%` }} />
          </span>
          <strong className="group-ranking-total">{formatNumber(item.demand)}</strong>
          <span className="group-ranking-share">{item.share.toFixed(1)}%</span>
        </div>)}
      </div>
      <p className="timeline-footnote">
        Showing the top {groupForecasts.length} stores by expected sales. Percentages are each store’s share of the total forecast.
      </p>
    </div>}
    </> : !loading && <div className="dashboard-pending" role="status">
      <strong>Your forecast is ready to generate</strong>
      <span>No charts or sales summaries will appear until the forecast finishes successfully.</span>
    </div>}
  </section>;
}
