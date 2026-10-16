import StyledSelect from './StyledSelect';

export default function ParamPanel({ params, onChange, disabled = false }) {
  return <fieldset className="panel-section forecast-parameters" disabled={disabled}>
    <h3 className="section-title">Case settings</h3>
    <div className="param-group">
      <label>Year</label>
      <StyledSelect ariaLabel="Year" value={params.predYear} onChange={event => onChange('predYear', Number(event.target.value))}>
        {Array.from({ length: 20 }, (_, i) => 2000+i).map(year => <option key={year} value={year}>{year}</option>)}
      </StyledSelect>
    </div>
    <div className="param-group">
      <label>Input-window configuration</label>
      <StyledSelect ariaLabel="Input-window configuration" value={params.leadTime} onChange={event => onChange('leadTime', event.target.value)}>
        {Array.from({ length: 20 }, (_, i) => i+1).map(lead => <option key={lead} value={`pre${lead}`}>pre{lead}</option>)}
      </StyledSelect>
    </div>
  </fieldset>;
}

