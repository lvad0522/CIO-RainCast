import { Children, useEffect, useRef, useState } from 'react';

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

function StyledSelect({ ariaLabel, value, onChange, children }) {
  const options = Children.toArray(children);
  const selectedIndex = Math.max(0, options.findIndex(option => String(option.props.value) === String(value)));
  const selectedOption = options[selectedIndex] || options[0];
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const isDisabled = option => Boolean(option?.props?.disabled);
  const hasDisabledOptions = options.some(isDisabled);
  const findEnabledIndex = (start, direction) => {
    if (!options.length) return -1;
    if (!hasDisabledOptions) {
      return Math.min(options.length - 1, Math.max(0, start));
    }
    let index = (start + options.length) % options.length;
    for (let count = 0; count < options.length; count += 1) {
      if (!isDisabled(options[index])) return index;
      index = (index + direction + options.length) % options.length;
    }
    return -1;
  };

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, selectedIndex]);

  const chooseOption = option => {
    if (!option || isDisabled(option)) return;
    onChange({ target: { value: option.props.value } });
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleKeyDown = event => {
    if (event.key === 'Escape') {
      if (open) event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setHighlightedIndex(findEnabledIndex(selectedIndex, 1));
        setOpen(true);
        return;
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setHighlightedIndex(index => findEnabledIndex(index + direction, direction));
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!open) return;
      event.preventDefault();
      setHighlightedIndex(findEnabledIndex(
        event.key === 'Home' ? 0 : options.length - 1,
        event.key === 'Home' ? 1 : -1,
      ));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) chooseOption(options[highlightedIndex]);
      else {
        setHighlightedIndex(findEnabledIndex(selectedIndex, 1));
        setOpen(true);
      }
    }
  };

  return (
    <div
      className={`styled-select ${open ? 'is-open' : ''}`}
      ref={rootRef}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className="styled-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        ref={triggerRef}
        title={selectedOption?.props.title}
        onClick={() => {
          setHighlightedIndex(findEnabledIndex(selectedIndex, 1));
          setOpen(current => !current);
        }}
      >
        <span className="styled-select-value">{selectedOption?.props.children}</span>
        <span className="styled-select-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div className="styled-select-menu" role="listbox" aria-label={ariaLabel} ref={menuRef}>
          {options.map((option, index) => {
            const optionValue = String(option.props.value);
            const isSelected = optionValue === String(value);
            return (
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-disabled={isDisabled(option)}
                tabIndex={-1}
                disabled={isDisabled(option)}
                title={option.props.title}
                className={`styled-select-option ${isSelected ? 'is-selected' : ''} ${index === highlightedIndex ? 'is-highlighted' : ''} ${isDisabled(option) ? 'is-disabled' : ''}`}
                key={optionValue}
                onMouseEnter={() => !isDisabled(option) && setHighlightedIndex(index)}
                onClick={() => chooseOption(option)}
              >
                <span>{option.props.children}</span>
                {isSelected && <span className="styled-select-check" aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
