"""Plot non-overlapping HTTP duration components from the saved benchmark."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

folder = Path(__file__).resolve().parents[1] / 'docs' / 'performance'
data = json.loads((folder / 'measurements.json').read_text())
rows = data['http-after-sharh-layout-fix']['results']
selected = [next(r for r in rows if r['name'] == name) for name in
            ['first explanation', 'search fresh', 'sharh search fresh', 'sharh search CDN']]
labels = ['Cold explanation, legacy', 'Warm hadith search', 'Explanation search, 15 items', 'Explanation search, CDN hit']
fluid = data['fluid-preview']
cold = fluid['coldService']['result']
selected.insert(1, {'wire': fluid['coldWire'], 'stages': cold['stages'] + [{'name': 'server', 'ms': cold['responseReadyMs']}]})
labels.insert(1, 'Cold explanation, Fluid benchmark')
parts = ['Imports', 'Unpack Chromium', 'Browser/page work', 'Dorar navigation', 'Read/parse HTML', 'Resolve 15 previews', 'Other inside handler', 'Outside handler']
colors = ['#8c6bb1', '#d95f02', '#7570b3', '#1b9e77', '#66a61e', '#e6ab02', '#a6a6a6', '#bdbdbd']
values = []
for row in selected:
    stages = row['stages']
    stage = lambda name: sum(s['ms'] for s in stages if s['name'] == name) / 1000
    total = row['wire']['total']
    server = stage('server')
    if stage('hydrate'):
        components = [0, 0, 0, 0, 0, stage('hydrate'), server - stage('hydrate'), total - server]
    elif stages:
        components = [stage('imports'), stage('extract'), sum(stage(n) for n in ['queue', 'launch', 'page', 'setup', 'cleanup']), stage('navigate'), stage('body') + stage('parse'), 0]
        components += [server - sum(components), total - server]
    else:
        components = [0] * 7 + [total]
    assert min(components) >= -0.01
    values.append([max(0, x) for x in components])

fig, ax = plt.subplots(figsize=(11, 5.5))
left = [0.0] * len(values)
for i, (part, color) in enumerate(zip(parts, colors)):
    widths = [v[i] for v in values]
    ax.barh(labels, widths, left=left, label=part, color=color, height=0.6)
    left = [x + y for x, y in zip(left, widths)]
for i, total in enumerate(left):
    ax.text(total + 0.15, i, f'{total:.2f}s', va='center', fontsize=10)
ax.invert_yaxis()
ax.set_xlim(0, max(left) + 1.5)
ax.set_xlabel('Complete HTTP request, seconds')
ax.set_title('Real Vercel requests: cold startup and loading explanation pages dominate')
ax.spines[['top', 'right']].set_visible(False)
ax.legend(loc='upper center', bbox_to_anchor=(0.5, -0.18), ncol=3, frameon=False, fontsize=9)
fig.tight_layout()
fig.savefig(folder / 'request-duration.png', dpi=170, bbox_inches='tight')
