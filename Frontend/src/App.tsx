import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from './lib/api';
import { downloadCsv, parseCsv } from './lib/csv';
import { detectDateFormat, parseWeeklyDate, weekStart } from './lib/dates';
import type { DateFormat } from './lib/dates';
import DemandDashboard from './components/DemandDashboard';
import type { CustomForecastResponse } from './types/api';

type Row = Record<string, string>;
const INITIAL_HEADERS = ['Date', 'Demand', 'Store'];
const MAX_TABLE_PREVIEW_ROWS = 100;
const emptyRow = (headers: string[]): Row => Object.fromEntries(headers.map(header => [header, '']));
const fmt = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });

function Icon({ name, size = 18 }: { name: 'chart' | 'upload' | 'table' | 'download' | 'plus' | 'trash' | 'arrow' | 'check' | 'activity' | 'file' | 'spark' | 'refresh' | 'database' | 'calendar' | 'alert'; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths: Record<string, ReactNode> = {
    chart: <><path d="M3 3v18h18"/><path d="m7 14 4-4 4 3 5-7"/></>, upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/></>, table: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16M15 4v16"/></>, download: <><path d="M12 4v12m-5-5 5 5 5-5"/><path d="M4 20h16"/></>, plus: <><path d="M12 5v14M5 12h14"/></>, trash: <><path d="M3 6h18M8 6V4h8v2m-11 0 1 14h12l1-14M10 10v6m4-6v6"/></>, arrow: <><path d="M5 12h14m-6-6 6 6-6 6"/></>, check: <path d="m5 12 4 4L19 6"/>, activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>, file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8m-8 4h8"/></>, spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-2-5.8L4 11l6-2.2z"/><path d="m19 15 1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/></>, refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2"/></>, database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></>, calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>, alert: <><path d="M12 3 2.8 20h18.4z"/><path d="M12 9v4m0 3h.01"/></>
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function App() {
  const [connection, setConnection] = useState<'checking' | 'online' | 'offline'>('checking');
  const [headers, setHeaders] = useState<string[]>(INITIAL_HEADERS);
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: 12 }, () => emptyRow(INITIAL_HEADERS)));
  const [dateColumn, setDateColumn] = useState('Date');
  const [dateFormat, setDateFormat] = useState<DateFormat>('auto');
  const [demandColumn, setDemandColumn] = useState('Demand');
  const [groupColumn, setGroupColumn] = useState('Store');
  const [horizon, setHorizon] = useState(4);
  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [datasetEditorOpen, setDatasetEditorOpen] = useState(true);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [datasetImported, setDatasetImported] = useState(false);
  const [dataMessage, setDataMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [result, setResult] = useState<CustomForecastResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshConnection = useCallback(async () => {
    setConnection('checking');
    try { await api.health(); setConnection('online'); }
    catch { setConnection('offline'); }
  }, []);
  useEffect(() => { void refreshConnection(); }, [refreshConnection]);

  const populatedRows = useMemo(() => rows.filter(row => headers.some(header => (row[header] ?? '').trim() !== '')).length, [rows, headers]);
  const previewRows = rows.slice(0, MAX_TABLE_PREVIEW_ROWS);
  const detectedDateFormat = useMemo(
    () => detectDateFormat(rows.map(row => (row[dateColumn] ?? '').trim()).filter(Boolean)),
    [rows, dateColumn],
  );
  const effectiveDateFormat = dateFormat === 'auto' ? detectedDateFormat : dateFormat;
  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!headers.includes(dateColumn) || !headers.includes(demandColumn)) errors.push('Choose date and demand columns that exist in your table.');
    if (dateColumn === demandColumn || (groupColumn && (groupColumn === dateColumn || groupColumn === demandColumn))) errors.push('Date, demand, and group columns must be distinct.');
    const active = rows.map((row, index) => ({ row, index })).filter(({ row }) => headers.some(header => (row[header] ?? '').trim() !== ''));
    if (active.length < 65) errors.push(`Add at least 65 rows of sales data. You currently have ${active.length}.`);
    if (active.length > 100_000) errors.push('This dataset has more than 100,000 rows. Reduce the file size before forecasting.');
    const grouped = new Map<string, Map<string, { date: string; timestamp: number }>>();
    const normalizedDates = new Map<number, string>();
    for (const { row, index } of active) {
      const dateText = (row[dateColumn] ?? '').trim(); const demandText = (row[demandColumn] ?? '').trim();
      if (!dateText) { errors.push(`Row ${index + 1}: date is blank.`); break; }
      const parsedDate = parseWeeklyDate(dateText, effectiveDateFormat);
      if (!parsedDate) { errors.push(`Row ${index + 1}: “${dateText}” is not a valid date in the selected format.`); break; }
      if (!demandText) { errors.push(`Row ${index + 1}: demand is blank.`); break; }
      const demand = Number(demandText);
      if (!Number.isFinite(demand)) { errors.push(`Row ${index + 1}: demand must be a finite number.`); break; }
      if (demand < 0) { errors.push(`Row ${index + 1}: demand cannot be negative.`); break; }
      const group = groupColumn ? (row[groupColumn] ?? '').trim() : 'All data';
      if (groupColumn && !group) { errors.push(`Row ${index + 1}: group value is blank.`); break; }
      const week = weekStart(parsedDate);
      const timestamp = Date.parse(`${week}T00:00:00Z`);
      normalizedDates.set(index, parsedDate);
      const weeks = grouped.get(group) ?? new Map<string, { date: string; timestamp: number }>();
      weeks.set(week, { date: week, timestamp });
      grouped.set(group, weeks);
    }
    if (grouped.size > 500) errors.push('This file has too many separate stores or groups to forecast at once.');
    let weeklyCount = 0;
    for (const [group, groupWeeks] of grouped) {
      if (errors.length) break;
      const points = [...groupWeeks.values()];
      points.sort((a, b) => a.timestamp - b.timestamp);
      weeklyCount += points.length;
      if (points.length < 65) { errors.push(`“${group}” has ${points.length} weeks of sales; each store or group needs at least 65 weeks to build a useful forecast.`); break; }
      for (let i = 1; i < points.length; i++) if (points[i].timestamp - points[i - 1].timestamp !== 7 * 86400000) { errors.push(`Group “${group}” has a missing sales week between ${points[i - 1].date} and ${points[i].date}. Daily sales are combined into Monday-start weeks.`); break; }
    }
    return { errors, activeCount: active.length, weeklyCount, groups: grouped.size, normalizedDates };
  }, [rows, headers, dateColumn, dateFormat, effectiveDateFormat, demandColumn, groupColumn]);
  const showDashboard = datasetImported && validation.errors.length === 0;

  useEffect(() => {
    if (showDashboard) {
      setWorkspaceOpen(false);
      setDatasetEditorOpen(false);
    }
  }, [showDashboard]);

  const setCell = (rowIndex: number, column: string, value: string) => {
    setResult(null);
    setRows(previous => previous.map((row, i) => i === rowIndex ? { ...row, [column]: value } : row));
  };
  const updateColumns = (nextHeaders: string[], nextRows: Row[]) => {
    setHeaders(nextHeaders); setRows(nextRows.length ? nextRows : [emptyRow(nextHeaders)]);
    setDatasetEditorOpen(false);
    setWorkspaceOpen(true);
    const dateGuess = nextHeaders.find(h => /date|week|time/i.test(h)) ?? nextHeaders[0];
    setDateFormat('auto');
    const demandGuess = nextHeaders.find(h => /demand|sales|quantity|units|target/i.test(h) && h !== dateGuess) ?? nextHeaders.find(h => h !== dateGuess) ?? nextHeaders[0];
    const groupGuess = nextHeaders.find(h => /store|region|product|group|department|sku/i.test(h) && h !== dateGuess && h !== demandGuess) ?? '';
    setDateColumn(dateGuess); setDemandColumn(demandGuess); setGroupColumn(groupGuess); setResult(null); setDatasetImported(true);
  };
  const importText = (text: string) => {
    try { const parsed = parseCsv(text); updateColumns(parsed.headers, parsed.rows); setDataMessage({ kind: 'success', text: `Imported ${parsed.rows.length.toLocaleString()} rows and ${parsed.headers.length} columns. Review the mapping and validation before forecasting.` }); setApiError(null); }
    catch (error) { setDataMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Could not parse this data.' }); }
  };
  const handleFile = async (file?: File) => { if (!file) return; if (!/\.csv$/i.test(file.name) && !['text/csv', 'application/vnd.ms-excel', 'text/plain'].includes(file.type)) { setDataMessage({ kind: 'error', text: 'Please upload a CSV file. Excel files are not supported by this frontend.' }); return; } try { importText(await file.text()); } catch { setDataMessage({ kind: 'error', text: 'Could not read the selected file.' }); } if (fileRef.current) fileRef.current.value = ''; };
  const addRows = (count = 1) => {
    setResult(null);
    setDatasetEditorOpen(true);
    setWorkspaceOpen(true);
    setRows(previous => [...previous, ...Array.from({ length: count }, () => emptyRow(headers))]);
  };
  const removeRow = (index: number) => {
    setResult(null);
    setRows(previous => previous.filter((_, i) => i !== index));
  };
  const runForecast = async () => {
    setApiError(null); setResult(null);
    if (validation.errors.length) { setApiError(validation.errors[0]); return; }
    setLoading(true);
    try {
      const records = rows.flatMap((row, index) => headers.some(header => (row[header] ?? '').trim() !== '') ? [Object.fromEntries(headers.map(header => [header, header === dateColumn ? validation.normalizedDates.get(index) ?? row[header] ?? '' : row[header] ?? '']))] : []);
      const response = await api.customForecast({ date_column: dateColumn, demand_column: demandColumn, group_column: groupColumn || null, horizon, records });
      if (!response.forecasts.length) {
        setApiError('No forecast was created. Please check your sales data and try again.');
        return;
      }
      setResult(response);
    } catch (error) { setApiError(error instanceof ApiError ? error.message : 'Something went wrong while creating the forecast. Please try again.'); }
    finally { setLoading(false); }
  };
  const exportDataset = () => downloadCsv('demand-dataset.csv', headers, rows.filter(row => headers.some(header => (row[header] ?? '').trim() !== '')));
  const exportForecast = () => {
    if (!result) return;
    const columns = ['week', 'store_or_group', 'expected_sales'];
    const rows = result.forecasts.map(point => ({
      week: point.forecast_date,
      store_or_group: point.group_value,
      expected_sales: point.predicted_demand,
    }));
    downloadCsv('demand-forecast.csv', columns, rows);
  };
  const isReady = connection === 'online';

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><Icon name="activity" size={21}/></div><div><div className="brand-name">Demand<span>Studio</span></div><div className="brand-subtitle">STORE SALES PLANNING</div></div></div><nav className="topbar-nav" aria-label="Dashboard sections"><a href="#workspace">Workspace</a>{showDashboard && <a href="#insights">Insights</a>}</nav><div className="topbar-right"><div className={`connection ${connection}`}><span className="status-dot"/><span>{connection === 'online' ? 'Ready' : connection === 'offline' ? 'Offline' : 'Loading…'}</span></div><button className="icon-button refresh-button" onClick={() => void refreshConnection()} aria-label="Check connection" title="Check connection"><Icon name="refresh"/></button><div className="avatar">DS</div></div></header>
    <main className="main-content"><div className="page-intro"><div><div className="eyebrow"><span className="eyebrow-line"/> STORE INTELLIGENCE</div><h1>Store demand dashboard</h1><p className="intro-copy">One clear view of sales history, store performance and what may come next.</p></div><div className="intro-badge"><Icon name="spark" size={16}/><span>Custom dataset</span></div></div>
      <section className="status-strip" aria-live="polite"><div className="status-icon"><Icon name={isReady ? 'check' : 'database'} size={18}/></div><div className="status-copy"><strong>{isReady ? 'Ready to forecast' : connection === 'offline' ? 'Forecasting is temporarily unavailable' : 'Getting things ready…'}</strong><span>{isReady ? 'Add your store sales data to see what may come next.' : connection === 'offline' ? 'Please make sure the app is running, then try again.' : 'Getting the forecast ready.'}</span></div>{connection === 'offline' && <button className="text-button" onClick={() => void refreshConnection()}>Try again <Icon name="arrow" size={14}/></button>}</section>

      <details className="workspace-disclosure" id="workspace" open={workspaceOpen} onToggle={event => setWorkspaceOpen(event.currentTarget.open)}>
      <summary className="workspace-summary"><span className="workspace-summary-icon"><Icon name="file" size={16}/></span><span><strong>Dataset & forecast settings</strong><small>{populatedRows.toLocaleString()} rows · {validation.groups} groups · {horizon}-week outlook</small></span><span className="workspace-summary-action">Edit settings</span></summary>
      <div className="workspace-grid"><section className="panel data-panel"><div className="panel-heading"><div><div className="section-kicker">YOUR DATA</div><h2>Bring your data</h2><p>Upload a CSV or work directly in the table.</p></div><span className="step-icon"><Icon name="file"/></span></div>
        <div className="source-actions"><button className="upload-card" onClick={() => fileRef.current?.click()}><span className="upload-icon"><Icon name="upload" size={20}/></span><span className="upload-text"><strong>Upload CSV</strong><small>Choose a .csv file from your device</small></span><Icon name="arrow" size={17}/></button><input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={event => void handleFile(event.target.files?.[0])}/><button className={`paste-card ${showPaste ? 'active' : ''}`} onClick={() => setShowPaste(v => !v)}><span className="paste-icon"><Icon name="table" size={20}/></span><span className="upload-text"><strong>Paste spreadsheet</strong><small>Copy cells from Excel or Sheets</small></span><Icon name="arrow" size={17}/></button></div>
        {showPaste && <div className="paste-area"><label htmlFor="paste-data">Paste CSV or tab-separated cells</label><textarea id="paste-data" value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder={'Date\tDemand\tStore\n2025-01-05\t120\tStore A'} rows={5}/><div className="paste-footer"><span>First row must contain column names.</span><button className="button button-secondary button-small" onClick={() => importText(pasteText)}>Import pasted data</button></div></div>}
        {dataMessage && <div className={`inline-message ${dataMessage.kind}`} role="status"><Icon name={dataMessage.kind === 'success' ? 'check' : dataMessage.kind === 'error' ? 'alert' : 'activity'} size={16}/><span>{dataMessage.text}</span><button className="message-close" onClick={() => setDataMessage(null)} aria-label="Dismiss message">×</button></div>}
        <details className="dataset-editor" open={datasetEditorOpen} onToggle={event => setDatasetEditorOpen(event.currentTarget.open)}>
        <summary><span className="table-icon"><Icon name="table" size={17}/></span><span><strong>Your dataset</strong><small>{populatedRows.toLocaleString()} data rows · {headers.length} columns</small></span><span className="editor-toggle">{datasetEditorOpen ? 'Hide table' : 'Edit data'}</span></summary>
        <div className="table-toolbar"><div className="table-title"><span className="table-icon"><Icon name="table" size={17}/></span><div><strong>Table editor</strong><small>{populatedRows} filled rows · {headers.length} columns</small></div></div><div className="table-tools"><button className="button button-quiet button-small" onClick={exportDataset} disabled={populatedRows === 0}><Icon name="download" size={15}/> Save data CSV</button><button className="button button-secondary button-small" onClick={() => addRows(1)}><Icon name="plus" size={15}/> Add row</button></div></div>
        <div className="table-wrap"><table className="data-table"><thead><tr><th className="row-num">#</th>{headers.map(header => <th key={header}>{header}</th>)}<th aria-label="Row actions"/></tr></thead><tbody>{previewRows.map((row, index) => <tr key={index}><td className="row-num">{index + 1}</td>{headers.map(header => <td key={header}><input aria-label={`Row ${index + 1}, ${header}`} value={row[header] ?? ''} onChange={event => setCell(index, header, event.target.value)} placeholder="—" /></td>)}<td className="row-action"><button className="delete-row" onClick={() => removeRow(index)} aria-label={`Remove row ${index + 1}`} title="Remove row"><Icon name="trash" size={14}/></button></td></tr>)}</tbody></table></div>
        <div className="table-footer"><span>Showing {previewRows.length} of {rows.length} rows · {populatedRows} with data{rows.length > MAX_TABLE_PREVIEW_ROWS ? ' · Export CSV to access all rows' : ''}</span><div><button className="text-button" onClick={() => addRows(10)}>Add 10 rows <Icon name="plus" size={14}/> </button><span className="footer-divider"/><button className="text-button danger-text" onClick={() => { setRows([emptyRow(headers)]); setResult(null); setDatasetImported(false); setDatasetEditorOpen(true); setWorkspaceOpen(true); setDataMessage({ kind: 'info', text: 'Table cleared.' }); }}>Clear table</button></div></div>
        <div className="data-note"><Icon name="alert" size={16}/><span>For a weekly forecast, provide at least <strong>65 weeks for each store or group</strong>. The first year helps detect yearly patterns; additional weeks train the forecast. Daily sales and multiple transactions in a week are added into weekly totals automatically.</span></div>
        </details>
      </section>

      <aside className="panel config-panel"><div className="panel-heading"><div><div className="section-kicker">FORECAST SETTINGS</div><h2>Choose what to forecast</h2><p>Tell us which columns contain your sales and dates.</p></div><span className="step-icon"><Icon name="spark"/></span></div>
        <div className="compact-field-grid">
        <div className="field-group"><label htmlFor="date-column">Date in your file <span className="required">*</span></label><select id="date-column" value={dateColumn} onChange={e => { setResult(null); setDateColumn(e.target.value); }} >{headers.map(h => <option key={h} value={h}>{h}</option>)}</select><small>Date for each week of sales</small></div>
        <div className="field-group"><label htmlFor="date-format">Date format</label><select id="date-format" value={dateFormat} onChange={e => { setResult(null); setDateFormat(e.target.value as DateFormat); }}><option value="auto">Auto-detect ({effectiveDateFormat === 'day-first' ? 'day first' : 'month first'})</option><option value="day-first">Day first (DD-MM-YYYY)</option><option value="month-first">Month first (MM-DD-YYYY)</option></select><small>Dates detected as {effectiveDateFormat === 'day-first' ? 'day first' : 'month first'}.</small></div>
        <div className="field-group"><label htmlFor="demand-column">Sales amount <span className="required">*</span></label><select id="demand-column" value={demandColumn} onChange={e => { setResult(null); setDemandColumn(e.target.value); }}>{headers.map(h => <option key={h} value={h}>{h}</option>)}</select><small>Number of items or amount sold each week</small></div>
        <div className="field-group"><label htmlFor="group-column">Show separately by <span className="optional">OPTIONAL</span></label><select id="group-column" value={groupColumn} onChange={e => { setResult(null); setGroupColumn(e.target.value); }}><option value="">Combine all sales</option>{headers.map(h => <option key={h} value={h}>{h}</option>)}</select><small>Choose a store, product or area column</small></div>
        </div>
        <div className="field-group horizon-group"><div className="horizon-label"><label htmlFor="horizon">Forecast horizon</label><span className="horizon-value">{horizon} <small>{horizon === 1 ? 'week' : 'weeks'}</small></span></div><input id="horizon" className="range-input" type="range" min="1" max="52" value={horizon} onChange={e => { setResult(null); setHorizon(Number(e.target.value)); }}/><div className="range-ends"><span>1 week</span><span>52 weeks</span></div></div>
        <div className={`validation-card ${validation.errors.length ? 'has-errors' : 'is-valid'}`}><div className="validation-head"><span className="validation-symbol"><Icon name={validation.errors.length ? 'alert' : 'check'} size={16}/></span><strong>{validation.errors.length ? 'Needs attention' : 'Sales data looks good'}</strong><span className="validation-count">{validation.errors.length ? 'Review' : 'Ready'}</span></div>{validation.errors.length ? <p>{validation.errors[0]}</p> : <p>{validation.activeCount < 65 ? `${validation.activeCount} filled data rows covering ${validation.weeklyCount} weeks. Each store needs at least 65 weeks.` : `${validation.activeCount.toLocaleString()} data rows covering ${validation.weeklyCount.toLocaleString()} weeks across ${validation.groups} store${validation.groups === 1 ? '' : 's or groups'}.`}</p>}</div>
        {apiError && <div className="api-error" role="alert"><Icon name="alert" size={17}/><div><strong>Forecast could not run</strong><p>{apiError}</p></div><button className="message-close" onClick={() => setApiError(null)} aria-label="Dismiss error">×</button></div>}
        <button className="button button-primary run-button" onClick={() => void runForecast()} disabled={loading || connection !== 'online' || validation.errors.length > 0}><span>{loading ? <span className="spinner"/> : <Icon name="chart" size={18}/>}</span>{loading ? 'Preparing…' : 'Generate forecast'}{!loading && <Icon name="arrow" size={17}/>}</button><p className="submit-footnote"><span className="secure-dot"/> Your sales data is used to prepare your forecast.</p>
      </aside></div>
      </details>
      {showDashboard && <DemandDashboard
        rows={rows}
        dateColumn={dateColumn}
        demandColumn={demandColumn}
        groupColumn={groupColumn}
        dateFormat={effectiveDateFormat}
        response={result}
        onGenerate={() => void runForecast()}
        canGenerate={connection === 'online' && validation.errors.length === 0 && !loading}
        loading={loading}
      />}
      {showDashboard && loading && <div className="forecast-running" role="status"><span className="spinner"/><div><strong>Preparing your forecast</strong><p>Checking your sales history. Larger datasets may take a little longer.</p></div></div>}
      {showDashboard && apiError && <div className="dashboard-api-error" role="alert"><Icon name="alert"/><span>{apiError}</span></div>}
      {showDashboard && result && <section className="panel forecast-table-panel"><div className="result-panel-head"><div><h3>Coming weeks</h3><p>Expected sales for each upcoming week</p></div><button className="button button-secondary" onClick={exportForecast}><Icon name="download" size={16}/> Download forecast</button></div><div className="forecast-table-wrap"><table className="forecast-table"><thead><tr><th>Week</th><th>Store or group</th><th className="numeric">Expected sales</th></tr></thead><tbody>{result.forecasts.map((point, index) => <tr key={`${point.group_id}-${point.forecast_date}-${index}`}><td><span className="date-cell"><Icon name="calendar" size={15}/>{point.forecast_date}</span></td><td>{point.group_value}</td><td className="numeric prediction-cell">{fmt(point.predicted_demand)}</td></tr>)}</tbody></table></div></section>}
      <footer className="app-footer"><div className="footer-brand"><span className="brand-mark mini"><Icon name="activity" size={15}/></span> DemandStudio <span className="footer-separator">·</span> Weekly sales planning</div></footer>
    </main>
  </div>;
}

export default App;
