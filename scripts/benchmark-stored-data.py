"""Measure local storage using an API response, not a complete Dorar dataset."""
import json
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

if sys.argv[1] == '--read':
    db = sqlite3.connect(sys.argv[2])
    print(len(json.loads(db.execute('SELECT payload FROM responses').fetchone()[0])['data']))
    sys.exit()

payload = Path(sys.argv[1]).read_text()
data = json.loads(payload)['data']
with tempfile.TemporaryDirectory(prefix='dorar-stored-data-') as folder:
    filename = str(Path(folder) / 'hadith.sqlite')
    db = sqlite3.connect(filename)
    db.execute('CREATE TABLE responses (payload TEXT)')
    db.execute('INSERT INTO responses VALUES (?)', (payload,))
    db.execute("CREATE VIRTUAL TABLE hadith USING fts5(text, tokenize='unicode61')")
    db.executemany('INSERT INTO hadith VALUES (?)', [(row['hadith'],) for row in data])
    db.commit()
    durations = []
    for _ in range(200):
        started = time.perf_counter()
        results = db.execute("SELECT text FROM hadith WHERE hadith MATCH 'المال'").fetchall()
        durations.append((time.perf_counter() - started) * 1000)
    started = time.perf_counter()
    reopened = subprocess.check_output([sys.executable, __file__, '--read', filename], text=True)
    reopened_ms = (time.perf_counter() - started) * 1000
    assert int(reopened) == len(data)
    print(json.dumps({
        'records': len(data), 'localIndexMatches': len(results),
        'localSearchMedianMs': statistics.median(durations),
        'storedResponseFreshProcessMs': reopened_ms,
        'databaseBytes': Path(filename).stat().st_size,
        'completeDorarDataset': False,
    }))
