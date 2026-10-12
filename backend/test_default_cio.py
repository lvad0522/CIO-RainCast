import json
import pytest
from fastapi import HTTPException
import chain
import default_cio as D


def write_cache(tmp_path, **changes):
    job_id = 'default-2019-pre6'
    folder = tmp_path / job_id
    folder.mkdir()
    for name in D.REQUIRED_FILES:
        (folder / name).touch()
    job = {'jobId': job_id, 'status': 'completed', 'stageIndex': 2,
           'projection': {'year': 2019, 'lead': 6}, 'progress': 100}
    job.update(changes)
    (folder / 'default_state.json').write_text(json.dumps({'cacheVersion': D.CACHE_VERSION, 'job': job}), encoding='utf-8')
    return folder


def test_restart_hydrates_without_computation(tmp_path, monkeypatch):
    monkeypatch.setattr(chain, 'JOB_ROOT', tmp_path)
    monkeypatch.setattr(chain, '_jobs', {})
    write_cache(tmp_path)
    def forbidden(*args, **kwargs):
        pytest.fail('Reading prepared data must never launch computation')
    monkeypatch.setattr(chain, '_run_chain_job', forbidden)
    job = D.load_default_job(2019, 'pre6')
    assert job['status'] == 'completed'
    assert chain._get_job(job['jobId'])['stageIndex'] == 2
    assert 'cacheVersion' not in job


def test_missing_or_partial_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(chain, 'JOB_ROOT', tmp_path)
    with pytest.raises(HTTPException) as error:
        D.load_default_job(2019, 'pre6')
    assert error.value.status_code == 503
    folder = write_cache(tmp_path)
    (folder / 'projection_preview.npz').unlink()
    with pytest.raises(HTTPException) as error:
        D.load_default_job(2019, 'pre6')
    assert error.value.status_code == 503


@pytest.mark.parametrize('changes', [{'projection': {'year': 2018, 'lead': 6}}, {'stageIndex': 1}, {'status': 'running'}, {'jobId': 'other'}])
def test_invalid_identity_or_unfinished_cache(tmp_path, monkeypatch, changes):
    monkeypatch.setattr(chain, 'JOB_ROOT', tmp_path)
    write_cache(tmp_path, **changes)
    with pytest.raises(HTTPException) as error:
        D.load_default_job(2019, 'pre6')
    assert error.value.status_code == 503


@pytest.mark.parametrize('year,lead', [(1999,'pre6'),(2020,'pre6'),(2019,'pre01'),(2019,'pre21'),(2019,'../pre6')])
def test_invalid_combinations(tmp_path, monkeypatch, year, lead):
    monkeypatch.setattr(chain, 'JOB_ROOT', tmp_path)
    with pytest.raises(HTTPException) as error:
        D.load_default_job(year, lead)
    assert error.value.status_code == 400
