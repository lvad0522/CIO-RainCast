export default function ResultsTable({ data, selectedFold, onSelectFold, embedded = false }) {
  const handleExportCSV = () => {
    if (!data || data.length === 0) return;
    const headers = ['Experiment', 'Pearson r', 'RMSE (mm/day)', 'MAE (mm/day)'];
    const rows = data.map(d => [d.experiment, d.pearsonR, d.rmse, d.mae]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lstm_results.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!data || data.length === 0) return null;

  return (
    <div className={embedded ? "focus-evaluation-group" : "result-card"} style={embedded ? { marginTop: 18 } : undefined}>
      <div className="result-header">
        <h3 className="result-title" style={{ margin: 0 }}>Domain-wide metrics by experiment</h3>
        <button className="export-btn" onClick={handleExportCSV}>📥 Export CSV</button>
      </div>
      <></>
      <div className="table-wrap">
        <table className="results-table">
          <thead>
            <tr>
              <th>Experiment</th>
              <th>Pearson r</th>
              <th>RMSE (mm/day)</th>
              <th>MAE (mm/day)</th>
            </tr>
          </thead>
          <tbody>
            {data.map(d => (
              <tr key={d.experiment} style={selectedFold === d.experiment ? { background: '#e8f3f4' } : undefined}>
                <td>{onSelectFold ? <button className="export-btn" onClick={() => onSelectFold(d.experiment)} aria-pressed={selectedFold === d.experiment}>Experiment {d.experiment}{selectedFold === d.experiment ? ' · Selected' : ''}</button> : `Experiment ${d.experiment}`}</td>
                <td className={d.pearsonR > 0.5 ? 'good' : d.pearsonR > 0.3 ? 'ok' : ''}>
                  {d.pearsonR}
                </td>
                <td>{d.rmse}</td>
                <td>{d.mae}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
