"""Locally prepared East Asian U850 maps, independent of the Indian Ocean EOF."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from scipy.interpolate import RegularGridInterpolator

import chain
import cioproj
import live_prediction as prediction
import u850_adapter as adapter

LAT = np.arange(20, 41, dtype=float)
LON = np.arange(100, 126, dtype=float)
CACHE_VERSION = 2
router = APIRouter(prefix='/api/default-u850', tags=['default-u850'])


def read_fields(raw_dir, wanted):
    """Read actual daily anomalies; interpolate within source coverage only."""
    entries = adapter.inventory(raw_dir)
    lon_grid, lat_grid = np.meshgrid(LON, LAT)
    points = np.column_stack((lat_grid.ravel(), lon_grid.ravel()))
    frames = {}
    for path, spec in entries:
        chosen = [(i, d) for i, d in enumerate(spec['dates']) if d in wanted]
        if not chosen:
            continue
        lati, loni = np.argsort(spec['lat']), np.argsort(spec['lon'])
        slat, slon = spec['lat'][lati], spec['lon'][loni]
        if slat[0] > LAT[0] or slat[-1] < LAT[-1] or slon[0] > LON[0] or slon[-1] < LON[-1]:
            raise ValueError('Source grid does not cover East Asia (20–40°N, 100–125°E); extrapolation is forbidden.')
        la = slice(max(0, np.searchsorted(slat, LAT[0])-1), min(len(slat), np.searchsorted(slat, LAT[-1], side='right')+1))
        lo = slice(max(0, np.searchsorted(slon, LON[0])-1), min(len(slon), np.searchsorted(slon, LON[-1], side='right')+1))
        with adapter.open_dataset(path) as ds:
            field = ds[spec['variable']]
            if str(field.attrs.get('_Unsigned', '')).lower() == 'true':
                raise ValueError('Unsigned U850 encoding is unsupported.')
            remaining = [d for d in field.dims if d not in spec['selected'] and d != spec['dims'][0]]
            for index, day in chosen:
                select = {**spec['selected'], spec['dims'][0]: index}
                raw = np.asarray(field.variable[tuple(select.get(d, slice(None)) for d in field.dims)].values, dtype=float)
                raw = np.transpose(raw, [remaining.index(d) for d in spec['dims'][1:]])
                for attr in ('_FillValue', 'missing_value'):
                    for fill in np.ravel(field.attrs.get(attr, [])):
                        raw = np.where(raw == fill, np.nan, raw)
                raw = (raw * float(field.attrs.get('scale_factor', 1)) + float(field.attrs.get('add_offset', 0))) * spec['factor']
                raw = raw[np.ix_(lati[la], loni[lo])]
                frame = RegularGridInterpolator((slat[la], slon[lo]), raw, bounds_error=True)(points).reshape(len(LAT), len(LON))
                if not np.isfinite(frame).all():
                    raise ValueError(f'{day}: East Asian U850 contains missing or non-finite values.')
                frames[day] = frame
    missing = wanted - frames.keys()
    if missing:
        raise ValueError(f'Missing {len(missing)} required dates, starting with {min(missing)}.')
    return frames


def preprocess_fields(raw, days_of_month, consts):
    """Apply the historical preprocessing to the displayed East Asian domain.

    This diagnostic field is not multiplied by the Indian Ocean EOF and does
    not replace the Indian Ocean fields that generated the model's CIO input.
    """
    if raw.ndim != 3 or raw.shape[2] != len(days_of_month) or not np.isfinite(raw).all():
        raise ValueError('Invalid raw U850 field or calendar.')
    days_of_month = np.asarray(days_of_month)
    average = np.zeros_like(raw)
    for day in range(1, 29):
        chosen = days_of_month == day
        if chosen.any():
            average[:, :, chosen] = raw[:, :, chosen].mean(axis=2, keepdims=True)
    processed = (raw - average - cioproj.lat_highpass(raw) - consts['Umean']) / consts['Ustd']
    if not np.isfinite(processed).all():
        raise ValueError('Non-finite East Asian preprocessing result.')
    return processed


def fingerprint(raw_dir):
    digest = hashlib.sha256(str(CACHE_VERSION).encode())
    for path in [*adapter.nc_files(raw_dir), prediction._mat_path(), Path(__file__), Path(adapter.__file__), Path(cioproj.__file__)]:
        stat = path.stat()
        digest.update(f'{path.name}:{stat.st_size}:{stat.st_mtime_ns}'.encode())
    return digest.hexdigest()


def prepare(raw_dir, leads=range(1, 21), years=range(2000, 2020), force=False):
    leads, years = list(leads), list(years)
    if not leads or not years or any(k not in range(1, 21) for k in leads) or any(y not in range(2000, 2020) for y in years):
        raise ValueError('Supported years: 2000–2019; leads: 1–20.')
    signature = fingerprint(raw_dir)
    pending = []
    for year in years:
        for lead in leads:
            folder = chain.JOB_ROOT / f'default-{year}-pre{lead}'
            marker = folder / 'eastasia_state.json'
            try:
                state = json.loads(marker.read_text(encoding='utf-8'))
                fresh = state.get('fingerprint') == signature and (folder / 'eastasia_u850.npz').is_file()
            except (OSError, ValueError, AttributeError):
                fresh = False
            if force or not fresh:
                pending.append((year, lead, folder))
    if not pending:
        print('East Asian U850: all requested windows already prepared', flush=True)
        return
    all_years = range(2000, 2021)
    pending_leads = sorted({lead for _, lead, _ in pending})
    wanted = {d for year in all_years for lead in pending_leads for d in adapter.expected_dates(year, lead)}
    print(f'East Asian U850: reading {len(wanted)} actual daily fields for {len(pending)} windows', flush=True)
    frames = read_fields(raw_dir, wanted)
    consts = cioproj.load_consts(str(prediction._mat_path()))
    for lead in pending_leads:
        all_dates = [d for year in all_years for d in adapter.expected_dates(year, lead)]
        raw_all = np.stack([frames[d] for d in all_dates], axis=2)
        processed_all = preprocess_fields(raw_all, [d.day for d in all_dates], consts)
        date_indices = {d: i for i, d in enumerate(all_dates)}
        for year, this_lead, folder in pending:
            if this_lead != lead:
                continue
            dates = adapter.expected_dates(year, lead)
            indices = [date_indices[d] for d in dates]
            fields = np.moveaxis(raw_all[:, :, indices], 2, 0).astype(np.float32)
            processed = np.moveaxis(processed_all[:, :, indices], 2, 0).astype(np.float32)
            if fields.shape != (112, len(LAT), len(LON)) or not np.isfinite(fields).all() or not np.isfinite(processed).all():
                raise ValueError('Invalid East Asian window.')
            folder.mkdir(parents=True, exist_ok=True)
            artifact = folder / 'eastasia_u850.tmp.npz'
            np.savez_compressed(artifact, fields=fields, processed=processed, lat=LAT, lon=LON, dates=np.array([d.isoformat() for d in dates]))
            artifact.replace(folder / 'eastasia_u850.npz')
            marker = folder / 'eastasia_state.tmp'
            marker.write_text(json.dumps({'cacheVersion': CACHE_VERSION, 'fingerprint': signature, 'year': year, 'lead': lead}), encoding='utf-8')
            marker.replace(folder / 'eastasia_state.json')
        print(f'East Asian U850 pre{lead}: raw + preprocessed windows saved', flush=True)
    print(f'East Asian U850: {len(pending)} windows prepared, each 112 × 21 × 26, in m/s', flush=True)


def load_frame(year, lead, time_index):
    if not isinstance(year, int) or year not in range(2000, 2020) or not isinstance(lead, str) or lead not in {f'pre{k}' for k in range(1, 21)}:
        raise HTTPException(400, 'Supported years: 2000–2019; leads: pre1–pre20.')
    if not isinstance(time_index, int) or time_index not in range(112):
        raise HTTPException(422, 'Time index must be between 0 and 111.')
    lead_number = int(lead[3:])
    folder = chain.JOB_ROOT / f'default-{year}-{lead}'
    try:
        state = json.loads((folder / 'eastasia_state.json').read_text(encoding='utf-8'))
        if (state['cacheVersion'], state['year'], state['lead']) != (CACHE_VERSION, year, lead_number):
            raise ValueError('Cache identity mismatch')
        with np.load(folder / 'eastasia_u850.npz', allow_pickle=False) as archive:
            fields, processed, lat, lon, dates = (archive[k] for k in ('fields', 'processed', 'lat', 'lon', 'dates'))
        expected = [d.isoformat() for d in adapter.expected_dates(year, lead_number)]
        if (fields.shape != (112, 21, 26) or processed.shape != fields.shape or not np.isfinite(fields).all() or not np.isfinite(processed).all()
                or not np.array_equal(lat, LAT) or not np.array_equal(lon, LON) or dates.tolist() != expected):
            raise ValueError('Invalid East Asian coordinates, dates, or values')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(503, 'East Asian U850 artifacts are missing or invalid. Run backend/eastasia_u850.py.') from exc
    frame = fields[time_index]
    return {'targetYear': year, 'lead': lead_number, 'timeIndex': time_index, 'totalSteps': 112,
            'date': expected[time_index], 'dates': expected, 'lat': lat.tolist(), 'lon': lon.tolist(),
            'data': frame.tolist(), 'processed': processed[time_index].tolist(),
            'processedScaleMax': max(float(np.max(np.abs(processed))), 1e-12), 'scaleMax': max(float(np.max(np.abs(fields))), 1e-12),
            'unit': 'm/s', 'source': 'CESM global U850 anomalies',
            'domain': {'lat': [20, 40], 'lon': [100, 125]}}


@router.get('')
def default_u850(year: int = Query(2000), lead: str = Query('pre20'), time_index: int = Query(0, ge=0, le=111)):
    return load_frame(year, lead, time_index)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw-dir', type=Path, default=Path(__file__).resolve().parents[1] / '摸库交付_2026-09-15' / '数据' / 'U850')
    parser.add_argument('--leads', type=int, nargs='+', default=list(range(1, 21)))
    parser.add_argument('--years', type=int, nargs='+', default=list(range(2000, 2020)))
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    prepare(args.raw_dir, args.leads, args.years, args.force)
